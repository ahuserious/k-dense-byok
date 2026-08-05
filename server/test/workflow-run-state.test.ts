import { describe, expect, it } from "vitest";
import {
  WORKFLOW_RUN_EVENT_SCHEMA_VERSION,
  WORKFLOW_RUN_STORAGE_VERSION,
  reduceWorkflowRun,
  type WorkflowGraphDocument,
  type WorkflowRunEventV1,
  type WorkflowRunManifestV1,
} from "../src/workflows/index.ts";
import { trustedLeanArtifactPaths } from "../src/workflows/lean4-artifacts.ts";

function graph(): WorkflowGraphDocument {
  return {
    schemaVersion: "1.0",
    id: "projection-workflow",
    name: "Projection workflow",
    entryNodeId: "worker",
    defaultModel: {
      requested: {
        source: "fixed",
        provider: "ollama",
        model: "qwen3:32b",
        auth: { kind: "local" },
        reasoning: "high",
      },
      resolution: { mode: "exact" },
    },
    limits: {
      maxIterations: 10,
      maxModelCalls: 20,
      maxParallelism: 4,
      maxSubagents: 4,
      timeoutMs: 60_000,
      maxTokens: 100_000,
      maxCostUsd: 0,
      maxRetries: 2,
    },
    evidence: {
      enabled: false,
      minimumIndependentSources: 0,
      requireArtifactReferences: false,
      onUnsupportedOutput: "fail",
    },
    nodes: [
      {
        id: "worker",
        name: "Worker",
        kind: "agent",
        terminal: true,
        workspace: { isolation: "read-only", writePaths: [] },
        prompt: "Work.",
      },
    ],
    edges: [],
  };
}

function manifest(): WorkflowRunManifestV1 {
  const workflow = graph();
  return manifestForGraph(workflow);
}

function manifestForGraph(workflow: WorkflowGraphDocument): WorkflowRunManifestV1 {
  return {
    storageVersion: WORKFLOW_RUN_STORAGE_VERSION,
    id: "wrun_00000000000000000000000000000000",
    projectId: "default",
    workflowId: workflow.id,
    workflowRevision: 1,
    graphSha256: "a".repeat(64),
    requestId: "request",
    requestSha256: "b".repeat(64),
    createdAt: 1,
    requestedBy: "api",
    input: {},
    effectiveLimits: workflow.limits,
    graph: workflow,
  };
}

function gateGraph(options: {
  artifact?: boolean;
  onUnsupportedOutput?: "fail" | "rescue" | "route";
} = {}): WorkflowGraphDocument {
  const workflow = graph();
  workflow.entryNodeId = "gate";
  workflow.nodes = [{
    id: "gate",
    name: "Gate",
    kind: "evidence-gate",
    terminal: true,
    workspace: { isolation: "read-only", writePaths: [] },
    checks: options.artifact ? ["artifact-exists"] : ["claim-support"],
    artifactIds: options.artifact ? ["report"] : [],
    onUnsupportedOutput: options.onUnsupportedOutput ?? "route",
  }];
  workflow.edges = [];
  if (options.artifact) {
    workflow.artifacts = [{
      id: "report",
      name: "Report",
      kind: "report",
      writerNodeId: "writer",
      path: "reports/report.md",
    }];
  }
  return workflow;
}

function event(
  seq: number,
  type: WorkflowRunEventV1["type"],
  fields: Partial<WorkflowRunEventV1> = {},
): WorkflowRunEventV1 {
  return {
    schemaVersion: WORKFLOW_RUN_EVENT_SCHEMA_VERSION,
    runId: manifest().id,
    eventId: `event-${seq}`,
    seq,
    ts: seq * 10,
    type,
    ...fields,
  };
}

function modelSlotFields(executionId: string, attempt: number, branchId: string) {
  return {
    executionId,
    nodeId: "worker",
    attempt,
    branchId,
    data: {
      modelCallSlot: { id: "agent", request: graph().defaultModel! },
    },
  };
}

function modelReceiptFields(executionId: string, attempt: number, branchId: string) {
  return {
    executionId,
    nodeId: "worker",
    attempt,
    branchId,
    data: {
      modelCallSlotId: "agent",
      receipt: {
        request: graph().defaultModel!,
        resolved: {
          provider: "ollama",
          model: "qwen3:32b",
          auth: { kind: "local" },
          reasoning: "high" as const,
          runtime: "local" as const,
        },
        fallbackUsed: false,
      },
    },
  };
}

function gateModelSlotFields(executionId = "gate-attempt") {
  return {
    executionId,
    nodeId: "gate",
    attempt: 1,
    branchId: "entry",
    data: {
      modelCallSlot: { id: "evidence-evaluator", request: graph().defaultModel! },
    },
  };
}

function gateModelReceiptFields(executionId = "gate-attempt") {
  return {
    executionId,
    nodeId: "gate",
    attempt: 1,
    branchId: "entry",
    data: {
      modelCallSlotId: "evidence-evaluator",
      receipt: {
        request: graph().defaultModel!,
        resolved: {
          provider: "ollama",
          model: "qwen3:32b",
          auth: { kind: "local" },
          reasoning: "high" as const,
          runtime: "local" as const,
        },
        fallbackUsed: false,
      },
    },
  };
}

function gateIdentity(executionId = "gate-attempt") {
  return {
    executionId,
    nodeId: "gate",
    attempt: 1,
    branchId: "entry",
  };
}

function gateDecision(supported: boolean) {
  return {
    supported,
    sourceIds: [],
    artifacts: [],
    summary: supported ? "Observed support passed." : "Observed support failed.",
  };
}

function evidenceModelSlotFields(executionId = "evidence-attempt") {
  return {
    executionId,
    nodeId: "worker",
    attempt: 1,
    branchId: "entry",
    data: {
      modelCallSlot: {
        id: "evidence-policy-evaluator",
        request: graph().defaultModel!,
      },
    },
  };
}

function evidenceModelReceiptFields(executionId = "evidence-attempt") {
  return {
    executionId,
    nodeId: "worker",
    attempt: 1,
    branchId: "entry",
    data: {
      modelCallSlotId: "evidence-policy-evaluator",
      receipt: modelReceiptFields(executionId, 1, "entry").data.receipt,
    },
  };
}

describe("reduceWorkflowRun", () => {
  it("keeps retry executions of one graph node separate", () => {
    const firstError = {
      code: "MODEL_ERROR",
      message: "first attempt failed",
      retryable: true,
    };
    const events = [
      event(1, "run_queued", { data: { workflowRevision: 1 } }),
      event(2, "run_started"),
      event(3, "node_started", {
        executionId: "attempt-1",
        nodeId: "worker",
        attempt: 1,
        branchId: "entry",
      }),
      event(4, "node_failed", {
        executionId: "attempt-1",
        nodeId: "worker",
        attempt: 1,
        branchId: "entry",
        data: { error: firstError, routeCondition: "failure" },
      }),
      event(5, "rescue_started", {
        executionId: "attempt-2",
        nodeId: "worker",
        attempt: 2,
        branchId: "entry",
        data: { trigger: "failure", previousError: firstError },
      }),
      event(6, "node_started", {
        executionId: "attempt-2",
        nodeId: "worker",
        attempt: 2,
        branchId: "entry",
      }),
      event(7, "model_call_declared", modelSlotFields("attempt-2", 2, "entry")),
      event(8, "model_resolved", modelReceiptFields("attempt-2", 2, "entry")),
      event(9, "node_succeeded", {
        executionId: "attempt-2",
        nodeId: "worker",
        attempt: 2,
        branchId: "entry",
        data: { routeCondition: "success" },
      }),
      event(10, "rescue_finished", {
        executionId: "attempt-2",
        nodeId: "worker",
        attempt: 2,
        branchId: "entry",
        data: { succeeded: true },
      }),
    ];
    const state = reduceWorkflowRun(manifest(), events);
    expect(state.status).toBe("running");
    expect(state.executions["attempt-1"]).toMatchObject({
      nodeId: "worker",
      branchId: "entry",
      status: "failed",
    });
    expect(state.executions["attempt-2"]).toMatchObject({
      nodeId: "worker",
      branchId: "entry",
      status: "succeeded",
    });
  });

  it("requires an explicit run terminal event and fails closed on diagnostics", () => {
    const failed = reduceWorkflowRun(manifest(), [
      event(1, "run_queued", { data: { workflowRevision: 1 } }),
      event(2, "run_started"),
      event(3, "node_started", {
        executionId: "attempt-1",
        nodeId: "worker",
        attempt: 1,
        branchId: "entry",
      }),
      event(4, "node_failed", {
        executionId: "attempt-1",
        nodeId: "worker",
        attempt: 1,
        branchId: "entry",
        data: {
          error: { code: "NODE_FAILED", message: "workflow stopped", retryable: false },
          routeCondition: "failure",
        },
      }),
      event(5, "run_failed", {
        data: {
          error: { code: "NODE_FAILED", message: "workflow stopped", retryable: false },
        },
      }),
    ]);
    expect(failed.status).toBe("failed");
    expect(failed.recoverable).toBe(false);

    const corrupt = reduceWorkflowRun(
      manifest(),
      [event(1, "run_queued", { data: { workflowRevision: 1 } })],
      [{ code: "malformed-event-row", message: "line 2 is corrupt", fatal: true }],
    );
    expect(corrupt.status).toBe("queued");
    expect(corrupt.recoverable).toBe(false);
  });

  it("fails closed when execution identities drift or events target unknown nodes", () => {
    const state = reduceWorkflowRun(manifest(), [
      event(1, "run_queued", { data: { workflowRevision: 1 } }),
      event(2, "run_started"),
      event(3, "node_started", {
        executionId: "attempt-1",
        nodeId: "worker",
        attempt: 1,
        branchId: "candidate-a",
      }),
      event(4, "node_succeeded", {
        executionId: "attempt-1",
        nodeId: "worker",
        attempt: 1,
        branchId: "candidate-b",
        data: { routeCondition: "success" },
      }),
      event(5, "node_started", {
        executionId: "attempt-2",
        nodeId: "missing-node",
        attempt: 1,
        branchId: "entry",
      }),
    ]);

    expect(state.recoverable).toBe(false);
    expect(state.executions["attempt-1"].status).toBe("running");
    expect(state.executions["attempt-2"]).toBeUndefined();
    expect(state.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "execution-identity-conflict",
      "unknown-node-id",
    ]);
  });

  it("does not let later events reopen a terminal run", () => {
    const state = reduceWorkflowRun(manifest(), [
      event(1, "run_queued", { data: { workflowRevision: 1 } }),
      event(2, "run_started"),
      event(3, "node_started", {
        executionId: "attempt-1",
        nodeId: "worker",
        attempt: 1,
        branchId: "entry",
      }),
      event(4, "model_call_declared", modelSlotFields("attempt-1", 1, "entry")),
      event(5, "model_resolved", modelReceiptFields("attempt-1", 1, "entry")),
      event(6, "node_succeeded", {
        executionId: "attempt-1",
        nodeId: "worker",
        attempt: 1,
        branchId: "entry",
        data: { routeCondition: "success" },
      }),
      event(7, "run_succeeded"),
      event(8, "run_resumed", { data: { resumeNumber: 1 } }),
    ]);

    expect(state.status).toBe("succeeded");
    expect(state.recoverable).toBe(false);
    expect(state.diagnostics).toContainEqual(
      expect.objectContaining({ code: "event-after-terminal", fatal: true }),
    );
  });

  it.each([
    { supported: true, routeCondition: "evidence-supported" as const },
    { supported: false, routeCondition: "evidence-unsupported" as const },
  ])("accepts a gate success only when it matches the prior $routeCondition decision", ({
    supported,
    routeCondition,
  }) => {
    const workflow = gateGraph();
    const events = [
      event(1, "run_queued", { data: { workflowRevision: 1 } }),
      event(2, "run_started"),
      event(3, "node_started", gateIdentity()),
      event(4, "model_call_declared", gateModelSlotFields()),
      event(5, "model_resolved", gateModelReceiptFields()),
      event(6, "gate_evaluated", {
        ...gateIdentity(),
        data: gateDecision(supported),
      }),
      event(7, "node_succeeded", {
        ...gateIdentity(),
        data: { routeCondition },
      }),
    ];

    const state = reduceWorkflowRun(manifestForGraph(workflow), events);

    expect(state.recoverable).toBe(true);
    expect(state.executions["gate-attempt"]).toMatchObject({
      status: "succeeded",
      gateDecision: { supported },
    });
  });

  it("rejects a gate success with no prior decision or a mismatched route", () => {
    const workflow = gateGraph();
    const common = [
      event(1, "run_queued", { data: { workflowRevision: 1 } }),
      event(2, "run_started"),
      event(3, "node_started", gateIdentity()),
      event(4, "model_call_declared", gateModelSlotFields()),
      event(5, "model_resolved", gateModelReceiptFields()),
    ];
    const missing = reduceWorkflowRun(manifestForGraph(workflow), [
      ...common,
      event(6, "node_succeeded", {
        ...gateIdentity(),
        data: { routeCondition: "evidence-supported" },
      }),
    ]);
    const mismatched = reduceWorkflowRun(manifestForGraph(workflow), [
      ...common,
      event(6, "gate_evaluated", {
        ...gateIdentity(),
        data: gateDecision(true),
      }),
      event(7, "node_succeeded", {
        ...gateIdentity(),
        data: { routeCondition: "evidence-unsupported" },
      }),
    ]);

    for (const state of [missing, mismatched]) {
      expect(state.recoverable).toBe(false);
      expect(state.executions["gate-attempt"].status).toBe("running");
      expect(state.diagnostics).toContainEqual(
        expect.objectContaining({ code: "invalid-gate-transition", fatal: true }),
      );
    }
  });

  it("requires a prior false gate decision before an evidence-unsupported failure", () => {
    const workflow = gateGraph({ onUnsupportedOutput: "fail" });
    const error = {
      code: "EVIDENCE_UNSUPPORTED",
      message: "The gate failed.",
      retryable: false,
    };
    const withoutDecision = reduceWorkflowRun(manifestForGraph(workflow), [
      event(1, "run_queued", { data: { workflowRevision: 1 } }),
      event(2, "run_started"),
      event(3, "node_started", gateIdentity()),
      event(4, "node_failed", {
        ...gateIdentity(),
        data: { error, routeCondition: "failure" },
      }),
    ]);
    const withDecision = reduceWorkflowRun(manifestForGraph(workflow), [
      event(1, "run_queued", { data: { workflowRevision: 1 } }),
      event(2, "run_started"),
      event(3, "node_started", gateIdentity()),
      event(4, "model_call_declared", gateModelSlotFields()),
      event(5, "model_resolved", gateModelReceiptFields()),
      event(6, "gate_evaluated", {
        ...gateIdentity(),
        data: gateDecision(false),
      }),
      event(7, "node_failed", {
        ...gateIdentity(),
        data: { error, routeCondition: "failure" },
      }),
    ]);

    expect(withoutDecision.recoverable).toBe(false);
    expect(withoutDecision.diagnostics).toContainEqual(
      expect.objectContaining({ code: "invalid-gate-transition", fatal: true }),
    );
    expect(withDecision.recoverable).toBe(true);
    expect(withDecision.executions["gate-attempt"]).toMatchObject({
      status: "failed",
      gateDecision: { supported: false },
      error: { code: "EVIDENCE_UNSUPPORTED" },
    });
  });

  it("preserves an early provider failure before any gate decision", () => {
    const workflow = gateGraph({ onUnsupportedOutput: "fail" });
    const state = reduceWorkflowRun(manifestForGraph(workflow), [
      event(1, "run_queued", { data: { workflowRevision: 1 } }),
      event(2, "run_started"),
      event(3, "node_started", gateIdentity()),
      event(4, "node_failed", {
        ...gateIdentity(),
        data: {
          error: {
            code: "PROVIDER_UNAVAILABLE",
            message: "Evaluator provider unavailable.",
            retryable: true,
          },
          routeCondition: "failure",
        },
      }),
    ]);

    expect(state.recoverable).toBe(true);
    expect(state.executions["gate-attempt"]).toMatchObject({
      status: "failed",
      error: { code: "PROVIDER_UNAVAILABLE" },
    });
    expect(state.executions["gate-attempt"].gateDecision).toBeUndefined();
  });

  it("rejects duplicate, torn, and forged gate decisions", () => {
    const workflow = gateGraph();
    const prefix = [
      event(1, "run_queued", { data: { workflowRevision: 1 } }),
      event(2, "run_started"),
      event(3, "node_started", gateIdentity()),
      event(4, "model_call_declared", gateModelSlotFields()),
      event(5, "model_resolved", gateModelReceiptFields()),
    ];
    const duplicate = reduceWorkflowRun(manifestForGraph(workflow), [
      ...prefix,
      event(6, "gate_evaluated", { ...gateIdentity(), data: gateDecision(true) }),
      event(7, "gate_evaluated", { ...gateIdentity(), data: gateDecision(true) }),
    ]);
    const torn = reduceWorkflowRun(manifestForGraph(workflow), [
      ...prefix,
      event(6, "gate_evaluated", {
        ...gateIdentity(),
        data: { supported: true, summary: "Missing bounded receipts." },
      }),
    ]);
    const forgedSource = reduceWorkflowRun(manifestForGraph(workflow), [
      ...prefix,
      event(6, "gate_evaluated", {
        ...gateIdentity(),
        data: {
          supported: true,
          sourceIds: ["source-001"],
          artifacts: [],
          summary: "A model-authored source is not observed inbound evidence.",
        },
      }),
    ]);
    const artifactWorkflow = gateGraph({ artifact: true });
    const forged = reduceWorkflowRun(manifestForGraph(artifactWorkflow), [
      event(1, "run_queued", { data: { workflowRevision: 1 } }),
      event(2, "run_started"),
      event(3, "node_started", gateIdentity()),
      event(4, "gate_evaluated", {
        ...gateIdentity(),
        data: {
          supported: false,
          sourceIds: [],
          artifacts: [{
            artifactId: "report",
            writerNodeId: "writer",
            path: "reports/report.md",
            size: 7,
            sha256: "c".repeat(64),
          }],
          summary: "Forged receipt.",
        },
      }),
    ]);

    expect(duplicate.diagnostics).toContainEqual(
      expect.objectContaining({ code: "duplicate-gate-decision", fatal: true }),
    );
    expect(torn.diagnostics).toContainEqual(
      expect.objectContaining({ code: "invalid-event-contract", fatal: true }),
    );
    expect(forgedSource.diagnostics).toContainEqual(
      expect.objectContaining({ code: "gate-decision-mismatch", fatal: true }),
    );
    expect(forged.diagnostics).toContainEqual(
      expect.objectContaining({ code: "gate-decision-mismatch", fatal: true }),
    );
  });

  it("rejects non-gate evidence receipts that are not supported by the terminal output", () => {
    const workflow = graph();
    workflow.evidence = {
      enabled: true,
      minimumIndependentSources: 1,
      requireArtifactReferences: false,
      onUnsupportedOutput: "route",
    };
    const identity = {
      executionId: "evidence-attempt",
      nodeId: "worker",
      attempt: 1,
      branchId: "entry",
    };
    const state = reduceWorkflowRun(manifestForGraph(workflow), [
      event(1, "run_queued", { data: { workflowRevision: 1 } }),
      event(2, "run_started"),
      event(3, "node_started", identity),
      event(4, "model_call_declared", modelSlotFields("evidence-attempt", 1, "entry")),
      event(5, "model_resolved", modelReceiptFields("evidence-attempt", 1, "entry")),
      event(6, "model_call_declared", evidenceModelSlotFields()),
      event(7, "model_resolved", evidenceModelReceiptFields()),
      event(8, "evidence_checked", {
        ...identity,
        data: {
          supported: true,
          sourceIds: ["source-001"],
          artifacts: [],
          summary: "Claimed support that the persisted output does not contain.",
        },
      }),
      event(9, "node_succeeded", {
        ...identity,
        data: {
          routeCondition: "evidence-supported",
          output: { answer: "No evidence-labelled fields exist." },
          artifacts: [],
        },
      }),
      event(10, "run_succeeded"),
    ]);

    expect(state.diagnostics).toContainEqual(
      expect.objectContaining({ code: "evidence-decision-mismatch", fatal: true }),
    );
    expect(state.status).not.toBe("succeeded");
  });

  it("rejects a failed Lean receipt followed by forged node success", () => {
    const workflow = graph();
    workflow.entryNodeId = "lean-proof";
    workflow.nodes = [{
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
    }];
    const identity = {
      executionId: "lean-attempt",
      nodeId: "lean-proof",
      attempt: 1,
      branchId: "entry",
    };
    const state = reduceWorkflowRun(manifestForGraph(workflow), [
      event(1, "run_queued", { data: { workflowRevision: 1 } }),
      event(2, "run_started"),
      event(3, "node_started", identity),
      event(4, "evidence_checked", {
        ...identity,
        data: {
          supported: false,
          sourceIds: [],
          artifacts: [],
          summary: "Lean failed.",
        },
      }),
      event(5, "node_succeeded", {
        ...identity,
        data: {
          routeCondition: "success",
          output: { kind: "lean4", status: "failed" },
          artifacts: [],
        },
      }),
      event(6, "run_succeeded"),
    ]);

    expect(state.diagnostics).toContainEqual(
      expect.objectContaining({ code: "lean-success-receipt-mismatch", fatal: true }),
    );
    expect(state.status).not.toBe("succeeded");
  });

  it("accepts verified Lean success only with both exact hashed host artifacts", () => {
    const workflow = graph();
    workflow.entryNodeId = "lean-proof";
    workflow.nodes = [{
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
    }];
    const identity = {
      executionId: "lean-attempt",
      nodeId: "lean-proof",
      attempt: 1,
      branchId: "entry",
    };
    const paths = trustedLeanArtifactPaths(manifest().id, identity.executionId);
    const artifacts = [
      { path: paths.proof, size: 1, sha256: "a".repeat(64) },
      { path: paths.log, size: 1, sha256: "b".repeat(64) },
    ];
    const state = reduceWorkflowRun(manifestForGraph(workflow), [
      event(1, "run_queued", { data: { workflowRevision: 1 } }),
      event(2, "run_started"),
      event(3, "node_started", identity),
      event(4, "node_succeeded", {
        ...identity,
        data: {
          routeCondition: "success",
          output: { kind: "lean4", status: "verified" },
          artifacts,
        },
      }),
      event(5, "run_succeeded"),
    ]);

    expect(state.diagnostics).toEqual([]);
    expect(state.status).toBe("succeeded");
  });
});
