import { isDeepStrictEqual } from "node:util";
import type { AgentRunOptions } from "@quintinshaw/pi-dynamic-workflows";
import type { TSchema } from "typebox";
import {
  deriveDynamicWorkflowLimits,
  executeDynamicWorkflowPlan,
  KadyDynamicWorkflowError,
  type DynamicWorkflowAgent,
  type DynamicWorkflowCallbacks,
  type DynamicWorkflowBudgetReserver,
  type DynamicWorkflowKernel,
  type DynamicWorkflowPlan,
  type DynamicWorkflowResumeData,
  type EffectiveDynamicWorkflowLimits,
} from "./dynamic-workflow-adapter.ts";
import type {
  ModelRequest,
  RequestedModel,
  WorkflowGraphDocument,
  WorkflowNode,
} from "./schema.ts";
import type {
  WorkflowModelResolutionReceipt,
  WorkflowResolvedModel,
} from "./run-state.ts";

export type AgentWorkflowNode = Extract<WorkflowNode, { kind: "agent" }>;

export interface AgentNodeExecutionIdentity {
  executionId: string;
  kernelRunId: string;
}

export interface ResolveAgentNodeModelContext {
  graphId: string;
  nodeId: string;
  runId: string;
  executionId: string;
  attempt: number;
}

export type AgentNodeModelResolver = (
  request: ModelRequest,
  context: ResolveAgentNodeModelContext,
) => WorkflowResolvedModel | Promise<WorkflowResolvedModel>;

export interface CreateAgentNodeAgentContext extends ResolveAgentNodeModelContext {
  projectCwd: string;
  runCwd: string;
  kernelRunId: string;
  node: AgentWorkflowNode;
  limits: EffectiveDynamicWorkflowLimits;
  modelReceipt: WorkflowModelResolutionReceipt;
}

export type AgentNodeAgentFactory = (
  context: CreateAgentNodeAgentContext,
) => DynamicWorkflowAgent | Promise<DynamicWorkflowAgent>;

export interface AgentNodeResumeData extends DynamicWorkflowResumeData {
  /** Durable Kady receipt from the execution whose journal is being replayed. */
  modelReceipt: WorkflowModelResolutionReceipt;
}

export interface ExecuteAgentNodeOptions {
  graph: Pick<WorkflowGraphDocument, "defaultModel" | "id" | "limits">;
  node: AgentWorkflowNode;
  projectCwd: string;
  runCwd: string;
  runId: string;
  /** Canonical identity minted by the durable DAG runner. */
  executionId: string;
  attempt?: number;
  parentExecutionId?: string;
  branchId?: string;
  signal?: AbortSignal;
  resume?: AgentNodeResumeData;
  callbacks?: DynamicWorkflowCallbacks;
  onModelReceipt?: (
    executionId: string,
    receipt: WorkflowModelResolutionReceipt,
  ) => void;
  resolveModel: AgentNodeModelResolver;
  createAgent: AgentNodeAgentFactory;
  reserveBudget: DynamicWorkflowBudgetReserver;
  kernel?: DynamicWorkflowKernel;
}

export interface AgentNodeExecutionResult {
  runId: string;
  nodeId: string;
  executionId: string;
  kernelRunId: string;
  attempt: number;
  output: unknown;
  modelReceipt: WorkflowModelResolutionReceipt;
  effectiveLimits: EffectiveDynamicWorkflowLimits;
  usage: NonNullable<
    Awaited<ReturnType<DynamicWorkflowKernel>>["tokenUsage"]
  >;
}

type FixedRequestedModel = Extract<RequestedModel, { source: "fixed" }>;

function modelResolutionError(
  message: string,
  code:
    | "WORKFLOW_MODEL_RESOLUTION_AMBIGUOUS"
    | "WORKFLOW_MODEL_RESOLUTION_MISMATCH"
    | "WORKFLOW_MODEL_RESOLUTION_UNCONFIRMED"
    | "WORKFLOW_UNSUPPORTED_MODEL_REQUEST",
): never {
  throw new KadyDynamicWorkflowError(message, code);
}

function agentNodeKernelIdentity(executionId: string): AgentNodeExecutionIdentity {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(executionId)) {
    throw new KadyDynamicWorkflowError(
      "The durable DAG runner supplied an invalid node execution identity.",
      "WORKFLOW_INVALID_CONTRACT",
    );
  }
  return { executionId, kernelRunId: `kernel_${executionId}` };
}

function modelSpec(resolved: WorkflowResolvedModel): string {
  return `${resolved.provider}/${resolved.model}:${resolved.reasoning}`;
}

/** Compile only data literals into the trusted package script surface. */
export function compileAgentNodePlan(
  node: AgentWorkflowNode,
  resolvedModel: WorkflowResolvedModel,
): DynamicWorkflowPlan {
  const meta = {
    name: `kady-agent-${node.id}`,
    description: node.description ?? `Execute Kady agent node ${node.id}.`,
  };
  const agentOptions = {
    label: node.name,
    phase: node.name,
    model: modelSpec(resolvedModel),
    // Kady's durable runner owns retry/rescue attempts and mints a fresh
    // execution identity for each one. An opaque kernel retry would perform a
    // second provider call behind this plan's declared one-call bound.
    retries: 0,
  };
  return {
    script: [
      `export const meta = ${JSON.stringify(meta)};`,
      `return await agent(${JSON.stringify(node.prompt)}, ${JSON.stringify(agentOptions)});`,
      "",
    ].join("\n"),
    maxAgentCalls: 1,
    minimumAgentCalls: 1,
    maxIterations: 1,
    maxParallelism: 1,
  };
}

function validateResolvedShape(resolved: WorkflowResolvedModel): void {
  if (!resolved.provider.trim() || !resolved.model.trim() || !resolved.auth.kind.trim()) {
    modelResolutionError(
      "The Kady model resolver returned an incomplete provider/model/auth receipt.",
      "WORKFLOW_MODEL_RESOLUTION_UNCONFIRMED",
    );
  }
}

function fixedModelMatches(
  requested: FixedRequestedModel,
  resolved: WorkflowResolvedModel,
): boolean {
  return (
    requested.provider === resolved.provider &&
    requested.model === resolved.model &&
    requested.auth.kind === resolved.auth.kind &&
    requested.auth.profile === resolved.auth.profile &&
    requested.reasoning === resolved.reasoning
  );
}

function assertRuntimeMatchesAuth(
  requested: RequestedModel,
  resolved: WorkflowResolvedModel,
): void {
  if (requested.source === "kady-current") {
    if (
      resolved.runtime === "openrouter-fusion" ||
      resolved.runtime === "kady-fusion"
    ) {
      modelResolutionError(
        "A simple agent node cannot silently resolve Kady Current to a compound fusion runtime.",
        "WORKFLOW_MODEL_RESOLUTION_MISMATCH",
      );
    }
    return;
  }

  const expectedRuntime =
    requested.auth.kind === "local"
      ? "local"
      : requested.auth.kind === "custom"
        ? "custom"
        : "pi";
  if (resolved.runtime !== expectedRuntime) {
    modelResolutionError(
      `Resolved runtime ${resolved.runtime} does not match requested auth ${requested.auth.kind}.`,
      "WORKFLOW_MODEL_RESOLUTION_MISMATCH",
    );
  }
}

/**
 * Turn a Kady resolver decision into a receipt only when it names the exact
 * request or one explicitly declared fallback. Kady Current remains an exact
 * indirection, but cannot be mixed into an ambiguous fallback list here.
 */
export function createAgentNodeModelReceipt(
  request: ModelRequest,
  resolved: WorkflowResolvedModel,
): WorkflowModelResolutionReceipt {
  validateResolvedShape(resolved);

  if (request.resolution.mode === "explicit-fallback") {
    if (
      request.requested.source === "kady-current" ||
      request.resolution.alternatives.some((alternative) => alternative.source === "kady-current")
    ) {
      modelResolutionError(
        "Kady Current cannot be disambiguated inside an explicit fallback list for an agent node.",
        "WORKFLOW_UNSUPPORTED_MODEL_REQUEST",
      );
    }
    const candidates = [request.requested, ...request.resolution.alternatives] as FixedRequestedModel[];
    const matchingIndexes = candidates.flatMap((candidate, index) =>
      fixedModelMatches(candidate, resolved) ? [index] : [],
    );
    if (matchingIndexes.length !== 1) {
      modelResolutionError(
        `Resolved model ${resolved.provider}/${resolved.model} is not one unambiguous requested/fallback candidate.`,
        matchingIndexes.length === 0
          ? "WORKFLOW_MODEL_RESOLUTION_MISMATCH"
          : "WORKFLOW_MODEL_RESOLUTION_AMBIGUOUS",
      );
    }
    const selected = candidates[matchingIndexes[0]];
    assertRuntimeMatchesAuth(selected, resolved);
    return {
      request: structuredClone(request),
      resolved: structuredClone(resolved),
      fallbackUsed: matchingIndexes[0] > 0,
      ...(matchingIndexes[0] > 0
        ? { resolutionReason: request.resolution.reason }
        : {}),
    };
  }

  if (request.requested.source === "fixed") {
    if (!fixedModelMatches(request.requested, resolved)) {
      modelResolutionError(
        `Exact model ${request.requested.provider}/${request.requested.model} resolved as ${resolved.provider}/${resolved.model}.`,
        "WORKFLOW_MODEL_RESOLUTION_MISMATCH",
      );
    }
  } else if (request.requested.reasoning !== resolved.reasoning) {
    modelResolutionError(
      `Kady Current requested ${request.requested.reasoning} reasoning but resolved ${resolved.reasoning}.`,
      "WORKFLOW_MODEL_RESOLUTION_MISMATCH",
    );
  }
  assertRuntimeMatchesAuth(request.requested, resolved);
  return {
    request: structuredClone(request),
    resolved: structuredClone(resolved),
    fallbackUsed: false,
  };
}

function receiptsEqual(
  left: WorkflowModelResolutionReceipt,
  right: WorkflowModelResolutionReceipt,
): boolean {
  return isDeepStrictEqual(left, right);
}

function callbacksWithStableExecutionId(
  callbacks: DynamicWorkflowCallbacks | undefined,
  executionId: string,
): DynamicWorkflowCallbacks | undefined {
  if (!callbacks) return undefined;
  return {
    ...callbacks,
    onAgentStart: callbacks.onAgentStart
      ? (event) => callbacks.onAgentStart?.({ ...event, id: executionId })
      : undefined,
    onAgentEnd: callbacks.onAgentEnd
      ? (event) => callbacks.onAgentEnd?.({ ...event, id: executionId })
      : undefined,
    onAgentHistory: callbacks.onAgentHistory
      ? (event) => callbacks.onAgentHistory?.({ ...event, id: executionId })
      : undefined,
  };
}

function guardedAgent(
  agent: DynamicWorkflowAgent,
  expectedModelSpec: string,
  runCwd: string,
  reportedModelSpecs: Set<string>,
  fallbackNotices: string[],
  liveCallCount: { value: number },
  executionId: string,
  modelReceipt: WorkflowModelResolutionReceipt,
  onModelReceipt:
    | ((executionId: string, receipt: WorkflowModelResolutionReceipt) => void)
    | undefined,
): DynamicWorkflowAgent {
  let receiptEmitted = false;
  return {
    async run<TSchemaDefinition extends TSchema | undefined>(
      prompt: string,
      runOptions?: AgentRunOptions<TSchemaDefinition>,
    ): Promise<unknown> {
      liveCallCount.value += 1;
      if (runOptions?.model !== expectedModelSpec) {
        modelResolutionError(
          `The workflow kernel routed ${String(runOptions?.model)} instead of ${expectedModelSpec}.`,
          "WORKFLOW_MODEL_RESOLUTION_MISMATCH",
        );
      }
      if (runOptions?.cwd !== undefined && runOptions.cwd !== runCwd) {
        throw new KadyDynamicWorkflowError(
          `The workflow kernel attempted to change the pinned run cwd to ${runOptions.cwd}.`,
          "WORKFLOW_INVALID_CONTRACT",
        );
      }
      const originalResolved = runOptions?.onModelResolved;
      const originalFallback = runOptions?.onModelFallback;
      return agent.run(prompt, {
        ...runOptions,
        cwd: runCwd,
        onModelResolved: (resolvedModelSpec) => {
          reportedModelSpecs.add(resolvedModelSpec);
          if (
            !receiptEmitted &&
            fallbackNotices.length === 0 &&
            resolvedModelSpec === expectedModelSpec
          ) {
            onModelReceipt?.(executionId, modelReceipt);
            receiptEmitted = true;
          }
          originalResolved?.(resolvedModelSpec);
        },
        onModelFallback: (notice) => {
          fallbackNotices.push(`${notice.tier}:${notice.requestedSpec}`);
          originalFallback?.(notice);
        },
      });
    },
  };
}

export async function executeAgentNode(
  options: ExecuteAgentNodeOptions,
): Promise<AgentNodeExecutionResult> {
  const attempt = options.attempt ?? 1;
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new KadyDynamicWorkflowError(
      "An agent node attempt must be a positive integer.",
      "WORKFLOW_INVALID_CONTRACT",
    );
  }
  const identity = agentNodeKernelIdentity(options.executionId);
  const request = options.node.model ?? options.graph.defaultModel;
  if (!request) {
    throw new KadyDynamicWorkflowError(
      `Agent node ${options.node.id} has no model request.`,
      "WORKFLOW_INVALID_CONTRACT",
    );
  }

  const resolutionContext: ResolveAgentNodeModelContext = {
    graphId: options.graph.id,
    nodeId: options.node.id,
    runId: options.runId,
    executionId: identity.executionId,
    attempt,
  };
  const resolved = await options.resolveModel(structuredClone(request), resolutionContext);
  const modelReceipt = createAgentNodeModelReceipt(request, resolved);
  if (options.resume && !receiptsEqual(options.resume.modelReceipt, modelReceipt)) {
    modelResolutionError(
      "The resumed node's durable model receipt differs from the model resolved now.",
      "WORKFLOW_MODEL_RESOLUTION_MISMATCH",
    );
  }

  const plan = compileAgentNodePlan(options.node, modelReceipt.resolved);
  const effectiveLimits = deriveDynamicWorkflowLimits(
    options.graph.limits,
    options.node.limits,
    plan,
  );
  const agent = await options.createAgent({
    ...resolutionContext,
    projectCwd: options.projectCwd,
    runCwd: options.runCwd,
    kernelRunId: identity.kernelRunId,
    node: options.node,
    limits: effectiveLimits,
    modelReceipt,
  });
  if (!agent || typeof agent.run !== "function") {
    throw new KadyDynamicWorkflowError(
      "The agent factory did not return a runnable injected agent.",
      "WORKFLOW_INVALID_CONTRACT",
    );
  }

  const reportedModelSpecs = new Set<string>();
  const fallbackNotices: string[] = [];
  const liveCallCount = { value: 0 };
  const result = await executeDynamicWorkflowPlan({
    plan,
    projectCwd: options.projectCwd,
    runCwd: options.runCwd,
    runId: identity.kernelRunId,
    graphLimits: options.graph.limits,
    nodeLimits: options.node.limits,
    agent: guardedAgent(
      agent,
      modelSpec(modelReceipt.resolved),
      options.runCwd,
      reportedModelSpecs,
      fallbackNotices,
      liveCallCount,
      identity.executionId,
      modelReceipt,
      options.onModelReceipt,
    ),
    reserveBudget: options.reserveBudget,
    signal: options.signal,
    resume: options.resume,
    callbacks: callbacksWithStableExecutionId(options.callbacks, identity.executionId),
    kernel: options.kernel,
  });

  if (fallbackNotices.length > 0) {
    modelResolutionError(
      `The injected agent reported an implicit model fallback: ${fallbackNotices.join(", ")}.`,
      "WORKFLOW_MODEL_RESOLUTION_MISMATCH",
    );
  }
  if (liveCallCount.value === 0) {
    if (!options.resume) {
      modelResolutionError(
        "The kernel returned without running the injected agent or replaying a durable receipt.",
        "WORKFLOW_MODEL_RESOLUTION_UNCONFIRMED",
      );
    }
  } else if (reportedModelSpecs.size === 0) {
    modelResolutionError(
      "The injected agent did not report its resolved model.",
      "WORKFLOW_MODEL_RESOLUTION_UNCONFIRMED",
    );
  } else if (reportedModelSpecs.size !== 1) {
    modelResolutionError(
      `The injected agent reported multiple resolved models: ${[...reportedModelSpecs].join(", ")}.`,
      "WORKFLOW_MODEL_RESOLUTION_AMBIGUOUS",
    );
  } else if (!reportedModelSpecs.has(modelSpec(modelReceipt.resolved))) {
    modelResolutionError(
      `The injected agent resolved ${[...reportedModelSpecs][0]} instead of ${modelSpec(modelReceipt.resolved)}.`,
      "WORKFLOW_MODEL_RESOLUTION_MISMATCH",
    );
  }

  return {
    runId: options.runId,
    nodeId: options.node.id,
    executionId: identity.executionId,
    kernelRunId: identity.kernelRunId,
    attempt,
    output: result.result,
    modelReceipt,
    effectiveLimits: result.effectiveLimits,
    usage: result.kernelResult.tokenUsage!,
  };
}
