import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { ProjectPaths } from "../src/projects.ts";
import type { WorkflowModelResolutionReceipt } from "../src/workflows/run-state.ts";
import type { ModelRequest, WorkflowNode } from "../src/workflows/schema.ts";
import {
  buildHostedFusionConfig,
  hostedFusionQuarantineSnapshot,
  runHostedOpenRouterFusion,
  waitForHostedFusionQuarantines,
  type HostedFusionDependencies,
  type HostedFusionResolvedModels,
  type HostedOpenRouterFusionRequest,
} from "../src/workflows/hosted-fusion.ts";

type HostedFusionDefinition = Extract<
  Extract<WorkflowNode, { kind: "fusion" }>["fusion"],
  { mode: "openrouter-router" }
>;

function paths(projectId: string): ProjectPaths {
  const root = `/tmp/kady-${projectId}`;
  const sandbox = `${root}/sandbox`;
  const kadyDir = `${sandbox}/.kady`;
  const workflowsDir = `${kadyDir}/workflows`;
  const workflowBudgetDir = `${workflowsDir}/budget`;
  const modalDir = `${kadyDir}/modal`;
  return {
    id: projectId,
    root,
    projectJson: `${root}/project.json`,
    sandbox,
    uploadDir: `${sandbox}/user_data`,
    kadyDir,
    runsDir: `${kadyDir}/runs`,
    notebookDir: `${kadyDir}/notebook`,
    provenanceDir: `${kadyDir}/provenance`,
    workflowsDir,
    workflowDefinitionsDir: `${workflowsDir}/definitions`,
    workflowRunsDir: `${workflowsDir}/runs`,
    workflowBudgetDir,
    workflowReservationsDir: `${workflowBudgetDir}/reservations`,
    modalDir,
    modalJobsDir: `${modalDir}/jobs`,
    modalReservationsDir: `${modalDir}/reservations`,
    modalCacheDir: `${modalDir}/cache`,
    modalEnvironmentsDir: `${modalDir}/environments`,
    skillsDir: `${sandbox}/.pi/skills`,
    sessionsDir: `${sandbox}/.pi/sessions`,
  };
}

function openRouterModel(
  model: string,
  reasoning: "off" | "low" | "high" | "xhigh" = "high",
): ModelRequest {
  return {
    requested: {
      source: "fixed",
      provider: "openrouter",
      model,
      auth: { kind: "api-key" },
      reasoning,
    },
    resolution: { mode: "exact" },
  };
}

function fusion(reasoning: "off" | "low" | "high" | "xhigh" = "high"): HostedFusionDefinition {
  return {
    mode: "openrouter-router",
    router: openRouterModel("openrouter/fusion", reasoning),
    members: [
      { id: "one", role: "Independent analysis", model: openRouterModel("vendor/one", reasoning) },
      { id: "two", role: "Adversarial analysis", model: openRouterModel("vendor/two", reasoning) },
    ],
    judge: openRouterModel("vendor/judge", reasoning),
  };
}

function receipt(
  request: ModelRequest,
  runtime: WorkflowModelResolutionReceipt["resolved"]["runtime"] = "openrouter-fusion",
): WorkflowModelResolutionReceipt {
  if (request.requested.source !== "fixed") throw new Error("test request must be fixed");
  return {
    request: structuredClone(request),
    resolved: {
      provider: request.requested.provider,
      model: request.requested.model,
      auth: { kind: request.requested.auth.kind },
      reasoning: request.requested.reasoning,
      runtime,
    },
    fallbackUsed: false,
  };
}

function resolved(definition: HostedFusionDefinition): HostedFusionResolvedModels {
  return {
    members: definition.members.map((member) => ({
      memberId: member.id,
      role: member.role,
      receipt: receipt(member.model),
    })),
    judgeDeliberation: receipt(definition.judge),
    judgeFinal: receipt(definition.judge),
  };
}

const validStats = {
  assistantMessages: 1,
  toolCalls: 0,
  tokens: {
    input: 120,
    output: 80,
    cacheRead: 10,
    cacheWrite: 0,
    total: 210,
  },
  cost: 0.42,
};

class FakeHostedSession {
  readonly sessionId = "hosted-session";
  readonly state: { errorMessage?: string } = {};
  isIdle = true;
  text = "Fused answer with material caveats.";
  stats = structuredClone(validStats);
  promptError: Error | undefined;
  promptImplementation: (() => Promise<void>) | undefined;

  constructor(private readonly events: string[]) {}

  async prompt(): Promise<void> {
    this.events.push("prompt");
    this.isIdle = false;
    if (this.promptImplementation) return this.promptImplementation();
    this.isIdle = true;
    if (this.promptError) throw this.promptError;
  }

  getLastAssistantText(): string | undefined {
    return this.text;
  }

  getSessionStats() {
    return structuredClone(this.stats);
  }

  clearQueue(): void {
    this.events.push("clear-queue");
  }

  async abort(): Promise<void> {
    this.events.push("abort");
    this.isIdle = true;
  }

  dispose(): void {
    this.events.push("dispose");
  }
}

let requestSequence = 0;

function request(
  definition: HostedFusionDefinition,
  reconcileUsage: HostedOpenRouterFusionRequest["reconcileUsage"],
  signal = new AbortController().signal,
  requestedProjectId?: string,
): HostedOpenRouterFusionRequest {
  requestSequence += 1;
  const projectId = requestedProjectId ?? `hosted-fusion-test-${requestSequence}`;
  return {
    projectId,
    paths: paths(projectId),
    identity: {
      requestId: `dagfusion_test_${requestSequence}`,
      ownerRunId: `wfrun_test_${requestSequence}`,
      nodeId: `dagx_test_${requestSequence}:fusion-hosted-compound`,
    },
    fusion: definition,
    resolved: resolved(definition),
    task: "Fuse the evidence.",
    maxTokens: 1_000,
    maxCostUsd: 2,
    timeoutMs: 5_000,
    signal,
    reconcileUsage,
  };
}

function fakeDependencies(
  session: FakeHostedSession,
  events: string[],
  now: () => number = (() => 100),
): Partial<HostedFusionDependencies> {
  return {
    buildModel(config) {
      events.push("build-model");
      expect(config).toMatchObject({ model: "openrouter/fusion" });
      return { provider: "openrouter", id: "openrouter/fusion" } as Model<Api>;
    },
    async createSession(input) {
      events.push("create-session");
      expect(input.model).toMatchObject({ provider: "openrouter", id: "openrouter/fusion" });
      return session;
    },
    setConfig(_projectId, _sessionId, config) {
      events.push(config ? "set-config" : "clear-config");
    },
    now,
  };
}

describe("hosted OpenRouter Fusion", () => {
  it("builds the exact panel, judge, shared-reasoning router config", () => {
    const definition = fusion("off");
    const config = buildHostedFusionConfig(definition, resolved(definition));

    expect(config).toEqual({
      model: "openrouter/fusion",
      reasoning_effort: "none",
      plugins: [
        {
          id: "fusion",
          preset: "general-high",
          analysis_models: ["vendor/one", "vendor/two"],
          model: "vendor/judge",
          max_tool_calls: 16,
        },
      ],
    });
  });

  it("rejects a changed receipt or non-shared reasoning at runtime", () => {
    const definition = fusion();
    const changed = resolved(definition);
    changed.members[0].receipt.resolved.runtime = "pi";
    expect(() => buildHostedFusionConfig(definition, changed)).toThrow(
      /exact immutable OpenRouter Fusion resolution receipt/,
    );

    const mismatched = fusion();
    mismatched.judge = openRouterModel("vendor/judge", "low");
    expect(() => buildHostedFusionConfig(mismatched, resolved(mismatched))).toThrow(
      /shared reasoning level/,
    );
  });

  it("runs one isolated session and reconciles complete actual usage exactly once", async () => {
    const events: string[] = [];
    const session = new FakeHostedSession(events);
    const reconcileUsage = vi.fn(async () => {
      events.push("reconcile");
    });

    const result = await runHostedOpenRouterFusion(
      request(fusion(), reconcileUsage),
      fakeDependencies(session, events),
    );

    expect(result).toMatchObject({
      text: "Fused answer with material caveats.",
      textTruncated: false,
      usage: { input: 120, output: 80, cacheRead: 10, cost: 0.42, turns: 1 },
    });
    expect(reconcileUsage).toHaveBeenCalledOnce();
    expect(reconcileUsage).toHaveBeenCalledWith(expect.objectContaining({
      reason: "terminal-response",
      responseStatus: "completed",
      usage: expect.objectContaining({ input: 120, output: 80, cost: 0.42 }),
    }));
    expect(events).toEqual([
      "build-model",
      "create-session",
      "set-config",
      "prompt",
      "clear-queue",
      "clear-config",
      "dispose",
      "reconcile",
    ]);
  });

  it("fails closed with one failed reconciliation when provider usage is missing", async () => {
    const events: string[] = [];
    const session = new FakeHostedSession(events);
    session.stats.tokens.output = Number.NaN;
    const reconcileUsage = vi.fn();

    await expect(runHostedOpenRouterFusion(
      request(fusion(), reconcileUsage),
      fakeDependencies(session, events),
    )).rejects.toMatchObject({ code: "HOSTED_FUSION_USAGE_MISSING" });

    expect(reconcileUsage).toHaveBeenCalledOnce();
    expect(reconcileUsage).toHaveBeenCalledWith(expect.objectContaining({
      reason: "protocol-error",
      responseStatus: "failed",
    }));
    expect(reconcileUsage.mock.calls[0][0]).not.toHaveProperty("usage");
    expect(events.slice(-3)).toEqual(["clear-queue", "clear-config", "dispose"]);
  });

  it("reconciles the pre-reserved envelope when pricing/session preparation fails", async () => {
    const events: string[] = [];
    const session = new FakeHostedSession(events);
    const dependencies = fakeDependencies(session, events);
    dependencies.buildModel = () => {
      events.push("build-model-failed");
      throw new Error("no complete catalogue price");
    };
    const reconcileUsage = vi.fn();

    await expect(runHostedOpenRouterFusion(
      request(fusion(), reconcileUsage),
      dependencies,
    )).rejects.toThrow("no complete catalogue price");

    expect(reconcileUsage).toHaveBeenCalledOnce();
    expect(reconcileUsage).toHaveBeenCalledWith(expect.objectContaining({
      reason: "protocol-error",
      responseStatus: "failed",
      progress: expect.objectContaining({ started: false }),
    }));
    expect(events).toEqual(["build-model-failed"]);
  });

  it("reconciles observed spend on provider failure and always clears the session", async () => {
    const events: string[] = [];
    const session = new FakeHostedSession(events);
    session.promptError = new Error("provider unavailable");
    const reconcileUsage = vi.fn();

    await expect(runHostedOpenRouterFusion(
      request(fusion(), reconcileUsage),
      fakeDependencies(session, events),
    )).rejects.toMatchObject({ code: "HOSTED_FUSION_PROVIDER_FAILED" });

    expect(reconcileUsage).toHaveBeenCalledOnce();
    expect(reconcileUsage).toHaveBeenCalledWith(expect.objectContaining({
      reason: "protocol-error",
      responseStatus: "failed",
      usage: expect.objectContaining({ cost: 0.42 }),
    }));
    expect(events.slice(-3)).toEqual(["clear-queue", "clear-config", "dispose"]);
  });

  it("propagates caller cancellation, aborts the session, and reconciles once", async () => {
    const events: string[] = [];
    const session = new FakeHostedSession(events);
    let rejectPrompt: ((error: Error) => void) | undefined;
    session.promptImplementation = () => new Promise<void>((_resolve, reject) => {
      rejectPrompt = reject;
    });
    session.abort = async () => {
      events.push("abort");
      session.isIdle = true;
      rejectPrompt?.(new Error("aborted"));
    };
    const controller = new AbortController();
    const reconcileUsage = vi.fn();

    const running = runHostedOpenRouterFusion(
      request(fusion(), reconcileUsage, controller.signal),
      fakeDependencies(session, events),
    );
    await vi.waitFor(() => expect(events).toContain("prompt"));
    controller.abort(new Error("user cancelled"));

    await expect(running).rejects.toMatchObject({ code: "HOSTED_FUSION_ABORTED" });
    expect(reconcileUsage).toHaveBeenCalledOnce();
    expect(reconcileUsage).toHaveBeenCalledWith(expect.objectContaining({
      reason: "caller-aborted",
      responseStatus: "interrupted",
    }));
    expect(events).toContain("abort");
    expect(events.indexOf("abort")).toBeLessThan(events.indexOf("clear-config"));
    expect(events.indexOf("clear-config")).toBeLessThan(events.indexOf("dispose"));
  });

  it("waits for provider quiescence before reconciling an abort and rejects a late result", async () => {
    const events: string[] = [];
    const session = new FakeHostedSession(events);
    let resolvePrompt: (() => void) | undefined;
    let resolveAbort: (() => void) | undefined;
    session.promptImplementation = () => new Promise<void>((resolve) => {
      resolvePrompt = resolve;
    });
    session.abort = async () => {
      events.push("abort-started");
      await new Promise<void>((resolve) => {
        resolveAbort = resolve;
      });
      session.isIdle = true;
      events.push("abort-finished");
    };
    const controller = new AbortController();
    const reconcileUsage = vi.fn(async () => {
      events.push("reconcile");
    });

    const running = runHostedOpenRouterFusion(
      request(fusion(), reconcileUsage, controller.signal),
      fakeDependencies(session, events),
    );
    const outcome = running.then(
      (result) => ({ status: "fulfilled" as const, result }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await vi.waitFor(() => expect(events).toContain("prompt"));
    controller.abort(new Error("user cancelled"));
    await vi.waitFor(() => expect(events).toContain("abort-started"));

    // A provider can finish its prompt after cancellation while its abort/close
    // acknowledgement is still outstanding. That late text is never success,
    // and its reservation remains owned until the session is quiescent.
    resolvePrompt?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reconcileUsage).not.toHaveBeenCalled();
    expect(events).not.toContain("clear-config");
    expect(events).not.toContain("dispose");

    resolveAbort?.();
    const settled = await outcome;
    expect(settled).toMatchObject({
      status: "rejected",
      error: { code: "HOSTED_FUSION_ABORTED" },
    });
    expect(reconcileUsage).toHaveBeenCalledOnce();
    expect(reconcileUsage).toHaveBeenCalledWith(expect.objectContaining({
      reason: "caller-aborted",
      responseStatus: "interrupted",
    }));
    expect(events.indexOf("abort-finished")).toBeLessThan(events.indexOf("dispose"));
    expect(events.indexOf("abort-finished")).toBeLessThan(events.indexOf("clear-config"));
    expect(events.indexOf("dispose")).toBeLessThan(events.indexOf("reconcile"));
  });

  it("full-charges and retains ownership when abort acknowledgement is rejected", async () => {
    const events: string[] = [];
    const session = new FakeHostedSession(events);
    let rejectPrompt: ((error: Error) => void) | undefined;
    let releaseRetry: (() => void) | undefined;
    let abortCalls = 0;
    session.promptImplementation = () => new Promise<void>((_resolve, reject) => {
      rejectPrompt = reject;
    });
    session.abort = async () => {
      abortCalls += 1;
      events.push(`abort-${abortCalls}`);
      if (abortCalls === 1) {
        rejectPrompt?.(new Error("provider prompt interrupted"));
        throw new Error("provider did not acknowledge abort");
      }
      await new Promise<void>((resolve) => {
        releaseRetry = resolve;
      });
      session.isIdle = true;
    };
    const controller = new AbortController();
    const reconcileUsage = vi.fn(async () => {
      events.push("reconcile");
    });
    const projectId = "hosted-fusion-rejected-ack";

    const running = runHostedOpenRouterFusion(
      request(fusion(), reconcileUsage, controller.signal, projectId),
      fakeDependencies(session, events),
    );
    await vi.waitFor(() => expect(events).toContain("prompt"));
    controller.abort(new Error("user cancelled"));

    await expect(running).rejects.toMatchObject({
      code: "HOSTED_FUSION_CANCELLATION_UNCONFIRMED",
    });
    expect(reconcileUsage).toHaveBeenCalledOnce();
    expect(reconcileUsage).toHaveBeenCalledWith(expect.objectContaining({
      reason: "protocol-error",
      responseStatus: "failed",
    }));
    expect(reconcileUsage.mock.calls[0][0]).not.toHaveProperty("usage");
    expect(hostedFusionQuarantineSnapshot(projectId)).toHaveLength(1);
    expect(events).not.toContain("clear-config");
    expect(events).not.toContain("dispose");

    releaseRetry?.();
    await vi.waitFor(() => expect(hostedFusionQuarantineSnapshot(projectId)).toEqual([]));
    expect(events).toContain("clear-config");
    expect(events).toContain("dispose");
  });

  it("settles a never-acknowledged cancellation within the bound and blocks admission until late quiescence", async () => {
    const events: string[] = [];
    const session = new FakeHostedSession(events);
    let rejectPrompt: ((error: Error) => void) | undefined;
    let releaseAbort: (() => void) | undefined;
    session.promptImplementation = () => new Promise<void>((_resolve, reject) => {
      rejectPrompt = reject;
    });
    session.abort = async () => {
      events.push("abort-pending");
      await new Promise<void>((resolve) => {
        releaseAbort = resolve;
      });
      session.isIdle = true;
      events.push("abort-acknowledged");
    };
    const controller = new AbortController();
    const reconcileUsage = vi.fn(async () => {
      events.push("reconcile-first");
    });
    const projectId = "hosted-fusion-pending-ack";
    const dependencies = {
      ...fakeDependencies(session, events),
      cancellationAckTimeoutMs: 10,
    };

    const running = runHostedOpenRouterFusion(
      request(fusion(), reconcileUsage, controller.signal, projectId),
      dependencies,
    );
    await vi.waitFor(() => expect(events).toContain("prompt"));
    controller.abort(new Error("user cancelled"));

    await expect(running).rejects.toMatchObject({
      code: "HOSTED_FUSION_CANCELLATION_UNCONFIRMED",
    });
    expect(reconcileUsage).toHaveBeenCalledOnce();
    expect(reconcileUsage.mock.calls[0][0]).not.toHaveProperty("usage");
    expect(hostedFusionQuarantineSnapshot(projectId)).toHaveLength(1);
    expect(events).not.toContain("clear-config");
    expect(events).not.toContain("dispose");
    let shutdownReleased = false;
    const gracefulShutdown = waitForHostedFusionQuarantines().then(() => {
      shutdownReleased = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shutdownReleased).toBe(false);

    const secondReconcile = vi.fn();
    const secondSession = new FakeHostedSession(events);
    const secondDependencies = fakeDependencies(secondSession, events);
    await expect(runHostedOpenRouterFusion(
      request(fusion(), secondReconcile, undefined, projectId),
      secondDependencies,
    )).rejects.toMatchObject({ code: "HOSTED_FUSION_SESSION_QUARANTINED" });
    expect(secondReconcile).toHaveBeenCalledOnce();
    expect(secondReconcile.mock.calls[0][0]).not.toHaveProperty("usage");
    expect(events.filter((event) => event === "create-session")).toHaveLength(1);

    rejectPrompt?.(new Error("provider prompt interrupted"));
    releaseAbort?.();
    await vi.waitFor(() => expect(hostedFusionQuarantineSnapshot(projectId)).toEqual([]));
    await gracefulShutdown;
    expect(shutdownReleased).toBe(true);
    expect(events.indexOf("abort-acknowledged")).toBeLessThan(events.indexOf("dispose"));
  });

  it("propagates the hosted deadline and settles the reservation as timed out", async () => {
    const events: string[] = [];
    const session = new FakeHostedSession(events);
    let rejectPrompt: ((error: Error) => void) | undefined;
    session.promptImplementation = () => new Promise<void>((_resolve, reject) => {
      rejectPrompt = reject;
    });
    session.abort = async () => {
      events.push("abort");
      session.isIdle = true;
      rejectPrompt?.(new Error("timed out"));
    };
    const reconcileUsage = vi.fn();
    const timedRequest = request(fusion(), reconcileUsage);
    timedRequest.timeoutMs = 10;

    await expect(runHostedOpenRouterFusion(
      timedRequest,
      fakeDependencies(session, events),
    )).rejects.toMatchObject({ code: "HOSTED_FUSION_TIMEOUT" });

    expect(reconcileUsage).toHaveBeenCalledOnce();
    expect(reconcileUsage).toHaveBeenCalledWith(expect.objectContaining({
      reason: "host-timeout",
      responseStatus: "timed_out",
    }));
    expect(events).toContain("abort");
    expect(events.indexOf("abort")).toBeLessThan(events.indexOf("clear-config"));
    expect(events.indexOf("clear-config")).toBeLessThan(events.indexOf("dispose"));
  });

  it("fails the node when exact-once budget reconciliation itself fails", async () => {
    const events: string[] = [];
    const session = new FakeHostedSession(events);
    const reconcileUsage = vi.fn(async () => {
      throw new Error("durable budget unavailable");
    });

    await expect(runHostedOpenRouterFusion(
      request(fusion(), reconcileUsage),
      fakeDependencies(session, events),
    )).rejects.toMatchObject({ code: "HOSTED_FUSION_RECONCILIATION_FAILED" });
    expect(reconcileUsage).toHaveBeenCalledOnce();
    expect(events.slice(-3)).toEqual(["clear-queue", "clear-config", "dispose"]);
  });

  it("still disposes the temporary session when clearing its Fusion config fails", async () => {
    const events: string[] = [];
    const session = new FakeHostedSession(events);
    const dependencies = fakeDependencies(session, events);
    dependencies.setConfig = (_projectId, _sessionId, config) => {
      events.push(config ? "set-config" : "clear-config");
      if (!config) throw new Error("config registry unavailable");
    };
    const reconcileUsage = vi.fn();

    await expect(runHostedOpenRouterFusion(
      request(fusion(), reconcileUsage),
      dependencies,
    )).rejects.toMatchObject({ code: "HOSTED_FUSION_CLEANUP_FAILED" });

    expect(reconcileUsage).toHaveBeenCalledOnce();
    expect(reconcileUsage).toHaveBeenCalledWith(expect.objectContaining({
      reason: "protocol-error",
      responseStatus: "failed",
    }));
    expect(reconcileUsage.mock.calls[0][0]).not.toHaveProperty("usage");
    expect(events.slice(-3)).toEqual(["clear-queue", "clear-config", "dispose"]);
  });
});
