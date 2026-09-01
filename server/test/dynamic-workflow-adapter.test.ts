import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type {
  WorkflowRunOptions,
  WorkflowRunResult,
} from "@quintinshaw/pi-dynamic-workflows";
import {
  compileAgentNodePlan,
  createAgentNodeModelReceipt,
  executeAgentNode,
  type AgentWorkflowNode,
} from "../src/workflows/agent-node-executor.ts";
import {
  executeDynamicWorkflowPlan,
  KadyDynamicWorkflowError,
  type DynamicWorkflowAgent,
  type DynamicWorkflowBudgetReserver,
  type DynamicWorkflowKernel,
  type DynamicWorkflowPlan,
} from "../src/workflows/dynamic-workflow-adapter.ts";
import type {
  ModelRequest,
  NodeLimits,
  WorkflowLimits,
} from "../src/workflows/schema.ts";
import type { WorkflowResolvedModel } from "../src/workflows/run-state.ts";

const PROJECT_CWD = fs.mkdtempSync(
  path.join(os.tmpdir(), "kady-dynamic-workflow-project-"),
);
const RUN_CWD = path.join(PROJECT_CWD, "run");
fs.mkdirSync(RUN_CWD);
afterAll(() => fs.rmSync(PROJECT_CWD, { recursive: true, force: true }));

const reserveBudget: DynamicWorkflowBudgetReserver = () => ({
  settle: () => undefined,
});

function graphLimits(overrides: Partial<WorkflowLimits> = {}): WorkflowLimits {
  return {
    maxIterations: 5,
    maxModelCalls: 8,
    maxParallelism: 4,
    maxSubagents: 4,
    timeoutMs: 30_000,
    maxTokens: 10_000,
    maxCostUsd: 10,
    maxRetries: 3,
    ...overrides,
  };
}

function simplePlan(overrides: Partial<DynamicWorkflowPlan> = {}): DynamicWorkflowPlan {
  return {
    script: 'export const meta = {"name":"test","description":"test"};\nreturn "ok";\n',
    maxAgentCalls: 1,
    minimumAgentCalls: 1,
    maxIterations: 1,
    maxParallelism: 1,
    ...overrides,
  };
}

function kernelResult(
  runId: string,
  result: unknown = "ok",
  overrides: Partial<WorkflowRunResult<unknown>> = {},
): WorkflowRunResult<unknown> {
  return {
    meta: { name: "test", description: "test" },
    result,
    logs: [],
    phases: [],
    agentCount: 1,
    durationMs: 1,
    runId,
    tokenUsage: {
      input: 2,
      output: 3,
      total: 5,
      cost: 0.01,
      cacheRead: 0,
      cacheWrite: 0,
    },
    ...overrides,
  };
}

const inertAgent: DynamicWorkflowAgent = {
  async run() {
    return "unused";
  },
};

function nextEventLoopTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function exactModelRequest(): ModelRequest {
  return {
    requested: {
      source: "fixed",
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4",
      auth: { kind: "api-key", profile: "research" },
      reasoning: "high",
    },
    resolution: { mode: "exact" },
  };
}

function resolvedModel(
  overrides: Partial<WorkflowResolvedModel> = {},
): WorkflowResolvedModel {
  return {
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4",
    auth: { kind: "api-key", profile: "research" },
    reasoning: "high",
    runtime: "pi",
    ...overrides,
  };
}

function agentNode(overrides: Partial<AgentWorkflowNode> = {}): AgentWorkflowNode {
  return {
    id: "analyze",
    name: "Analyze evidence",
    kind: "agent",
    terminal: true,
    workspace: { isolation: "read-only", writePaths: [] },
    prompt: "Analyze the evidence and state the supported result.",
    model: exactModelRequest(),
    ...overrides,
  };
}

function agentCallingKernel(
  expectedModelSpec: string,
  capture?: (options: WorkflowRunOptions) => void,
): DynamicWorkflowKernel {
  return async (_script, options) => {
    capture?.(options);
    const kernelAgentId = `${options.runId}:0`;
    options.onAgentStart?.({
      id: kernelAgentId,
      label: "Analyze evidence",
      phase: "Analyze evidence",
      prompt: "Analyze the evidence and state the supported result.",
      model: expectedModelSpec,
    });
    const result = await options.agent!.run(
      "Analyze the evidence and state the supported result.",
      {
        model: expectedModelSpec,
        signal: options.signal,
        onModelResolved: () => undefined,
      },
    );
    options.onAgentEnd?.({
      id: kernelAgentId,
      label: "Analyze evidence",
      phase: "Analyze evidence",
      result,
      tokens: 5,
      model: expectedModelSpec,
    });
    const usage = {
      input: 2,
      output: 3,
      total: 5,
      cost: 0.01,
      cacheRead: 0,
      cacheWrite: 0,
    };
    options.onTokenUsage?.(usage);
    return kernelResult(options.runId!, result, { tokenUsage: usage });
  };
}

describe("Kady dynamic-workflow kernel adapter", () => {
  it("uses only explicit paths and injected runtime state", async () => {
    let receivedScript: string | undefined;
    let receivedOptions: WorkflowRunOptions | undefined;
    const kernel: DynamicWorkflowKernel = async (script, options) => {
      receivedScript = script;
      receivedOptions = options;
      return kernelResult(options.runId!);
    };
    const cwdSpy = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw new Error("global cwd must not be read");
    });

    try {
      await executeDynamicWorkflowPlan({
        plan: simplePlan(),
        projectCwd: PROJECT_CWD,
        runCwd: RUN_CWD,
        runId: "kernel-run-explicit",
        graphLimits: graphLimits(),
        agent: inertAgent,
        reserveBudget,
        kernel,
      });
    } finally {
      cwdSpy.mockRestore();
    }

    expect(receivedScript).toBe(simplePlan().script);
    expect(receivedOptions?.cwd).toBe(fs.realpathSync(RUN_CWD));
    expect(receivedOptions?.agent).not.toBe(inertAgent);
    expect(receivedOptions?.agent?.run).toEqual(expect.any(Function));
    expect(receivedOptions?.agentRegistry).toBeInstanceOf(Map);
    expect(receivedOptions?.agentRegistry?.size).toBe(0);
    expect(receivedOptions?.persistLogs).toBe(false);
    expect(receivedOptions?.loadSavedWorkflow).toBeUndefined();
    expect(receivedOptions?.sharedStore).toBeUndefined();
  });

  it("forwards graph-derived limits and clamps invalid node escalation", async () => {
    let receivedOptions: WorkflowRunOptions | undefined;
    const kernel: DynamicWorkflowKernel = async (_script, options) => {
      receivedOptions = options;
      return kernelResult(options.runId!, "ok", { agentCount: 3 });
    };
    const excessiveNodeLimits: NodeLimits = {
      maxIterations: 99,
      maxModelCalls: 99,
      maxParallelism: 99,
      maxSubagents: 99,
      timeoutMs: 99_999,
      maxTokens: 99_999,
      maxCostUsd: 99,
      maxRetries: 99,
    };

    const result = await executeDynamicWorkflowPlan({
      plan: simplePlan({ maxAgentCalls: 5, maxIterations: 2, maxParallelism: 10 }),
      projectCwd: PROJECT_CWD,
      runCwd: RUN_CWD,
      runId: "kernel-run-limits",
      graphLimits: graphLimits({ maxSubagents: 3 }),
      nodeLimits: excessiveNodeLimits,
      agent: inertAgent,
      reserveBudget,
      kernel,
    });

    expect(result.effectiveLimits.clampedNodeLimitKeys).toEqual([
      "maxIterations",
      "maxModelCalls",
      "maxParallelism",
      "maxSubagents",
      "timeoutMs",
      "maxTokens",
      "maxCostUsd",
      "maxRetries",
    ]);
    expect(receivedOptions).toMatchObject({
      maxAgents: 5,
      concurrency: 3,
      agentRetries: 0,
      agentTimeoutMs: 30_000,
      tokenBudget: 10_000,
    });
  });

  it("forwards resume state, run identity, and lifecycle callbacks", async () => {
    const journal = new Map();
    const onAgentJournal = vi.fn();
    const onLog = vi.fn();
    const onPhase = vi.fn();
    const onTokenUsage = vi.fn();
    let receivedOptions: WorkflowRunOptions | undefined;
    const kernel: DynamicWorkflowKernel = async (_script, options) => {
      receivedOptions = options;
      options.onAgentJournal?.({ index: 0, runId: options.runId, hash: "hash", result: "ok" });
      options.onLog?.("log");
      options.onPhase?.("phase");
      options.onTokenUsage?.({ input: 1, output: 1, total: 2, cost: 0 });
      return kernelResult(options.runId!);
    };
    const initialTokenUsage = {
      input: 1,
      output: 2,
      total: 3,
      cost: 0.01,
      cacheRead: 0,
      cacheWrite: 0,
    };

    await executeDynamicWorkflowPlan({
      plan: simplePlan(),
      projectCwd: PROJECT_CWD,
      runCwd: RUN_CWD,
      runId: "kernel-run-resume",
      graphLimits: graphLimits(),
      agent: inertAgent,
      reserveBudget,
      resume: { journal, fromRunId: "kernel-run-resume", initialTokenUsage },
      callbacks: { onAgentJournal, onLog, onPhase, onTokenUsage },
      kernel,
    });

    expect(receivedOptions?.runId).toBe("kernel-run-resume");
    expect(receivedOptions?.resumeJournal).toBe(journal);
    expect(receivedOptions?.resumeFromRunId).toBe("kernel-run-resume");
    expect(receivedOptions?.initialTokenUsage).toBe(initialTokenUsage);
    expect(receivedOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(onAgentJournal).toHaveBeenCalledOnce();
    expect(onLog).toHaveBeenCalledWith("log");
    expect(onPhase).toHaveBeenCalledWith("phase");
    expect(onTokenUsage).toHaveBeenCalled();
  });

  it("keeps caller-aborted execution and its reservation open until the trusted agent settles", async () => {
    const controller = new AbortController();
    const settle = vi.fn();
    let markAgentStarted: (() => void) | undefined;
    const agentStarted = new Promise<void>((resolve) => {
      markAgentStarted = resolve;
    });
    let markAgentAborted: (() => void) | undefined;
    const agentAborted = new Promise<void>((resolve) => {
      markAgentAborted = resolve;
    });
    let releaseAgent: (() => void) | undefined;
    const agentMaySettle = new Promise<void>((resolve) => {
      releaseAgent = resolve;
    });
    const agent: DynamicWorkflowAgent = {
      async run(_prompt, options) {
        markAgentStarted?.();
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener("abort", () => {
            markAgentAborted?.();
            resolve();
          }, { once: true });
        });
        await agentMaySettle;
        return "late ordinary result";
      },
    };
    const kernel: DynamicWorkflowKernel = async (_script, options) => {
      const result = await options.agent!.run("run the trusted leaf");
      return kernelResult(options.runId!, result);
    };

    const execution = executeDynamicWorkflowPlan({
      plan: simplePlan(),
      projectCwd: PROJECT_CWD,
      runCwd: RUN_CWD,
      runId: "kernel-run-abort",
      graphLimits: graphLimits(),
      agent,
      reserveBudget: () => ({ settle }),
      signal: controller.signal,
      kernel,
    });
    let executionSettled = false;
    void execution.then(
      () => { executionSettled = true; },
      () => { executionSettled = true; },
    );
    await agentStarted;
    controller.abort("user-stop");
    await agentAborted;
    await nextEventLoopTurn();

    expect(executionSettled).toBe(false);
    expect(settle).not.toHaveBeenCalled();

    releaseAgent?.();
    await expect(execution).rejects.toMatchObject({ code: "WORKFLOW_ABORTED" });
    expect(settle).toHaveBeenCalledWith({ status: "aborted" });
  });

  it("preserves a trusted-agent cleanup failure after caller abort", async () => {
    const controller = new AbortController();
    const cleanupFailure = new Error("delegation reconciliation failed during cleanup");
    let markAgentStarted: (() => void) | undefined;
    const agentStarted = new Promise<void>((resolve) => {
      markAgentStarted = resolve;
    });
    let markAgentAborted: (() => void) | undefined;
    const agentAborted = new Promise<void>((resolve) => {
      markAgentAborted = resolve;
    });
    let releaseCleanup: (() => void) | undefined;
    const cleanupMayFinish = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const settle = vi.fn();
    const execution = executeDynamicWorkflowPlan({
      plan: simplePlan(),
      projectCwd: PROJECT_CWD,
      runCwd: RUN_CWD,
      runId: "kernel-run-abort-cleanup-failure",
      graphLimits: graphLimits(),
      agent: {
        async run(_prompt, options) {
          await new Promise<void>((resolve) => {
            options?.signal?.addEventListener("abort", () => {
              markAgentAborted?.();
              resolve();
            }, { once: true });
          });
          await cleanupMayFinish;
          throw cleanupFailure;
        },
      },
      reserveBudget: () => ({ settle }),
      signal: controller.signal,
      kernel: async (_script, options) => {
        markAgentStarted?.();
        const result = await options.agent!.run("run the trusted leaf");
        return kernelResult(options.runId!, result);
      },
    });

    await agentStarted;
    controller.abort("user-stop");
    await agentAborted;
    await nextEventLoopTurn();
    expect(settle).not.toHaveBeenCalled();

    releaseCleanup?.();
    await expect(execution).rejects.toBe(cleanupFailure);
    expect(settle).toHaveBeenCalledWith({ status: "aborted" });
  });

  it("rejects null and recoverable kernel outcomes", async () => {
    const nullKernel: DynamicWorkflowKernel = async (_script, options) =>
      kernelResult(options.runId!, null);
    await expect(
      executeDynamicWorkflowPlan({
        plan: simplePlan(),
        projectCwd: PROJECT_CWD,
        runCwd: RUN_CWD,
        runId: "kernel-run-null",
        graphLimits: graphLimits(),
        agent: inertAgent,
        reserveBudget,
        kernel: nullKernel,
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_KERNEL_AMBIGUOUS_RESULT" });

    const recoverableKernel: DynamicWorkflowKernel = async (_script, options) => {
      options.onAgentEnd?.({
        id: `${options.runId}:0`,
        label: "failed",
        result: null,
        error: "provider failed",
        recoverable: true,
      });
      return kernelResult(options.runId!, "nominal-success");
    };
    await expect(
      executeDynamicWorkflowPlan({
        plan: simplePlan(),
        projectCwd: PROJECT_CWD,
        runCwd: RUN_CWD,
        runId: "kernel-run-recoverable",
        graphLimits: graphLimits(),
        agent: inertAgent,
        reserveBudget,
        kernel: recoverableKernel,
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_KERNEL_RECOVERABLE_FAILURE" });
  });

  it("rejects a real run directory outside the declared project before admission", async () => {
    const kernel = vi.fn();
    const reserve = vi.fn(reserveBudget);
    await expect(
      executeDynamicWorkflowPlan({
        plan: simplePlan(),
        projectCwd: PROJECT_CWD,
        runCwd: path.parse(PROJECT_CWD).root,
        runId: "kernel-run-outside",
        graphLimits: graphLimits(),
        agent: inertAgent,
        reserveBudget: reserve,
        kernel,
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_INVALID_CONTRACT" });
    expect(reserve).not.toHaveBeenCalled();
    expect(kernel).not.toHaveBeenCalled();
  });

  it("keeps a timed-out reservation open until the trusted kernel settles", async () => {
    const settle = vi.fn();
    let markKernelAborted: (() => void) | undefined;
    const kernelAborted = new Promise<void>((resolve) => {
      markKernelAborted = resolve;
    });
    let releaseKernel: (() => void) | undefined;
    const kernelMaySettle = new Promise<void>((resolve) => {
      releaseKernel = resolve;
    });
    const execution = executeDynamicWorkflowPlan({
      plan: simplePlan(),
      projectCwd: PROJECT_CWD,
      runCwd: RUN_CWD,
      runId: "kernel-run-delayed-timeout-settlement",
      graphLimits: graphLimits({ timeoutMs: 25 }),
      agent: inertAgent,
      reserveBudget: () => ({ settle }),
      kernel: async (_script, options) => {
        await new Promise<void>((resolve) => {
          options.signal?.addEventListener("abort", () => {
            markKernelAborted?.();
            resolve();
          }, { once: true });
        });
        await kernelMaySettle;
        return kernelResult(options.runId!, "late ordinary result");
      },
    });

    await kernelAborted;
    await nextEventLoopTurn();
    expect(settle).not.toHaveBeenCalled();

    releaseKernel?.();
    await expect(execution).rejects.toMatchObject({ code: "WORKFLOW_TIMEOUT" });
    expect(settle).toHaveBeenCalledWith({ status: "timed-out" });
  });

  it("reserves the complete budget before dispatch and fails closed on refusal", async () => {
    const kernel = vi.fn();
    const reserve = vi.fn(() => {
      throw new Error("project budget is already reserved");
    });
    await expect(
      executeDynamicWorkflowPlan({
        plan: simplePlan(),
        projectCwd: PROJECT_CWD,
        runCwd: RUN_CWD,
        runId: "kernel-run-budget-refused",
        graphLimits: graphLimits(),
        agent: inertAgent,
        reserveBudget: reserve,
        kernel,
      }),
    ).rejects.toThrow("project budget is already reserved");
    expect(reserve).toHaveBeenCalledOnce();
    expect(kernel).not.toHaveBeenCalled();
  });

  it("aborts on live cumulative cost evidence instead of waiting for completion", async () => {
    const settle = vi.fn();
    let markUsageReported: (() => void) | undefined;
    const usageReported = new Promise<void>((resolve) => {
      markUsageReported = resolve;
    });
    let releaseKernel: (() => void) | undefined;
    const kernelMaySettle = new Promise<void>((resolve) => {
      releaseKernel = resolve;
    });
    const execution = executeDynamicWorkflowPlan({
      plan: simplePlan(),
      projectCwd: PROJECT_CWD,
      runCwd: RUN_CWD,
      runId: "kernel-run-live-cost-limit",
      graphLimits: graphLimits({ maxCostUsd: 1 }),
      agent: inertAgent,
      reserveBudget: () => ({ settle }),
      kernel: async (_script, options) => {
        options.onTokenUsage?.({
          input: 1,
          output: 1,
          total: 2,
          cost: 1.01,
        });
        markUsageReported?.();
        await kernelMaySettle;
        return kernelResult(options.runId!, "late ordinary result");
      },
    });

    await usageReported;
    await nextEventLoopTurn();
    expect(settle).not.toHaveBeenCalled();

    releaseKernel?.();
    await expect(execution).rejects.toMatchObject({
      code: "WORKFLOW_COST_LIMIT_EXCEEDED",
    });
    expect(settle).toHaveBeenCalledWith({
      status: "failed",
      usage: expect.objectContaining({ cost: 1.01 }),
    });
  });
});

describe("Kady agent-node compiler and executor", () => {
  it("compiles deterministic literals", () => {
    const node = agentNode({
      prompt: 'Analyze "quoted" evidence.\nDo not infer.',
    });
    const firstPlan = compileAgentNodePlan(node, resolvedModel());
    const secondPlan = compileAgentNodePlan(structuredClone(node), resolvedModel());
    expect(firstPlan).toEqual(secondPlan);
    expect(firstPlan.script).toContain(JSON.stringify(node.prompt));
    expect(firstPlan.script).toContain("openrouter/anthropic/claude-sonnet-4:high");
    expect(firstPlan.script).toContain('"retries":0');
    expect(firstPlan.maxAgentCalls).toBe(1);
  });

  it("executes the public kernel with a fake agent and emits an exact receipt", async () => {
    const receiptCallback = vi.fn();
    const startCallback = vi.fn();
    let factoryContext:
      | Parameters<NonNullable<Parameters<typeof executeAgentNode>[0]["createAgent"]>>[0]
      | undefined;
    const result = await executeAgentNode({
      graph: { id: "graph", limits: graphLimits(), defaultModel: exactModelRequest() },
      node: agentNode(),
      projectCwd: PROJECT_CWD,
      runCwd: RUN_CWD,
      runId: "run-agent-real-kernel",
      executionId: "dagx_agent-real-kernel",
      resolveModel: () => resolvedModel(),
      createAgent: (context) => {
        factoryContext = context;
        return {
          async run(_prompt, runOptions) {
            runOptions?.onModelResolved?.("openrouter/anthropic/claude-sonnet-4:high");
            return "supported result";
          },
        };
      },
      reserveBudget,
      callbacks: { onAgentStart: startCallback },
      onModelReceipt: receiptCallback,
    });

    expect(result.output).toBe("supported result");
    expect(result.executionId).toBe("dagx_agent-real-kernel");
    expect(result.kernelRunId).toBe("kernel_dagx_agent-real-kernel");
    expect(result.modelReceipt).toEqual({
      request: exactModelRequest(),
      resolved: resolvedModel(),
      fallbackUsed: false,
    });
    expect(factoryContext?.projectCwd).toBe(PROJECT_CWD);
    expect(factoryContext?.runCwd).toBe(RUN_CWD);
    expect(factoryContext?.executionId).toBe(result.executionId);
    expect(startCallback).toHaveBeenCalledWith(
      expect.objectContaining({ id: result.executionId }),
    );
    expect(receiptCallback).toHaveBeenCalledWith(result.executionId, result.modelReceipt);
  });

  it("accepts only declared fallback models and records why", () => {
    const request: ModelRequest = {
      requested: exactModelRequest().requested,
      resolution: {
        mode: "explicit-fallback",
        alternatives: [
          {
            source: "fixed",
            provider: "ollama",
            model: "qwen3:32b",
            auth: { kind: "local" },
            reasoning: "high",
          },
        ],
        reason: "Use the private local model when remote access is unavailable.",
      },
    };
    const receipt = createAgentNodeModelReceipt(
      request,
      resolvedModel({
        provider: "ollama",
        model: "qwen3:32b",
        auth: { kind: "local" },
        runtime: "local",
      }),
    );

    expect(receipt.fallbackUsed).toBe(true);
    expect(receipt.resolutionReason).toBe(request.resolution.mode === "explicit-fallback"
      ? request.resolution.reason
      : undefined);
  });

  it("rejects a resolver downgrade before creating an agent", async () => {
    const createAgent = vi.fn();
    const kernel = vi.fn();

    await expect(
      executeAgentNode({
        graph: { id: "graph", limits: graphLimits(), defaultModel: exactModelRequest() },
        node: agentNode(),
        projectCwd: PROJECT_CWD,
        runCwd: RUN_CWD,
        runId: "run-resolver-downgrade",
        executionId: "dagx_resolver-downgrade",
        resolveModel: () => resolvedModel({ model: "anthropic/claude-haiku" }),
        createAgent,
        reserveBudget,
        kernel,
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_MODEL_RESOLUTION_MISMATCH" });
    expect(createAgent).not.toHaveBeenCalled();
    expect(kernel).not.toHaveBeenCalled();
  });

  it("rejects ambiguous or missing runtime model confirmation", async () => {
    const executeWithReports = (reports: string[]) =>
      executeAgentNode({
        graph: { id: "graph", limits: graphLimits(), defaultModel: exactModelRequest() },
        node: agentNode(),
        projectCwd: PROJECT_CWD,
        runCwd: RUN_CWD,
        runId: `run-reports-${reports.length}`,
        executionId: `dagx_reports-${reports.length}`,
        resolveModel: () => resolvedModel(),
        createAgent: () => ({
          async run(_prompt, runOptions) {
            for (const report of reports) runOptions?.onModelResolved?.(report);
            return "answer";
          },
        }),
        reserveBudget,
        kernel: agentCallingKernel("openrouter/anthropic/claude-sonnet-4:high"),
      });

    await expect(
      executeWithReports([
        "openrouter/anthropic/claude-sonnet-4:high",
        "openrouter/anthropic/claude-haiku:low",
      ]),
    ).rejects.toMatchObject({ code: "WORKFLOW_MODEL_RESOLUTION_AMBIGUOUS" });
    await expect(executeWithReports([])).rejects.toMatchObject({
      code: "WORKFLOW_MODEL_RESOLUTION_UNCONFIRMED",
    });
  });

  it("forwards explicit run cwd and abort signal through the fake kernel to the agent", async () => {
    const controller = new AbortController();
    let receivedAgentSignal: AbortSignal | undefined;
    let receivedAgentCwd: string | undefined;
    await executeAgentNode({
      graph: { id: "graph", limits: graphLimits(), defaultModel: exactModelRequest() },
      node: agentNode(),
      projectCwd: PROJECT_CWD,
      runCwd: RUN_CWD,
      runId: "run-forwarding",
      executionId: "dagx_forwarding",
      signal: controller.signal,
      resolveModel: () => resolvedModel(),
      createAgent: () => ({
        async run(_prompt, runOptions) {
          receivedAgentSignal = runOptions?.signal;
          receivedAgentCwd = runOptions?.cwd;
          runOptions?.onModelResolved?.("openrouter/anthropic/claude-sonnet-4:high");
          return "answer";
        },
      }),
      reserveBudget,
      kernel: agentCallingKernel("openrouter/anthropic/claude-sonnet-4:high"),
    });

    expect(receivedAgentSignal).toBeInstanceOf(AbortSignal);
    expect(receivedAgentCwd).toBe(RUN_CWD);
  });

  it("rejects a kernel attempt to replace the leaf agent's pinned cwd", async () => {
    const expectedModelSpec = "openrouter/anthropic/claude-sonnet-4:high";
    await expect(
      executeAgentNode({
        graph: { id: "graph", limits: graphLimits(), defaultModel: exactModelRequest() },
        node: agentNode(),
        projectCwd: PROJECT_CWD,
        runCwd: RUN_CWD,
        runId: "run-cwd-escape",
        executionId: "dagx_cwd-escape",
        resolveModel: () => resolvedModel(),
        createAgent: () => ({ async run() { return "unreachable"; } }),
        reserveBudget,
        kernel: async (_script, options) => {
          await options.agent!.run("escape", {
            model: expectedModelSpec,
            cwd: path.parse(PROJECT_CWD).root,
          });
          return kernelResult(options.runId!);
        },
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_INVALID_CONTRACT" });
  });

  it("persists actual model-resolution evidence before a later provider failure", async () => {
    const receiptCallback = vi.fn();
    await expect(
      executeAgentNode({
        graph: { id: "graph", limits: graphLimits(), defaultModel: exactModelRequest() },
        node: agentNode(),
        projectCwd: PROJECT_CWD,
        runCwd: RUN_CWD,
        runId: "run-provider-fails-after-resolution",
        executionId: "dagx_provider-fails-after-resolution",
        resolveModel: () => resolvedModel(),
        createAgent: () => ({
          async run(_prompt, runOptions) {
            runOptions?.onModelResolved?.(
              "openrouter/anthropic/claude-sonnet-4:high",
            );
            throw new Error("provider stream failed");
          },
        }),
        reserveBudget,
        onModelReceipt: receiptCallback,
        kernel: agentCallingKernel("openrouter/anthropic/claude-sonnet-4:high"),
      }),
    ).rejects.toThrow("provider stream failed");
    expect(receiptCallback).toHaveBeenCalledWith(
      "dagx_provider-fails-after-resolution",
      expect.objectContaining({
        request: exactModelRequest(),
        resolved: resolvedModel(),
        fallbackUsed: false,
      }),
    );
  });

  it("keeps the Kady execution ID stable in forwarded agent callbacks", async () => {
    const onAgentStart = vi.fn();
    const onAgentEnd = vi.fn();
    const result = await executeAgentNode({
      graph: { id: "graph", limits: graphLimits(), defaultModel: exactModelRequest() },
      node: agentNode(),
      projectCwd: PROJECT_CWD,
      runCwd: RUN_CWD,
      runId: "run-callback-id",
      executionId: "dagx_callback-id",
      resolveModel: () => resolvedModel(),
      createAgent: () => ({
        async run(_prompt, runOptions) {
          runOptions?.onModelResolved?.("openrouter/anthropic/claude-sonnet-4:high");
          return "answer";
        },
      }),
      reserveBudget,
      callbacks: { onAgentStart, onAgentEnd },
      kernel: agentCallingKernel("openrouter/anthropic/claude-sonnet-4:high"),
    });

    expect(onAgentStart).toHaveBeenCalledWith(
      expect.objectContaining({ id: result.executionId }),
    );
    expect(onAgentEnd).toHaveBeenCalledWith(
      expect.objectContaining({ id: result.executionId }),
    );
  });
});

describe("adapter errors", () => {
  it("uses a typed error surface", () => {
    expect(new KadyDynamicWorkflowError("failure", "WORKFLOW_INVALID_CONTRACT")).toMatchObject({
      name: "KadyDynamicWorkflowError",
      code: "WORKFLOW_INVALID_CONTRACT",
    });
  });
});
