import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import {
  DefaultResourceLoader,
  createEventBus,
  type ExtensionAPI,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import subagentsExtension from "pi-subagents";
import {
  SUBAGENT_DELEGATION_CANCEL_EVENT,
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  SUBAGENT_DELEGATION_STARTED_EVENT,
  SUBAGENT_DELEGATION_UPDATE_EVENT,
  SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION,
  type SubagentDelegationV2Request,
  type SubagentDelegationV2TerminalResponse,
} from "pi-subagents/delegation";
import {
  createDagFusionDelegationHost,
  DagFusionDelegationError,
  expectedDelegatedModel,
  type DagFusionDelegationHost,
  type DagFusionDelegationIdentity,
  type OwnedDelegationV2Request,
} from "../pi-packages/dag-fusion-drive/index.ts";
import {
  createDagFusionWorkflowSessionBridge,
  dagFusionExtensionPath,
} from "../src/agent/dag-fusion-bridge.ts";
import { subagentsExtensionPath } from "../src/agent/subagent-bridge.ts";

const require_ = createRequire(import.meta.url);
const hosts: DagFusionDelegationHost[] = [];

function request(
  overrides: Partial<OwnedDelegationV2Request> = {},
): OwnedDelegationV2Request {
  return {
    version: SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION,
    requestId: "attempt-1",
    ownerRunId: "workflow-1",
    nodeId: "research-1",
    agent: "researcher",
    task: "Collect evidence for the node.",
    context: "fresh",
    cwd: "/tmp/project",
    model: "openai-codex/gpt-5.4",
    thinking: "high",
    timeoutMs: 1_000,
    turnBudget: { maxTurns: 3, graceTurns: 1 },
    toolBudget: { hard: 2, block: "*" },
    result: { kind: "text" },
    ...overrides,
  };
}

function identity(
  ownedRequest: OwnedDelegationV2Request,
): DagFusionDelegationIdentity {
  return {
    requestId: ownedRequest.requestId,
    ownerRunId: ownedRequest.ownerRunId,
    nodeId: ownedRequest.nodeId,
  };
}

function completedResponse(
  ownedRequest: OwnedDelegationV2Request,
  overrides: Partial<SubagentDelegationV2TerminalResponse> = {},
): SubagentDelegationV2TerminalResponse {
  return {
    version: SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION,
    ...identity(ownedRequest),
    status: "completed",
    runId: `child-${ownedRequest.requestId}`,
    agent: ownedRequest.agent,
    model: expectedDelegatedModel(ownedRequest.model, ownedRequest.thinking),
    thinking: ownedRequest.thinking,
    launchContractDigest: `sha256:${ownedRequest.requestId}`,
    result: { kind: "text", text: "evidence" },
    usage: {
      input: 8,
      output: 4,
      cacheRead: 2,
      cacheWrite: 0,
      cost: 0.02,
      turns: 1,
      toolCalls: 1,
      durationMs: 20,
    },
    ...overrides,
  };
}

function cancelledResponse(
  ownedRequest: OwnedDelegationV2Request,
  overrides: Partial<SubagentDelegationV2TerminalResponse> = {},
): SubagentDelegationV2TerminalResponse {
  return {
    version: SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION,
    ...identity(ownedRequest),
    status: "cancelled",
    ...overrides,
  };
}

function nextEventLoopTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function trackedHost(
  events: ReturnType<typeof createEventBus>,
  options: Omit<
    Parameters<typeof createDagFusionDelegationHost>[0],
    "events"
  > = {},
): DagFusionDelegationHost {
  const host = createDagFusionDelegationHost({ events, ...options });
  hosts.push(host);
  return host;
}

function expectCode(
  promise: Promise<unknown>,
  code: DagFusionDelegationError["code"],
): Promise<void> {
  return promise.then(
    () => {
      throw new Error(`Expected ${code}, but the promise resolved.`);
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(DagFusionDelegationError);
      expect((error as DagFusionDelegationError).code).toBe(code);
    },
  );
}

afterEach(async () => {
  await Promise.allSettled(hosts.splice(0).map((host) => host.dispose()));
  vi.restoreAllMocks();
});

describe("pi-subagents compatibility", () => {
  it("loads both extensions through their public entries", () => {
    expect(subagentsExtensionPath()).toBe(require_.resolve("pi-subagents"));
    expect(typeof subagentsExtension).toBe("function");
    expect(dagFusionExtensionPath()).toMatch(/dag-fusion-drive[/\\]index\.ts$/);
  });

  it("exposes the Delegation V2 owned-leaf contract", () => {
    const ownedRequest: SubagentDelegationV2Request = request();

    expect(ownedRequest.version).toBe(2);
    expect(SUBAGENT_DELEGATION_REQUEST_EVENT).toBe(
      "prompt-template:subagent:request",
    );
    expect(SUBAGENT_DELEGATION_RESPONSE_EVENT).toBe(
      "prompt-template:subagent:response",
    );
    expect(SUBAGENT_DELEGATION_CANCEL_EVENT).toBe(
      "prompt-template:subagent:cancel",
    );
  });

  it("round-trips a bounded V2 request through the real pi-subagents extension", async () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "kady-pi-v2-smoke-"),
    );
    const bridge = createDagFusionWorkflowSessionBridge({
      maxPending: 1,
      maxRequestTimeoutMs: 2_000,
    });
    const ownedRequest = request({ cwd: temporaryRoot });
    try {
      const loader = new DefaultResourceLoader({
        cwd: temporaryRoot,
        agentDir: path.join(temporaryRoot, "agent"),
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        additionalExtensionPaths: [subagentsExtensionPath()],
        extensionFactories: [bridge.extension],
      });
      await loader.reload();

      const reconciled = vi.fn();
      const receipt = await bridge.getHost().delegate(ownedRequest, {
        limits: { maxTokens: 100, maxCostUsd: 1 },
        reconcileUsage: reconciled,
      });

      // No AgentSession is active in this loader-only smoke. Reaching this
      // typed terminal proves the actual pi-subagents V2 listener parsed and
      // correlated the full ownership tuple without launching paid work.
      expect(receipt.response).toMatchObject({
        version: 2,
        ...identity(ownedRequest),
        status: "unavailable_context",
      });
      expect(reconciled).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "terminal-response",
          responseStatus: "unavailable_context",
        }),
      );
    } finally {
      await bridge.dispose();
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("round-trips one owned request with exact model/thinking and reconciled usage", async () => {
    const events = createEventBus();
    const host = trackedHost(events);
    const ownedRequest = request();
    const reconciled = vi.fn();
    const updates = vi.fn();
    let wireRequest: unknown;

    events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (data) => {
      wireRequest = data;
      events.emit(SUBAGENT_DELEGATION_STARTED_EVENT, {
        version: 2,
        ...identity(ownedRequest),
      });
      events.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, {
        version: 2,
        ...identity(ownedRequest),
        model: expectedDelegatedModel(ownedRequest.model, ownedRequest.thinking),
        tokens: 10,
        toolCount: 1,
        durationMs: 10,
      });
      events.emit(
        SUBAGENT_DELEGATION_RESPONSE_EVENT,
        completedResponse(ownedRequest),
      );
    });

    const receipt = await host.delegate(ownedRequest, {
      limits: { maxTokens: 100, maxCostUsd: 1 },
      reconcileUsage: reconciled,
      onUpdate: updates,
    });

    expect(wireRequest).toEqual(ownedRequest);
    expect(receipt.requested).toEqual({
      agent: "researcher",
      model: "openai-codex/gpt-5.4",
      thinking: "high",
    });
    expect(receipt.resolved).toMatchObject({
      agent: "researcher",
      model: "openai-codex/gpt-5.4:high",
      thinking: "high",
    });
    expect(receipt.usage).toMatchObject({ totalTokens: 12, cost: 0.02 });
    expect(updates).toHaveBeenCalledTimes(1);
    expect(reconciled).toHaveBeenCalledOnce();
    expect(reconciled.mock.calls[0][0]).toMatchObject({
      reason: "terminal-response",
      responseStatus: "completed",
      usage: { input: 8, output: 4 },
    });
    expect(host.snapshot().pending).toEqual([]);
  });

  it("keeps explicit cancellation owned until an exact terminal response settles the child", async () => {
    const events = createEventBus();
    const host = trackedHost(events);
    const ownedRequest = request();
    const cancels: unknown[] = [];
    const reconciled = vi.fn();
    let acknowledgeCancellation!: () => void;
    const mayAcknowledgeCancellation = new Promise<void>((resolve) => {
      acknowledgeCancellation = resolve;
    });
    events.on(SUBAGENT_DELEGATION_CANCEL_EVENT, (data) => {
      cancels.push(data);
      void mayAcknowledgeCancellation.then(() => {
        // Even a late ordinary completion is terminal settlement evidence, but
        // it must never turn a requested cancellation back into success.
        events.emit(
          SUBAGENT_DELEGATION_RESPONSE_EVENT,
          completedResponse(ownedRequest),
        );
      });
    });

    const delegated = host.delegate(ownedRequest, {
      limits: { maxTokens: 100, maxCostUsd: 1 },
      reconcileUsage: reconciled,
    });
    const rejection = expectCode(delegated, "DAG_FUSION_CANCELLED");

    expect(host.cancel(identity(ownedRequest))).toBe(true);
    await nextEventLoopTurn();
    expect(host.snapshot().pending).toEqual([identity(ownedRequest)]);
    expect(reconciled).not.toHaveBeenCalled();
    expect(host.cancel(identity(ownedRequest))).toBe(false);

    acknowledgeCancellation();
    await rejection;
    expect(cancels).toEqual([
      { version: 2, ...identity(ownedRequest) },
    ]);
    expect(reconciled).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: identity(ownedRequest),
        reason: "caller-cancelled",
        responseStatus: "completed",
        usage: expect.objectContaining({ input: 8, output: 4 }),
      }),
    );
    expect(host.snapshot().pending).toEqual([]);
  });

  it("keeps caller abort pending until the child acknowledges settlement", async () => {
    const events = createEventBus();
    const host = trackedHost(events);
    const ownedRequest = request();
    const controller = new AbortController();
    const reconciled = vi.fn();
    let acknowledgeCancellation!: () => void;
    const mayAcknowledgeCancellation = new Promise<void>((resolve) => {
      acknowledgeCancellation = resolve;
    });
    events.on(SUBAGENT_DELEGATION_CANCEL_EVENT, () => {
      void mayAcknowledgeCancellation.then(() => {
        events.emit(
          SUBAGENT_DELEGATION_RESPONSE_EVENT,
          cancelledResponse(ownedRequest),
        );
      });
    });
    const delegated = host.delegate(ownedRequest, {
      limits: { maxTokens: 100, maxCostUsd: 1 },
      reconcileUsage: reconciled,
      signal: controller.signal,
    });

    controller.abort("user stop");
    await nextEventLoopTurn();
    expect(host.snapshot().pending).toEqual([identity(ownedRequest)]);
    expect(reconciled).not.toHaveBeenCalled();

    acknowledgeCancellation();
    await expectCode(delegated, "DAG_FUSION_ABORTED");
    expect(reconciled).toHaveBeenCalledWith(expect.objectContaining({
      reason: "caller-aborted",
      responseStatus: "cancelled",
    }));
  });

  it("ignores wrong-owner and stale terminal events as cancellation acknowledgements", async () => {
    const events = createEventBus();
    const host = trackedHost(events);
    const ownedRequest = request();
    const delegated = host.delegate(ownedRequest, {
      limits: { maxTokens: 100, maxCostUsd: 1 },
      reconcileUsage: () => undefined,
    });
    const rejection = expectCode(delegated, "DAG_FUSION_CANCELLED");
    expect(host.cancel(identity(ownedRequest))).toBe(true);

    events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
      ...cancelledResponse(ownedRequest),
      ownerRunId: "someone-elses-run",
    });
    await Promise.resolve();
    expect(host.snapshot().pending).toEqual([identity(ownedRequest)]);
    expect(host.snapshot().rejectedEvents).toBe(1);

    events.emit(
      SUBAGENT_DELEGATION_RESPONSE_EVENT,
      cancelledResponse(ownedRequest),
    );
    await rejection;

    events.emit(
      SUBAGENT_DELEGATION_RESPONSE_EVENT,
      cancelledResponse(ownedRequest),
    );
    await Promise.resolve();
    expect(host.snapshot().rejectedEvents).toBe(2);
  });

  it.each([
    ["model", { model: "openrouter/other:model" }],
    ["thinking", { thinking: "low" }],
    ["agent", { agent: "fallback-researcher" }],
  ])("rejects an exact %s mismatch without accepting fallback", async (_field, mismatch) => {
    const events = createEventBus();
    const host = trackedHost(events);
    const ownedRequest = request();
    const reconciled = vi.fn();
    events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, () => {
      events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        ...completedResponse(ownedRequest),
        ...mismatch,
      });
    });

    await expectCode(
      host.delegate(ownedRequest, {
        limits: { maxTokens: 100, maxCostUsd: 1 },
        reconcileUsage: reconciled,
      }),
      "DAG_FUSION_PROTOCOL_MISMATCH",
    );
    expect(reconciled).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "protocol-error" }),
    );
  });

  it("rejects terminal usage that contradicts progress or reserved limits", async () => {
    const events = createEventBus();
    const host = trackedHost(events);
    const ownedRequest = request();
    events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, () => {
      events.emit(SUBAGENT_DELEGATION_STARTED_EVENT, {
        version: 2,
        ...identity(ownedRequest),
      });
      events.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, {
        version: 2,
        ...identity(ownedRequest),
        tokens: 20,
      });
      events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        ...completedResponse(ownedRequest),
        usage: {
          ...completedResponse(ownedRequest).usage,
          input: 8,
          output: 4,
        },
      });
    });

    await expectCode(
      host.delegate(ownedRequest, {
        limits: { maxTokens: 100, maxCostUsd: 1 },
        reconcileUsage: () => undefined,
      }),
      "DAG_FUSION_USAGE_MISMATCH",
    );
  });

  it("fails closed on concurrent, logical-node, identity-history, and total-history bounds", async () => {
    const events = createEventBus();
    const host = trackedHost(events, { maxPending: 1, maxIdentityFacts: 1 });
    const first = request();
    events.on(SUBAGENT_DELEGATION_CANCEL_EVENT, () => {
      events.emit(
        SUBAGENT_DELEGATION_RESPONSE_EVENT,
        cancelledResponse(first),
      );
    });
    const firstPromise = host.delegate(first, {
      limits: { maxTokens: 100, maxCostUsd: 1 },
      reconcileUsage: () => undefined,
    });
    const firstRejection = expectCode(firstPromise, "DAG_FUSION_CANCELLED");

    await expectCode(
      host.delegate(request({ requestId: "attempt-2" }), {
        limits: { maxTokens: 100, maxCostUsd: 1 },
        reconcileUsage: () => undefined,
      }),
      "DAG_FUSION_DUPLICATE_NODE",
    );
    await expectCode(
      host.delegate(
        request({ requestId: "attempt-3", nodeId: "research-2" }),
        {
          limits: { maxTokens: 100, maxCostUsd: 1 },
          reconcileUsage: () => undefined,
        },
      ),
      "DAG_FUSION_CAPACITY_EXHAUSTED",
    );

    expect(host.cancel(identity(first))).toBe(true);
    await firstRejection;
    expect(host.snapshot()).toMatchObject({ saturated: true, identityFacts: 1 });

    await expectCode(
      host.delegate(first, {
        limits: { maxTokens: 100, maxCostUsd: 1 },
        reconcileUsage: () => undefined,
      }),
      "DAG_FUSION_DUPLICATE_IDENTITY",
    );
    await expectCode(
      host.delegate(
        request({ requestId: "attempt-4", nodeId: "research-4" }),
        {
          limits: { maxTokens: 100, maxCostUsd: 1 },
          reconcileUsage: () => undefined,
        },
      ),
      "DAG_FUSION_CAPACITY_EXHAUSTED",
    );
  });

  it("reports host timeout only after the exact child cancellation acknowledgement", async () => {
    const events = createEventBus();
    const host = trackedHost(events, {
      maxRequestTimeoutMs: 100,
      responseGraceMs: 1,
    });
    const ownedRequest = request({ timeoutMs: 5 });
    const cancels: unknown[] = [];
    const reconciled = vi.fn();
    events.on(SUBAGENT_DELEGATION_CANCEL_EVENT, (data) => {
      cancels.push(data);
      events.emit(
        SUBAGENT_DELEGATION_RESPONSE_EVENT,
        cancelledResponse(ownedRequest),
      );
    });

    await expectCode(
      host.delegate(ownedRequest, {
        limits: { maxTokens: 100, maxCostUsd: 1 },
        reconcileUsage: reconciled,
      }),
      "DAG_FUSION_TIMEOUT",
    );
    expect(cancels).toEqual([{ version: 2, ...identity(ownedRequest) }]);
    expect(reconciled).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "host-timeout",
        responseStatus: "cancelled",
      }),
    );
  });

  it("full-charges but quarantines an unacknowledged child until its exact terminal response", async () => {
    const events = createEventBus();
    const host = trackedHost(events, { cancellationAckTimeoutMs: 1 });
    const ownedRequest = request();
    const reconciled = vi.fn();
    const delegated = host.delegate(ownedRequest, {
      limits: { maxTokens: 100, maxCostUsd: 1 },
      reconcileUsage: reconciled,
    });

    expect(host.cancel(identity(ownedRequest))).toBe(true);
    await expectCode(delegated, "DAG_FUSION_CANCELLATION_UNCONFIRMED");
    expect(reconciled).toHaveBeenCalledWith({
      identity: identity(ownedRequest),
      reason: "protocol-error",
      progress: {
        started: false,
        tokens: 0,
        toolCalls: 0,
        durationMs: 0,
      },
    });
    expect(host.snapshot()).toMatchObject({
      pending: [identity(ownedRequest)],
      quarantined: [identity(ownedRequest)],
    });

    await expectCode(
      host.delegate(request({ requestId: "attempt-2", nodeId: "research-2" }), {
        limits: { maxTokens: 100, maxCostUsd: 1 },
        reconcileUsage: () => undefined,
      }),
      "DAG_FUSION_QUARANTINED",
    );

    let disposeSettled = false;
    const disposing = host.dispose().then(() => {
      disposeSettled = true;
    });
    await nextEventLoopTurn();
    expect(disposeSettled).toBe(false);

    events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
      ...cancelledResponse(ownedRequest),
      ownerRunId: "wrong-owner",
    });
    await nextEventLoopTurn();
    expect(disposeSettled).toBe(false);
    expect(host.snapshot().quarantined).toEqual([identity(ownedRequest)]);

    events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
      ...cancelledResponse(ownedRequest),
      unexpectedField: "not a trusted V2 terminal shape",
    });
    await nextEventLoopTurn();
    expect(disposeSettled).toBe(false);
    expect(host.snapshot()).toMatchObject({
      quarantined: [identity(ownedRequest)],
      rejectedEvents: 2,
    });

    events.emit(
      SUBAGENT_DELEGATION_RESPONSE_EVENT,
      cancelledResponse(ownedRequest),
    );
    await disposing;
    expect(reconciled).toHaveBeenCalledOnce();
    expect(host.snapshot()).toMatchObject({ pending: [], quarantined: [] });
  });

  it("fails visibly and quarantines a malformed exact cancellation acknowledgement", async () => {
    const events = createEventBus();
    const host = trackedHost(events);
    const ownedRequest = request();
    const reconciled = vi.fn();
    events.on(SUBAGENT_DELEGATION_CANCEL_EVENT, () => {
      events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        ...completedResponse(ownedRequest),
        model: "openrouter/wrong-model:high",
      });
    });
    const delegated = host.delegate(ownedRequest, {
      limits: { maxTokens: 100, maxCostUsd: 1 },
      reconcileUsage: reconciled,
    });

    expect(host.cancel(identity(ownedRequest))).toBe(true);
    await expectCode(delegated, "DAG_FUSION_PROTOCOL_MISMATCH");
    expect(reconciled).toHaveBeenCalledWith(expect.objectContaining({
      reason: "protocol-error",
    }));
    expect(reconciled.mock.calls[0]?.[0]).not.toHaveProperty("usage");
    expect(host.snapshot()).toMatchObject({
      pending: [identity(ownedRequest)],
      quarantined: [identity(ownedRequest)],
    });

    events.emit(
      SUBAGENT_DELEGATION_RESPONSE_EVENT,
      cancelledResponse(ownedRequest),
    );
    await vi.waitFor(() => {
      expect(host.snapshot()).toMatchObject({ pending: [], quarantined: [] });
    });
    expect(reconciled).toHaveBeenCalledOnce();
  });

  it("disposes all owned leaves and rejects later work", async () => {
    const events = createEventBus();
    const host = trackedHost(events);
    const ownedRequest = request();
    const cancels: unknown[] = [];
    events.on(SUBAGENT_DELEGATION_CANCEL_EVENT, (data) => {
      cancels.push(data);
      events.emit(
        SUBAGENT_DELEGATION_RESPONSE_EVENT,
        cancelledResponse(ownedRequest),
      );
    });
    const delegated = host.delegate(ownedRequest, {
      limits: { maxTokens: 100, maxCostUsd: 1 },
      reconcileUsage: () => undefined,
    });
    const rejection = expectCode(delegated, "DAG_FUSION_DISPOSED");

    await host.dispose();
    await rejection;
    expect(cancels).toEqual([{ version: 2, ...identity(ownedRequest) }]);
    expect(host.snapshot()).toEqual({
      disposed: true,
      saturated: false,
      pending: [],
      quarantined: [],
      identityFacts: 0,
      rejectedEvents: 0,
    });
    await expectCode(
      host.delegate(request({ requestId: "later" }), {
        limits: { maxTokens: 100, maxCostUsd: 1 },
        reconcileUsage: () => undefined,
      }),
      "DAG_FUSION_DISPOSED",
    );
  });

  it("exposes a host only after the dedicated Kady loader binds its extension", async () => {
    const events = createEventBus();
    const shutdownHandlers: Array<() => void | Promise<void>> = [];
    const bridge = createDagFusionWorkflowSessionBridge({ maxPending: 2 });
    expect(() => bridge.getHost()).toThrow(/resource loader has reloaded/);

    const inline = bridge.extension as Exclude<InlineExtension, Function>;
    const fakePi = {
      events,
      on(event: string, handler: () => void | Promise<void>) {
        if (event === "session_shutdown") shutdownHandlers.push(handler);
      },
    } as unknown as ExtensionAPI;
    await inline.factory(fakePi);

    expect(bridge.getHost().snapshot()).toMatchObject({
      disposed: false,
      pending: [],
    });
    await Promise.all(shutdownHandlers.map((handler) => handler()));
    expect(() => bridge.getHost()).toThrow(/resource loader has reloaded/);
    await bridge.dispose();
    expect(() => bridge.getHost()).toThrow(/bridge is disposed/);
  });
});
