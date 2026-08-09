import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import { resolvePaths } from "../src/projects.ts";
import {
  WorkflowDagNodeError,
  WorkflowStore,
  runWorkflowDag,
  workflowRunFiles,
  workflowNodeExecutionId,
  type ModelRequest,
  type RescuePolicy,
  type WorkflowGraphDocument,
  type WorkflowModelResolutionReceipt,
  type WorkflowNode,
  type WorkflowNodeExecutor,
  type WorkflowNodeExecutorResult,
} from "../src/workflows/index.ts";
import { trustedLeanArtifactPaths } from "../src/workflows/lean4-artifacts.ts";

const PROJECT_ID = "workflow-runner-test";

const disabledRescue: RescuePolicy = {
  enabled: false,
  maxAttempts: 0,
  triggers: [],
};

const failureRescue: RescuePolicy = {
  enabled: true,
  maxAttempts: 2,
  triggers: ["failure"],
};

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

function modelReceipt(): WorkflowModelResolutionReceipt {
  return {
    request: exactModel(),
    resolved: {
      provider: "ollama",
      model: "qwen3:32b",
      auth: { kind: "local" },
      reasoning: "high",
      runtime: "local",
    },
    fallbackUsed: false,
  };
}

function completeAgentNode(
  context: Parameters<WorkflowNodeExecutor>[0],
  result: WorkflowNodeExecutorResult = {},
): WorkflowNodeExecutorResult {
  context.recordModelResolution("agent", modelReceipt());
  return result;
}

function agentNode(id: string, terminal: boolean): WorkflowNode {
  return {
    id,
    name: id,
    kind: "agent",
    terminal,
    workspace: { isolation: "read-only", writePaths: [] },
    prompt: `Execute ${id}.`,
  };
}

function workflow(
  nodes: WorkflowNode[],
  edges: WorkflowGraphDocument["edges"],
  options: {
    entryNodeId?: string;
    maxParallelism?: number;
    rescue?: RescuePolicy;
  } = {},
): WorkflowGraphDocument {
  return {
    schemaVersion: "1.0",
    id: "runner-workflow",
    name: "Runner workflow",
    entryNodeId: options.entryNodeId ?? nodes[0].id,
    defaultModel: exactModel(),
    limits: {
      maxIterations: 20,
      maxModelCalls: 100,
      maxParallelism: options.maxParallelism ?? 4,
      maxSubagents: 16,
      timeoutMs: 60_000,
      maxTokens: 1_000_000,
      maxCostUsd: 10,
      maxRetries: 3,
    },
    rescue: options.rescue ?? disabledRescue,
    evidence: {
      enabled: false,
      minimumIndependentSources: 0,
      requireArtifactReferences: false,
      onUnsupportedOutput: "fail",
    },
    nodes,
    edges,
  };
}

function createRun(
  store: WorkflowStore,
  document: WorkflowGraphDocument,
  requestId: string,
) {
  store.saveDefinition(PROJECT_ID, document.id, document);
  return store.createRun(PROJECT_ID, {
    workflowId: document.id,
    requestId,
    requestedBy: "api",
    input: { goal: "Exercise the durable runner." },
  });
}

function resetProjects(): void {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    signal.addEventListener("abort", () => reject(new Error("aborted")), {
      once: true,
    });
  });
}

beforeEach(resetProjects);
afterAll(() => fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }));

describe("durable workflow DAG runner", () => {
  it("executes a linear graph and writes an authoritative event trace", async () => {
    const store = new WorkflowStore();
    const document = workflow(
      [agentNode("start", false), agentNode("finish", true)],
      [{ id: "start-finish", from: "start", to: "finish" }],
    );
    const manifest = createRun(store, document, "linear");
    const calls: string[] = [];

    const result = await runWorkflowDag({
      projectId: PROJECT_ID,
      runId: manifest.id,
      store,
      executeNode: (context) => {
        const { node } = context;
        calls.push(node.id);
        return completeAgentNode(
          context,
          node.id === "start" ? { output: { result: "bounded" } } : { output: "done" },
        );
      },
    });

    expect(result.state.status).toBe("succeeded");
    expect(calls).toEqual(["start", "finish"]);
    expect(store.readRunEvents(PROJECT_ID, manifest.id, { limit: 100 }).events.map(
      (event) => event.type,
    )).toEqual([
      "run_queued",
      "run_started",
      "node_started",
      "model_call_declared",
      "model_resolved",
      "node_succeeded",
      "node_started",
      "model_call_declared",
      "model_resolved",
      "node_succeeded",
      "run_succeeded",
    ]);
    expect(Object.values(result.state.executions)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: "start", status: "succeeded" }),
        expect.objectContaining({ nodeId: "finish", status: "succeeded" }),
      ]),
    );
  });

  it("persists the verified personality commit and digest in the durable run stream", async () => {
    const store = new WorkflowStore();
    const node: WorkflowNode = {
      id: "deliberate",
      name: "Deliberate",
      kind: "council",
      terminal: true,
      workspace: { isolation: "read-only", writePaths: [] },
      goal: "Audit genome evidence.",
      members: [
        { id: "reviewer", role: "Reviewer", model: exactModel() },
        { id: "auditor", role: "Evidence auditor", model: exactModel() },
      ],
      chair: exactModel(),
      rounds: 1,
      preserveMinorityReports: true,
      settings: {
        deliberation: {
          personalityStoreRef: "scientific-agents/v1",
          bestOfNPersonalityCount: 1,
          mimeographs: { mode: "auto", personalityRefs: [] },
        },
      },
    };
    const document = workflow([node], []);
    const manifest = createRun(store, document, "durable-deliberation-staffing");
    const storeDigest = "d".repeat(64);
    const revision = "a".repeat(40);

    const result = await runWorkflowDag({
      projectId: PROJECT_ID,
      runId: manifest.id,
      store,
      executeNode: (context) => {
        context.recordDeliberationStaffingReceipt?.({
          storeRef: "scientific-agents/v1",
          source: "ahuserious/scientific-agents",
          revision,
          storeDigest,
          selectedPersonalityRefs: ["genomics"],
          effectivePromptSha256: "e".repeat(64),
        });
        for (const slot of context.expectedModelCallSlots) {
          context.recordModelResolution(slot.id, {
            ...modelReceipt(),
            request: structuredClone(slot.request),
          });
        }
        return { output: "done" };
      },
    });

    const staffingEvent = store.readRunEvents(PROJECT_ID, manifest.id, { limit: 100 }).events.find(
      (event) => event.type === "deliberation_staffing_bound",
    );
    expect(result.state.status).toBe("succeeded");
    expect(staffingEvent?.data?.deliberationStaffingReceipt).toMatchObject({
      revision,
      storeDigest,
      selectedPersonalityRefs: ["genomics"],
    });
    expect(Object.values(result.state.executions)[0]?.deliberationStaffingReceipt).toMatchObject({
      revision,
      storeDigest,
    });
  });

  it("honours explicit fan-out and graph maxParallelism", async () => {
    const store = new WorkflowStore();
    const document = workflow(
      [
        agentNode("root", false),
        agentNode("alpha", true),
        agentNode("beta", true),
        agentNode("gamma", true),
      ],
      [
        { id: "root-alpha", from: "root", to: "alpha" },
        { id: "root-beta", from: "root", to: "beta" },
        { id: "root-gamma", from: "root", to: "gamma" },
      ],
      { maxParallelism: 2 },
    );
    const manifest = createRun(store, document, "parallel");
    let concurrent = 0;
    let maximumConcurrent = 0;
    const calls = new Map<string, number>();

    const result = await runWorkflowDag({
      projectId: PROJECT_ID,
      runId: manifest.id,
      store,
      executeNode: async (context) => {
        const { node } = context;
        calls.set(node.id, (calls.get(node.id) ?? 0) + 1);
        if (node.id === "root") return completeAgentNode(context);
        concurrent += 1;
        maximumConcurrent = Math.max(maximumConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 15));
        concurrent -= 1;
        return completeAgentNode(context);
      },
    });

    expect(result.state.status).toBe("succeeded");
    expect(maximumConcurrent).toBe(2);
    expect(Object.fromEntries(calls)).toEqual({ root: 1, alpha: 1, beta: 1, gamma: 1 });
  });

  it("runs an any-ready fan-in node once on its first activated edge", async () => {
    const store = new WorkflowStore();
    const document = workflow(
      [
        agentNode("root", false),
        agentNode("left", false),
        agentNode("right", false),
        agentNode("merge", true),
      ],
      [
        { id: "root-left", from: "root", to: "left" },
        { id: "root-right", from: "root", to: "right" },
        { id: "left-merge", from: "left", to: "merge" },
        { id: "right-merge", from: "right", to: "merge" },
      ],
      { maxParallelism: 3 },
    );
    const manifest = createRun(store, document, "any-ready");
    const counts = new Map<string, number>();
    let mergeInbound: string[] = [];

    const result = await runWorkflowDag({
      projectId: PROJECT_ID,
      runId: manifest.id,
      store,
      executeNode: async (context) => {
        const { node, inbound } = context;
        counts.set(node.id, (counts.get(node.id) ?? 0) + 1);
        if (node.id === "left") await new Promise((resolve) => setTimeout(resolve, 5));
        if (node.id === "right") await new Promise((resolve) => setTimeout(resolve, 30));
        if (node.id === "merge") mergeInbound = inbound.map((item) => item.fromNodeId);
        return completeAgentNode(context, { output: node.id });
      },
    });

    expect(result.state.status).toBe("succeeded");
    expect(counts.get("merge")).toBe(1);
    expect(mergeInbound).toEqual(["left"]);
  });

  it("follows a failure route after rescue is disabled", async () => {
    const store = new WorkflowStore();
    const document = workflow(
      [agentNode("start", false), agentNode("success", true), agentNode("fallback", true)],
      [
        { id: "start-success", from: "start", to: "success", condition: "success" },
        { id: "start-fallback", from: "start", to: "fallback", condition: "failure" },
      ],
    );
    const manifest = createRun(store, document, "failure-route");
    const calls: string[] = [];

    const result = await runWorkflowDag({
      projectId: PROJECT_ID,
      runId: manifest.id,
      store,
      executeNode: (context) => {
        const { node } = context;
        calls.push(node.id);
        if (node.id === "start") {
          throw new WorkflowDagNodeError("primary path failed", "PRIMARY_FAILED", true);
        }
        return completeAgentNode(context);
      },
    });

    expect(result.state.status).toBe("succeeded");
    expect(calls).toEqual(["start", "fallback"]);
    expect(Object.values(result.state.executions)).toContainEqual(
      expect.objectContaining({ nodeId: "start", status: "failed" }),
    );
  });

  it.each([
    { supported: true, expected: "supported" },
    { supported: false, expected: "unsupported" },
  ])("routes an evidence gate when supported=$supported", async ({ supported, expected }) => {
    const store = new WorkflowStore();
    const gate: WorkflowNode = {
      id: "gate",
      name: "gate",
      kind: "evidence-gate",
      terminal: false,
      workspace: { isolation: "read-only", writePaths: [] },
      checks: ["claim-support"],
      artifactIds: [],
      onUnsupportedOutput: "route",
    };
    const document = workflow(
      [gate, agentNode("supported", true), agentNode("unsupported", true)],
      [
        {
          id: "gate-supported",
          from: "gate",
          to: "supported",
          condition: "evidence-supported",
        },
        {
          id: "gate-unsupported",
          from: "gate",
          to: "unsupported",
          condition: "evidence-unsupported",
        },
      ],
    );
    const manifest = createRun(store, document, `gate-${String(supported)}`);
    const calls: string[] = [];

    const result = await runWorkflowDag({
      projectId: PROJECT_ID,
      runId: manifest.id,
      store,
      executeNode: (context) => {
        const { node } = context;
        calls.push(node.id);
        if (node.id === "gate") {
          context.recordModelResolution("evidence-evaluator", modelReceipt());
          return {
            evidence: {
              supported,
              summary: "bounded decision",
              sourceIds: [],
              artifacts: [],
            },
          };
        }
        return completeAgentNode(context);
      },
    });

    expect(result.state.status).toBe("succeeded");
    expect(calls).toEqual(["gate", expected]);
    const gateEvent = store.readRunEvents(PROJECT_ID, manifest.id, { limit: 100 }).events.find(
      (event) => event.type === "gate_evaluated",
    );
    expect(gateEvent?.data).toMatchObject({ supported });
  });

  it("turns an invented evidence source id into a durable unsupported route", async () => {
    const store = new WorkflowStore();
    const gate: WorkflowNode = {
      id: "gate",
      name: "gate",
      kind: "evidence-gate",
      terminal: false,
      workspace: { isolation: "read-only", writePaths: [] },
      checks: ["claim-support"],
      artifactIds: [],
      evidence: {
        enabled: true,
        minimumIndependentSources: 1,
        requireArtifactReferences: false,
        onUnsupportedOutput: "route",
      },
      onUnsupportedOutput: "route",
    };
    const document = workflow(
      [agentNode("writer", false), gate, agentNode("supported", true), agentNode("unsupported", true)],
      [
        { id: "writer-gate", from: "writer", to: "gate" },
        { id: "gate-supported", from: "gate", to: "supported", condition: "evidence-supported" },
        { id: "gate-unsupported", from: "gate", to: "unsupported", condition: "evidence-unsupported" },
      ],
    );
    const manifest = createRun(store, document, "invented-gate-source");
    const calls: string[] = [];

    const result = await runWorkflowDag({
      projectId: PROJECT_ID,
      runId: manifest.id,
      store,
      executeNode: (context) => {
        calls.push(context.node.id);
        if (context.node.id === "writer") {
          return completeAgentNode(context, {
            output: { evidence: ["doi:10.1/observed"] },
          });
        }
        if (context.node.id === "gate") {
          context.recordModelResolution("evidence-evaluator", modelReceipt());
          return {
            evidence: {
              supported: true,
              summary: "The evaluator invented an id.",
              sourceIds: ["source-999"],
              artifacts: [],
            },
          };
        }
        return completeAgentNode(context);
      },
    });

    expect(result.state.status).toBe("succeeded");
    expect(calls).toEqual(["writer", "gate", "unsupported"]);
    const events = store.readRunEvents(PROJECT_ID, manifest.id, { limit: 100 }).events;
    expect(events.find((event) => event.type === "gate_evaluated")).toMatchObject({
      data: {
        supported: false,
        sourceIds: [],
        artifacts: [],
        summary: expect.stringContaining("outside the observed source catalog"),
      },
    });
  });

  it("does not let a gate's model output create its own trusted source receipt", async () => {
    const store = new WorkflowStore();
    const gate: WorkflowNode = {
      id: "gate",
      name: "gate",
      kind: "evidence-gate",
      terminal: false,
      workspace: { isolation: "read-only", writePaths: [] },
      checks: ["claim-support"],
      artifactIds: [],
      evidence: {
        enabled: true,
        minimumIndependentSources: 1,
        requireArtifactReferences: false,
        onUnsupportedOutput: "route",
      },
      onUnsupportedOutput: "route",
    };
    const document = workflow(
      [gate, agentNode("supported", true), agentNode("unsupported", true)],
      [
        { id: "gate-supported", from: "gate", to: "supported", condition: "evidence-supported" },
        { id: "gate-unsupported", from: "gate", to: "unsupported", condition: "evidence-unsupported" },
      ],
    );
    const manifest = createRun(store, document, "self-authored-gate-source");

    const result = await runWorkflowDag({
      projectId: PROJECT_ID,
      runId: manifest.id,
      store,
      executeNode: (context) => {
        if (context.node.id !== "gate") return completeAgentNode(context);
        context.recordModelResolution("evidence-evaluator", modelReceipt());
        return {
          output: { evidence: ["model-authored support"] },
          evidence: {
            supported: true,
            summary: "The model cited its own output.",
            sourceIds: ["source-001"],
            artifacts: [],
          },
        };
      },
    });

    expect(result.state.status).toBe("succeeded");
    expect(Object.values(result.state.executions)).toContainEqual(
      expect.objectContaining({ nodeId: "unsupported", status: "succeeded" }),
    );
    expect(store.readRunEvents(PROJECT_ID, manifest.id, { limit: 100 }).events.find(
      (event) => event.type === "gate_evaluated",
    )).toMatchObject({ data: { supported: false, sourceIds: [] } });
  });

  it("persists an unsupported gate decision before failing the node", async () => {
    const store = new WorkflowStore();
    const gate: WorkflowNode = {
      id: "gate",
      name: "gate",
      kind: "evidence-gate",
      terminal: false,
      workspace: { isolation: "read-only", writePaths: [] },
      checks: ["claim-support"],
      artifactIds: [],
      onUnsupportedOutput: "fail",
    };
    const document = workflow(
      [gate, agentNode("supported", true)],
      [{ id: "gate-supported", from: "gate", to: "supported", condition: "evidence-supported" }],
    );
    const manifest = createRun(store, document, "gate-event-before-fail");

    const result = await runWorkflowDag({
      projectId: PROJECT_ID,
      runId: manifest.id,
      store,
      executeNode: (context) => {
        if (context.node.id !== "gate") return completeAgentNode(context);
        context.recordModelResolution("evidence-evaluator", modelReceipt());
        return {
          evidence: {
            supported: false,
            summary: "Unsupported after evaluation.",
            sourceIds: [],
            artifacts: [],
          },
        };
      },
    });

    expect(result.state.status).toBe("failed");
    const events = store.readRunEvents(PROJECT_ID, manifest.id, { limit: 100 }).events;
    const decisionIndex = events.findIndex((event) => event.type === "gate_evaluated");
    const failureIndex = events.findIndex((event) => event.type === "node_failed");
    expect(decisionIndex).toBeGreaterThan(-1);
    expect(failureIndex).toBeGreaterThan(decisionIndex);
    expect(events[failureIndex]).toMatchObject({
      data: { error: { code: "EVIDENCE_UNSUPPORTED" } },
    });
  });

  it("persists an unsupported gate decision before rescue starts", async () => {
    const store = new WorkflowStore();
    const rescue: RescuePolicy = {
      enabled: true,
      maxAttempts: 1,
      triggers: ["unsupported-output"],
    };
    const gate: WorkflowNode = {
      id: "gate",
      name: "gate",
      kind: "evidence-gate",
      terminal: false,
      workspace: { isolation: "read-only", writePaths: [] },
      checks: ["claim-support"],
      artifactIds: [],
      onUnsupportedOutput: "rescue",
    };
    const document = workflow(
      [gate, agentNode("supported", true)],
      [{ id: "gate-supported", from: "gate", to: "supported", condition: "evidence-supported" }],
      { rescue },
    );
    const manifest = createRun(store, document, "gate-event-before-rescue");

    const result = await runWorkflowDag({
      projectId: PROJECT_ID,
      runId: manifest.id,
      store,
      executeNode: (context) => {
        if (context.node.id !== "gate") return completeAgentNode(context);
        context.recordModelResolution("evidence-evaluator", modelReceipt());
        return {
          evidence: {
            supported: context.attempt === 2,
            summary: context.attempt === 2 ? "Recovered support." : "Needs rescue.",
            sourceIds: [],
            artifacts: [],
          },
        };
      },
    });

    expect(result.state.status).toBe("succeeded");
    const events = store.readRunEvents(PROJECT_ID, manifest.id, { limit: 100 }).events;
    const firstDecisionIndex = events.findIndex((event) =>
      event.type === "gate_evaluated" && event.attempt === 1
    );
    const firstFailureIndex = events.findIndex((event) =>
      event.type === "node_failed" && event.attempt === 1
    );
    const rescueIndex = events.findIndex((event) => event.type === "rescue_started");
    expect(firstDecisionIndex).toBeGreaterThan(-1);
    expect(firstFailureIndex).toBeGreaterThan(firstDecisionIndex);
    expect(rescueIndex).toBeGreaterThan(firstFailureIndex);
  });

  it.each([
    { stale: false, expectedRoute: "supported", expectedSupported: true },
    { stale: true, expectedRoute: "unsupported", expectedSupported: false },
  ])(
    "independently verifies a declared inbound gate artifact when stale=$stale",
    async ({ stale, expectedRoute, expectedSupported }) => {
      const store = new WorkflowStore();
      const writer = {
        ...agentNode("writer", false),
        workspace: { isolation: "isolated-worktree", writePaths: ["gate-results"] },
      } as WorkflowNode;
      const gate: WorkflowNode = {
        id: "gate",
        name: "gate",
        kind: "evidence-gate",
        terminal: false,
        workspace: { isolation: "read-only", writePaths: [] },
        checks: ["artifact-exists"],
        artifactIds: ["report"],
        onUnsupportedOutput: "route",
      };
      const document = workflow(
        [writer, gate, agentNode("supported", true), agentNode("unsupported", true)],
        [
          { id: "writer-gate", from: "writer", to: "gate" },
          { id: "gate-supported", from: "gate", to: "supported", condition: "evidence-supported" },
          { id: "gate-unsupported", from: "gate", to: "unsupported", condition: "evidence-unsupported" },
        ],
      );
      document.artifacts = [{
        id: "report",
        name: "Gate report",
        kind: "report",
        writerNodeId: "writer",
        path: "gate-results/report.md",
      }];
      const manifest = createRun(store, document, `gate-artifact-${String(stale)}`);
      const contents = Buffer.from("current report\n", "utf-8");
      const absolutePath = path.join(resolvePaths(PROJECT_ID).sandbox, "gate-results/report.md");

      const result = await runWorkflowDag({
        projectId: PROJECT_ID,
        runId: manifest.id,
        store,
        executeNode: (context) => {
          if (context.node.id === "writer") {
            fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
            fs.writeFileSync(absolutePath, contents);
            return completeAgentNode(context, {
              artifacts: [{ path: "gate-results/report.md", size: contents.length }],
            });
          }
          if (context.node.id === "gate") {
            const inboundReceipt = context.inbound[0].artifacts[0];
            if (stale) fs.writeFileSync(absolutePath, "replaced report\n");
            return {
              evidence: {
                supported: true,
                summary: "Executor claims the artifact is current.",
                sourceIds: [],
                artifacts: [{
                  artifactId: "report",
                  writerNodeId: "writer",
                  ...inboundReceipt,
                  sha256: inboundReceipt.sha256!,
                }],
              },
            };
          }
          return completeAgentNode(context);
        },
      });

      if (!(fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW) {
        expect(result.state.status).toBe("failed");
        return;
      }
      expect(result.state.status).toBe("succeeded");
      expect(Object.values(result.state.executions)).toContainEqual(
        expect.objectContaining({ nodeId: expectedRoute, status: "succeeded" }),
      );
      const gateEvent = store.readRunEvents(PROJECT_ID, manifest.id, { limit: 100 }).events.find(
        (event) => event.type === "gate_evaluated",
      );
      expect(gateEvent?.data).toMatchObject({ supported: expectedSupported });
      if (stale) expect(gateEvent?.data?.artifacts).toEqual([]);
      else {
        expect(gateEvent?.data?.artifacts).toEqual([expect.objectContaining({
          artifactId: "report",
          writerNodeId: "writer",
          path: "gate-results/report.md",
          sha256: createHash("sha256").update(contents).digest("hex"),
        })]);
      }
    },
  );

  it("enforces enabled common evidence policy against trusted artifact receipts", async () => {
    const store = new WorkflowStore();
    const terminal = agentNode("terminal", true);
    const document = workflow([terminal], []);
    document.evidence = {
      enabled: true,
      minimumIndependentSources: 1,
      requireArtifactReferences: true,
      onUnsupportedOutput: "fail",
    };
    const manifest = createRun(store, document, "common-evidence-fail");

    const result = await runWorkflowDag({
      projectId: PROJECT_ID,
      runId: manifest.id,
      store,
      executeNode: (context) => {
        context.recordModelResolution("agent", modelReceipt());
        context.recordModelResolution("evidence-policy-evaluator", modelReceipt());
        return {
          output: { answer: "claim", evidence: ["doi:10.1/example"] },
          evidence: {
            supported: true,
            summary: "The model-assisted review found support.",
            sourceIds: ["source-001"],
          },
        };
      },
    });

    expect(result.state.status).toBe("failed");
    const events = store.readRunEvents(PROJECT_ID, manifest.id, { limit: 100 }).events;
    expect(events.find((event) => event.type === "evidence_checked")).toMatchObject({
      data: {
        supported: false,
        sourceIds: ["source-001"],
        summary: expect.stringContaining("No normalized artifact receipt"),
      },
    });
    expect(Object.values(result.state.executions)[0].error).toMatchObject({
      code: "EVIDENCE_UNSUPPORTED",
    });
  });

  it("accepts only run-scoped Lean host artifacts and preserves them on evidence failure", async () => {
    const store = new WorkflowStore();
    const leanNode: WorkflowNode = {
      id: "lean-proof",
      name: "Lean proof",
      kind: "lean4",
      terminal: true,
      workspace: { isolation: "read-only", writePaths: [] },
      goal: "Verify the reviewed theorem.",
      theorem: "theorem reflexive (n : Nat) : n = n := rfl",
      mode: "verify",
      mathlib: false,
      skill: "byom-dag-fusion",
      evidence: {
        enabled: true,
        minimumIndependentSources: 0,
        requireArtifactReferences: true,
        onUnsupportedOutput: "fail",
      },
    };
    const document = workflow([leanNode], []);
    const manifest = createRun(store, document, "lean-artifact-failure");
    let expectedPaths: ReturnType<typeof trustedLeanArtifactPaths> | undefined;

    const result = await runWorkflowDag({
      projectId: PROJECT_ID,
      runId: manifest.id,
      store,
      executeNode: (context) => {
        context.recordModelResolution("evidence-policy-evaluator", modelReceipt());
        expectedPaths = trustedLeanArtifactPaths(manifest.id, context.executionId);
        const sandbox = resolvePaths(PROJECT_ID).sandbox;
        const proof = "theorem reflexive (n : Nat) : n = n := rfl\n";
        const log = "Lean rejected a separate trust-policy check.\n";
        for (const [relativePath, contents] of [
          [expectedPaths.proof, proof],
          [expectedPaths.log, log],
        ] as const) {
          const absolute = path.join(sandbox, relativePath);
          fs.mkdirSync(path.dirname(absolute), { recursive: true });
          fs.writeFileSync(absolute, contents);
        }
        return {
          output: { kind: "lean4", status: "failed", summary: "Lean rejected proof." },
          artifacts: [
            {
              path: expectedPaths.proof,
              size: Buffer.byteLength(proof),
              sha256: createHash("sha256").update(proof).digest("hex"),
              mediaType: "text/x-lean",
            },
            {
              path: expectedPaths.log,
              size: Buffer.byteLength(log),
              sha256: createHash("sha256").update(log).digest("hex"),
              mediaType: "text/plain",
            },
          ],
          evidence: {
            supported: false,
            summary: "The trusted Lean verifier rejected the proof.",
            sourceIds: [],
          },
        };
      },
    });

    expect(result.state.status).toBe("failed");
    expect(expectedPaths?.proof).toMatch(/^workflow_artifacts\/dag-workflows\/lean\//);
    const evidenceEvent = store.readRunEvents(PROJECT_ID, manifest.id, { limit: 100 }).events
      .find((event) => event.type === "evidence_checked");
    expect(evidenceEvent?.data).toMatchObject({
      supported: false,
      sourceIds: [],
      artifacts: [
        { path: expectedPaths?.proof, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
        { path: expectedPaths?.log, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      ],
    });
  });

  it("persists disabled-policy Lean failure receipts before node_failed", async () => {
    const store = new WorkflowStore();
    const leanNode: WorkflowNode = {
      id: "lean-proof",
      name: "Lean proof",
      kind: "lean4",
      terminal: true,
      workspace: { isolation: "read-only", writePaths: [] },
      goal: "Verify the reviewed theorem.",
      theorem: "theorem reflexive (n : Nat) : n = n := rfl",
      mode: "verify",
      mathlib: false,
      skill: "byom-dag-fusion",
    };
    const document = workflow([leanNode], []);
    const manifest = createRun(store, document, "lean-disabled-policy-failure");

    const result = await runWorkflowDag({
      projectId: PROJECT_ID,
      runId: manifest.id,
      store,
      executeNode: (context) => {
        const artifactPaths = trustedLeanArtifactPaths(manifest.id, context.executionId);
        const proof = "theorem reflexive (n : Nat) : n = n := rfl\n";
        const log = "Lean rejected the reviewed theorem.\n";
        for (const [relativePath, contents] of [
          [artifactPaths.proof, proof],
          [artifactPaths.log, log],
        ] as const) {
          const absolute = path.join(resolvePaths(PROJECT_ID).sandbox, relativePath);
          fs.mkdirSync(path.dirname(absolute), { recursive: true });
          fs.writeFileSync(absolute, contents);
        }
        return {
          output: {
            kind: "lean4",
            status: "failed",
            summary: "Lean rejected the reviewed theorem.",
          },
          artifacts: [
            { path: artifactPaths.proof, size: Buffer.byteLength(proof) },
            { path: artifactPaths.log, size: Buffer.byteLength(log) },
          ],
          evidence: {
            supported: false,
            summary: "Lean rejected the reviewed theorem.",
            sourceIds: [],
          },
        };
      },
    });

    expect(result.state.status).toBe("failed");
    expect(Object.values(result.state.executions)[0].error).toMatchObject({
      code: "WORKFLOW_LEAN_VERIFICATION_FAILED",
      retryable: false,
    });
    const events = store.readRunEvents(PROJECT_ID, manifest.id, { limit: 100 }).events;
    const evidenceIndex = events.findIndex((event) => event.type === "evidence_checked");
    const failedIndex = events.findIndex((event) => event.type === "node_failed");
    expect(evidenceIndex).toBeGreaterThan(-1);
    expect(failedIndex).toBeGreaterThan(evidenceIndex);
    expect(events[evidenceIndex]).toMatchObject({
      data: {
        supported: false,
        sourceIds: [],
        artifacts: [
          { path: expect.stringMatching(/\/Proof\.lean$/), sha256: expect.any(String) },
          { path: expect.stringMatching(/\/verification\.log$/), sha256: expect.any(String) },
        ],
      },
    });
  });

  it("rejects receiptless Lean success when common evidence is disabled", async () => {
    const store = new WorkflowStore();
    const leanNode: WorkflowNode = {
      id: "lean-proof",
      name: "Lean proof",
      kind: "lean4",
      terminal: true,
      workspace: { isolation: "read-only", writePaths: [] },
      goal: "Verify the reviewed theorem.",
      theorem: "theorem reflexive (n : Nat) : n = n := rfl",
      mode: "verify",
      mathlib: false,
      skill: "byom-dag-fusion",
    };
    const document = workflow([leanNode], []);
    const manifest = createRun(store, document, "lean-receiptless-success");

    const result = await runWorkflowDag({
      projectId: PROJECT_ID,
      runId: manifest.id,
      store,
      executeNode: () => ({
        output: { kind: "lean4", status: "verified" },
        evidence: { supported: true, sourceIds: [] },
      }),
    });

    expect(result.state.status).toBe("failed");
    expect(Object.values(result.state.executions)[0].error).toMatchObject({
      code: "INVALID_LEAN_VERIFICATION_RESULT",
      retryable: false,
    });
    const events = store.readRunEvents(PROJECT_ID, manifest.id, { limit: 100 }).events;
    const evidenceIndex = events.findIndex((event) => event.type === "evidence_checked");
    const failedIndex = events.findIndex((event) => event.type === "node_failed");
    expect(evidenceIndex).toBeGreaterThan(-1);
    expect(failedIndex).toBeGreaterThan(evidenceIndex);
    expect(events[evidenceIndex]).toMatchObject({
      data: {
        supported: false,
        sourceIds: [],
        summary: expect.stringContaining("both exact host-owned"),
      },
    });
  });

  it("rejects a near-miss path beside the exact run-scoped Lean host artifacts", async () => {
    const store = new WorkflowStore();
    const leanNode: WorkflowNode = {
      id: "lean-proof",
      name: "Lean proof",
      kind: "lean4",
      terminal: true,
      workspace: { isolation: "read-only", writePaths: [] },
      goal: "Verify the reviewed theorem.",
      theorem: "theorem reflexive (n : Nat) : n = n := rfl",
      mode: "verify",
      mathlib: false,
      skill: "byom-dag-fusion",
      evidence: {
        enabled: true,
        minimumIndependentSources: 0,
        requireArtifactReferences: true,
        onUnsupportedOutput: "fail",
      },
    };
    const document = workflow([leanNode], []);
    const manifest = createRun(store, document, "lean-artifact-near-miss");

    const result = await runWorkflowDag({
      projectId: PROJECT_ID,
      runId: manifest.id,
      store,
      executeNode: (context) => {
        context.recordModelResolution("evidence-policy-evaluator", modelReceipt());
        const expectedPaths = trustedLeanArtifactPaths(manifest.id, context.executionId);
        const unexpectedPath = path.posix.join(expectedPaths.directory, "Proof-copy.lean");
        const proof = "theorem reflexive (n : Nat) : n = n := rfl\n";
        const absolute = path.join(resolvePaths(PROJECT_ID).sandbox, unexpectedPath);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, proof);
        return {
          output: { kind: "lean4", status: "verified" },
          artifacts: [{ path: unexpectedPath, size: Buffer.byteLength(proof) }],
          evidence: { supported: true, sourceIds: [] },
        };
      },
    });

    expect(result.state.status).toBe("failed");
    expect(Object.values(result.state.executions)[0].error).toMatchObject({
      code: "UNDECLARED_NODE_ARTIFACT",
      retryable: false,
    });
    expect(store.readRunEvents(PROJECT_ID, manifest.id, { limit: 100 }).events)
      .not.toContainEqual(expect.objectContaining({ type: "evidence_checked" }));
  });

  it("rescues an unsupported common evidence-policy decision", async () => {
    const store = new WorkflowStore();
    const rescue: RescuePolicy = {
      enabled: true,
      maxAttempts: 1,
      triggers: ["unsupported-output"],
    };
    const document = workflow([agentNode("terminal", true)], [], { rescue });
    document.evidence = {
      enabled: true,
      minimumIndependentSources: 1,
      requireArtifactReferences: false,
      onUnsupportedOutput: "rescue",
    };
    const manifest = createRun(store, document, "common-evidence-rescue");

    const result = await runWorkflowDag({
      projectId: PROJECT_ID,
      runId: manifest.id,
      store,
      executeNode: (context) => {
        context.recordModelResolution("agent", modelReceipt());
        context.recordModelResolution("evidence-policy-evaluator", modelReceipt());
        return {
          output: { answer: `attempt-${context.attempt}`, evidence: ["doi:10.1/example"] },
          evidence: {
            supported: context.attempt === 2,
            summary: context.attempt === 2 ? "Supported on retry." : "Support is incomplete.",
            sourceIds: ["source-001"],
          },
        };
      },
    });

    expect(result.state.status).toBe("succeeded");
    const events = store.readRunEvents(PROJECT_ID, manifest.id, { limit: 100 }).events;
    expect(events.filter((event) => event.type === "evidence_checked")).toHaveLength(2);
    expect(events.find((event) => event.type === "rescue_started")).toMatchObject({
      data: {
        trigger: "unsupported-output",
        previousError: { code: "EVIDENCE_UNSUPPORTED" },
      },
    });
  });

  it("routes a non-gate node using its common evidence-policy verdict", async () => {
    const store = new WorkflowStore();
    const routed = {
      ...agentNode("review", false),
      evidence: {
        enabled: true,
        minimumIndependentSources: 1,
        requireArtifactReferences: false,
        onUnsupportedOutput: "route" as const,
      },
    } as WorkflowNode;
    const supported = {
      ...agentNode("supported", true),
      evidence: {
        enabled: false,
        minimumIndependentSources: 0,
        requireArtifactReferences: false,
        onUnsupportedOutput: "fail" as const,
      },
    } as WorkflowNode;
    const unsupported = {
      ...agentNode("unsupported", true),
      evidence: {
        enabled: false,
        minimumIndependentSources: 0,
        requireArtifactReferences: false,
        onUnsupportedOutput: "fail" as const,
      },
    } as WorkflowNode;
    const document = workflow(
      [routed, supported, unsupported],
      [
        {
          id: "review-supported",
          from: "review",
          to: "supported",
          condition: "evidence-supported",
        },
        {
          id: "review-unsupported",
          from: "review",
          to: "unsupported",
          condition: "evidence-unsupported",
        },
      ],
    );
    const manifest = createRun(store, document, "common-evidence-route");
    const calls: string[] = [];

    const result = await runWorkflowDag({
      projectId: PROJECT_ID,
      runId: manifest.id,
      store,
      executeNode: (context) => {
        calls.push(context.node.id);
        if (context.node.id !== "review") return completeAgentNode(context);
        context.recordModelResolution("agent", modelReceipt());
        context.recordModelResolution("evidence-policy-evaluator", modelReceipt());
        return {
          output: { answer: "unsupported claim", evidence: ["doi:10.1/example"] },
          evidence: {
            supported: false,
            summary: "The support check found a material gap.",
            sourceIds: ["source-001"],
          },
        };
      },
    });

    expect(result.state.status).toBe("succeeded");
    expect(calls).toEqual(["review", "unsupported"]);
    expect(store.readRunEvents(PROJECT_ID, manifest.id, { limit: 100 }).events.find(
      (event) => event.type === "evidence_checked",
    )).toMatchObject({ data: { supported: false, sourceIds: ["source-001"] } });
  });

  it("fails visibly when a node outcome has no route", async () => {
    const store = new WorkflowStore();
    const document = workflow([agentNode("terminal", true)], []);
    const manifest = createRun(store, document, "unhandled");

    const result = await runWorkflowDag({
      projectId: PROJECT_ID,
      runId: manifest.id,
      store,
      executeNode: () => {
        throw new WorkflowDagNodeError("terminal failed", "TERMINAL_FAILED");
      },
    });

    expect(result.state.status).toBe("failed");
    expect(result.state.lastError).toMatchObject({ code: "UNHANDLED_NODE_OUTCOME" });
  });

  it("persists a canonical model receipt before a later provider failure", async () => {
    const store = new WorkflowStore();
    const document = workflow([agentNode("terminal", true)], []);
    const manifest = createRun(store, document, "receipt-before-failure");

    const result = await runWorkflowDag({
      projectId: PROJECT_ID,
      runId: manifest.id,
      store,
      executeNode: (context) => {
        expect(context.executionId).toBe(
          workflowNodeExecutionId(manifest.id, "terminal", 1),
        );
        context.recordModelResolution("agent", modelReceipt());
        throw new WorkflowDagNodeError("provider stream failed", "PROVIDER_STREAM_FAILED");
      },
    });

    expect(result.state.status).toBe("failed");
    const events = store.readRunEvents(PROJECT_ID, manifest.id, { limit: 100 }).events;
    const resolvedIndex = events.findIndex((event) => event.type === "model_resolved");
    const failedIndex = events.findIndex((event) => event.type === "node_failed");
    expect(resolvedIndex).toBeGreaterThan(-1);
    expect(resolvedIndex).toBeLessThan(failedIndex);
    expect(Object.values(result.state.executions)[0].modelCallSlots.agent.receipt).toEqual(
      modelReceipt(),
    );
  });

  it("requires every configured compound model-call slot before success", async () => {
    const store = new WorkflowStore();
    const council: WorkflowNode = {
      id: "council",
      name: "Council",
      kind: "council",
      terminal: true,
      workspace: { isolation: "read-only", writePaths: [] },
      goal: "Reach a supported decision.",
      members: [
        { id: "alpha", role: "Independent analyst", model: exactModel() },
        { id: "beta", role: "Skeptical analyst", model: exactModel() },
      ],
      chair: exactModel(),
      rounds: 2,
      preserveMinorityReports: true,
    };
    const document = workflow([council], []);
    const manifest = createRun(store, document, "compound-receipts");

    const result = await runWorkflowDag({
      projectId: PROJECT_ID,
      runId: manifest.id,
      store,
      executeNode: (context) => {
        expect(context.expectedModelCallSlots).toHaveLength(6);
        context.recordModelResolution(context.expectedModelCallSlots[0].id, modelReceipt());
        return {};
      },
    });

    expect(result.state.status).toBe("failed");
    const events = store.readRunEvents(PROJECT_ID, manifest.id, { limit: 100 }).events;
    expect(events.filter((event) => event.type === "model_call_declared")).toHaveLength(6);
    expect(events.filter((event) => event.type === "model_resolved")).toHaveLength(1);
    expect(events.find((event) => event.type === "node_failed")?.data?.error).toMatchObject({
      code: "INCOMPLETE_MODEL_CALL_RECEIPTS",
    });
  });

  it("rescues a failed node within the effective maxAttempts", async () => {
    const store = new WorkflowStore();
    const document = workflow([agentNode("terminal", true)], [], { rescue: failureRescue });
    const manifest = createRun(store, document, "rescue-success");
    const attempts: number[] = [];

    const result = await runWorkflowDag({
      projectId: PROJECT_ID,
      runId: manifest.id,
      store,
      executeNode: (context) => {
        const { attempt } = context;
        attempts.push(attempt);
        if (attempt === 1) throw new WorkflowDagNodeError("retry me", "TRANSIENT", true);
        return completeAgentNode(context);
      },
    });

    expect(result.state.status).toBe("succeeded");
    expect(attempts).toEqual([1, 2]);
    expect(store.readRunEvents(PROJECT_ID, manifest.id, { limit: 100 }).events.map(
      (event) => event.type,
    )).toEqual(expect.arrayContaining(["rescue_started", "rescue_finished"]));
  });

  it.each([
    {
      label: "workflow maxRetries=0",
      workflowMaxRetries: 0,
      nodeMaxRetries: undefined,
      expectedAttempts: [1],
    },
    {
      label: "workflow maxRetries=1",
      workflowMaxRetries: 1,
      nodeMaxRetries: undefined,
      expectedAttempts: [1, 2],
    },
    {
      label: "node maxRetries=1 under workflow maxRetries=3",
      workflowMaxRetries: 3,
      nodeMaxRetries: 1,
      expectedAttempts: [1, 2],
    },
  ])("caps automatic rescue with $label", async ({
    workflowMaxRetries,
    nodeMaxRetries,
    expectedAttempts,
  }) => {
    const store = new WorkflowStore();
    const terminal = agentNode("terminal", true);
    if (nodeMaxRetries !== undefined) terminal.limits = { maxRetries: nodeMaxRetries };
    const document = workflow([terminal], [], { rescue: failureRescue });
    document.limits.maxRetries = workflowMaxRetries;
    const manifest = createRun(
      store,
      document,
      `rescue-retry-cap-${workflowMaxRetries}-${String(nodeMaxRetries)}`,
    );
    const attempts: number[] = [];

    const result = await runWorkflowDag({
      projectId: PROJECT_ID,
      runId: manifest.id,
      store,
      executeNode: ({ attempt }) => {
        attempts.push(attempt);
        throw new WorkflowDagNodeError("still retryable", "TRANSIENT", true);
      },
    });

    expect(result.state.status).toBe("failed");
    expect(attempts).toEqual(expectedAttempts);
    expect(store.readRunEvents(PROJECT_ID, manifest.id, { limit: 100 }).events.filter(
      (event) => event.type === "rescue_started",
    )).toHaveLength(expectedAttempts.length - 1);
  });

  it.each([
    {
      phase: "pre" as const,
      code: "WORKFLOW_PRE_COMPACTION_CHECK_FAILED",
      trigger: "pre-compaction",
    },
    {
      phase: "post" as const,
      code: "WORKFLOW_POST_COMPACTION_CHECK_FAILED",
      trigger: "post-compaction",
    },
  ])("records and rescues a failed $phase-compaction check", async ({
    phase,
    code,
    trigger,
  }) => {
    const store = new WorkflowStore();
    const rescue: RescuePolicy = {
      enabled: true,
      maxAttempts: 1,
      triggers: [trigger],
    };
    const document = workflow([agentNode("terminal", true)], [], { rescue });
    const manifest = createRun(store, document, `compaction-${phase}`);

    const result = await runWorkflowDag({
      projectId: PROJECT_ID,
      runId: manifest.id,
      store,
      executeNode: (context) => {
        if (context.attempt === 1) {
          const error = { code, message: `${phase} check failed`, retryable: true };
          context.recordCompactionCheck({ phase, passed: false, error });
          throw new WorkflowDagNodeError(error.message, code, true);
        }
        return completeAgentNode(context);
      },
    });

    expect(result.state.status).toBe("succeeded");
    const events = store.readRunEvents(PROJECT_ID, manifest.id, { limit: 100 }).events;
    expect(events.find((event) => event.type === "compaction_checked")).toMatchObject({
      data: { phase, passed: false, error: { code } },
    });
    expect(events.find((event) => event.type === "rescue_started")).toMatchObject({
      data: { trigger, previousError: { code } },
    });
  });

  it.each([
    "WORKFLOW_EVIDENCE_UNSUPPORTED",
    "EVIDENCE_UNSUPPORTED",
  ])("maps %s to the unsupported-output rescue trigger", async (code) => {
    const store = new WorkflowStore();
    const rescue: RescuePolicy = {
      enabled: true,
      maxAttempts: 1,
      triggers: ["unsupported-output"],
    };
    const document = workflow([agentNode("terminal", true)], [], { rescue });
    const manifest = createRun(store, document, `unsupported-output-${code}`);

    const result = await runWorkflowDag({
      projectId: PROJECT_ID,
      runId: manifest.id,
      store,
      executeNode: (context) => {
        if (context.attempt === 1) {
          throw new WorkflowDagNodeError("unsupported evidence", code, true);
        }
        return completeAgentNode(context);
      },
    });

    expect(result.state.status).toBe("succeeded");
    expect(store.readRunEvents(PROJECT_ID, manifest.id, { limit: 100 }).events.find(
      (event) => event.type === "rescue_started",
    )).toMatchObject({
      data: { trigger: "unsupported-output", previousError: { code } },
    });
  });

  it("maps exhausted bounded research to the stalled rescue trigger", async () => {
    const store = new WorkflowStore();
    const rescue: RescuePolicy = {
      enabled: true,
      maxAttempts: 1,
      triggers: ["stalled"],
    };
    const document = workflow([agentNode("terminal", true)], [], { rescue });
    const manifest = createRun(store, document, "research-goal-stalled");

    const result = await runWorkflowDag({
      projectId: PROJECT_ID,
      runId: manifest.id,
      store,
      executeNode: (context) => {
        if (context.attempt === 1) {
          throw new WorkflowDagNodeError(
            "bounded research exhausted its completion criteria",
            "WORKFLOW_RESEARCH_GOAL_NOT_MET",
            true,
          );
        }
        return completeAgentNode(context);
      },
    });

    expect(result.state.status).toBe("succeeded");
    expect(store.readRunEvents(PROJECT_ID, manifest.id, { limit: 100 }).events.find(
      (event) => event.type === "rescue_started",
    )).toMatchObject({
      data: {
        trigger: "stalled",
        previousError: { code: "WORKFLOW_RESEARCH_GOAL_NOT_MET" },
      },
    });
  });

  it("fails after bounded rescue exhaustion", async () => {
    const store = new WorkflowStore();
    const document = workflow([agentNode("terminal", true)], [], { rescue: failureRescue });
    const manifest = createRun(store, document, "rescue-exhausted");
    const attempts: number[] = [];

    const result = await runWorkflowDag({
      projectId: PROJECT_ID,
      runId: manifest.id,
      store,
      executeNode: ({ attempt }) => {
        attempts.push(attempt);
        throw new WorkflowDagNodeError("still broken", "TRANSIENT", true);
      },
    });

    expect(result.state.status).toBe("failed");
    expect(attempts).toEqual([1, 2, 3]);
    const events = store.readRunEvents(PROJECT_ID, manifest.id, { limit: 100 }).events;
    expect(events.filter((event) => event.type === "rescue_started")).toHaveLength(2);
    expect(events.filter((event) => event.type === "rescue_finished")).toHaveLength(2);
  });

  it("never auto-rescues a nonretryable failure even when its trigger is enabled", async () => {
    const store = new WorkflowStore();
    const document = workflow([agentNode("terminal", true)], [], { rescue: failureRescue });
    const manifest = createRun(store, document, "nonretryable-no-rescue");
    const attempts: number[] = [];

    const result = await runWorkflowDag({
      projectId: PROJECT_ID,
      runId: manifest.id,
      store,
      executeNode: ({ attempt }) => {
        attempts.push(attempt);
        throw new WorkflowDagNodeError("permanent failure", "PERMANENT", false);
      },
    });

    expect(result.state.status).toBe("failed");
    expect(attempts).toEqual([1]);
    const events = store.readRunEvents(PROJECT_ID, manifest.id, { limit: 100 }).events;
    expect(events.some((event) => event.type === "rescue_started")).toBe(false);
    expect(Object.values(result.state.executions)[0].error).toMatchObject({
      code: "PERMANENT",
      retryable: false,
    });
  });

  it("honours a disabled node rescue override over an enabled workflow policy", async () => {
    const store = new WorkflowStore();
    const terminal = {
      ...agentNode("terminal", true),
      rescue: disabledRescue,
    } as WorkflowNode;
    const document = workflow([terminal], [], { rescue: failureRescue });
    const manifest = createRun(store, document, "rescue-disabled");
    const attempts: number[] = [];

    const result = await runWorkflowDag({
      projectId: PROJECT_ID,
      runId: manifest.id,
      store,
      executeNode: ({ attempt }) => {
        attempts.push(attempt);
        throw new Error("no rescue");
      },
    });

    expect(result.state.status).toBe("failed");
    expect(attempts).toEqual([1]);
    expect(store.readRunEvents(PROJECT_ID, manifest.id, { limit: 100 }).events.some(
      (event) => event.type === "rescue_started",
    )).toBe(false);
  });

  it("records an untyped caller AbortSignal as a recoverable interruption", async () => {
    const store = new WorkflowStore();
    const document = workflow([agentNode("terminal", true)], []);
    const manifest = createRun(store, document, "abort");
    const controller = new AbortController();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    const execution = runWorkflowDag({
      projectId: PROJECT_ID,
      runId: manifest.id,
      store,
      signal: controller.signal,
      executeNode: async ({ signal }) => {
        markStarted?.();
        return await waitForAbort(signal);
      },
    });
    await started;
    controller.abort("test cancellation");
    const result = await execution;

    expect(result.state.status).toBe("interrupted");
    expect(result.state.lastError).toMatchObject({
      code: "RUN_INTERRUPTED",
      retryable: true,
    });
    expect(Object.values(result.state.executions)).toContainEqual(
      expect.objectContaining({ nodeId: "terminal", status: "interrupted" }),
    );
  });

  it("observes a durable user cancellation requested by another store instance", async () => {
    const ownerStore = new WorkflowStore();
    const cancellingStore = new WorkflowStore();
    const document = workflow([agentNode("terminal", true)], []);
    const manifest = createRun(ownerStore, document, "cross-process-cancel");
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    const execution = runWorkflowDag({
      projectId: PROJECT_ID,
      runId: manifest.id,
      store: ownerStore,
      executeNode: async ({ signal }) => {
        markStarted?.();
        return await waitForAbort(signal);
      },
    });
    await started;
    expect(cancellingStore.requestRunCancellation(PROJECT_ID, manifest.id).state.status)
      .toBe("running");
    const result = await execution;

    expect(result.state.status).toBe("cancelled");
    expect(result.state.lastError).toMatchObject({
      code: "USER_CANCELLED",
      retryable: false,
    });
  });

  it("resumes an interrupted run without re-executing succeeded nodes", async () => {
    const store = new WorkflowStore();
    const document = workflow(
      [agentNode("start", false), agentNode("finish", true)],
      [{ id: "start-finish", from: "start", to: "finish" }],
    );
    const manifest = createRun(store, document, "resume");
    const startExecutionId = workflowNodeExecutionId(manifest.id, "start", 1);
    store.appendRunEvent(PROJECT_ID, manifest.id, {
      eventId: "manual-run-started",
      type: "run_started",
    }, 1);
    store.appendRunEvent(PROJECT_ID, manifest.id, {
      eventId: "manual-start-started",
      type: "node_started",
      executionId: startExecutionId,
      nodeId: "start",
      attempt: 1,
      branchId: "entry",
    }, 2);
    store.appendRunEvent(PROJECT_ID, manifest.id, {
      eventId: "manual-start-model-slot",
      type: "model_call_declared",
      executionId: startExecutionId,
      nodeId: "start",
      attempt: 1,
      branchId: "entry",
      data: { modelCallSlot: { id: "agent", request: exactModel() } },
    }, 3);
    store.appendRunEvent(PROJECT_ID, manifest.id, {
      eventId: "manual-start-model-receipt",
      type: "model_resolved",
      executionId: startExecutionId,
      nodeId: "start",
      attempt: 1,
      branchId: "entry",
      data: { modelCallSlotId: "agent", receipt: modelReceipt() },
    }, 4);
    store.appendRunEvent(PROJECT_ID, manifest.id, {
      eventId: "manual-start-succeeded",
      type: "node_succeeded",
      executionId: startExecutionId,
      nodeId: "start",
      attempt: 1,
      branchId: "entry",
      data: { routeCondition: "success", output: { saved: true } },
    }, 5);
    store.appendRunEvent(PROJECT_ID, manifest.id, {
      eventId: "manual-interrupted",
      type: "run_interrupted",
      data: {
        previousStatus: "running",
        error: { code: "SERVER_RESTART", message: "restart", retryable: true },
      },
    }, 6);
    const calls: string[] = [];

    const result = await runWorkflowDag({
      projectId: PROJECT_ID,
      runId: manifest.id,
      store,
      executeNode: (context) => {
        const { node, inbound } = context;
        calls.push(node.id);
        expect(inbound[0]?.output).toEqual({ saved: true });
        return completeAgentNode(context);
      },
    });

    expect(result.state.status).toBe("succeeded");
    expect(calls).toEqual(["finish"]);
    expect(store.readRunEvents(PROJECT_ID, manifest.id, { limit: 100 }).events.some(
      (event) => event.type === "run_resumed",
    )).toBe(true);
  });

  it("restarts an interrupted node attempt with a distinct transition event", async () => {
    let now = 10_000;
    const store = new WorkflowStore({ now: () => now });
    const recoveryStore = new WorkflowStore({ now: () => now });
    const document = workflow([agentNode("terminal", true)], []);
    const manifest = createRun(store, document, "resume-active-node");
    let markStarted: (() => void) | undefined;
    let releaseFirstAttempt: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const firstAttemptMayFinish = new Promise<void>((resolve) => {
      releaseFirstAttempt = resolve;
    });

    const firstRun = runWorkflowDag({
      projectId: PROJECT_ID,
      runId: manifest.id,
      store,
      leaseDurationMs: 60_000,
      executeNode: async () => {
        markStarted?.();
        await firstAttemptMayFinish;
        throw new Error("the original process lost ownership");
      },
    });
    await started;
    expect(recoveryStore.reconcileInterruptedRuns(PROJECT_ID).active).toEqual([manifest.id]);
    now += 60_001;
    expect(recoveryStore.reconcileInterruptedRuns(PROJECT_ID).interrupted).toEqual([manifest.id]);
    releaseFirstAttempt?.();
    await expect(firstRun).rejects.toMatchObject({ code: "RUN_ALREADY_ACTIVE" });

    const resumedContexts: Array<{ attempt: number; resumed: boolean; executionId: string }> = [];
    const result = await runWorkflowDag({
      projectId: PROJECT_ID,
      runId: manifest.id,
      store: recoveryStore,
      executeNode: (context) => {
        const { attempt, resumed, executionId } = context;
        resumedContexts.push({ attempt, resumed, executionId });
        return completeAgentNode(context);
      },
    });

    expect(result.state.status).toBe("succeeded");
    expect(resumedContexts).toEqual([{
      attempt: 1,
      resumed: true,
      executionId: workflowNodeExecutionId(manifest.id, "terminal", 1),
    }]);
    const nodeStarts = store.readRunEvents(PROJECT_ID, manifest.id, { limit: 100 }).events.filter(
      (event) => event.type === "node_started",
    );
    expect(nodeStarts).toHaveLength(2);
    expect(new Set(nodeStarts.map((event) => event.eventId)).size).toBe(2);
    expect(new Set(nodeStarts.map((event) => event.executionId)).size).toBe(1);
  });

  it("rejects concurrent ownership of the same run", async () => {
    const store = new WorkflowStore();
    const document = workflow([agentNode("terminal", true)], []);
    const manifest = createRun(store, document, "ownership");
    const controller = new AbortController();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const first = runWorkflowDag({
      projectId: PROJECT_ID,
      runId: manifest.id,
      store,
      signal: controller.signal,
      executeNode: async ({ signal }) => {
        markStarted?.();
        return await waitForAbort(signal);
      },
    });
    await started;

    await expect(runWorkflowDag({
      projectId: PROJECT_ID,
      runId: manifest.id,
      store,
      executeNode: () => ({}),
    })).rejects.toMatchObject({ code: "RUN_ALREADY_ACTIVE" });
    controller.abort();
    await first;
  });

  it("refuses terminal and corrupt durable histories", async () => {
    const store = new WorkflowStore();
    const document = workflow([agentNode("terminal", true)], []);
    const terminalRun = createRun(store, document, "terminal-refusal");
    await runWorkflowDag({
      projectId: PROJECT_ID,
      runId: terminalRun.id,
      store,
      executeNode: (context) => completeAgentNode(context),
    });
    await expect(runWorkflowDag({
      projectId: PROJECT_ID,
      runId: terminalRun.id,
      store,
      executeNode: () => ({}),
    })).rejects.toMatchObject({ code: "RUN_NOT_RUNNABLE" });

    const corruptRun = store.createRun(PROJECT_ID, {
      workflowId: document.id,
      requestId: "corrupt-refusal",
      requestedBy: "api",
    });
    fs.appendFileSync(workflowRunFiles(PROJECT_ID, corruptRun.id).events, "{malformed}\n");
    await expect(runWorkflowDag({
      projectId: PROJECT_ID,
      runId: corruptRun.id,
      store,
      executeNode: () => ({}),
    })).rejects.toMatchObject({ code: "RUN_CORRUPT" });
  });

  it("persists artifact receipts measured from the real sandbox and rejects false claims", async () => {
    const store = new WorkflowStore();
    const writer = {
      ...agentNode("writer", true),
      workspace: { isolation: "isolated-worktree", writePaths: ["results"] },
    } as WorkflowNode;
    const document = workflow([writer], []);
    document.artifacts = [{
      id: "report",
      name: "Verified report",
      kind: "report",
      writerNodeId: "writer",
      path: "results/report.md",
    }];
    const manifest = createRun(store, document, "verified-artifact");
    const sandbox = resolvePaths(PROJECT_ID).sandbox;
    fs.mkdirSync(`${sandbox}/results`, { recursive: true });
    const contents = Buffer.from("verified evidence\n", "utf-8");
    fs.writeFileSync(`${sandbox}/results/report.md`, contents);

    const result = await runWorkflowDag({
      projectId: PROJECT_ID,
      runId: manifest.id,
      store,
      executeNode: (context) => completeAgentNode(context, {
        artifacts: [{ path: "results/report.md", size: contents.length }],
      }),
    });
    if (!(fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW) {
      expect(result.state.status).toBe("failed");
      expect(Object.values(result.state.executions)[0].error).toMatchObject({
        code: "UNVERIFIED_NODE_ARTIFACT",
      });
      return;
    }
    expect(result.state.status).toBe("succeeded");
    expect(Object.values(result.state.executions)[0].artifacts).toEqual([{
      path: "results/report.md",
      size: contents.length,
      sha256: createHash("sha256").update(contents).digest("hex"),
    }]);

    const falseClaim = store.createRun(PROJECT_ID, {
      workflowId: document.id,
      requestId: "false-artifact-claim",
      requestedBy: "api",
    });
    const rejected = await runWorkflowDag({
      projectId: PROJECT_ID,
      runId: falseClaim.id,
      store,
      executeNode: (context) => completeAgentNode(context, {
        artifacts: [{ path: "results/report.md", size: contents.length + 1 }],
      }),
    });
    expect(rejected.state.status).toBe("failed");
    expect(rejected.state.lastError).toMatchObject({ code: "UNHANDLED_NODE_OUTCOME" });
    expect(Object.values(rejected.state.executions)[0].error).toMatchObject({
      code: "ARTIFACT_RECEIPT_MISMATCH",
    });
  });

  it.skipIf(process.platform === "win32")(
    "refuses an artifact path containing a symlink component",
    async () => {
      const store = new WorkflowStore();
      const writer = {
        ...agentNode("writer", true),
        workspace: { isolation: "isolated-worktree", writePaths: ["results"] },
      } as WorkflowNode;
      const document = workflow([writer], []);
      document.artifacts = [{
        id: "linked-report",
        name: "Linked report",
        kind: "report",
        writerNodeId: "writer",
        path: "results/linked/report.md",
      }];
      const manifest = createRun(store, document, "symlink-artifact");
      const sandbox = resolvePaths(PROJECT_ID).sandbox;
      const outside = `${PROJECTS_ROOT}/outside-artifacts`;
      fs.mkdirSync(`${sandbox}/results`, { recursive: true });
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(`${outside}/report.md`, "outside\n");
      fs.symlinkSync(outside, `${sandbox}/results/linked`, "dir");

      const result = await runWorkflowDag({
        projectId: PROJECT_ID,
        runId: manifest.id,
        store,
        executeNode: (context) => completeAgentNode(context, {
          artifacts: [{ path: "results/linked/report.md", size: 8 }],
        }),
      });
      expect(result.state.status).toBe("failed");
      expect(Object.values(result.state.executions)[0].error).toMatchObject({
        code: "UNVERIFIED_NODE_ARTIFACT",
      });
    },
  );

  it.skipIf(
    process.platform === "win32" ||
    !(fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW,
  )("rejects an artifact path replaced while its opened file is hashed", async () => {
    const store = new WorkflowStore();
    const writer = {
      ...agentNode("writer", true),
      workspace: { isolation: "isolated-worktree", writePaths: ["results"] },
    } as WorkflowNode;
    const document = workflow([writer], []);
    document.artifacts = [{
      id: "report",
      name: "Verified report",
      kind: "report",
      writerNodeId: "writer",
      path: "results/report.md",
    }];
    const manifest = createRun(store, document, "replaced-artifact");
    const sandbox = resolvePaths(PROJECT_ID).sandbox;
    const target = `${sandbox}/results/report.md`;
    const originalTarget = `${sandbox}/results/report.original.md`;
    const contents = Buffer.alloc(2 * 1024 * 1024, 0x61);
    fs.mkdirSync(`${sandbox}/results`, { recursive: true });
    fs.writeFileSync(target, contents);

    const originalReadSync = fs.readSync;
    let replaced = false;
    const readSpy = vi.spyOn(fs, "readSync").mockImplementation((
      (fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) => {
        const bytesRead = originalReadSync(fd, buffer, offset, length, position);
        if (!replaced && fs.fstatSync(fd).size === contents.length) {
          replaced = true;
          fs.renameSync(target, originalTarget);
          fs.writeFileSync(target, contents);
        }
        return bytesRead;
      }
    ) as typeof fs.readSync);

    let result;
    try {
      result = await runWorkflowDag({
        projectId: PROJECT_ID,
        runId: manifest.id,
        store,
        executeNode: (context) => completeAgentNode(context, {
          artifacts: [{ path: "results/report.md", size: contents.length }],
        }),
      });
    } finally {
      readSpy.mockRestore();
    }

    expect(replaced).toBe(true);
    expect(result.state.status).toBe("failed");
    expect(Object.values(result.state.executions)[0].error).toMatchObject({
      code: "UNVERIFIED_NODE_ARTIFACT",
    });
  });

  it("fails closed on oversized node output without persisting it", async () => {
    const store = new WorkflowStore();
    const document = workflow([agentNode("terminal", true)], []);
    const manifest = createRun(store, document, "large-output");

    const result = await runWorkflowDag({
      projectId: PROJECT_ID,
      runId: manifest.id,
      store,
      executeNode: (context) => completeAgentNode(
        context,
        { output: "x".repeat(20 * 1024) },
      ),
    });

    expect(result.state.status).toBe("failed");
    const failedEvent = store.readRunEvents(PROJECT_ID, manifest.id, { limit: 100 }).events.find(
      (event) => event.type === "node_failed",
    );
    expect(failedEvent?.data?.error).toMatchObject({ code: "NODE_OUTPUT_TOO_LARGE" });
    expect(failedEvent?.data?.output).toBeUndefined();
  });
});
