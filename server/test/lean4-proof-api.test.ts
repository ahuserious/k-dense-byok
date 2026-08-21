import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PROJECTS_ROOT } from "../src/config.ts";
import { resolvePaths } from "../src/projects.ts";
import { withActiveProject } from "../src/scope.ts";
import {
  LEAN4_SOURCE_MAX_BYTES,
  projectLean4Proofs,
  registerLean4Routes,
  type Lean4ProofListResponse,
  type Lean4ProofSourceResponse,
} from "../src/api/lean4.ts";
import {
  createKadyWorkflowNodeExecutor,
  type KadyWorkflowUsageReserver,
  type TrustedLeanVerificationRequest,
  type TrustedLeanVerificationResult,
  type TrustedLeanVerifier,
} from "../src/workflows/kady-node-executor.ts";
import { trustedLeanArtifactPaths } from "../src/workflows/lean4-artifacts.ts";
import {
  WorkflowStore,
  runWorkflowDag,
  type ModelRequest,
  type WorkflowGraphDocument,
  type WorkflowNode,
  type WorkflowRunRecord,
} from "../src/workflows/index.ts";

/**
 * GATE B for matrix row 10 — the EFFECT, not the schema.
 *
 * Every test below runs the REAL `lean4` branch of
 * `createKadyWorkflowNodeExecutor`, the REAL `runWorkflowDag` artifact-receipt
 * verification (real files on disk, real sha256, real TOCTOU stat snapshots,
 * real `isTrustedLeanArtifactPath` gate), the REAL `WorkflowStore` event log,
 * and the REAL route handler. What is asserted is which verifier was
 * dispatched, with which authored parameters, which artifacts the runner
 * actually accepted, and what the endpoint then hands a browser.
 *
 * WHERE THE REAL LEAN PATH STOPS, said plainly: there is no Lean toolchain and
 * no pinned Mathlib checkout in this environment, so `createTrustedLeanVerifier`
 * cannot run here. The seam is at the `TrustedLeanVerifier` boundary — the SAME
 * seam production injects at (`workflows/service.ts`:
 * `verifyLean: options.leanVerifier ?? createTrustedLeanVerifier()`). Only the
 * child process that would shell out to `lake env lean` is substituted; the
 * `mathlibRevision`/`mathlibTree` values below stand in for what
 * `inspectPinnedMathlibCheckout()` produces from a real checkout. These tests do
 * NOT prove that Lean ran. They prove that whatever the trusted verifier
 * reports reaches the browser intact, that an untrusted path never does, and
 * that a Lean node's proof artifact is produced, stored and served.
 */

const PROJECT_ID = "lean4-proof-api-test";
const MATHLIB_REVISION = "4d1f6e2a9c3b8705ef2213a4c65d90bb17e4f0aa";
const MATHLIB_TREE = "9b7c05e1d24f38a6be0913cc74d5f28a6e11b3d0";
const PROOF_SOURCE = "theorem kady_reflexive (n : Nat) : n = n := rfl\n";
const VERIFICATION_LOG = "byom-dag-fusion: allowed_axioms=propext,Classical.choice\n";

let app: FastifyInstance;

async function buildLean4App(): Promise<FastifyInstance> {
  const instance = Fastify();
  // Mirrors the project-scope hook in `server/src/index.ts`, which is not this
  // lane's file. The two registration lines for the real server are in the
  // clone's INTEGRATION.md.
  instance.addHook("onRequest", (request, _reply, done) => {
    const header = request.headers["x-project-id"];
    const projectId = (Array.isArray(header) ? header[0] : header) ?? PROJECT_ID;
    withActiveProject(String(projectId), () => done());
  });
  registerLean4Routes(instance);
  await instance.ready();
  return instance;
}

function exactModel(): ModelRequest {
  return {
    requested: {
      source: "fixed",
      provider: "ollama",
      model: "qwen3:32b",
      auth: { kind: "local" },
      reasoning: "high",
    },
    resolution: { mode: "exact" },
  };
}

function leanNode(overrides: Partial<Extract<WorkflowNode, { kind: "lean4" }>> = {}): WorkflowNode {
  return {
    id: "lean-proof",
    name: "Lean proof",
    kind: "lean4",
    terminal: true,
    workspace: { isolation: "read-only", writePaths: [] },
    goal: "Machine-check the reviewed theorem.",
    theorem: "theorem kady_reflexive (n : Nat) : n = n := rfl",
    mode: "verify",
    mathlib: true,
    skill: "byom-dag-fusion",
    ...overrides,
  } as WorkflowNode;
}

function workflow(nodes: WorkflowNode[]): WorkflowGraphDocument {
  return {
    schemaVersion: "1.0",
    id: "lean4-proof-workflow",
    name: "Lean 4 proof workflow",
    entryNodeId: nodes[0].id,
    defaultModel: exactModel(),
    limits: {
      maxIterations: 4,
      maxModelCalls: 4,
      maxParallelism: 1,
      maxSubagents: 1,
      timeoutMs: 60_000,
      maxTokens: 100_000,
      maxCostUsd: 1,
      maxRetries: 1,
    },
    rescue: { enabled: false, maxAttempts: 0, triggers: [] },
    // Common evidence evaluation is off so the run needs no model provider at
    // all; the runner's own trusted-Lean receipt rules still apply in full.
    evidence: {
      enabled: false,
      minimumIndependentSources: 0,
      requireArtifactReferences: false,
      onUnsupportedOutput: "fail",
    },
    nodes,
    edges: [],
  };
}

function writeSandboxFile(relativePath: string, contents: string): void {
  const absolute = path.join(resolvePaths(PROJECT_ID).sandbox, relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, contents);
}

function sha256(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

/**
 * A stand-in for `createTrustedLeanVerifier()` that does exactly what the real
 * one does on its host side: writes `Proof.lean` and `verification.log` to the
 * host-owned paths and returns a receipt carrying the pinned Mathlib identity.
 */
function trustedVerifierWriting(options: {
  proofPathOverride?: (directory: string) => string;
  logContents?: string;
  result?: Partial<TrustedLeanVerificationResult>;
}): { verify: TrustedLeanVerifier; requests: TrustedLeanVerificationRequest[] } {
  const requests: TrustedLeanVerificationRequest[] = [];
  const verify: TrustedLeanVerifier = (request) => {
    requests.push(request);
    const expected = trustedLeanArtifactPaths(request.runId, request.executionId);
    const proofPath = options.proofPathOverride
      ? options.proofPathOverride(expected.directory)
      : expected.proof;
    const logContents = options.logContents ?? VERIFICATION_LOG;
    writeSandboxFile(proofPath, PROOF_SOURCE);
    writeSandboxFile(expected.log, logContents);
    return {
      status: "verified",
      summary: "Lean accepted the reviewed theorem with no sorry and no extra axioms.",
      theoremName: "kady_reflexive",
      normalizedStatement: "theorem kady_reflexive (n : Nat) : n = n",
      executionPolicy: "unsandboxed-opt-in",
      toolchain: "leanprover/lean4:v4.19.0",
      mathlibRevision: MATHLIB_REVISION,
      mathlibTree: MATHLIB_TREE,
      assumptions: ["propext", "Classical.choice"],
      translationGaps: [],
      artifacts: [
        {
          path: proofPath,
          size: Buffer.byteLength(PROOF_SOURCE),
          sha256: sha256(PROOF_SOURCE),
          mediaType: "text/x-lean",
        },
        {
          path: expected.log,
          size: Buffer.byteLength(logContents),
          sha256: sha256(logContents),
          mediaType: "text/plain",
        },
      ],
      ...options.result,
    } satisfies TrustedLeanVerificationResult;
  };
  return { verify, requests };
}

/** Never called by a verify-mode Lean node: it makes zero model calls. */
const refuseUsage: KadyWorkflowUsageReserver = () => {
  throw new Error("A verify-mode Lean node must not reserve model usage.");
};

async function executeLeanRun(options: {
  requestId: string;
  node?: WorkflowNode;
  verifyLean: TrustedLeanVerifier;
  reserveUsage?: KadyWorkflowUsageReserver;
}): Promise<{ store: WorkflowStore; run: WorkflowRunRecord }> {
  const store = new WorkflowStore();
  const document = workflow([options.node ?? leanNode()]);
  store.saveDefinition(PROJECT_ID, document.id, document);
  const manifest = store.createRun(PROJECT_ID, {
    workflowId: document.id,
    requestId: options.requestId,
    requestedBy: "api",
    input: { goal: "Machine-check the reviewed theorem." },
  });
  await runWorkflowDag({
    projectId: PROJECT_ID,
    runId: manifest.id,
    store,
    executeNode: createKadyWorkflowNodeExecutor({
      reserveUsage: options.reserveUsage ?? refuseUsage,
      verifyLean: options.verifyLean,
    }),
  });
  const run = store.readRun(PROJECT_ID, manifest.id);
  if (!run) throw new Error("The executed run is unreadable.");
  return { store, run };
}

function inject(url: string) {
  return app.inject({ method: "GET", url, headers: { "x-project-id": PROJECT_ID } });
}

beforeEach(async () => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  if (!app) app = await buildLean4App();
});

afterAll(async () => {
  if (app) await app.close();
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
});

describe("Lean 4 proof artifact API", () => {
  it("serves the proof receipt a real Lean node execution produced, with its mathlib provenance", async () => {
    const verifier = trustedVerifierWriting({});
    const { run } = await executeLeanRun({
      requestId: "lean4-proof-success",
      verifyLean: verifier.verify,
    });

    // EFFECT 1 — the executor dispatched the trusted verifier with the authored
    // node parameters. Verify mode makes no model call and proposes no proof body.
    expect(verifier.requests).toHaveLength(1);
    expect(verifier.requests[0]).toMatchObject({
      projectId: PROJECT_ID,
      runId: run.manifest.id,
      workflowId: "lean4-proof-workflow",
      nodeId: "lean-proof",
      mode: "verify",
      theorem: "theorem kady_reflexive (n : Nat) : n = n := rfl",
      mathlib: true,
      skill: "byom-dag-fusion",
    });
    expect(verifier.requests[0].proofBody).toBeUndefined();

    // EFFECT 2 — the runner accepted exactly the two host-owned artifacts and
    // hashed the real bytes itself.
    expect(run.state.status).toBe("succeeded");
    const execution = Object.values(run.state.executions)[0];
    const expectedPaths = trustedLeanArtifactPaths(run.manifest.id, execution.executionId);
    expect(execution.artifacts.map((artifact) => artifact.path).sort()).toEqual(
      [expectedPaths.log, expectedPaths.proof].sort(),
    );
    expect(
      execution.artifacts.find((artifact) => artifact.path === expectedPaths.proof)?.sha256,
    ).toBe(sha256(PROOF_SOURCE));

    // EFFECT 3 — the endpoint hands a browser that receipt, provenance included.
    const response = await inject(`/lean4/runs/${run.manifest.id}/proofs`);
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json() as Lean4ProofListResponse;
    expect(body.runId).toBe(run.manifest.id);
    expect(body.runStatus).toBe("succeeded");
    expect(body.truncated).toBe(false);
    expect(body.proofs).toHaveLength(1);
    expect(body.proofs[0]).toMatchObject({
      nodeId: "lean-proof",
      nodeName: "Lean proof",
      executionId: execution.executionId,
      executionStatus: "succeeded",
      status: "verified",
      mode: "verify",
      mathlibRequested: true,
      theoremName: "kady_reflexive",
      normalizedStatement: "theorem kady_reflexive (n : Nat) : n = n",
      executionPolicy: "unsandboxed-opt-in",
      toolchain: "leanprover/lean4:v4.19.0",
      mathlibRevision: MATHLIB_REVISION,
      mathlibTree: MATHLIB_TREE,
      assumptions: ["propext", "Classical.choice"],
      translationGaps: [],
      proofPath: expectedPaths.proof,
      logPath: expectedPaths.log,
      provenanceGap: "none",
      error: null,
    });
    expect(body.proofs[0].artifacts).toEqual([
      {
        kind: "proof",
        path: expectedPaths.proof,
        size: Buffer.byteLength(PROOF_SOURCE),
        sha256: sha256(PROOF_SOURCE),
        mediaType: "text/x-lean",
      },
      {
        kind: "log",
        path: expectedPaths.log,
        size: Buffer.byteLength(VERIFICATION_LOG),
        sha256: sha256(VERIFICATION_LOG),
        mediaType: "text/plain",
      },
    ]);
  });

  it("serves the proof and log bytes the verifier actually wrote", async () => {
    const verifier = trustedVerifierWriting({});
    const { run } = await executeLeanRun({
      requestId: "lean4-proof-source",
      verifyLean: verifier.verify,
    });
    const executionId = Object.values(run.state.executions)[0].executionId;
    const expectedPaths = trustedLeanArtifactPaths(run.manifest.id, executionId);

    const proof = await inject(
      `/lean4/runs/${run.manifest.id}/proofs/${executionId}/source?artifact=proof`,
    );
    expect(proof.statusCode).toBe(200);
    const proofBody = proof.json() as Lean4ProofSourceResponse;
    expect(proofBody).toEqual({
      runId: run.manifest.id,
      executionId,
      artifact: "proof",
      path: expectedPaths.proof,
      size: Buffer.byteLength(PROOF_SOURCE),
      sha256: sha256(PROOF_SOURCE),
      truncated: false,
      text: PROOF_SOURCE,
    });

    const log = await inject(
      `/lean4/runs/${run.manifest.id}/proofs/${executionId}/source?artifact=log`,
    );
    expect(log.statusCode).toBe(200);
    expect((log.json() as Lean4ProofSourceResponse).text).toBe(VERIFICATION_LOG);

    // The default artifact is the proof, so the row's "proof artifact rendered"
    // needs no query parameter.
    const defaulted = await inject(
      `/lean4/runs/${run.manifest.id}/proofs/${executionId}/source`,
    );
    expect((defaulted.json() as Lean4ProofSourceResponse).artifact).toBe("proof");
  });

  it("refuses an untrusted artifact path end to end: the runner rejects it and nothing is served", async () => {
    const verifier = trustedVerifierWriting({
      proofPathOverride: (directory) => `${directory}/Proof-copy.lean`,
    });
    const { run } = await executeLeanRun({
      requestId: "lean4-proof-untrusted",
      verifyLean: verifier.verify,
    });

    // The runner refused the near-miss path outright — a `verified` verifier
    // receipt does not survive an artifact outside `isTrustedLeanArtifactPath`.
    expect(run.state.status).toBe("failed");
    const execution = Object.values(run.state.executions)[0];
    expect(execution.error?.code).toBe("UNDECLARED_NODE_ARTIFACT");

    const response = await inject(`/lean4/runs/${run.manifest.id}/proofs`);
    expect(response.statusCode).toBe(200);
    const body = response.json() as Lean4ProofListResponse;
    expect(body.proofs).toHaveLength(1);
    expect(body.proofs[0]).toMatchObject({
      executionStatus: "failed",
      status: null,
      artifacts: [],
      proofPath: null,
      logPath: null,
      provenanceGap: "discarded-on-failure",
    });
    expect(body.proofs[0].error?.code).toBe("UNDECLARED_NODE_ARTIFACT");

    const source = await inject(
      `/lean4/runs/${run.manifest.id}/proofs/${execution.executionId}/source`,
    );
    expect(source.statusCode).toBe(404);
    expect(source.json()).toEqual({
      code: "LEAN4_ARTIFACT_MISSING",
      detail: "No Lean artifact is stored for that execution.",
    });
  });

  it("drops an artifact reference that names a path outside the trusted pair", async () => {
    const verifier = trustedVerifierWriting({});
    const { run } = await executeLeanRun({
      requestId: "lean4-proof-projection-filter",
      verifyLean: verifier.verify,
    });
    const execution = Object.values(run.state.executions)[0];
    const expectedPaths = trustedLeanArtifactPaths(run.manifest.id, execution.executionId);

    // A doctored run record: the projection must refuse the path on its own,
    // without relying on the runner having refused it first.
    const doctored: WorkflowRunRecord = {
      manifest: run.manifest,
      state: {
        ...run.state,
        executions: {
          ...run.state.executions,
          [execution.executionId]: {
            ...execution,
            artifacts: [
              { ...execution.artifacts[0], path: `${expectedPaths.directory}/Proof-copy.lean` },
              { path: "user_data/Proof.lean", size: 10, sha256: "c".repeat(64) },
              execution.artifacts.find((artifact) => artifact.path === expectedPaths.log)!,
            ],
          },
        },
      },
    };
    const projected = projectLean4Proofs(doctored, PROJECT_ID);
    expect(projected.proofs[0].artifacts.map((artifact) => artifact.path)).toEqual([
      expectedPaths.log,
    ]);
    expect(projected.proofs[0].proofPath).toBeNull();
    expect(projected.proofs[0].logPath).toBe(expectedPaths.log);
  });

  it("truncates an oversized verification log and says so", async () => {
    const oversized = `${"lean stdout line\n".repeat(20_000)}`;
    expect(Buffer.byteLength(oversized)).toBeGreaterThan(LEAN4_SOURCE_MAX_BYTES);
    const verifier = trustedVerifierWriting({ logContents: oversized });
    const { run } = await executeLeanRun({
      requestId: "lean4-proof-truncation",
      verifyLean: verifier.verify,
    });
    const executionId = Object.values(run.state.executions)[0].executionId;

    const response = await inject(
      `/lean4/runs/${run.manifest.id}/proofs/${executionId}/source?artifact=log`,
    );
    expect(response.statusCode).toBe(200);
    const body = response.json() as Lean4ProofSourceResponse;
    expect(body.truncated).toBe(true);
    expect(body.size).toBe(Buffer.byteLength(oversized));
    expect(Buffer.byteLength(body.text)).toBe(LEAN4_SOURCE_MAX_BYTES);
    expect(oversized.startsWith(body.text)).toBe(true);
  });

  it("carries a rejected verification's provenance rather than hiding the failure", async () => {
    const verifier = trustedVerifierWriting({
      result: {
        status: "failed",
        summary: "Lean rejected the proof: unsolved goals.",
        assumptions: [],
        translationGaps: ["The informal statement quantified over reals, not naturals."],
      },
    });
    const { run } = await executeLeanRun({
      requestId: "lean4-proof-rejected",
      verifyLean: verifier.verify,
    });

    expect(run.state.status).toBe("failed");
    const body = (await inject(`/lean4/runs/${run.manifest.id}/proofs`))
      .json() as Lean4ProofListResponse;
    // FINDING (runner.ts, not this lane's file — see INTEGRATION.md §3): a
    // REJECTED Lean verification throws, so the runner lands on `node_failed`,
    // whose event data is `{error, routeCondition}` only. The executor's output
    // object — and with it `mathlibRevision`/`mathlibTree` — is never
    // persisted. The verdict survives through the node error code and the
    // `evidence_checked` summary, and the projection says so explicitly rather
    // than reporting the pin as "never reported".
    expect(body.proofs[0]).toMatchObject({
      status: "failed",
      mathlibRevision: null,
      mathlibTree: null,
      provenanceGap: "discarded-on-failure",
    });
    expect(body.proofs[0].error?.code).toBe("WORKFLOW_LEAN_VERIFICATION_FAILED");
    expect(body.proofs[0].summary).toContain("Lean rejected the proof: unsolved goals.");
    // The receipts themselves survive a rejection: a failed proof is still evidence.
    expect(body.proofs[0].proofPath).not.toBeNull();
    expect(body.proofs[0].logPath).not.toBeNull();
    const rejectedExecutionId = Object.values(run.state.executions)[0].executionId;
    const rejectedSource = await inject(
      `/lean4/runs/${run.manifest.id}/proofs/${rejectedExecutionId}/source`,
    );
    expect(rejectedSource.statusCode).toBe(200);
    expect((rejectedSource.json() as Lean4ProofSourceResponse).text).toBe(PROOF_SOURCE);
  });

  it("answers an empty list for a run with no Lean node, and 404 for an unknown run", async () => {
    const store = new WorkflowStore();
    const document = workflow([{
      id: "start",
      name: "Start",
      kind: "agent",
      terminal: true,
      workspace: { isolation: "read-only", writePaths: [] },
      prompt: "Return one bounded result.",
    } as WorkflowNode]);
    store.saveDefinition(PROJECT_ID, document.id, document);
    const manifest = store.createRun(PROJECT_ID, {
      workflowId: document.id,
      requestId: "lean4-proof-no-lean-node",
      requestedBy: "api",
      input: {},
    });

    const empty = await inject(`/lean4/runs/${manifest.id}/proofs`);
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toMatchObject({ proofs: [], truncated: false });

    const absentRunId = `wrun_${"0".repeat(32)}`;
    const missing = await inject(`/lean4/runs/${absentRunId}/proofs`);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({
      code: "LEAN4_RUN_NOT_FOUND",
      detail: `No such workflow run: ${absentRunId}`,
    });

    // A syntactically impossible run id is a bad request, not a missing one.
    const malformed = await inject("/lean4/runs/not-a-run-id/proofs");
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({
      code: "LEAN4_INVALID_REQUEST",
      detail: "The run id is not a canonical run id.",
    });
  });

  it("refuses a non-Lean execution, a bad artifact name, and leaks no filesystem path", async () => {
    const verifier = trustedVerifierWriting({});
    const { run } = await executeLeanRun({
      requestId: "lean4-proof-refusals",
      verifyLean: verifier.verify,
    });
    const executionId = Object.values(run.state.executions)[0].executionId;

    const unknownExecution = await inject(
      `/lean4/runs/${run.manifest.id}/proofs/exec_not_here/source`,
    );
    expect(unknownExecution.statusCode).toBe(404);
    expect(unknownExecution.json()).toEqual({
      code: "LEAN4_PROOF_NOT_FOUND",
      detail: "That execution is not a Lean node execution of this run.",
    });

    const badArtifact = await inject(
      `/lean4/runs/${run.manifest.id}/proofs/${executionId}/source?artifact=passwd`,
    );
    expect(badArtifact.statusCode).toBe(400);
    expect(badArtifact.json()).toEqual({
      code: "LEAN4_INVALID_REQUEST",
      detail: "artifact must be either proof or log.",
    });

    // #71 — no error body may name a filesystem location.
    const sandbox = resolvePaths(PROJECT_ID).sandbox;
    fs.rmSync(path.join(sandbox, "workflow_artifacts"), { recursive: true, force: true });
    const vanished = await inject(
      `/lean4/runs/${run.manifest.id}/proofs/${executionId}/source`,
    );
    expect(vanished.statusCode).toBe(404);
    for (const body of [unknownExecution.body, badArtifact.body, vanished.body]) {
      expect(body).not.toContain(sandbox);
      expect(body).not.toContain(PROJECTS_ROOT);
      expect(body).not.toContain("ENOENT");
      expect(body).not.toContain("/Users/");
    }
  });

  it("refuses a symlinked artifact path and a file the run never accepted", async () => {
    const verifier = trustedVerifierWriting({});
    const { run } = await executeLeanRun({
      requestId: "lean4-proof-symlink",
      verifyLean: verifier.verify,
    });
    const executionId = Object.values(run.state.executions)[0].executionId;
    const expected = trustedLeanArtifactPaths(run.manifest.id, executionId);
    const sandbox = resolvePaths(PROJECT_ID).sandbox;
    const proofAbsolute = path.join(sandbox, expected.proof);

    // The sandbox is user-writable (uploads, PUT /sandbox/file), so a trusted
    // NAME does not bound what the name resolves to. Replace the accepted proof
    // with a link to a file outside the sandbox.
    const outsideTarget = path.join(PROJECTS_ROOT, "outside-the-sandbox.txt");
    fs.writeFileSync(outsideTarget, "this must never be served\n");
    fs.rmSync(proofAbsolute);
    fs.symlinkSync(outsideTarget, proofAbsolute);

    const linked = await inject(
      `/lean4/runs/${run.manifest.id}/proofs/${executionId}/source?artifact=proof`,
    );
    expect(linked.statusCode).toBe(403);
    expect(linked.json()).toEqual({
      code: "LEAN4_ARTIFACT_UNTRUSTED",
      detail: "That artifact path passes through a symbolic link and is not trusted.",
    });
    expect(linked.body).not.toContain("this must never be served");
    expect(linked.body).not.toContain(sandbox);

    // And a real file sitting at a trusted path that the run never accepted a
    // receipt for is not this run's evidence either.
    const { run: emptyRun } = await executeLeanRun({
      requestId: "lean4-proof-unaccepted",
      verifyLean: trustedVerifierWriting({
        proofPathOverride: (directory) => `${directory}/Proof-copy.lean`,
      }).verify,
    });
    const emptyExecutionId = Object.values(emptyRun.state.executions)[0].executionId;
    const emptyExpected = trustedLeanArtifactPaths(emptyRun.manifest.id, emptyExecutionId);
    writeSandboxFile(emptyExpected.proof, "theorem planted : True := trivial\n");
    const unaccepted = await inject(
      `/lean4/runs/${emptyRun.manifest.id}/proofs/${emptyExecutionId}/source?artifact=proof`,
    );
    expect(unaccepted.statusCode).toBe(404);
    expect(unaccepted.json()).toEqual({
      code: "LEAN4_ARTIFACT_MISSING",
      detail: "No Lean artifact is stored for that execution.",
    });
    expect(unaccepted.body).not.toContain("planted");
  });

  it("never reserves model usage for a verify-mode Lean node", async () => {
    const reserveUsage = vi.fn<KadyWorkflowUsageReserver>(() => ({ reconcile() {} }));
    const verifier = trustedVerifierWriting({});
    const { run } = await executeLeanRun({
      requestId: "lean4-proof-no-model-call",
      verifyLean: verifier.verify,
      reserveUsage,
    });
    expect(run.state.status).toBe("succeeded");
    expect(reserveUsage).not.toHaveBeenCalled();
  });
});
