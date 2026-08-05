import { describe, expect, it, vi } from "vitest";
import { SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION } from "pi-subagents/delegation";
import {
  DAG_FUSION_GRAPH_CONTRACT_VERSION,
  DagFusionDelegationError,
  DagFusionRuntimeError,
  createDagFusionDelegatingTrustedHostV1,
  dagFusionHostAbortSettledV1,
  dagFusionExpectedModelSlotsV1,
  executeDagFusionGraphV1,
  validateDagFusionGraphV1,
  type DagFusionAgentExecutionRequestV1,
  type DagFusionDelegationReceipt,
  type DagFusionGraphV1,
  type DagFusionModelSelectorV1,
  type DagFusionNodeExecutionResultV1,
  type DagFusionNodeV1,
  type DagFusionTrustedHostV1,
  type DelegateDagFusionNodeOptions,
  type OwnedDelegationV2Request,
} from "../pi-packages/dag-fusion-drive/index.ts";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function model(modelId = "gpt-5.4"): DagFusionModelSelectorV1 {
  return {
    provider: "openai-codex",
    model: modelId,
    auth: { kind: "oauth", profile: "research" },
    reasoning: "high",
  };
}

function graph(): DagFusionGraphV1 {
  return {
    version: DAG_FUSION_GRAPH_CONTRACT_VERSION,
    id: "portable-fusion",
    name: "Portable fusion",
    limits: {
      timeoutMs: 20_000,
      maxTokens: 2_000,
      maxCostUsd: 5,
      maxModelCalls: 4,
    },
    // The dependent node deliberately comes first. Execution still follows a
    // stable topological order rather than source-array order alone.
    nodes: [
      {
        id: "synthesize",
        kind: "fusion",
        instruction: "Synthesize the evidence.",
        fusion: {
          mode: "panel-judge",
          members: [
            { id: "local", role: "Local critic", model: {
              provider: "ollama",
              model: "qwen3:32b",
              auth: { kind: "local" },
              reasoning: "off",
            } },
            { id: "remote", role: "Remote critic", model: model() },
          ],
          judge: model("o3"),
          preserveDissent: true,
        },
        limits: {
          timeoutMs: 10_000,
          maxTokens: 1_000,
          maxCostUsd: 3,
          maxModelCalls: 3,
        },
      },
      {
        id: "research",
        kind: "agent",
        specialist: "researcher",
        instruction: "Collect evidence.",
        model: model(),
        limits: {
          timeoutMs: 10_000,
          maxTokens: 1_000,
          maxCostUsd: 2,
          maxModelCalls: 1,
        },
      },
    ],
    edges: [{ from: "research", to: "synthesize" }],
  };
}

function exactResult(
  node: DagFusionNodeV1,
  output: DagFusionNodeExecutionResultV1["output"],
  usage: DagFusionNodeExecutionResultV1["usage"],
): DagFusionNodeExecutionResultV1 {
  return {
    output,
    usage,
    modelResolutions: dagFusionExpectedModelSlotsV1(node).map((entry) => ({
      slot: entry.slot,
      requested: entry.requested,
      resolved: entry.requested,
    })),
  };
}

async function expectRuntimeCode(
  promise: Promise<unknown>,
  code: DagFusionRuntimeError["code"],
): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: "DagFusionRuntimeError",
    code,
  });
}

describe("dag-fusion-drive runtime contract", () => {
  it("validates and clones the bounded provider-neutral subset", () => {
    const source = graph();
    const validation = validateDagFusionGraphV1(source);
    expect(validation).toMatchObject({ ok: true });
    if (!validation.ok) throw new Error("expected valid graph");
    source.nodes[1]!.id = "mutated";
    expect(validation.value.nodes[1]!.id).toBe("research");
    expect(validation.value.nodes[0]).toMatchObject({
      kind: "fusion",
      fusion: {
        members: [
          { model: { provider: "ollama", auth: { kind: "local" } } },
          { model: { provider: "openai-codex", auth: { kind: "oauth" } } },
        ],
      },
    });
  });

  it("reports unsupported nodes, unknown fields, and cycles deterministically", () => {
    const unsupported = graph() as unknown as Record<string, unknown>;
    (unsupported.nodes as Array<Record<string, unknown>>)[1]!.kind = "research-until-goal";
    const unsupportedValidation = validateDagFusionGraphV1(unsupported);
    expect(unsupportedValidation).toEqual({
      ok: false,
      issues: [{
        path: "$.nodes[1].kind",
        code: "invalid_value",
        message: "Contract v1 supports only agent and fusion nodes.",
      }],
    });

    const withVisualState = graph() as unknown as Record<string, unknown>;
    (withVisualState.nodes as Array<Record<string, unknown>>)[1]!.visual = { x: 1 };
    expect(validateDagFusionGraphV1(withVisualState)).toEqual({
      ok: false,
      issues: [{
        path: "$.nodes[1].visual",
        code: "unknown_property",
        message: "Property visual is not part of contract v1.",
      }],
    });

    const cyclic = graph();
    cyclic.edges.push({ from: "synthesize", to: "research" });
    const cyclicValidation = validateDagFusionGraphV1(cyclic);
    expect(cyclicValidation).toMatchObject({
      ok: false,
      issues: [{ path: "$.edges", code: "cycle" }],
    });
  });

  it("executes serially in stable topological order with bounded inbound data", async () => {
    const order: string[] = [];
    const host: DagFusionTrustedHostV1 = {
      async executeAgent(request) {
        order.push(request.node.id);
        expect(request.inbound).toEqual([]);
        expect(request.admission).toEqual(request.node.limits);
        return exactResult(request.node, { evidence: ["source-a"] }, {
          inputTokens: 10,
          outputTokens: 5,
          costUsd: 0.1,
          modelCalls: 1,
        });
      },
      async executeFusion(request) {
        order.push(request.node.id);
        expect(request.inbound).toEqual([{
          fromNodeId: "research",
          output: { evidence: ["source-a"] },
        }]);
        return exactResult(request.node, { answer: "supported" }, {
          inputTokens: 20,
          outputTokens: 10,
          costUsd: 0.2,
          modelCalls: 3,
        });
      },
    };

    const result = await executeDagFusionGraphV1(graph(), host, { runId: "run-123" });
    expect(order).toEqual(["research", "synthesize"]);
    expect(result).toMatchObject({
      contractVersion: "1.0",
      runId: "run-123",
      graphId: "portable-fusion",
      terminalNodeIds: ["synthesize"],
      usage: { inputTokens: 30, outputTokens: 15, modelCalls: 4 },
    });
    expect(result.usage.costUsd).toBeCloseTo(0.3);
    expect(result.nodes.map((node) => node.nodeId)).toEqual(["research", "synthesize"]);
  });

  it("fails visibly on model fallback and admitted-budget overrun", async () => {
    const fallbackHost: DagFusionTrustedHostV1 = {
      async executeAgent(request) {
        const result = exactResult(request.node, null, {
          inputTokens: 1,
          outputTokens: 1,
          costUsd: 0,
          modelCalls: 1,
        });
        result.modelResolutions[0]!.resolved = model("smaller-model");
        return result;
      },
      executeFusion: vi.fn(),
    };
    await expectRuntimeCode(
      executeDagFusionGraphV1(graph(), fallbackHost, { runId: "fallback-run" }),
      "DAG_FUSION_RUNTIME_INVALID_HOST_RESULT",
    );
    expect(fallbackHost.executeFusion).not.toHaveBeenCalled();

    const budgetHost: DagFusionTrustedHostV1 = {
      async executeAgent(request) {
        return exactResult(request.node, null, {
          inputTokens: request.admission.maxTokens,
          outputTokens: 1,
          costUsd: 0,
          modelCalls: 1,
        });
      },
      executeFusion: vi.fn(),
    };
    await expectRuntimeCode(
      executeDagFusionGraphV1(graph(), budgetHost, { runId: "budget-run" }),
      "DAG_FUSION_RUNTIME_BUDGET_EXCEEDED",
    );
  });

  it("signals a timed-out host but waits for its reconciliation acknowledgement", async () => {
    const timedGraph = graph();
    const researchNode = timedGraph.nodes.find((node) => node.id === "research")!;
    researchNode.limits.timeoutMs = 1_000;
    const reconciliationGate = deferred();
    let abortObserved = false;
    let reconciliationFinished = false;
    let callerSettled = false;
    const executeFusion = vi.fn();
    const host: DagFusionTrustedHostV1 = {
      async executeAgent(request) {
        await new Promise<void>((resolve) => {
          const onAbort = () => {
            abortObserved = true;
            resolve();
          };
          if (request.signal.aborted) onAbort();
          else request.signal.addEventListener("abort", onAbort, { once: true });
        });
        await reconciliationGate.promise;
        reconciliationFinished = true;
        return dagFusionHostAbortSettledV1();
      },
      executeFusion,
    };

    const pending = executeDagFusionGraphV1(timedGraph, host, { runId: "timeout-settlement" });
    const callerObservation = pending.then(
      () => {
        callerSettled = true;
      },
      () => {
        callerSettled = true;
      },
    );
    await vi.waitFor(() => expect(abortObserved).toBe(true), { timeout: 2_000 });
    await Promise.resolve();
    expect(callerSettled).toBe(false);

    reconciliationGate.resolve();
    await expectRuntimeCode(pending, "DAG_FUSION_RUNTIME_TIMEOUT");
    await callerObservation;
    expect(reconciliationFinished).toBe(true);
    expect(callerSettled).toBe(true);
    expect(executeFusion).not.toHaveBeenCalled();
  });

  it("waits for host reconciliation after caller cancellation before rejecting", async () => {
    const abortController = new AbortController();
    const hostStarted = deferred();
    const reconciliationGate = deferred();
    let abortObserved = false;
    let reconciliationFinished = false;
    let callerSettled = false;
    const executeFusion = vi.fn();
    const host: DagFusionTrustedHostV1 = {
      async executeAgent(request) {
        hostStarted.resolve();
        await new Promise<void>((resolve) => {
          const onAbort = () => {
            abortObserved = true;
            resolve();
          };
          if (request.signal.aborted) onAbort();
          else request.signal.addEventListener("abort", onAbort, { once: true });
        });
        await reconciliationGate.promise;
        reconciliationFinished = true;
        return dagFusionHostAbortSettledV1();
      },
      executeFusion,
    };

    const pending = executeDagFusionGraphV1(graph(), host, {
      runId: "caller-abort-settlement",
      signal: abortController.signal,
    });
    const callerObservation = pending.then(
      () => {
        callerSettled = true;
      },
      () => {
        callerSettled = true;
      },
    );
    await hostStarted.promise;
    abortController.abort(new Error("cancel requested"));
    await vi.waitFor(() => expect(abortObserved).toBe(true));
    await Promise.resolve();
    expect(callerSettled).toBe(false);

    reconciliationGate.resolve();
    await expectRuntimeCode(pending, "DAG_FUSION_RUNTIME_ABORTED");
    await callerObservation;
    expect(reconciliationFinished).toBe(true);
    expect(callerSettled).toBe(true);
    expect(executeFusion).not.toHaveBeenCalled();
  });

  it("does not infer abort settlement from an ordinary late host result", async () => {
    const abortController = new AbortController();
    const hostStarted = deferred();
    const host: DagFusionTrustedHostV1 = {
      async executeAgent(request) {
        hostStarted.resolve();
        await new Promise<void>((resolve) => {
          if (request.signal.aborted) resolve();
          else request.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return exactResult(request.node, { late: true }, {
          inputTokens: 1,
          outputTokens: 1,
          costUsd: 0,
          modelCalls: 1,
        });
      },
      executeFusion: vi.fn(),
    };

    const pending = executeDagFusionGraphV1(graph(), host, {
      runId: "missing-abort-settlement",
      signal: abortController.signal,
    });
    await hostStarted.promise;
    abortController.abort();

    await expectRuntimeCode(pending, "DAG_FUSION_RUNTIME_HOST_FAILED");
  });

  it("composes agent execution with the owned Delegation V2 client", async () => {
    const delegated = vi.fn(async (
      request: OwnedDelegationV2Request,
      options: DelegateDagFusionNodeOptions,
    ) => {
      expect(request.ownerRunId).toBe("delegated-run");
      expect(request.nodeId).toBe("research");
      expect(options.limits).toEqual({ maxTokens: 1_000, maxCostUsd: 2 });
      expect(options.signal).toBeInstanceOf(AbortSignal);
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
        response: {
          version: SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION,
          requestId: request.requestId,
          ownerRunId: request.ownerRunId,
          nodeId: request.nodeId,
          status: "completed",
        },
        progress: { started: true, tokens: 2, toolCalls: 0, durationMs: 1 },
      } as DagFusionDelegationReceipt;
    });
    const prepareAgent = vi.fn((request: DagFusionAgentExecutionRequestV1) => ({
      request: {
        version: SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION,
        requestId: "delegation-1",
        ownerRunId: request.runId,
        nodeId: request.node.id,
        agent: request.node.specialist,
        task: request.node.instruction,
        context: "fresh" as const,
        cwd: "/trusted/host/workspace",
        model: `${request.node.model.provider}/${request.node.model.model}`,
        thinking: request.node.model.reasoning,
        timeoutMs: request.admission.timeoutMs,
        turnBudget: { maxTurns: 3 },
        toolBudget: { hard: 2, block: "*" as const },
        result: { kind: "text" as const },
      },
      reconcileUsage: vi.fn(),
    }));
    const host = createDagFusionDelegatingTrustedHostV1({
      delegationHost: { delegate: delegated },
      prepareAgent,
      mapAgentReceipt(_receipt, request) {
        return exactResult(request.node, { delegated: true }, {
          inputTokens: 1,
          outputTokens: 1,
          costUsd: 0,
          modelCalls: 1,
        });
      },
      async executeFusion(request) {
        return exactResult(request.node, { answer: true }, {
          inputTokens: 1,
          outputTokens: 1,
          costUsd: 0,
          modelCalls: 3,
        });
      },
    });

    await executeDagFusionGraphV1(graph(), host, { runId: "delegated-run" });
    expect(prepareAgent).toHaveBeenCalledOnce();
    expect(delegated).toHaveBeenCalledOnce();
  });

  it("makes the Delegation V2 adapter wait for its reconciler before acknowledging abort", async () => {
    const abortController = new AbortController();
    const delegationStarted = deferred();
    const reconciliationGate = deferred();
    let reconciliationFinished = false;
    let callerSettled = false;
    const mapAgentReceipt = vi.fn();
    const executeFusion = vi.fn();
    const host = createDagFusionDelegatingTrustedHostV1({
      delegationHost: {
        async delegate(request, options) {
          delegationStarted.resolve();
          await new Promise<void>((resolve) => {
            if (options.signal?.aborted) resolve();
            else options.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          await options.reconcileUsage({
            identity: {
              requestId: request.requestId,
              ownerRunId: request.ownerRunId,
              nodeId: request.nodeId,
            },
            reason: "caller-aborted",
            progress: {
              started: true,
              tokens: 2,
              toolCalls: 0,
              durationMs: 5,
            },
          });
          throw new DagFusionDelegationError(
            "Delegation stopped after reconciliation.",
            "DAG_FUSION_ABORTED",
          );
        },
      },
      prepareAgent(request) {
        return {
          request: {
            version: SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION,
            requestId: "adapter-abort-1",
            ownerRunId: request.runId,
            nodeId: request.node.id,
            agent: request.node.specialist,
            task: request.node.instruction,
            context: "fresh",
            cwd: "/trusted/host/workspace",
            model: `${request.node.model.provider}/${request.node.model.model}`,
            thinking: request.node.model.reasoning,
            timeoutMs: request.admission.timeoutMs,
            turnBudget: { maxTurns: 3 },
            toolBudget: { hard: 2, block: "*" },
            result: { kind: "text" },
          },
          async reconcileUsage() {
            await reconciliationGate.promise;
            reconciliationFinished = true;
          },
        };
      },
      mapAgentReceipt,
      executeFusion,
    });

    const pending = executeDagFusionGraphV1(graph(), host, {
      runId: "adapter-abort",
      signal: abortController.signal,
    });
    const callerObservation = pending.then(
      () => {
        callerSettled = true;
      },
      () => {
        callerSettled = true;
      },
    );
    await delegationStarted.promise;
    abortController.abort();
    await Promise.resolve();
    expect(callerSettled).toBe(false);

    reconciliationGate.resolve();
    await expectRuntimeCode(pending, "DAG_FUSION_RUNTIME_ABORTED");
    await callerObservation;
    expect(reconciliationFinished).toBe(true);
    expect(mapAgentReceipt).not.toHaveBeenCalled();
    expect(executeFusion).not.toHaveBeenCalled();
  });

  it("never maps an unconfirmed Delegation V2 cancellation to abort-settled", async () => {
    const abortController = new AbortController();
    const delegationStarted = deferred();
    const reconcileUsage = vi.fn();
    const host = createDagFusionDelegatingTrustedHostV1({
      delegationHost: {
        async delegate(_request, options) {
          delegationStarted.resolve();
          await new Promise<void>((resolve) => {
            if (options.signal?.aborted) resolve();
            else options.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          await options.reconcileUsage({
            identity: {
              requestId: "adapter-unconfirmed-1",
              ownerRunId: "adapter-unconfirmed",
              nodeId: "research",
            },
            reason: "protocol-error",
            progress: {
              started: true,
              tokens: 0,
              toolCalls: 0,
              durationMs: 5,
            },
          });
          throw new DagFusionDelegationError(
            "Child cancellation acknowledgement never arrived.",
            "DAG_FUSION_CANCELLATION_UNCONFIRMED",
          );
        },
      },
      prepareAgent(request) {
        return {
          request: {
            version: SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION,
            requestId: "adapter-unconfirmed-1",
            ownerRunId: request.runId,
            nodeId: request.node.id,
            agent: request.node.specialist,
            task: request.node.instruction,
            context: "fresh",
            cwd: "/trusted/host/workspace",
            model: `${request.node.model.provider}/${request.node.model.model}`,
            thinking: request.node.model.reasoning,
            timeoutMs: request.admission.timeoutMs,
            turnBudget: { maxTurns: 3 },
            toolBudget: { hard: 2, block: "*" },
            result: { kind: "text" },
          },
          reconcileUsage,
        };
      },
      mapAgentReceipt: vi.fn(),
      executeFusion: vi.fn(),
    });

    const pending = executeDagFusionGraphV1(graph(), host, {
      runId: "adapter-unconfirmed",
      signal: abortController.signal,
    });
    await delegationStarted.promise;
    abortController.abort();

    await expectRuntimeCode(pending, "DAG_FUSION_RUNTIME_HOST_FAILED");
    expect(reconcileUsage).toHaveBeenCalledWith(expect.objectContaining({
      reason: "protocol-error",
    }));
  });

  it("rejects a delegation plan that changes ownership", async () => {
    const host = createDagFusionDelegatingTrustedHostV1({
      delegationHost: { delegate: vi.fn() },
      prepareAgent(request) {
        return {
          request: {
            version: SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION,
            requestId: "wrong-owner",
            ownerRunId: "another-run",
            nodeId: request.node.id,
            agent: request.node.specialist,
            task: request.node.instruction,
            context: "fresh",
            cwd: "/trusted/host/workspace",
            model: "openai-codex/gpt-5.4",
            thinking: "high",
            timeoutMs: 1_000,
            turnBudget: { maxTurns: 1 },
            toolBudget: { hard: 0, block: "*" },
            result: { kind: "text" },
          },
          reconcileUsage: vi.fn(),
        };
      },
      mapAgentReceipt: vi.fn(),
      executeFusion: vi.fn(),
    });
    await expectRuntimeCode(
      executeDagFusionGraphV1(graph(), host, { runId: "owned-run" }),
      "DAG_FUSION_RUNTIME_INVALID_DELEGATION_PLAN",
    );
  });
});
