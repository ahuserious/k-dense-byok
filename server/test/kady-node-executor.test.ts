import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterAll, describe, expect, it, vi } from "vitest";
import type {
  DagFusionDelegationReceipt,
  DagFusionDelegationUsageSettlement,
  DelegateDagFusionNodeOptions,
  OwnedDelegationRequest,
  TrustedDagFusionCompactionAudit,
} from "../pi-packages/dag-fusion-drive/index.ts";
import type { ProjectPaths } from "../src/projects.ts";
import {
  createKadyWorkflowNodeExecutor,
  KADY_WORKFLOW_READ_ONLY_AGENT,
  type KadyHostedFusionTransportOptions,
  type KadySupervisedDelegateOptions,
  type KadyWorkflowUsageAdmission,
  type KadyWorkflowUsageReserver,
  type TrustedLeanVerifier,
} from "../src/workflows/kady-node-executor.ts";
import {
  workflowModelCallSlotForNode,
  workflowModelCallSlotsForNode,
  type WorkflowModelCallSlot,
  type WorkflowModelResolutionReceipt,
} from "../src/workflows/run-state.ts";
import type {
  ModelRequest,
  NodeSpecV1,
  WorkflowGraphDocument,
  WorkflowNode,
  WorkflowSettingsV1,
} from "../src/workflows/schema.ts";
import { validateWorkflowGraphDocument } from "../src/workflows/validate.ts";
import {
  resolveWorkflowModel,
  type ResolvedWorkflowModel,
  type WorkflowModelResolutionContext,
} from "../src/agent/workflow-model-resolution.ts";
import type {
  WorkflowNodeExecutor,
  WorkflowNodeExecutorContext,
} from "../src/workflows/runner.ts";
import type {
  HostedOpenRouterFusionRequest,
  HostedOpenRouterFusionResult,
} from "../src/workflows/hosted-fusion.ts";
import { trustedLeanArtifactPaths } from "../src/workflows/lean4-artifacts.ts";
import type {
  SupervisedWorkflowBudgetDescriptorV1,
} from "../src/workflows/supervised-budget.ts";

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "kady-node-executor-"));

afterAll(() => fs.rmSync(TEST_ROOT, { recursive: true, force: true }));

function projectPaths(projectId = "node-executor-test"): ProjectPaths {
  const root = path.join(TEST_ROOT, projectId);
  const sandbox = path.join(root, "sandbox");
  const kadyDir = path.join(sandbox, ".kady");
  const workflowsDir = path.join(kadyDir, "workflows");
  const workflowBudgetDir = path.join(workflowsDir, "budget");
  const modalDir = path.join(kadyDir, "modal");
  const piDir = path.join(sandbox, ".pi");
  fs.mkdirSync(sandbox, { recursive: true });
  return {
    id: projectId,
    root,
    projectJson: path.join(root, "project.json"),
    sandbox,
    uploadDir: path.join(sandbox, "user_data"),
    kadyDir,
    runsDir: path.join(kadyDir, "runs"),
    notebookDir: path.join(kadyDir, "notebook"),
    provenanceDir: path.join(kadyDir, "provenance"),
    workflowsDir,
    workflowDefinitionsDir: path.join(workflowsDir, "definitions"),
    workflowRunsDir: path.join(workflowsDir, "runs"),
    workflowBudgetDir,
    workflowReservationsDir: path.join(workflowBudgetDir, "reservations"),
    modalDir,
    modalJobsDir: path.join(modalDir, "jobs"),
    modalReservationsDir: path.join(modalDir, "reservations"),
    modalCacheDir: path.join(modalDir, "cache"),
    modalEnvironmentsDir: path.join(modalDir, "environments"),
    skillsDir: path.join(piDir, "skills"),
    sessionsDir: path.join(piDir, "sessions"),
  };
}

function writeProjectArtifact(
  relativePath: string,
  contents: string,
): { path: string; size: number; sha256: string } {
  const absolutePath = path.join(projectPaths().sandbox, relativePath);
  const bytes = Buffer.from(contents, "utf-8");
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, bytes);
  return {
    path: relativePath,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function exactModel(
  model = "qwen3:32b",
  reasoning: ModelRequest["requested"]["reasoning"] = "high",
): ModelRequest {
  return {
    requested: {
      source: "fixed",
      provider: "ollama",
      model,
      auth: { kind: "local" },
      reasoning,
    },
    resolution: { mode: "exact" },
  };
}

function localModel(
  provider: "ollama" | "openai-compatible",
  model: string,
  reasoning: ModelRequest["requested"]["reasoning"],
): ModelRequest {
  return {
    requested: {
      source: "fixed",
      provider,
      model,
      auth: { kind: provider === "ollama" ? "local" : "custom" },
      reasoning,
    },
    resolution: { mode: "exact" },
  };
}

function nonReasoningPiModel(provider: string, id: string): Model<Api> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider,
    baseUrl: "http://127.0.0.1.invalid/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_768,
    maxTokens: 8_192,
  };
}

function openRouterModel(model = "anthropic/claude-sonnet-4"): ModelRequest {
  return {
    requested: {
      source: "fixed",
      provider: "openrouter",
      model,
      auth: { kind: "api-key" },
      reasoning: "high",
    },
    resolution: { mode: "exact" },
  };
}

function graph(node: WorkflowNode, overrides: Partial<WorkflowGraphDocument> = {}): WorkflowGraphDocument {
  return {
    schemaVersion: "1.0",
    id: "executor-graph",
    name: "Executor graph",
    entryNodeId: node.id,
    defaultModel: exactModel(),
    limits: {
      maxIterations: 4,
      maxModelCalls: 32,
      maxParallelism: 4,
      maxSubagents: 4,
      timeoutMs: 30_000,
      maxTokens: 32_000,
      maxCostUsd: 8,
      maxRetries: 1,
    },
    evidence: {
      enabled: false,
      minimumIndependentSources: 0,
      requireArtifactReferences: false,
      onUnsupportedOutput: "route",
    },
    nodes: [node],
    edges: [],
    ...overrides,
  };
}

function baseNode(
  kind: WorkflowNode["kind"],
): Pick<WorkflowNode, "id" | "name" | "kind" | "terminal" | "workspace"> {
  return {
    id: "step",
    name: "Step",
    kind,
    terminal: true,
    workspace: { isolation: "read-only", writePaths: [] },
  } as Pick<WorkflowNode, "id" | "name" | "kind" | "terminal" | "workspace">;
}

function resolvedReceipt(request: ModelRequest): {
  model: Model<Api>;
  receipt: WorkflowModelResolutionReceipt;
} {
  const requested = request.requested.source === "fixed"
    ? request.requested
    : {
        source: "fixed" as const,
        provider: "ollama",
        model: "qwen3:32b",
        auth: { kind: "local" as const },
        reasoning: request.requested.reasoning,
      };
  return {
    model: {
      provider: requested.provider,
      id: requested.model,
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    } as Model<Api>,
    receipt: {
      request: structuredClone(request),
      resolved: {
        provider: requested.provider,
        model: requested.model,
        auth: { kind: requested.auth.kind },
        reasoning: requested.reasoning,
        runtime: requested.auth.kind === "local" ? "local" : "pi",
      },
      fallbackUsed: false,
    },
  };
}

function completedReceipt(
  request: OwnedDelegationRequest,
  value: unknown,
  status: "completed" | "failed" = "completed",
): DagFusionDelegationReceipt {
  const usage = {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 1,
    toolCalls: 0,
    durationMs: 5,
  };
  return {
    identity: {
      requestId: request.requestId,
      ownerRunId: request.ownerRunId,
      nodeId: request.nodeId,
    },
    requested: {
      agent: request.agent,
      model: request.model,
      thinking: request.thinking,
    },
    resolved: {
      agent: request.agent,
      model: `${request.model}:${request.thinking}`,
      thinking: request.thinking,
      launchContractDigest: "launch-contract",
    },
    response: {
      requestId: request.requestId,
      ownerRunId: request.ownerRunId,
      nodeId: request.nodeId,
      status,
      agent: request.agent,
      model: `${request.model}:${request.thinking}`,
      thinking: request.thinking,
      launchContractDigest: "launch-contract",
      runId: `pirun-${request.requestId}`,
      ...(status === "completed"
        ? { result: { kind: "structured" as const, value }, usage }
        : { error: "provider failed", usage }),
    },
    usage: { ...usage, totalTokens: 15 },
    progress: {
      started: true,
      model: `${request.model}:${request.thinking}`,
      tokens: 15,
      toolCalls: 0,
      durationMs: 5,
    },
  };
}

type HostCall = {
  request: OwnedDelegationRequest;
  options: KadySupervisedDelegateOptions;
};

class FakeHost {
  readonly calls: HostCall[] = [];

  constructor(
    private readonly values: unknown[],
    private readonly events?: string[],
  ) {}

  async delegate(
    request: OwnedDelegationRequest,
    options: DelegateDagFusionNodeOptions,
  ): Promise<DagFusionDelegationReceipt> {
    this.events?.push(`delegate:${request.nodeId.split(":").at(-1)}`);
    this.calls.push({ request: structuredClone(request), options });
    if (this.values.length === 0) throw new Error("Fake host response queue exhausted.");
    const value = this.values.shift();
    const receipt = completedReceipt(request, value);
    await options.reconcileUsage({
      identity: receipt.identity,
      reason: "terminal-response",
      responseStatus: "completed",
      usage: receipt.response.status === "completed" ? receipt.response.usage : undefined,
      progress: receipt.progress,
    });
    return receipt;
  }
}

function contextFor(
  document: WorkflowGraphDocument,
  events: string[] = [],
  signal = new AbortController().signal,
): WorkflowNodeExecutorContext {
  const node = document.nodes[0];
  const declared = new Map<string, WorkflowModelCallSlot>();
  const expected = workflowModelCallSlotsForNode(document, node);
  for (const slot of expected) declared.set(slot.id, structuredClone(slot));
  return {
    projectId: "node-executor-test",
    runId: "wfrun_executor-test",
    workflowId: document.id,
    workflowRevision: 1,
    graph: {
      id: document.id,
      settings: document.settings,
      defaultModel: document.defaultModel,
      limits: document.limits,
      rescue: document.rescue,
      evidence: document.evidence,
      artifacts: document.artifacts,
    },
    node,
    runInput: { goal: "Reach the node goal." },
    attempt: 1,
    executionId: "dagx_executor-test",
    branchId: "main",
    resumed: false,
    inbound: [],
    expectedModelCallSlots: expected,
    declareModelCallSlot(slotId) {
      const slot = workflowModelCallSlotForNode(document, node, slotId);
      if (!slot) throw new Error(`bad dynamic slot ${slotId}`);
      events.push(`declare:${slotId}`);
      declared.set(slot.id, structuredClone(slot));
      return slot;
    },
    recordModelResolution(slotId, receipt) {
      const slot = declared.get(slotId);
      if (!slot || JSON.stringify(slot.request) !== JSON.stringify(receipt.request)) {
        throw new Error(`bad receipt ${slotId}`);
      }
      events.push(`record:${slotId}`);
    },
    recordCompactionCheck(check) {
      events.push(`compaction:${check.phase}:${check.passed}`);
    },
    signal,
  };
}

function executorFor(
  host: { delegate: FakeHost["delegate"] },
  document: WorkflowGraphDocument,
  options: {
    reconcileUsage?: (settlement: DagFusionDelegationUsageSettlement) => void;
    onReserve?: (admission: KadyWorkflowUsageAdmission) => void;
    reserveUsage?: KadyWorkflowUsageReserver;
    verifyLean?: TrustedLeanVerifier;
    onResolve?: (request: ModelRequest) => void;
    resolveModel?: (
      request: ModelRequest,
      context: WorkflowModelResolutionContext,
    ) => Promise<ResolvedWorkflowModel>;
    runHostedFusion?: (
      request: HostedOpenRouterFusionRequest,
      transport?: KadyHostedFusionTransportOptions,
    ) => Promise<HostedOpenRouterFusionResult>;
    assertChildRuntimeReady?: (paths: ProjectPaths) => void;
    readCompactionAudit?: (
      sandboxRoot: string,
      childRunId: string,
    ) => TrustedDagFusionCompactionAudit;
  } = {},
): WorkflowNodeExecutor {
  const paths = projectPaths();
  return createKadyWorkflowNodeExecutor({
    reserveUsage: options.reserveUsage ?? ((admission) => {
      options.onReserve?.(admission);
      return {
        reconcile(settlement) {
          options.reconcileUsage?.(settlement);
        },
      };
    }),
    verifyLean: options.verifyLean,
    dependencies: {
      pathsForProject: () => paths,
      loadManifest: () => ({
        projectId: paths.id,
        workflowId: document.id,
        workflowRevision: 1,
      }),
      getDelegationSession: async () => ({ host }),
      resolveModel: async (request, resolutionContext) => {
        options.onResolve?.(request);
        if (options.resolveModel) {
          return options.resolveModel(request, resolutionContext);
        }
        return resolvedReceipt(request);
      },
      assertChildRuntimeReady: options.assertChildRuntimeReady ?? (() => {}),
      readCompactionAudit: options.readCompactionAudit ?? (() => ({
        occurred: false,
        checks: [],
      })),
      ...(options.runHostedFusion
        ? { runHostedFusion: options.runHostedFusion }
        : {}),
    },
  });
}

const analysis = (answer: string) => ({
  answer,
  evidence: [`evidence:${answer}`],
  uncertainties: [],
});

function supervisedDescriptor(slotId: string): SupervisedWorkflowBudgetDescriptorV1 {
  return {
    version: 1,
    reservationId: `wbres_${createHash("sha256").update(slotId).digest("hex").slice(0, 32)}`,
    runId: "wfrun_executor-test",
    executionId: "dagx_executor-test",
    attempt: 1,
    slotId,
    provider: "openrouter",
    authType: "api_key",
  };
}

describe("production Kady DAG node executor", () => {
  it("records exact resolution before an explicit read-only Delegation V2 call", async () => {
    const node: WorkflowNode = {
      ...baseNode("agent"),
      kind: "agent",
      prompt: "Analyze the dataset.",
      model: exactModel("qwen3:14b", "low"),
    };
    const document = graph(node, {
      limits: {
        ...graph(node).limits,
        maxTokens: 2_000,
        maxCostUsd: 2,
      },
    });
    const events: string[] = [];
    const reconciled = vi.fn();
    const descriptor = supervisedDescriptor("agent");
    let admission: KadyWorkflowUsageAdmission | undefined;
    const host = new FakeHost([analysis("supported")], events);
    const result = await executorFor(host, document, {
      reserveUsage: (value) => {
        admission = value;
        events.push(`reserve:${value.slotId}`);
        return { descriptor, reconcile: reconciled };
      },
    })(
      contextFor(document, events),
    );

    expect(events.slice(0, 3)).toEqual([
      "record:agent",
      "reserve:agent",
      "delegate:agent",
    ]);
    expect(events.filter((event) => event === "reserve:agent")).toHaveLength(1);
    expect(host.calls).toHaveLength(1);
    expect(host.calls[0].request).toMatchObject({
      agent: KADY_WORKFLOW_READ_ONLY_AGENT,
      context: "fresh",
      model: "ollama/qwen3:14b",
      thinking: "low",
      turnBudget: { maxTurns: 12, graceTurns: 0 },
      toolBudget: { soft: 24, hard: 32, block: "*" },
      skill: false,
      artifacts: false,
      result: { kind: "structured" },
    });
    expect(host.calls[0].options.limits).toEqual({ maxTokens: 2_000, maxCostUsd: 0 });
    expect(host.calls[0].options.supervisedBudget).toEqual(descriptor);
    expect(admission).toMatchObject({
      slotId: "agent",
      maxTokens: 2_000,
      maxCostUsd: 0,
      modelCallCount: 1,
      runMaxTokens: 2_000,
      runMaxCostUsd: 2,
      runMaxModelCalls: 32,
      modelReceipt: {
        resolved: {
          provider: "ollama",
          model: "qwen3:14b",
          reasoning: "low",
          runtime: "local",
        },
      },
    });
    expect(reconciled).toHaveBeenCalledOnce();
    expect(result.output).toMatchObject({
      kind: "agent",
      runtime: "pi-dynamic-workflows",
      kernelRunId: "kernel_dagx_executor-test",
      answer: "supported",
    });
  });

  it("feeds NodeSpec token and cost caps into durable usage admission", async () => {
    const node: WorkflowNode = {
      ...baseNode("agent"),
      kind: "agent",
      prompt: "Analyze within the frozen NodeSpec budget.",
      model: openRouterModel(),
      settings: { budget: { maxTokens: 1_000, maxCostUsd: 0.25 } },
    };
    const document = graph(node);
    let admission: KadyWorkflowUsageAdmission | undefined;
    const host = new FakeHost([analysis("bounded")]);

    await executorFor(host, document, {
      reserveUsage: (value) => {
        admission = value;
        return {
          descriptor: supervisedDescriptor(value.slotId),
          reconcile() {},
        };
      },
    })(contextFor(document));

    expect(admission).toMatchObject({
      maxTokens: 1_000,
      maxCostUsd: 0.25,
      runMaxTokens: 32_000,
      runMaxCostUsd: 8,
    });
    expect(host.calls[0].options.limits).toEqual({
      maxTokens: 1_000,
      maxCostUsd: 0.25,
    });
  });

  it("executes with a settings-only model and reasoning override", async () => {
    const settingsModel = openRouterModel("settings-only-model");
    const node: WorkflowNode = {
      ...baseNode("agent"),
      kind: "agent",
      prompt: "Use the authoritative NodeSpec model.",
      settings: {
        model: settingsModel,
        reasoningEffort: "xhigh",
        hyperparameters: { temperature: 1, top_p: 1, sampling: {} },
        conditions: { exists: [] },
        harness: "pi",
        databases: [],
        skills: { mode: "auto", list: [] },
        subagents: { mode: "auto" },
        autonomy: "strict",
        deliberation: {
          bestOfNPersonalityCount: 2,
          mimeographs: { mode: "auto", personalityRefs: [] },
        },
        billingMode: "inherit",
      },
    };
    const document = graph(node);
    document.settings = { defaultHarness: "pi", databases: [] };
    delete document.defaultModel;
    const host = new FakeHost([analysis("settings model executed")]);

    await executorFor(host, document)(contextFor(document));

    expect(host.calls).toHaveLength(1);
    expect(host.calls[0].request).toMatchObject({
      model: "openrouter/settings-only-model",
      thinking: "xhigh",
    });
  });

  it("keeps an explicit evidence-policy evaluator separate from the primary NodeSpec model", () => {
    const primary = openRouterModel("settings-primary");
    const evaluator = openRouterModel("policy-evaluator");
    const node: WorkflowNode = {
      ...baseNode("agent"),
      kind: "agent",
      prompt: "Analyze with an independent evidence check.",
      settings: { model: primary },
      evidence: {
        enabled: true,
        minimumIndependentSources: 0,
        requireArtifactReferences: false,
        onUnsupportedOutput: "fail",
        evaluator,
      },
    };
    const document = graph(node);

    expect(validateWorkflowGraphDocument(document)).toMatchObject({ ok: true });
    expect(workflowModelCallSlotsForNode(document, node)).toEqual([
      { id: "agent", request: primary },
      { id: "evidence-policy-evaluator", request: evaluator },
    ]);
  });

  it("keeps every explicit Council role model when settings.model is present", () => {
    const settingsModel = openRouterModel("settings-primary");
    const memberA = openRouterModel("council-member-a");
    const memberB = openRouterModel("council-member-b");
    const chair = openRouterModel("council-chair");
    const node: WorkflowNode = {
      ...baseNode("council"),
      kind: "council",
      goal: "Review the evidence.",
      settings: { model: settingsModel },
      members: [
        { id: "a", role: "Reviewer A", model: memberA },
        { id: "b", role: "Reviewer B", model: memberB },
      ],
      chair,
      rounds: 1,
      preserveMinorityReports: true,
    };
    const document = graph(node);
    const validation = validateWorkflowGraphDocument(document);

    expect(validation).toMatchObject({ ok: false });
    if (!validation.ok) {
      expect(validation.issues).toContainEqual(expect.objectContaining({
        code: "ambiguous-node-spec-model",
        path: "/nodes/0/settings/model",
      }));
    }
    expect(workflowModelCallSlotsForNode(document, node)).toEqual([
      { id: "council-round-1-member-a", request: memberA },
      { id: "council-round-1-member-b", request: memberB },
      { id: "council-round-1-chair", request: chair },
    ]);
  });

  it("keeps every explicit Fusion role model when settings.model is present", () => {
    const settingsModel = openRouterModel("settings-primary");
    const memberA = openRouterModel("fusion-member-a");
    const memberB = openRouterModel("fusion-member-b");
    const synthesizer = openRouterModel("fusion-synthesizer");
    const node: WorkflowNode = {
      ...baseNode("fusion"),
      kind: "fusion",
      goal: "Fuse the panel.",
      settings: { model: settingsModel },
      fusion: {
        mode: "kady-panel",
        members: [
          { id: "a", role: "Analyst A", model: memberA },
          { id: "b", role: "Analyst B", model: memberB },
        ],
        synthesizer,
        rounds: 1,
      },
      preserveMinorityReports: true,
    };
    const document = graph(node);
    const validation = validateWorkflowGraphDocument(document);

    expect(validation).toMatchObject({ ok: false });
    if (!validation.ok) {
      expect(validation.issues).toContainEqual(expect.objectContaining({
        code: "ambiguous-node-spec-model",
        path: "/nodes/0/settings/model",
      }));
    }
    expect(workflowModelCallSlotsForNode(document, node)).toEqual([
      { id: "fusion-round-1-member-a", request: memberA },
      { id: "fusion-round-1-member-b", request: memberB },
      { id: "fusion-synthesizer", request: synthesizer },
    ]);
  });

  it("keeps hosted Fusion member and judge models when settings.model is present", () => {
    const settingsModel = openRouterModel("settings-primary");
    const memberA = openRouterModel("hosted-member-a");
    const memberB = openRouterModel("hosted-member-b");
    const judge = openRouterModel("hosted-judge");
    const node: WorkflowNode = {
      ...baseNode("fusion"),
      kind: "fusion",
      goal: "Keep every hosted role request exact.",
      settings: { model: settingsModel },
      fusion: {
        mode: "openrouter-router",
        router: openRouterModel("openrouter/fusion"),
        members: [
          { id: "a", role: "Analyst A", model: memberA },
          { id: "b", role: "Analyst B", model: memberB },
        ],
        judge,
      },
      preserveMinorityReports: true,
    };
    const document = graph(node);
    const validation = validateWorkflowGraphDocument(document);

    expect(validation).toMatchObject({ ok: false });
    if (!validation.ok) {
      expect(validation.issues).toContainEqual(expect.objectContaining({
        code: "ambiguous-node-spec-model",
        path: "/nodes/0/settings/model",
      }));
    }
    expect(workflowModelCallSlotsForNode(document, node)).toEqual([
      { id: "fusion-panel-a", request: memberA },
      { id: "fusion-panel-b", request: memberB },
      { id: "fusion-judge-deliberation", request: judge },
      { id: "fusion-judge-final", request: judge },
    ]);
  });

  it("uses settings.model only for repeated Best-of-N candidates", () => {
    const settingsModel = openRouterModel("settings-primary");
    const evaluator = openRouterModel("best-of-n-evaluator");
    const node: WorkflowNode = {
      ...baseNode("best-of-n"),
      kind: "best-of-n",
      goal: "Choose the strongest candidate.",
      settings: { model: settingsModel },
      candidateCount: 2,
      evaluator,
    };
    const document = graph(node);

    expect(validateWorkflowGraphDocument(document)).toMatchObject({ ok: true });
    expect(workflowModelCallSlotsForNode(document, node)).toEqual([
      { id: "candidate-1", request: settingsModel },
      { id: "candidate-2", request: settingsModel },
      { id: "candidate-evaluator", request: evaluator },
    ]);
  });

  it("keeps an explicit evidence-gate evaluator when settings.model is present", () => {
    const settingsModel = openRouterModel("settings-primary");
    const evaluator = openRouterModel("gate-evaluator");
    const node: WorkflowNode = {
      ...baseNode("evidence-gate"),
      kind: "evidence-gate",
      settings: { model: settingsModel },
      checks: ["claim-support"],
      artifactIds: [],
      evaluator,
      onUnsupportedOutput: "fail",
    };
    const document = graph(node);
    const validation = validateWorkflowGraphDocument(document);

    expect(validation).toMatchObject({ ok: false });
    if (!validation.ok) {
      expect(validation.issues).toContainEqual(expect.objectContaining({
        code: "ambiguous-node-spec-model",
        path: "/nodes/0/settings/model",
      }));
    }
    expect(workflowModelCallSlotsForNode(document, node)).toEqual([
      { id: "evidence-evaluator", request: evaluator },
    ]);
  });

  it.each([
    {
      label: "conditions.when",
      settings: { conditions: { when: "inputs.ready" } },
      code: "node-conditions-enforcement-pending",
      unit: "S4",
    },
    {
      label: "conditions.exists",
      settings: { conditions: { exists: ["inputs/missing.csv"] } },
      code: "node-conditions-enforcement-pending",
      unit: "S4",
    },
    {
      label: "harness",
      settings: { harness: "codex" },
      code: "node-harness-enforcement-pending",
      unit: "S4",
    },
    {
      label: "hyperparameters.temperature",
      settings: { hyperparameters: { temperature: 0.2 } },
      code: "node-hyperparameters-enforcement-pending",
      unit: "S4",
    },
    {
      label: "hyperparameters.top_p",
      settings: { hyperparameters: { top_p: 0.9 } },
      code: "node-hyperparameters-enforcement-pending",
      unit: "S4",
    },
    {
      label: "hyperparameters.sampling",
      settings: { hyperparameters: { sampling: { seed: 7 } } },
      code: "node-hyperparameters-enforcement-pending",
      unit: "S4",
    },
    {
      label: "databases",
      settings: { databases: ["pubmed"] },
      code: "node-databases-enforcement-pending",
      unit: "S4",
    },
    {
      label: "skills mode",
      settings: { skills: { mode: "manual" } },
      code: "node-skills-mode-enforcement-pending",
      unit: "S4",
    },
    {
      label: "skills list",
      settings: { skills: { list: ["database-lookup"] } },
      code: "node-skills-list-enforcement-pending",
      unit: "S4",
    },
    {
      label: "subagents mode",
      settings: { subagents: { mode: "auto-manual" } },
      code: "node-subagents-mode-enforcement-pending",
      unit: "S4",
    },
    {
      label: "autonomy",
      settings: { autonomy: "loose" },
      code: "node-autonomy-enforcement-pending",
      unit: "S4",
    },
    {
      label: "deliberation.personalityStoreRef",
      settings: { deliberation: { personalityStoreRef: "scientific-agents/v1" } },
      code: "node-deliberation-enforcement-pending",
      unit: "S5",
    },
    {
      label: "deliberation.bestOfNPersonalityCount",
      settings: { deliberation: { bestOfNPersonalityCount: 4 } },
      code: "node-deliberation-enforcement-pending",
      unit: "S5",
    },
    {
      label: "deliberation.mimeographs.mode",
      settings: { deliberation: { mimeographs: { mode: "manual" } } },
      code: "node-deliberation-enforcement-pending",
      unit: "S5",
    },
    {
      label: "deliberation.mimeographs.personalityRefs",
      settings: {
        deliberation: {
          mimeographs: { personalityRefs: ["skeptical-reviewer"] },
        },
      },
      code: "node-deliberation-enforcement-pending",
      unit: "S5",
    },
    {
      label: "billing mode",
      settings: { billingMode: "subscription" },
      code: "node-billing-mode-enforcement-pending",
      unit: "S4",
    },
    {
      label: "workflow default harness",
      workflowSettings: { defaultHarness: "codex" },
      code: "workflow-default-harness-enforcement-pending",
      unit: "S4",
    },
    {
      label: "workflow databases",
      workflowSettings: { databases: ["arxiv"] },
      code: "workflow-databases-enforcement-pending",
      unit: "S4",
    },
  ] satisfies Array<{
    label: string;
    settings?: NodeSpecV1;
    workflowSettings?: WorkflowSettingsV1;
    code: string;
    unit: "S4" | "S5";
  }>)("fails closed on non-default $label before receipt, reservation, or provider call", async ({
    settings,
    workflowSettings,
    code,
    unit,
  }) => {
    const node: WorkflowNode = {
      ...baseNode("agent"),
      kind: "agent",
      prompt: "Do not execute an unbound NodeSpec field.",
      ...(settings ? { settings } : {}),
    };
    const document = graph(node);
    if (workflowSettings) document.settings = workflowSettings;
    const events: string[] = [];
    const host = new FakeHost([analysis("must not run")], events);
    const onReserve = vi.fn();
    const onResolve = vi.fn();

    const validation = validateWorkflowGraphDocument(document);
    expect(validation).toMatchObject({ ok: false });
    if (!validation.ok) {
      expect(validation.issues).toContainEqual(expect.objectContaining({
        code,
        message: expect.stringContaining(`(${unit})`),
      }));
    }

    await expect(
      executorFor(host, document, { onReserve, onResolve })(
        contextFor(document, events),
      ),
    ).rejects.toMatchObject({
      code: "WORKFLOW_NODE_INVALID_CONTEXT",
      message: expect.stringContaining(`(${unit})`),
    });

    expect(events.some((event) => event.startsWith("record:"))).toBe(false);
    expect(onReserve).not.toHaveBeenCalled();
    expect(onResolve).not.toHaveBeenCalled();
    expect(host.calls).toHaveLength(0);
  });

  it.each([
    ["ollama", "qwen3:32b"],
    ["openai-compatible", "lab/model"],
  ] as const)(
    "rejects unsupported exact %s reasoning before receipt, reservation, or delegation",
    async (provider, modelId) => {
      const modelRequest = localModel(provider, modelId, "high");
      const node: WorkflowNode = {
        ...baseNode("agent"),
        kind: "agent",
        prompt: "Analyze privately.",
        model: modelRequest,
      };
      const document = graph(node);
      const events: string[] = [];
      const host = new FakeHost([analysis("must not run")], events);
      const authenticateModel = vi.fn(async () => {});
      const onReserve = vi.fn();

      await expect(
        executorFor(host, document, {
          onReserve,
          resolveModel: (request, resolutionContext) => resolveWorkflowModel(
            request,
            resolutionContext,
            {
              resolveFixedModel: (candidate) => nonReasoningPiModel(
                candidate.provider,
                candidate.model,
              ),
              authenticateModel,
            },
          ),
        })(contextFor(document, events)),
      ).rejects.toMatchObject({ code: "WORKFLOW_MODEL_UNSUPPORTED_REQUEST" });

      expect(authenticateModel).not.toHaveBeenCalled();
      expect(onReserve).not.toHaveBeenCalled();
      expect(host.calls).toHaveLength(0);
      expect(events).not.toContain("record:agent");
    },
  );

  it.each([
    ["ollama", "qwen3:32b"],
    ["openai-compatible", "lab/model"],
  ] as const)(
    "dispatches exact non-reasoning %s requests only when reasoning is off",
    async (provider, modelId) => {
      const modelRequest = localModel(provider, modelId, "off");
      const node: WorkflowNode = {
        ...baseNode("agent"),
        kind: "agent",
        prompt: "Analyze privately without extended reasoning.",
        model: modelRequest,
      };
      const document = graph(node);
      const events: string[] = [];
      const host = new FakeHost([analysis("private result")], events);
      const authenticateModel = vi.fn(async () => {});
      let admission: KadyWorkflowUsageAdmission | undefined;

      const result = await executorFor(host, document, {
        onReserve: (value) => {
          admission = value;
          events.push(`reserve:${value.slotId}`);
        },
        resolveModel: (request, resolutionContext) => resolveWorkflowModel(
          request,
          resolutionContext,
          {
            resolveFixedModel: (candidate) => nonReasoningPiModel(
              candidate.provider,
              candidate.model,
            ),
            authenticateModel,
          },
        ),
      })(contextFor(document, events));

      expect(authenticateModel).toHaveBeenCalledOnce();
      expect(events.slice(0, 3)).toEqual([
        "record:agent",
        "reserve:agent",
        "delegate:agent",
      ]);
      expect(host.calls[0].request).toMatchObject({
        model: `${provider}/${modelId}`,
        thinking: "off",
      });
      expect(admission?.modelReceipt.resolved).toMatchObject({
        provider,
        model: modelId,
        reasoning: "off",
        runtime: provider === "ollama" ? "local" : "custom",
      });
      expect(result.output).toMatchObject({ answer: "private result" });
    },
  );

  it("blocks a resolver receipt that claims unsupported reasoning for its actual model", async () => {
    const modelRequest = localModel("ollama", "qwen3:32b", "high");
    const node: WorkflowNode = {
      ...baseNode("agent"),
      kind: "agent",
      prompt: "Do not dispatch a clamped request.",
      model: modelRequest,
    };
    const document = graph(node);
    const events: string[] = [];
    const host = new FakeHost([analysis("must not run")], events);
    const onReserve = vi.fn();

    await expect(
      executorFor(host, document, {
        onReserve,
        resolveModel: async (request) => ({
          model: nonReasoningPiModel("ollama", "qwen3:32b"),
          receipt: resolvedReceipt(request).receipt,
        }),
      })(contextFor(document, events)),
    ).rejects.toMatchObject({ code: "WORKFLOW_MODEL_RESOLUTION_MISMATCH" });

    expect(onReserve).not.toHaveBeenCalled();
    expect(host.calls).toHaveLength(0);
    expect(events).not.toContain("record:agent");
  });

  it("inherits workflow evidence, declares one evaluator, and splits the node budget by call", async () => {
    const node: WorkflowNode = {
      ...baseNode("agent"),
      kind: "agent",
      prompt: "Analyze the cited claim.",
      model: openRouterModel("vendor/worker"),
    };
    const document = graph(node, {
      defaultModel: openRouterModel("vendor/default-evaluator"),
      limits: {
        ...graph(node).limits,
        maxModelCalls: 2,
        maxSubagents: 1,
        maxTokens: 1_000,
        maxCostUsd: 2,
      },
      evidence: {
        enabled: true,
        minimumIndependentSources: 1,
        requireArtifactReferences: false,
        onUnsupportedOutput: "fail",
      },
    });
    const admissions: KadyWorkflowUsageAdmission[] = [];
    const host = new FakeHost([
      analysis("supported"),
      {
        supported: true,
        summary: "The catalogued citation supports the answer.",
        sourceIds: ["source-001"],
        unsupportedClaims: [],
      },
    ]);

    const result = await executorFor(host, document, {
      onReserve: (admission) => admissions.push(admission),
    })(contextFor(document));

    expect(host.calls.map((call) => call.request.nodeId.split(":").at(-1))).toEqual([
      "agent",
      "evidence-policy-evaluator",
    ]);
    expect(admissions.map((admission) => admission.slotId)).toEqual([
      "agent",
      "evidence-policy-evaluator",
    ]);
    expect(admissions.map((admission) => admission.maxTokens)).toEqual([500, 500]);
    expect(admissions.map((admission) => admission.maxCostUsd)).toEqual([1, 1]);
    expect(admissions.reduce((sum, admission) => sum + admission.modelCallCount, 0)).toBe(2);
    expect(result.evidence).toEqual({
      supported: true,
      summary: "The catalogued citation supports the answer.",
      sourceIds: ["source-001"],
    });
    expect(host.calls[1].request.task).toContain(
      "Perform a model-assisted support check, not a proof of truth.",
    );
  });

  it("lets a node disable inherited common evidence without dispatching an evaluator", async () => {
    const node: WorkflowNode = {
      ...baseNode("agent"),
      kind: "agent",
      prompt: "Run without the inherited evidence evaluator.",
      evidence: {
        enabled: false,
        minimumIndependentSources: 0,
        requireArtifactReferences: false,
        onUnsupportedOutput: "fail",
      },
    };
    const document = graph(node, {
      evidence: {
        enabled: true,
        minimumIndependentSources: 1,
        requireArtifactReferences: false,
        onUnsupportedOutput: "fail",
      },
    });
    const host = new FakeHost([analysis("node override")]);

    const result = await executorFor(host, document)(contextFor(document));

    expect(host.calls.map((call) => call.request.nodeId.split(":").at(-1))).toEqual(["agent"]);
    expect(result.evidence).toBeUndefined();
  });

  it("rejects evidence identifiers invented outside the bounded node catalog", async () => {
    const node: WorkflowNode = {
      ...baseNode("agent"),
      kind: "agent",
      prompt: "Analyze one catalogued citation.",
    };
    const document = graph(node, {
      evidence: {
        enabled: true,
        minimumIndependentSources: 0,
        requireArtifactReferences: false,
        onUnsupportedOutput: "fail",
      },
    });
    const host = new FakeHost([
      analysis("bounded"),
      {
        supported: true,
        summary: "Cites an identifier that was never offered.",
        sourceIds: ["source-999"],
        unsupportedClaims: [],
      },
    ]);

    await expect(executorFor(host, document)(contextFor(document))).rejects.toMatchObject({
      code: "WORKFLOW_DELEGATION_INVALID_RESULT",
    });
    expect(host.calls).toHaveLength(2);
  });

  it("records trusted child compaction checks and fails visibly on a bad post-check", async () => {
    const node: WorkflowNode = {
      ...baseNode("agent"),
      kind: "agent",
      prompt: "Analyze after compaction.",
    };
    const document = graph(node);
    const events: string[] = [];
    const context = contextFor(document, events);

    await expect(executorFor(new FakeHost([analysis("unsafe")]), document, {
      readCompactionAudit: () => ({
        occurred: true,
        checks: [
          { attempt: 1, phase: "pre", passed: true },
          { attempt: 1, phase: "post", passed: false, errorCode: "POST_MISMATCH" },
        ],
      }),
    })(context)).rejects.toMatchObject({
      code: "WORKFLOW_POST_COMPACTION_CHECK_FAILED",
      retryable: true,
    });
    expect(events).toContain("compaction:pre:true");
    expect(events).toContain("compaction:post:false");
  });

  it("fails closed as a pre-check when the trusted child audit cannot be read", async () => {
    const node: WorkflowNode = {
      ...baseNode("agent"),
      kind: "agent",
      prompt: "Require the audit attestation.",
    };
    const document = graph(node);
    const events: string[] = [];

    await expect(executorFor(new FakeHost([analysis("untrusted")]), document, {
      readCompactionAudit: () => {
        throw new Error("sidecar missing");
      },
    })(contextFor(document, events))).rejects.toMatchObject({
      code: "WORKFLOW_PRE_COMPACTION_CHECK_FAILED",
      retryable: true,
    });
    expect(events).toContain("compaction:pre:false");
  });

  it("gives a rescue retry the bounded prior failure and an explicit correction directive", async () => {
    const node: WorkflowNode = {
      ...baseNode("agent"),
      kind: "agent",
      prompt: "Analyze the evidence.",
    };
    const document = graph(node);
    const host = new FakeHost([analysis("corrected")]);
    const context = contextFor(document);
    context.attempt = 2;
    context.previousError = {
      code: "WORKFLOW_POST_COMPACTION_CHECK_FAILED",
      message: "The trusted post-compaction receipt disagreed.",
      retryable: true,
    };

    await executorFor(host, document)(context);

    expect(host.calls[0].request.task).toContain(
      "Verified previous failure: {\"code\":\"WORKFLOW_POST_COMPACTION_CHECK_FAILED\"",
    );
    expect(host.calls[0].request.task).toContain(
      "Rescue attempt 2: diagnose and correct this failure without changing the graph or its limits.",
    );
  });

  it("declares research slots sequentially and stops immediately when every criterion is met", async () => {
    const node: WorkflowNode = {
      ...baseNode("research-until-goal"),
      kind: "research-until-goal",
      goal: "Determine whether the claim is supported.",
      completionCriteria: ["Primary source checked", "Contradiction checked"],
      limits: { maxIterations: 3 },
    };
    const document = graph(node);
    const incomplete = {
      ...analysis("not yet"),
      goalMet: false,
      remainingGaps: ["Contradiction remains"],
      criteria: [
        { criterion: node.completionCriteria[0], satisfied: true, evidence: "source" },
        { criterion: node.completionCriteria[1], satisfied: false, evidence: "not checked" },
      ],
    };
    const complete = {
      ...analysis("supported"),
      goalMet: true,
      remainingGaps: [],
      criteria: node.completionCriteria.map((criterion) => ({
        criterion,
        satisfied: true,
        evidence: "checked",
      })),
    };
    const events: string[] = [];
    const host = new FakeHost([incomplete, complete, complete], events);
    const descriptors = new Map<string, SupervisedWorkflowBudgetDescriptorV1>();
    const result = await executorFor(host, document, {
      reserveUsage: (item) => {
        const descriptor = supervisedDescriptor(item.slotId);
        descriptors.set(item.slotId, descriptor);
        return { descriptor, reconcile() {} };
      },
    })(contextFor(document, events));

    expect(host.calls.map((call) => call.request.nodeId.split(":").at(-1))).toEqual([
      "research-iteration-1",
      "research-iteration-2",
    ]);
    expect(events).toContain("declare:research-iteration-2");
    expect(events.indexOf("declare:research-iteration-2")).toBeLessThan(
      events.indexOf("record:research-iteration-2"),
    );
    expect(host.calls.map((call) => call.options.supervisedBudget)).toEqual([
      descriptors.get("research-iteration-1"),
      descriptors.get("research-iteration-2"),
    ]);
    expect(result.output).toMatchObject({ goalMet: true, iterations: 2 });
  });

  it("runs Council members before the chair in every round and preserves minority reports", async () => {
    const node: WorkflowNode = {
      ...baseNode("council"),
      kind: "council",
      goal: "Choose the defensible interpretation.",
      members: [
        { id: "optimist", role: "Support strongest claim", model: openRouterModel("vendor/model-a") },
        { id: "skeptic", role: "Challenge strongest claim", model: openRouterModel("vendor/model-b") },
      ],
      chair: openRouterModel("vendor/chair"),
      rounds: 2,
      preserveMinorityReports: true,
    };
    const member = (position: string) => ({
      position,
      rationale: `${position} rationale`,
      evidence: [position],
      concerns: [],
    });
    const chair = (decision: string) => ({
      decision,
      rationale: `${decision} rationale`,
      consensus: false,
      minorityReports: [{ memberId: "skeptic", report: "The evidence is too weak." }],
    });
    const host = new FakeHost([
      member("yes-1"), member("no-1"), chair("qualified-1"),
      member("yes-2"), member("no-2"), chair("qualified-2"),
    ]);
    const document = graph(node);
    const admissions: KadyWorkflowUsageAdmission[] = [];
    const result = await executorFor(host, document, {
      onReserve: (admission) => admissions.push(admission),
    })(contextFor(document));

    expect(host.calls.map((call) => call.request.nodeId.split(":").at(-1))).toEqual([
      "council-round-1-member-optimist",
      "council-round-1-member-skeptic",
      "council-round-1-chair",
      "council-round-2-member-optimist",
      "council-round-2-member-skeptic",
      "council-round-2-chair",
    ]);
    expect(admissions.map((admission) => admission.slotId)).toEqual([
      "council-round-1-member-optimist",
      "council-round-1-member-skeptic",
      "council-round-1-chair",
      "council-round-2-member-optimist",
      "council-round-2-member-skeptic",
      "council-round-2-chair",
    ]);
    expect(admissions.reduce((sum, admission) => sum + admission.maxTokens, 0))
      .toBeLessThanOrEqual(document.limits.maxTokens);
    expect(admissions.reduce((sum, admission) => sum + admission.maxCostUsd, 0))
      .toBeLessThanOrEqual(document.limits.maxCostUsd);
    expect(result.output).toMatchObject({
      kind: "council",
      decision: "qualified-2",
      consensus: false,
      minorityReports: [{ memberId: "skeptic", report: "The evidence is too weak." }],
    });
  });

  it("budgets Council deliberation plus one common evidence evaluator", async () => {
    const node: WorkflowNode = {
      ...baseNode("council"),
      kind: "council",
      goal: "Reach a supported decision.",
      members: [
        { id: "alpha", role: "Primary analysis", model: openRouterModel("vendor/alpha") },
        { id: "beta", role: "Adversarial analysis", model: openRouterModel("vendor/beta") },
      ],
      chair: openRouterModel("vendor/chair"),
      rounds: 1,
      preserveMinorityReports: false,
    };
    const document = graph(node, {
      defaultModel: openRouterModel("vendor/evidence"),
      limits: {
        ...graph(node).limits,
        maxModelCalls: 4,
        maxSubagents: 1,
        maxTokens: 4_000,
        maxCostUsd: 4,
      },
      evidence: {
        enabled: true,
        minimumIndependentSources: 1,
        requireArtifactReferences: false,
        onUnsupportedOutput: "fail",
      },
    });
    const host = new FakeHost([
      { position: "alpha", rationale: "alpha rationale", evidence: ["doi:alpha"], concerns: [] },
      { position: "beta", rationale: "beta rationale", evidence: ["doi:beta"], concerns: [] },
      { decision: "qualified", rationale: "chair rationale", consensus: true, minorityReports: [] },
      {
        supported: true,
        summary: "At least one catalogued source supports the chair decision.",
        sourceIds: ["source-001"],
        unsupportedClaims: [],
      },
    ]);
    const admissions: KadyWorkflowUsageAdmission[] = [];

    const result = await executorFor(host, document, {
      onReserve: (admission) => admissions.push(admission),
    })(contextFor(document));

    expect(host.calls.map((call) => call.request.nodeId.split(":").at(-1))).toEqual([
      "council-round-1-member-alpha",
      "council-round-1-member-beta",
      "council-round-1-chair",
      "evidence-policy-evaluator",
    ]);
    expect(admissions).toHaveLength(4);
    expect(admissions.every((admission) => admission.maxTokens === 1_000)).toBe(true);
    expect(admissions.every((admission) => admission.maxCostUsd === 1)).toBe(true);
    expect(admissions.reduce((sum, admission) => sum + admission.modelCallCount, 0)).toBe(4);
    expect(result.evidence).toMatchObject({ supported: true, sourceIds: ["source-001"] });
  });

  it("executes Kady panel Fusion as member calls followed by an exact synthesizer", async () => {
    const node: WorkflowNode = {
      ...baseNode("fusion"),
      kind: "fusion",
      goal: "Fuse complementary analyses.",
      fusion: {
        mode: "kady-panel",
        members: [
          { id: "local", role: "Private local analysis", model: exactModel("local") },
          { id: "remote", role: "Remote analysis", model: exactModel("remote") },
        ],
        synthesizer: exactModel("synth"),
        rounds: 1,
      },
      preserveMinorityReports: true,
    };
    const member = (analysisText: string) => ({
      analysis: analysisText,
      evidence: [analysisText],
      disagreements: [],
    });
    const host = new FakeHost([
      member("local result"),
      member("remote result"),
      {
        answer: "fused result",
        rationale: "Uses both results",
        consensus: false,
        minorityReports: [{ memberId: "local", report: "Local caveat" }],
      },
    ]);
    const document = graph(node);
    const result = await executorFor(host, document)(contextFor(document));

    expect(host.calls.map((call) => call.request.nodeId.split(":").at(-1))).toEqual([
      "fusion-round-1-member-local",
      "fusion-round-1-member-remote",
      "fusion-synthesizer",
    ]);
    expect(result.output).toMatchObject({
      kind: "kady-panel-fusion",
      answer: "fused result",
      minorityReports: [{ memberId: "local", report: "Local caveat" }],
    });
  });

  it("uses best-of-2 by default and returns only the evaluator-selected candidate", async () => {
    const node: WorkflowNode = {
      ...baseNode("best-of-n"),
      kind: "best-of-n",
      goal: "Find the stronger answer.",
    };
    const host = new FakeHost([
      analysis("first"),
      analysis("second"),
      { winner: 2, rationale: "Better evidence", scores: [40, 90] },
    ]);
    const document = graph(node);
    const result = await executorFor(host, document)(contextFor(document));

    expect(host.calls).toHaveLength(3);
    expect(result.output).toMatchObject({
      kind: "best-of-n",
      candidateCount: 2,
      winner: 2,
      answer: "second",
      scores: [40, 90],
    });
  });

  it("routes a deterministic missing-artifact verdict without asking a model", async () => {
    const node: WorkflowNode = {
      ...baseNode("evidence-gate"),
      kind: "evidence-gate",
      checks: ["artifact-exists"],
      artifactIds: ["report"],
      onUnsupportedOutput: "route",
    };
    const document = graph(node, {
      artifacts: [{
        id: "report",
        name: "Report",
        kind: "report",
        writerNodeId: "step",
        path: "missing/report.md",
      }],
    });
    const host = new FakeHost([]);
    const result = await executorFor(host, document)(contextFor(document));

    expect(host.calls).toHaveLength(0);
    expect(result.evidence).toMatchObject({ supported: false });
    expect(result.output).toMatchObject({
      kind: "evidence-gate",
      supported: false,
      artifactChecks: [{ artifactId: "report", exists: false }],
    });
  });

  it("combines a model evidence check with the independent-source threshold", async () => {
    const node: WorkflowNode = {
      ...baseNode("evidence-gate"),
      kind: "evidence-gate",
      checks: ["citations", "claim-support"],
      artifactIds: [],
      evaluator: exactModel("evidence-checker"),
      onUnsupportedOutput: "route",
    };
    const document = graph(node, {
      evidence: {
        enabled: true,
        minimumIndependentSources: 2,
        requireArtifactReferences: false,
        onUnsupportedOutput: "route",
      },
    });
    const host = new FakeHost([{
      supported: true,
      summary: "One source supports the claim.",
      sourceIds: ["source-001"],
      unsupportedClaims: [],
    }]);
    const context = contextFor(document);
    context.inbound = [{
      edgeId: "writer-gate",
      fromNodeId: "writer",
      condition: "success",
      executionId: "dagx_writer",
      artifacts: [],
      output: { evidence: ["doi:10.1/example", "doi:10.2/example"] },
    }];
    const result = await executorFor(host, document)(context);

    expect(host.calls.map((call) => call.request.nodeId.split(":").at(-1))).toEqual([
      "evidence-evaluator",
    ]);
    expect(result.evidence).toMatchObject({ supported: false });
    expect(result.evidence?.summary).toContain("2 required");
  });

  it("returns an unsupported verdict when the evaluator invents a catalog id", async () => {
    const node: WorkflowNode = {
      ...baseNode("evidence-gate"),
      kind: "evidence-gate",
      checks: ["claim-support"],
      artifactIds: [],
      evaluator: exactModel("evidence-checker"),
      onUnsupportedOutput: "fail",
    };
    const document = graph(node, {
      evidence: {
        enabled: true,
        minimumIndependentSources: 1,
        requireArtifactReferences: false,
        onUnsupportedOutput: "fail",
      },
    });
    const host = new FakeHost([{
      supported: true,
      summary: "A fabricated identifier appears sufficient.",
      sourceIds: ["source-999"],
      unsupportedClaims: [],
    }]);
    const context = contextFor(document);
    context.inbound = [{
      edgeId: "writer-gate",
      fromNodeId: "writer",
      condition: "success",
      executionId: "dagx_writer",
      artifacts: [],
      output: { evidence: ["doi:10.1/observed"] },
    }];

    const result = await executorFor(host, document)(context);

    expect(result.evidence).toMatchObject({
      supported: false,
      sourceIds: [],
      artifacts: [],
      summary: expect.stringContaining("outside the observed source catalog"),
    });
  });

  it("accepts only a current exact-path receipt from the declared writer", async () => {
    const node: WorkflowNode = {
      ...baseNode("evidence-gate"),
      kind: "evidence-gate",
      checks: ["artifact-exists"],
      artifactIds: ["exact-report"],
      onUnsupportedOutput: "route",
    };
    const relativePath = "gate-artifacts/exact-report.md";
    const document = graph(node, {
      artifacts: [{
        id: "exact-report",
        name: "Exact report",
        kind: "report",
        writerNodeId: "writer",
        path: relativePath,
      }],
    });
    const receipt = writeProjectArtifact(relativePath, "verified gate report\n");
    const context = contextFor(document);
    context.inbound = [{
      edgeId: "writer-gate",
      fromNodeId: "writer",
      condition: "success",
      executionId: "dagx_writer",
      artifacts: [receipt],
    }];

    const result = await executorFor(new FakeHost([]), document)(context);

    expect(result.evidence).toEqual({
      supported: true,
      summary: "Deterministic artifact requirements passed.",
      sourceIds: [],
      artifacts: [{
        artifactId: "exact-report",
        writerNodeId: "writer",
        ...receipt,
      }],
    });
  });

  it.each([
    {
      label: "wrong writer",
      fromNodeId: "other-writer",
      receiptPath: "gate-artifacts/wrong-writer.md",
      declaredPath: "gate-artifacts/wrong-writer.md",
    },
    {
      label: "near-match path",
      fromNodeId: "writer",
      receiptPath: "gate-artifacts/near-match.md.bak",
      declaredPath: "gate-artifacts/near-match.md",
    },
  ])("rejects a $label artifact receipt", async ({ fromNodeId, receiptPath, declaredPath }) => {
    const node: WorkflowNode = {
      ...baseNode("evidence-gate"),
      kind: "evidence-gate",
      checks: ["artifact-exists"],
      artifactIds: ["bounded-report"],
      onUnsupportedOutput: "route",
    };
    const document = graph(node, {
      artifacts: [{
        id: "bounded-report",
        name: "Bounded report",
        kind: "report",
        writerNodeId: "writer",
        path: declaredPath,
      }],
    });
    const receipt = writeProjectArtifact(receiptPath, "not exact evidence\n");
    const context = contextFor(document);
    context.inbound = [{
      edgeId: "writer-gate",
      fromNodeId,
      condition: "success",
      executionId: "dagx_writer",
      artifacts: [receipt],
    }];

    const result = await executorFor(new FakeHost([]), document)(context);

    expect(result.evidence).toMatchObject({ supported: false, artifacts: [] });
  });

  it("rejects an exact receipt after its file becomes stale", async () => {
    const node: WorkflowNode = {
      ...baseNode("evidence-gate"),
      kind: "evidence-gate",
      checks: ["artifact-exists"],
      artifactIds: ["stale-report"],
      onUnsupportedOutput: "route",
    };
    const relativePath = "gate-artifacts/stale-report.md";
    const document = graph(node, {
      artifacts: [{
        id: "stale-report",
        name: "Stale report",
        kind: "report",
        writerNodeId: "writer",
        path: relativePath,
      }],
    });
    const staleReceipt = writeProjectArtifact(relativePath, "original evidence\n");
    writeProjectArtifact(relativePath, "replacement evidence\n");
    const context = contextFor(document);
    context.inbound = [{
      edgeId: "writer-gate",
      fromNodeId: "writer",
      condition: "success",
      executionId: "dagx_writer",
      artifacts: [staleReceipt],
    }];

    const result = await executorFor(new FakeHost([]), document)(context);

    expect(result.evidence).toMatchObject({ supported: false, artifacts: [] });
  });

  it.skipIf(process.platform === "win32")(
    "rejects an exact receipt whose declared path is a symbolic link",
    async () => {
      const node: WorkflowNode = {
        ...baseNode("evidence-gate"),
        kind: "evidence-gate",
        checks: ["artifact-exists"],
        artifactIds: ["linked-report"],
        onUnsupportedOutput: "route",
      };
      const relativePath = "gate-artifacts/linked-report.md";
      const document = graph(node, {
        artifacts: [{
          id: "linked-report",
          name: "Linked report",
          kind: "report",
          writerNodeId: "writer",
          path: relativePath,
        }],
      });
      const outside = path.join(TEST_ROOT, "outside-linked-report.md");
      const contents = Buffer.from("linked evidence\n", "utf-8");
      fs.writeFileSync(outside, contents);
      const absolutePath = path.join(projectPaths().sandbox, relativePath);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.rmSync(absolutePath, { force: true });
      fs.symlinkSync(outside, absolutePath);
      const context = contextFor(document);
      context.inbound = [{
        edgeId: "writer-gate",
        fromNodeId: "writer",
        condition: "success",
        executionId: "dagx_writer",
        artifacts: [{
          path: relativePath,
          size: contents.length,
          sha256: createHash("sha256").update(contents).digest("hex"),
        }],
      }];

      const result = await executorFor(new FakeHost([]), document)(context);

      expect(result.evidence).toMatchObject({ supported: false, artifacts: [] });
    },
  );

  it("uses a node evidence override instead of the workflow evidence policy", async () => {
    const node: WorkflowNode = {
      ...baseNode("evidence-gate"),
      kind: "evidence-gate",
      checks: ["citations", "claim-support"],
      artifactIds: [],
      evaluator: exactModel("evidence-checker"),
      evidence: {
        enabled: true,
        minimumIndependentSources: 1,
        requireArtifactReferences: false,
        onUnsupportedOutput: "route",
      },
      onUnsupportedOutput: "route",
    };
    const document = graph(node, {
      evidence: {
        enabled: true,
        minimumIndependentSources: 3,
        requireArtifactReferences: true,
        onUnsupportedOutput: "route",
      },
    });
    const host = new FakeHost([{
      supported: true,
      summary: "The node-level evidence requirement passed.",
      sourceIds: ["source-001"],
      unsupportedClaims: [],
    }]);
    const context = contextFor(document);
    context.inbound = [{
      edgeId: "writer-gate",
      fromNodeId: "writer",
      condition: "success",
      executionId: "dagx_writer",
      artifacts: [],
      output: { evidence: ["doi:10.1/example"] },
    }];

    const result = await executorFor(host, document)(context);

    expect(host.calls).toHaveLength(1);
    expect(result.evidence).toMatchObject({ supported: true });
  });

  it("uses a common-policy evaluator as the explicit gate fallback without a duplicate call", async () => {
    const node: WorkflowNode = {
      ...baseNode("evidence-gate"),
      kind: "evidence-gate",
      checks: ["claim-support"],
      artifactIds: [],
      evidence: {
        enabled: true,
        minimumIndependentSources: 0,
        requireArtifactReferences: false,
        onUnsupportedOutput: "route",
        evaluator: exactModel("policy-evidence-checker"),
      },
      onUnsupportedOutput: "route",
    };
    const document = graph(node);
    const host = new FakeHost([{
      supported: true,
      summary: "The gate's authored support check passed.",
      sourceIds: [],
      unsupportedClaims: [],
    }]);

    const result = await executorFor(host, document)(contextFor(document));

    expect(host.calls.map((call) => call.request.nodeId.split(":").at(-1))).toEqual([
      "evidence-evaluator",
    ]);
    expect(host.calls[0].request.model).toBe("ollama/policy-evidence-checker");
    expect(result.evidence).toMatchObject({ supported: true });
  });

  it("disables common evidence augmentation without bypassing an explicit gate", async () => {
    const node: WorkflowNode = {
      ...baseNode("evidence-gate"),
      kind: "evidence-gate",
      checks: ["claim-support"],
      artifactIds: [],
      evaluator: exactModel("evidence-checker"),
      evidence: {
        enabled: false,
        minimumIndependentSources: 20,
        requireArtifactReferences: true,
        onUnsupportedOutput: "fail",
      },
      onUnsupportedOutput: "route",
    };
    const document = graph(node, {
      evidence: {
        enabled: true,
        minimumIndependentSources: 2,
        requireArtifactReferences: true,
        onUnsupportedOutput: "fail",
      },
    });
    const host = new FakeHost([{
      supported: true,
      summary: "The authored claim-support check passed.",
      sourceIds: [],
      unsupportedClaims: [],
    }]);

    const result = await executorFor(host, document)(contextFor(document));

    expect(host.calls).toHaveLength(1);
    expect(result.evidence).toMatchObject({ supported: true });
  });

  it("uses the injected trusted Lean verifier after a bounded solve proposal", async () => {
    const node: WorkflowNode = {
      ...baseNode("lean4"),
      kind: "lean4",
      goal: "Prove the identity.",
      theorem: "∀ n : Nat, n + 0 = n",
      mode: "solve",
      solverModel: exactModel("lean-solver"),
      mathlib: true,
      skill: "byom-dag-fusion",
    };
    const host = new FakeHost([{
      proofBody: "simpa using Nat.add_zero n",
      translationNotes: ["Natural numbers only"],
    }]);
    const verifyLean = vi.fn<TrustedLeanVerifier>(async (request) => ({
      status: "verified",
      summary: "Lean accepted the theorem without placeholders.",
      theoremName: "kady_dag_test",
      normalizedStatement: "forall n : Nat, n + 0 = n",
      toolchain: "leanprover/lean4:v4.19.0",
      mathlibRevision: "abc123",
      artifacts: [],
    }));
    const document = graph(node);
    const result = await executorFor(host, document, { verifyLean })(contextFor(document));

    expect(host.calls[0].request.skill).toBe("byom-dag-fusion");
    expect(verifyLean).toHaveBeenCalledWith(expect.objectContaining({
      skill: "byom-dag-fusion",
      mode: "solve",
      theorem: "∀ n : Nat, n + 0 = n",
      proofBody: "simpa using Nat.add_zero n",
    }));
    expect(result.output).toMatchObject({
      kind: "lean4",
      status: "verified",
      theoremName: "kady_dag_test",
    });
  });

  it("runs Lean verify mode only through the trusted verifier", async () => {
    const node: WorkflowNode = {
      ...baseNode("lean4"),
      kind: "lean4",
      goal: "Verify the supplied theorem.",
      theorem: "theorem reflexive (n : Nat) : n = n := rfl",
      mode: "verify",
      mathlib: false,
      skill: "byom-dag-fusion",
    };
    const host = new FakeHost([]);
    const verifyLean = vi.fn<TrustedLeanVerifier>(async () => ({
      status: "verified",
      summary: "Lean accepted reflexive.",
      theoremName: "reflexive",
    }));
    const document = graph(node);
    const result = await executorFor(host, document, { verifyLean })(contextFor(document));

    expect(host.calls).toHaveLength(0);
    expect(verifyLean).toHaveBeenCalledWith(expect.objectContaining({
      mode: "verify",
      theorem: node.theorem,
    }));
    expect(result.output).toMatchObject({ status: "verified", theoremName: "reflexive" });
  });

  it("never lets a model evidence evaluator override a trusted Lean failure", async () => {
    const node: WorkflowNode = {
      ...baseNode("lean4"),
      kind: "lean4",
      goal: "Verify the reviewed theorem.",
      theorem: "theorem impossible : False := by contradiction",
      mode: "verify",
      mathlib: false,
      skill: "byom-dag-fusion",
      evidence: {
        enabled: true,
        minimumIndependentSources: 0,
        requireArtifactReferences: false,
        onUnsupportedOutput: "fail",
      },
    };
    const host = new FakeHost([{
      supported: true,
      summary: "The model evaluator claims the output is supported.",
      sourceIds: [],
      unsupportedClaims: [],
    }]);
    const verifyLean = vi.fn<TrustedLeanVerifier>(async () => ({
      status: "failed",
      summary: "Lean rejected the reviewed theorem.",
      theoremName: "impossible",
      artifacts: [],
    }));
    const document = graph(node);

    const result = await executorFor(host, document, { verifyLean })(contextFor(document));

    expect(host.calls).toHaveLength(1);
    expect(result.evidence).toMatchObject({
      supported: false,
      summary: expect.stringContaining("Lean rejected"),
    });
  });

  it("returns trusted Lean failure artifacts when common evidence is disabled", async () => {
    const node: WorkflowNode = {
      ...baseNode("lean4"),
      kind: "lean4",
      goal: "Verify the reviewed theorem.",
      theorem: "theorem impossible : False := by contradiction",
      mode: "verify",
      mathlib: false,
      skill: "byom-dag-fusion",
    };
    const artifactPaths = trustedLeanArtifactPaths(
      "wfrun_executor-test",
      "dagx_executor-test",
    );
    const artifacts = [
      { path: artifactPaths.proof, size: 48 },
      { path: artifactPaths.log, size: 96 },
    ];
    const verifyLean = vi.fn<TrustedLeanVerifier>(async () => ({
      status: "failed",
      summary: "Lean rejected the reviewed theorem.",
      theoremName: "impossible",
      artifacts,
    }));
    const document = graph(node);
    const host = new FakeHost([]);

    const result = await executorFor(host, document, { verifyLean })(contextFor(document));

    expect(host.calls).toEqual([]);
    expect(result).toMatchObject({
      artifacts,
      evidence: {
        supported: false,
        summary: "Lean rejected the reviewed theorem.",
        sourceIds: [],
      },
      output: { kind: "lean4", status: "failed", theoremName: "impossible" },
    });
  });

  it("rejects a solver response that attempts to replace the host-owned theorem", async () => {
    const node: WorkflowNode = {
      ...baseNode("lean4"),
      kind: "lean4",
      goal: "Prove a nontrivial equality.",
      theorem: "1 = 2",
      mode: "solve",
      solverModel: exactModel("lean-solver"),
      mathlib: true,
      skill: "byom-dag-fusion",
    };
    const host = new FakeHost([{
      leanSource: "theorem weakened : True := by trivial",
      theoremName: "weakened",
      translationNotes: [],
    }]);
    const verifyLean = vi.fn<TrustedLeanVerifier>();
    const document = graph(node);

    await expect(executorFor(host, document, { verifyLean })(contextFor(document)))
      .rejects.toMatchObject({ code: "WORKFLOW_DELEGATION_INVALID_RESULT" });
    expect(verifyLean).not.toHaveBeenCalled();
  });

  it("fails Lean preflight before model resolution, reservation, or provider dispatch", async () => {
    const node: WorkflowNode = {
      ...baseNode("lean4"),
      kind: "lean4",
      goal: "Prove an equality.",
      theorem: "1 = 1",
      mode: "solve",
      solverModel: exactModel("lean-solver"),
      mathlib: true,
      skill: "byom-dag-fusion",
    };
    const verifyImplementation = vi.fn<TrustedLeanVerifier>();
    const preflight = vi.fn(async () => ({
      status: "unavailable" as const,
      executionPolicy: "disabled" as const,
      summary: "Lean execution is disabled by server policy.",
    }));
    const verifyLean = Object.assign(verifyImplementation, { preflight });
    const host = new FakeHost([{
      proofBody: "rfl",
      translationNotes: [],
    }]);
    const resolved: ModelRequest[] = [];
    const reserved: KadyWorkflowUsageAdmission[] = [];
    const document = graph(node);

    await expect(executorFor(host, document, {
      verifyLean,
      onResolve: (request) => resolved.push(request),
      onReserve: (admission) => reserved.push(admission),
    })(contextFor(document))).rejects.toMatchObject({
      code: "WORKFLOW_LEAN_VERIFIER_UNAVAILABLE",
    });
    expect(preflight).toHaveBeenCalledOnce();
    expect(verifyImplementation).not.toHaveBeenCalled();
    expect(resolved).toEqual([]);
    expect(reserved).toEqual([]);
    expect(host.calls).toEqual([]);
  });

  it("propagates in-flight cancellation to the V2 host and reconciles the cancelled call", async () => {
    const node: WorkflowNode = {
      ...baseNode("agent"),
      kind: "agent",
      prompt: "Wait for cancellation.",
    };
    const document = graph(node);
    const observed = { aborted: false, reconciled: false, stopped: false };
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    let sawAbort!: () => void;
    const didSeeAbort = new Promise<void>((resolve) => {
      sawAbort = resolve;
    });
    let releaseChild!: () => void;
    const childMayStop = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    const host = {
      async delegate(request: OwnedDelegationRequest, options: DelegateDagFusionNodeOptions) {
        started();
        await new Promise<void>((resolve) => {
          const onAbort = async () => {
            observed.aborted = true;
            sawAbort();
            await childMayStop;
            await options.reconcileUsage({
              identity: {
                requestId: request.requestId,
                ownerRunId: request.ownerRunId,
                nodeId: request.nodeId,
              },
              reason: "caller-aborted",
              progress: { started: true, tokens: 0, toolCalls: 0, durationMs: 1 },
            });
            observed.reconciled = true;
            observed.stopped = true;
            resolve();
          };
          options.signal?.addEventListener("abort", onAbort, { once: true });
        });
        throw new Error("cancelled");
      },
    };
    const controller = new AbortController();
    const execution = executorFor(host, document)(contextFor(document, [], controller.signal));
    let executionSettled = false;
    void execution.then(
      () => { executionSettled = true; },
      () => { executionSettled = true; },
    );
    await didStart;
    controller.abort("user cancelled");
    await didSeeAbort;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(executionSettled).toBe(false);
    expect(observed).toEqual({ aborted: true, reconciled: false, stopped: false });

    releaseChild();
    await expect(execution).rejects.toMatchObject({ code: "WORKFLOW_NODE_ABORTED" });
    expect(observed).toEqual({ aborted: true, reconciled: true, stopped: true });
  });

  it("refuses budget admission before dispatching a paid call", async () => {
    const node: WorkflowNode = {
      ...baseNode("agent"),
      kind: "agent",
      prompt: "Do not run when admission fails.",
      model: openRouterModel(),
    };
    const document = graph(node);
    const host = new FakeHost([analysis("unused")]);
    const reserveUsage = vi.fn<KadyWorkflowUsageReserver>(() => {
      throw Object.assign(new Error("project spend cap exhausted"), {
        code: "WORKFLOW_BUDGET_EXCEEDED",
      });
    });

    await expect(
      executorFor(host, document, { reserveUsage })(contextFor(document)),
    ).rejects.toMatchObject({ code: "WORKFLOW_BUDGET_EXCEEDED" });
    expect(reserveUsage).toHaveBeenCalledOnce();
    expect(host.calls).toHaveLength(0);
  });

  it("fails a missing child audit package before budget admission or provider dispatch", async () => {
    const node: WorkflowNode = {
      ...baseNode("agent"),
      kind: "agent",
      prompt: "Do not dispatch without the child audit package.",
    };
    const document = graph(node);
    const host = new FakeHost([analysis("unused")]);
    const reserveUsage = vi.fn<KadyWorkflowUsageReserver>(() => ({ reconcile() {} }));

    await expect(executorFor(host, document, {
      reserveUsage,
      assertChildRuntimeReady: () => {
        throw new Error("canonical dag-fusion-drive package is missing");
      },
    })(contextFor(document))).rejects.toThrow(/package is missing/);

    expect(reserveUsage).not.toHaveBeenCalled();
    expect(host.calls).toHaveLength(0);
  });

  it("reconciles a reservation when the V2 host rejects before owning it", async () => {
    const node: WorkflowNode = {
      ...baseNode("agent"),
      kind: "agent",
      prompt: "Exercise pre-launch failure.",
    };
    const document = graph(node);
    const reconcile = vi.fn();
    const reserveUsage = vi.fn<KadyWorkflowUsageReserver>(() => ({ reconcile }));
    const host = {
      async delegate(): Promise<DagFusionDelegationReceipt> {
        throw new Error("extension session unavailable");
      },
    };

    await expect(
      executorFor(host, document, { reserveUsage })(contextFor(document)),
    ).rejects.toThrow("extension session unavailable");
    expect(reconcile).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
      reason: "protocol-error",
      progress: expect.objectContaining({ started: false }),
    }));
  });

  it("fails safe by reconciling a terminal receipt even if a host omits its callback", async () => {
    const node: WorkflowNode = {
      ...baseNode("agent"),
      kind: "agent",
      prompt: "Exercise host callback postcondition.",
    };
    const document = graph(node);
    const reconcile = vi.fn();
    const host = {
      async delegate(request: OwnedDelegationRequest) {
        return completedReceipt(request, analysis("recovered settlement"));
      },
    };

    const result = await executorFor(host, document, {
      reserveUsage: () => ({ reconcile }),
    })(contextFor(document));

    expect(result.output).toMatchObject({ answer: "recovered settlement" });
    expect(reconcile).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
      reason: "terminal-response",
      responseStatus: "completed",
      usage: expect.objectContaining({ input: 10, output: 5 }),
    }));
  });

  it("fails visibly on non-completed terminal responses", async () => {
    const node: WorkflowNode = {
      ...baseNode("agent"),
      kind: "agent",
      prompt: "Fail.",
    };
    const document = graph(node);
    let delegationCalls = 0;
    const host = {
      async delegate(request: OwnedDelegationRequest, options: DelegateDagFusionNodeOptions) {
        delegationCalls += 1;
        const receipt = completedReceipt(request, null, "failed");
        await options.reconcileUsage({
          identity: receipt.identity,
          reason: "terminal-response",
          responseStatus: "failed",
          usage: receipt.response.status === "invalid_request" ? undefined : receipt.response.usage,
          progress: receipt.progress,
        });
        return receipt;
      },
    };
    await expect(executorFor(host, document)(contextFor(document))).rejects.toMatchObject({
      code: "WORKFLOW_DELEGATION_FAILED",
      retryable: true,
    });
    expect(delegationCalls).toBe(1);
  });

  it("rejects non-default hosted Fusion reasoning before receipts or provider work", async () => {
    const node: WorkflowNode = {
      ...baseNode("fusion"),
      kind: "fusion",
      goal: "Reject unsupported hosted reasoning plumbing.",
      settings: { reasoningEffort: "xhigh" },
      fusion: {
        mode: "openrouter-router",
        router: openRouterModel("openrouter/fusion"),
        members: [
          { id: "one", role: "One", model: openRouterModel("vendor/one") },
          { id: "two", role: "Two", model: openRouterModel("vendor/two") },
        ],
        judge: openRouterModel("vendor/judge"),
      },
      preserveMinorityReports: true,
    };
    const document = graph(node);
    const validation = validateWorkflowGraphDocument(document);
    const events: string[] = [];
    const onReserve = vi.fn();
    const onResolve = vi.fn();
    const runHostedFusion = vi.fn(async () => {
      throw new Error("hosted Fusion must not run");
    });

    expect(validation).toMatchObject({ ok: false });
    if (!validation.ok) {
      expect(validation.issues).toContainEqual(expect.objectContaining({
        code: "hosted-fusion-reasoning-enforcement-pending",
        path: "/nodes/0/settings/reasoningEffort",
        message: expect.stringContaining("fusion-topology unit (S5)"),
      }));
    }
    await expect(
      executorFor(new FakeHost([], events), document, {
        onReserve,
        onResolve,
        runHostedFusion,
      })(contextFor(document, events)),
    ).rejects.toMatchObject({
      code: "WORKFLOW_NODE_INVALID_CONTEXT",
      message: expect.stringContaining("fusion-topology unit (S5)"),
    });
    expect(events.some((event) => event.startsWith("record:"))).toBe(false);
    expect(onResolve).not.toHaveBeenCalled();
    expect(onReserve).not.toHaveBeenCalled();
    expect(runHostedFusion).not.toHaveBeenCalled();
  });

  it("keeps default-effort hosted Fusion slots identical to persisted requests", () => {
    const memberOne = openRouterModel("vendor/one");
    const memberTwo = openRouterModel("vendor/two");
    const judge = openRouterModel("vendor/judge");
    const node: WorkflowNode = {
      ...baseNode("fusion"),
      kind: "fusion",
      goal: "Keep the persisted hosted topology exact.",
      settings: { reasoningEffort: "high" },
      fusion: {
        mode: "openrouter-router",
        router: openRouterModel("openrouter/fusion"),
        members: [
          { id: "one", role: "One", model: memberOne },
          { id: "two", role: "Two", model: memberTwo },
        ],
        judge,
      },
      preserveMinorityReports: true,
    };
    const document = graph(node);

    expect(validateWorkflowGraphDocument(document)).toMatchObject({ ok: true });
    expect(workflowModelCallSlotsForNode(document, node)).toEqual([
      { id: "fusion-panel-one", request: memberOne },
      { id: "fusion-panel-two", request: memberTwo },
      { id: "fusion-judge-deliberation", request: judge },
      { id: "fusion-judge-final", request: judge },
    ]);
  });

  it("runs hosted OpenRouter Fusion as one compound reservation without a Pi-subagent slot", async () => {
    const node: WorkflowNode = {
      ...baseNode("fusion"),
      kind: "fusion",
      goal: "Use hosted Fusion.",
      fusion: {
        mode: "openrouter-router",
        router: {
          requested: {
            source: "fixed",
            provider: "openrouter",
            model: "openrouter/fusion",
            auth: { kind: "api-key" },
            reasoning: "high",
          },
          resolution: { mode: "exact" },
        },
        members: [
          { id: "one", role: "One", model: openRouterModel("vendor/one") },
          { id: "two", role: "Two", model: openRouterModel("vendor/two") },
        ],
        judge: openRouterModel("vendor/judge"),
      },
      preserveMinorityReports: true,
    };
    const host = new FakeHost([]);
    const document = graph(node, {
      limits: {
        ...graph(node).limits,
        maxSubagents: 0,
        maxTokens: 12_000,
        maxCostUsd: 6,
      },
    });
    const admissions: KadyWorkflowUsageAdmission[] = [];
    const events: string[] = [];
    const reconciled = vi.fn();
    const descriptor = supervisedDescriptor("fusion-hosted-compound");
    const hostedCalls: HostedOpenRouterFusionRequest[] = [];
    const hostedTransports: Array<KadyHostedFusionTransportOptions | undefined> = [];
    const runHostedFusion = vi.fn(async (
      request: HostedOpenRouterFusionRequest,
      transport?: KadyHostedFusionTransportOptions,
    ) => {
      events.push("hosted-provider");
      hostedCalls.push(request);
      hostedTransports.push(transport);
      const usage = {
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.5,
        turns: 1,
        toolCalls: 0,
        durationMs: 25,
      };
      await request.reconcileUsage({
        identity: request.identity,
        reason: "terminal-response",
        responseStatus: "completed",
        usage,
        progress: {
          started: true,
          model: "openrouter/openrouter/fusion",
          tokens: 150,
          toolCalls: 0,
          durationMs: 25,
        },
      });
      return { text: "Hosted fused answer", textTruncated: false, usage };
    });

    const result = await executorFor(host, document, {
      runHostedFusion,
      reserveUsage: (item) => {
        admissions.push(item);
        events.push(`reserve:${item.slotId}`);
        return { descriptor, reconcile: reconciled };
      },
    })(contextFor(document, events));

    expect(host.calls).toHaveLength(0);
    expect(events).toEqual([
      "record:fusion-panel-one",
      "record:fusion-panel-two",
      "record:fusion-judge-deliberation",
      "record:fusion-judge-final",
      "reserve:fusion-hosted-compound",
      "hosted-provider",
    ]);
    expect(runHostedFusion).toHaveBeenCalledOnce();
    expect(hostedTransports).toEqual([{ supervisedBudget: descriptor }]);
    expect(hostedCalls[0].resolved.members.map((member) => member.receipt.resolved)).toEqual([
      expect.objectContaining({ provider: "openrouter", model: "vendor/one", runtime: "openrouter-fusion" }),
      expect.objectContaining({ provider: "openrouter", model: "vendor/two", runtime: "openrouter-fusion" }),
    ]);
    expect(hostedCalls[0].resolved.judgeDeliberation.resolved).toMatchObject({
      model: "vendor/judge",
      runtime: "openrouter-fusion",
    });
    expect(hostedCalls[0].resolved.judgeFinal.resolved).toMatchObject({
      model: "vendor/judge",
      runtime: "openrouter-fusion",
    });
    expect(admissions).toHaveLength(1);
    expect(admissions[0]).toMatchObject({
      slotId: "fusion-hosted-compound",
      maxTokens: 12_000,
      maxCostUsd: 6,
      modelCallCount: 4,
      runMaxTokens: 12_000,
      runMaxCostUsd: 6,
      runMaxModelCalls: 32,
      modelReceipt: {
        resolved: {
          provider: "openrouter",
          model: "openrouter/fusion",
          runtime: "openrouter-fusion",
        },
      },
    });
    expect(reconciled).toHaveBeenCalledOnce();
    expect(result.output).toMatchObject({
      kind: "openrouter-hosted-fusion",
      runtime: "openrouter-fusion",
      answer: "Hosted fused answer",
      panel: [
        expect.objectContaining({ memberId: "one", model: "vendor/one" }),
        expect.objectContaining({ memberId: "two", model: "vendor/two" }),
      ],
      judge: expect.objectContaining({ model: "vendor/judge", billedCalls: 2 }),
      minorityReportsRequested: true,
      minorityStructureVerified: false,
    });
  });

  it("keeps hosted Fusion compound calls and its evidence evaluator inside one node envelope", async () => {
    const node: WorkflowNode = {
      ...baseNode("fusion"),
      kind: "fusion",
      goal: "Use hosted Fusion and then inspect its support.",
      fusion: {
        mode: "openrouter-router",
        router: openRouterModel("openrouter/fusion"),
        members: [
          { id: "one", role: "One", model: openRouterModel("vendor/one") },
          { id: "two", role: "Two", model: openRouterModel("vendor/two") },
        ],
        judge: openRouterModel("vendor/judge"),
      },
      preserveMinorityReports: true,
    };
    const document = graph(node, {
      defaultModel: openRouterModel("vendor/evidence"),
      limits: {
        ...graph(node).limits,
        maxModelCalls: 5,
        maxSubagents: 1,
        maxTokens: 1_000,
        maxCostUsd: 10,
      },
      evidence: {
        enabled: true,
        minimumIndependentSources: 0,
        requireArtifactReferences: false,
        onUnsupportedOutput: "fail",
      },
    });
    const host = new FakeHost([{
      supported: true,
      summary: "The model-assisted review found no unsupported claim.",
      sourceIds: [],
      unsupportedClaims: [],
    }]);
    const admissions: KadyWorkflowUsageAdmission[] = [];
    const runHostedFusion = vi.fn(async (request: HostedOpenRouterFusionRequest) => {
      const usage = {
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 1,
        turns: 1,
        toolCalls: 0,
        durationMs: 20,
      };
      await request.reconcileUsage({
        identity: request.identity,
        reason: "terminal-response",
        responseStatus: "completed",
        usage,
        progress: {
          started: true,
          model: "openrouter/openrouter/fusion",
          tokens: 150,
          toolCalls: 0,
          durationMs: 20,
        },
      });
      return { text: "Hosted fused answer", textTruncated: false, usage };
    });

    const result = await executorFor(host, document, {
      runHostedFusion,
      onReserve: (admission) => admissions.push(admission),
    })(contextFor(document));

    expect(runHostedFusion).toHaveBeenCalledOnce();
    expect(host.calls.map((call) => call.request.nodeId.split(":").at(-1))).toEqual([
      "evidence-policy-evaluator",
    ]);
    expect(admissions).toEqual([
      expect.objectContaining({
        slotId: "fusion-hosted-compound",
        maxTokens: 800,
        maxCostUsd: 8,
        modelCallCount: 4,
      }),
      expect.objectContaining({
        slotId: "evidence-policy-evaluator",
        maxTokens: 200,
        maxCostUsd: 2,
        modelCallCount: 1,
      }),
    ]);
    expect(admissions.reduce((sum, admission) => sum + admission.maxTokens, 0)).toBe(1_000);
    expect(admissions.reduce((sum, admission) => sum + admission.maxCostUsd, 0)).toBe(10);
    expect(admissions.reduce((sum, admission) => sum + admission.modelCallCount, 0)).toBe(5);
    expect(result.evidence).toMatchObject({ supported: true, sourceIds: [] });
  });

  it("fails visibly and preserves exact-once accounting when hosted Fusion fails", async () => {
    const node: WorkflowNode = {
      ...baseNode("fusion"),
      kind: "fusion",
      goal: "Use hosted Fusion.",
      fusion: {
        mode: "openrouter-router",
        router: openRouterModel("openrouter/fusion"),
        members: [
          { id: "one", role: "One", model: openRouterModel("vendor/one") },
          { id: "two", role: "Two", model: openRouterModel("vendor/two") },
        ],
        judge: openRouterModel("vendor/judge"),
      },
      preserveMinorityReports: false,
    };
    const document = graph(node);
    const reconciled = vi.fn();
    const runHostedFusion = vi.fn(async (request: HostedOpenRouterFusionRequest) => {
      await request.reconcileUsage({
        identity: request.identity,
        reason: "protocol-error",
        responseStatus: "failed",
        progress: { started: true, tokens: 0, toolCalls: 0, durationMs: 2 },
      });
      throw Object.assign(new Error("hosted provider unavailable"), {
        code: "HOSTED_FUSION_PROVIDER_FAILED",
      });
    });

    await expect(executorFor(new FakeHost([]), document, {
      runHostedFusion,
      reconcileUsage: reconciled,
    })(contextFor(document))).rejects.toMatchObject({
      code: "HOSTED_FUSION_PROVIDER_FAILED",
    });
    expect(runHostedFusion).toHaveBeenCalledOnce();
    expect(reconciled).toHaveBeenCalledOnce();
  });

  it("maps hosted Fusion cancellation to a workflow abort and reconciles once", async () => {
    const node: WorkflowNode = {
      ...baseNode("fusion"),
      kind: "fusion",
      goal: "Cancel hosted Fusion.",
      fusion: {
        mode: "openrouter-router",
        router: openRouterModel("openrouter/fusion"),
        members: [
          { id: "one", role: "One", model: openRouterModel("vendor/one") },
          { id: "two", role: "Two", model: openRouterModel("vendor/two") },
        ],
        judge: openRouterModel("vendor/judge"),
      },
      preserveMinorityReports: false,
    };
    const document = graph(node);
    const controller = new AbortController();
    const reconciled = vi.fn();
    let started: (() => void) | undefined;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    let hostedRequest: HostedOpenRouterFusionRequest | undefined;
    let rejectHosted: ((error: Error) => void) | undefined;
    const runHostedFusion = vi.fn((request: HostedOpenRouterFusionRequest) =>
      new Promise<HostedOpenRouterFusionResult>((_resolve, reject) => {
        hostedRequest = request;
        rejectHosted = reject;
        started?.();
      })
    );

    const running = executorFor(new FakeHost([]), document, {
      runHostedFusion,
      reconcileUsage: reconciled,
    })(contextFor(document, [], controller.signal));
    await didStart;
    controller.abort(new Error("user cancelled"));
    if (!hostedRequest || !rejectHosted) throw new Error("hosted fake did not start");
    expect(hostedRequest.signal.aborted).toBe(true);
    await hostedRequest.reconcileUsage({
      identity: hostedRequest.identity,
      reason: "caller-aborted",
      responseStatus: "interrupted",
      progress: { started: true, tokens: 0, toolCalls: 0, durationMs: 1 },
    });
    rejectHosted(new Error("hosted request aborted"));

    await expect(running).rejects.toMatchObject({ code: "WORKFLOW_NODE_ABORTED" });
    expect(reconciled).toHaveBeenCalledOnce();
  });

  it("fails safe by reconciling hosted usage when a runner omits its callback", async () => {
    const node: WorkflowNode = {
      ...baseNode("fusion"),
      kind: "fusion",
      goal: "Recover hosted accounting.",
      fusion: {
        mode: "openrouter-router",
        router: openRouterModel("openrouter/fusion"),
        members: [
          { id: "one", role: "One", model: openRouterModel("vendor/one") },
          { id: "two", role: "Two", model: openRouterModel("vendor/two") },
        ],
        judge: openRouterModel("vendor/judge"),
      },
      preserveMinorityReports: false,
    };
    const document = graph(node);
    const usage = {
      input: 20,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.1,
      turns: 1,
      toolCalls: 0,
      durationMs: 4,
    };
    const reconciled = vi.fn();
    const result = await executorFor(new FakeHost([]), document, {
      runHostedFusion: async () => ({
        text: "Recovered accounting",
        textTruncated: false,
        usage,
      }),
      reconcileUsage: reconciled,
    })(contextFor(document));

    expect(result.output).toMatchObject({ answer: "Recovered accounting" });
    expect(reconciled).toHaveBeenCalledOnce();
    expect(reconciled).toHaveBeenCalledWith(expect.objectContaining({
      reason: "terminal-response",
      responseStatus: "completed",
      usage,
    }));
  });

  it("rejects prompt-only writable isolation before resolving or delegating", async () => {
    const node: WorkflowNode = {
      ...baseNode("agent"),
      kind: "agent",
      prompt: "Write a result.",
      workspace: { isolation: "exclusive-project", writePaths: ["result.md"] },
    };
    const host = new FakeHost([analysis("unused")]);
    const document = graph(node);
    await expect(executorFor(host, document)(contextFor(document))).rejects.toMatchObject({
      code: "WORKFLOW_WRITABLE_ISOLATION_UNSUPPORTED",
    });
    expect(host.calls).toHaveLength(0);
  });
});
