import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectPaths } from "../src/projects.ts";
import type { TrustedLeanVerificationRequest } from "../src/workflows/kady-node-executor.ts";
import {
  createTrustedLeanVerifier,
  inspectPinnedMathlibCheckout,
  leanVerifierChildEnvironment,
} from "../src/workflows/lean4-verifier.ts";
import { trustedLeanArtifactPaths } from "../src/workflows/lean4-artifacts.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kady-lean-host-"));
  temporaryDirectories.push(directory);
  return directory;
}

function fixture(options?: {
  script?: string;
  createLakeProject?: boolean;
  axiomReceipts?: string[];
}): {
  request: TrustedLeanVerificationRequest;
  verifierScript: string;
  sandbox: string;
  mathlibRevision?: string;
  mathlibTree?: string;
} {
  const root = temporaryDirectory();
  const sandbox = path.join(root, "sandbox");
  const workflowRunsDir = path.join(sandbox, ".kady", "workflows", "runs");
  fs.mkdirSync(sandbox, { recursive: true });
  let mathlibRevision: string | undefined;
  let mathlibTree: string | undefined;
  const lakeProject = path.join(sandbox, "lean-project");
  if (options?.createLakeProject !== false) {
    const mathlib = path.join(lakeProject, ".lake", "packages", "mathlib");
    fs.mkdirSync(mathlib, { recursive: true });
    fs.writeFileSync(path.join(mathlib, "Mathlib.lean"), "def kadyFixture : Nat := 1\n");
    for (const args of [
      ["init", "--quiet"],
      ["config", "user.email", "kady-test@example.invalid"],
      ["config", "user.name", "Kady Test"],
      ["add", "Mathlib.lean"],
      ["commit", "--quiet", "-m", "fixture"],
    ]) {
      const result = spawnSync("git", args, { cwd: mathlib, encoding: "utf8" });
      if (result.status !== 0) throw new Error(`git fixture failed: ${result.stderr}`);
    }
    mathlibRevision = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: mathlib,
      encoding: "utf8",
    }).stdout.trim();
    mathlibTree = spawnSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: mathlib,
      encoding: "utf8",
    }).stdout.trim();
    const detach = spawnSync("git", ["checkout", "--quiet", "--detach", mathlibRevision], {
      cwd: mathlib,
      encoding: "utf8",
    });
    if (detach.status !== 0) throw new Error(`git detach failed: ${detach.stderr}`);
    fs.writeFileSync(
      path.join(lakeProject, "lake-manifest.json"),
      JSON.stringify({
        packages: [{
          name: "mathlib",
          type: "git",
          url: "https://github.com/leanprover-community/mathlib4.git",
          rev: mathlibRevision,
        }],
      }),
    );
  }
  const verifierScript = path.join(root, "fake-verifier.mjs");
  fs.writeFileSync(
    verifierScript,
    options?.script ?? [
      "process.stdout.write('byom-dag-fusion: toolchain=leanprover/lean4:v4.32.2\\n');",
      `process.stdout.write('byom-dag-fusion: mathlib_revision=${mathlibRevision}\\n');`,
      ...(options?.axiomReceipts ?? ["none"]).map((receipt) =>
        `process.stdout.write('byom-dag-fusion: allowed_axioms=${receipt}\\n');`
      ),
    ].join("\n"),
    { mode: 0o600 },
  );
  const paths = {
    id: "project",
    sandbox,
    workflowRunsDir,
  } as ProjectPaths;
  return {
    verifierScript,
    sandbox,
    request: {
      projectId: "project",
      runId: "run_1",
      workflowId: "workflow",
      nodeId: "prove",
      executionId: "dagx_prove_1",
      goal: "Prove addition by zero.",
      mode: "verify",
      theorem: "theorem add_zero_kady (n : Nat) : n + 0 = n := by simp\n",
      mathlib: false,
      skill: "byom-dag-fusion",
      paths,
      signal: new AbortController().signal,
    },
    mathlibRevision,
    mathlibTree,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("trusted Lean 4 workflow verifier", () => {
  it("returns exact visible host-managed artifacts and pinned tree identity", async () => {
    const setup = fixture();
    const verify = createTrustedLeanVerifier({
      verifierScriptPath: setup.verifierScript,
      executionPolicy: "unsandboxed-opt-in",
    });

    const result = await verify(setup.request);

    expect(result).toMatchObject({
      status: "verified",
      theoremName: "add_zero_kady",
      toolchain: "leanprover/lean4:v4.32.2",
      mathlibRevision: setup.mathlibRevision,
      mathlibTree: setup.mathlibTree,
      executionPolicy: "unsandboxed-opt-in",
      assumptions: [],
    });
    const expectedArtifacts = trustedLeanArtifactPaths("run_1", "dagx_prove_1");
    expect(result.artifacts?.map((artifact) => artifact.path)).toEqual([
      expectedArtifacts.proof,
      expectedArtifacts.log,
    ]);
    expect(fs.readFileSync(path.join(setup.sandbox, expectedArtifacts.proof), "utf8"))
      .toContain("theorem add_zero_kady");
    expect(fs.readFileSync(path.join(setup.sandbox, expectedArtifacts.log), "utf8"))
      .toContain("execution_id=dagx_prove_1");
  });

  it("fails visibly without weakening a missing pinned Lake project", async () => {
    const setup = fixture({ createLakeProject: false });
    const verify = createTrustedLeanVerifier({
      verifierScriptPath: setup.verifierScript,
      executionPolicy: "unsandboxed-opt-in",
    });

    const result = await verify(setup.request);

    expect(result.status).toBe("unavailable");
    expect(result.summary).toContain("Pinned Lake project lean-project is missing");
    expect(result.summary).toContain("did not install or update Lean");
    expect(fs.existsSync(path.join(setup.sandbox, "workflow_artifacts"))).toBe(false);
  });

  it("maps formal admission rejection to a failed proof", async () => {
    const setup = fixture({
      script: "process.stderr.write('forbidden token sorry\\n'); process.exit(65);",
    });
    const verify = createTrustedLeanVerifier({
      verifierScriptPath: setup.verifierScript,
      executionPolicy: "unsandboxed-opt-in",
    });

    const result = await verify(setup.request);

    expect(result).toMatchObject({ status: "failed", theoremName: "add_zero_kady" });
    expect(result.summary).toContain("forbidden token sorry");
  });

  it("rejects a zero exit that omits the toolchain receipt", async () => {
    const setup = fixture({ script: "process.stdout.write('not a receipt\\n');" });
    const verify = createTrustedLeanVerifier({
      verifierScriptPath: setup.verifierScript,
      executionPolicy: "unsandboxed-opt-in",
    });

    const result = await verify(setup.request);

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("matching toolchain receipt");
  });

  it("persists the verifier's unique allowed-axiom receipt", async () => {
    const setup = fixture({
      axiomReceipts: ["propext,Classical.choice,Quot.sound"],
    });
    const verify = createTrustedLeanVerifier({
      verifierScriptPath: setup.verifierScript,
      executionPolicy: "unsandboxed-opt-in",
    });

    const result = await verify(setup.request);

    expect(result).toMatchObject({
      status: "verified",
      assumptions: ["propext", "Classical.choice", "Quot.sound"],
    });
  });

  it.each([
    ["missing", []],
    ["duplicate", ["none", "none"]],
    ["unsupported", ["propext,False.elim"]],
    ["malformed", ["propext, Classical.choice"]],
  ])("rejects a %s allowed-axiom receipt", async (_label, axiomReceipts) => {
    const setup = fixture({ axiomReceipts });
    const verify = createTrustedLeanVerifier({
      verifierScriptPath: setup.verifierScript,
      executionPolicy: "unsandboxed-opt-in",
    });

    const result = await verify(setup.request);

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("unique valid allowed-axiom receipt");
    expect(result.assumptions).toBeUndefined();
  });

  it("kills and rejects the verifier process when the node is cancelled", async () => {
    const setup = fixture({ script: "setInterval(() => {}, 1000);" });
    const abortController = new AbortController();
    setup.request.signal = abortController.signal;
    const verify = createTrustedLeanVerifier({
      verifierScriptPath: setup.verifierScript,
      timeoutMs: 5_000,
      executionPolicy: "unsandboxed-opt-in",
    });

    const pending = verify(setup.request);
    setTimeout(() => abortController.abort(new Error("run cancelled")), 25);

    await expect(pending).rejects.toThrow("run cancelled");
  });

  it("does not allow the host-managed proof path to traverse a symlink", async () => {
    const setup = fixture();
    const outside = path.join(path.dirname(setup.sandbox), "outside");
    fs.mkdirSync(outside);
    fs.mkdirSync(path.join(setup.sandbox, "workflow_artifacts"));
    fs.symlinkSync(outside, path.join(setup.sandbox, "workflow_artifacts", "dag-workflows"));
    const verify = createTrustedLeanVerifier({
      verifierScriptPath: setup.verifierScript,
      executionPolicy: "unsandboxed-opt-in",
    });

    const result = await verify(setup.request);

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("could not be preserved safely");
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("is disabled by default until the server owner explicitly opts in", async () => {
    const setup = fixture({ createLakeProject: false });
    const verify = createTrustedLeanVerifier({ verifierScriptPath: setup.verifierScript });

    await expect(verify.preflight?.(setup.request)).resolves.toMatchObject({
      status: "unavailable",
      executionPolicy: "disabled",
      summary: expect.stringContaining("KADY_ALLOW_UNSANDBOXED_LEAN=1"),
    });
    const result = await verify(setup.request);
    expect(result).toMatchObject({ status: "unavailable", executionPolicy: "disabled" });
    expect(fs.existsSync(path.join(setup.sandbox, "workflow_artifacts"))).toBe(false);
  });

  it("constructs a solve declaration from the exact proposition and proof body only", async () => {
    const setup = fixture();
    setup.request.mode = "solve";
    setup.request.theorem = "∀ n : Nat, n + 0 = n";
    setup.request.proofBody = "simpa using Nat.add_zero n";
    setup.request.mathlib = true;
    const verify = createTrustedLeanVerifier({
      verifierScriptPath: setup.verifierScript,
      executionPolicy: "unsandboxed-opt-in",
    });

    const result = await verify(setup.request);

    expect(result).toMatchObject({
      status: "verified",
      normalizedStatement: "∀ n : Nat, n + 0 = n",
      theoremName: expect.stringMatching(/^kady_dag_[a-f0-9]{24}$/),
    });
    const source = fs.readFileSync(
      path.join(setup.sandbox, trustedLeanArtifactPaths("run_1", "dagx_prove_1").proof),
      "utf8",
    );
    expect(source).toContain(`theorem ${result.theoremName} : ∀ n : Nat, n + 0 = n := by`);
    expect(source).toContain("  simpa using Nat.add_zero n");
  });

  it("cannot relabel a proof of True as the requested nontrivial proposition", async () => {
    const setup = fixture({
      script: [
        "import fs from 'node:fs';",
        "const source = fs.readFileSync(process.argv[2], 'utf8');",
        "if (!source.includes(': 1 = 2 := by') || !source.includes('exact True.intro')) process.exit(70);",
        "process.stderr.write('type mismatch: True.intro does not prove 1 = 2\\n');",
        "process.exit(65);",
      ].join("\n"),
    });
    setup.request.mode = "solve";
    setup.request.theorem = "1 = 2";
    setup.request.proofBody = "exact True.intro";
    const verify = createTrustedLeanVerifier({
      verifierScriptPath: setup.verifierScript,
      executionPolicy: "unsandboxed-opt-in",
    });

    const result = await verify(setup.request);

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("does not prove 1 = 2");
    expect(result.normalizedStatement).toBeUndefined();
  });

  it("rejects a dirty pinned Mathlib checkout", () => {
    const setup = fixture();
    const lakeProject = path.join(setup.sandbox, "lean-project");
    expect(inspectPinnedMathlibCheckout(lakeProject)).toMatchObject({
      revision: setup.mathlibRevision,
      tree: setup.mathlibTree,
    });
    fs.appendFileSync(
      path.join(lakeProject, ".lake", "packages", "mathlib", "Mathlib.lean"),
      "def dirtyMutation : Nat := 2\n",
    );

    expect(() => inspectPinnedMathlibCheckout(lakeProject)).toThrow(/dirty/i);
  });

  it("passes only an explicit non-secret environment allowlist to the verifier child", () => {
    const environment = leanVerifierChildEnvironment(12_345, {
      PATH: "/trusted/bin",
      LANG: "C.UTF-8",
      OPENROUTER_API_KEY: "secret-openrouter",
      ANTHROPIC_API_KEY: "secret-anthropic",
      NODE_OPTIONS: "--require=attacker.js",
      KADY_ALLOW_UNSANDBOXED_LEAN: "1",
    });

    expect(environment).toEqual({
      PATH: "/trusted/bin",
      LANG: "C.UTF-8",
      BYOM_DAG_FUSION_TIMEOUT_MS: "12345",
    });
  });
});
