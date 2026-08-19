/**
 * Both defects pinned here are transport-only. The in-process node executor
 * binds `nodeControl` onto the hosted-Fusion session and dispatches `harness`
 * through `dispatchWorkflowHarness`, but `server/src/index.ts` starts the
 * out-of-process workflow supervisor on every real server start and hands
 * `WorkflowSupervisorClient.nodeExecutorDependencies()` to the executor, which
 * overrides exactly those two seams. So every assertion below drives the real
 * supervisor client, the real wire codec and the real coordinator; the only
 * stand-ins are the OpenRouter round trip and the Pi session build, which need
 * a network and a model runtime respectively.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  DagFusionDelegationReceipt,
  DagFusionDelegationUsageSettlement,
  OwnedDelegationRequest,
} from "../pi-packages/dag-fusion-drive/index.ts";
import { resolvePaths, type ProjectPaths } from "../src/projects.ts";
import {
  applyS4ProviderRequestBindings,
  createS4HostedFusionSession,
  WorkflowHarnessDispatchError,
  type WorkflowHarness,
} from "../src/agent/workflow-delegation-session.ts";
import type { WorkflowHarnessAdapterSelection } from "../src/workflows/harness-registry.ts";
import {
  createKadyWorkflowNodeExecutor,
  type KadyWorkflowUsageAdmission,
  type S4NodeExecutionBindings,
} from "../src/workflows/kady-node-executor.ts";
import type {
  HostedOpenRouterFusionRequest,
  HostedOpenRouterFusionResult,
} from "../src/workflows/hosted-fusion.ts";
import type {
  ModelRequest,
  WorkflowGraphDocument,
  WorkflowNode,
} from "../src/workflows/schema.ts";
import {
  workflowModelCallSlotForNode,
  workflowModelCallSlotsForNode,
  type WorkflowModelCallSlot,
} from "../src/workflows/run-state.ts";
import type {
  WorkflowNodeExecutorContext,
} from "../src/workflows/runner.ts";
import { ensureWorkflowSupervisor } from "../src/workflows/supervisor/client.ts";
import {
  WorkflowSupervisorCoordinator,
  type WorkflowSupervisorCoordinatorDependencies,
} from "../src/workflows/supervisor/coordinator.ts";
import { WorkflowSupervisorJournal } from "../src/workflows/supervisor/journal.ts";
import {
  encodeWorkflowSupervisorResponseLine,
  parseWorkflowSupervisorRequestLine,
  type SerializedHostedOpenRouterFusionRequest,
  type WorkflowSupervisorRequest,
  type WorkflowSupervisorResponse,
} from "../src/workflows/supervisor/protocol.ts";
import { workflowBudgetReservationId } from "../src/workflows/budget.ts";
import {
  createSupervisedWorkflowBudgetDescriptor,
  type SupervisedWorkflowBudgetDescriptorV1,
} from "../src/workflows/supervised-budget.ts";
import {
  WORKFLOW_SUPERVISOR_RUNTIME_VERSION,
  workflowSupervisorRepositoryDigest,
  writeWorkflowSupervisorRuntimeState,
  type WorkflowSupervisorRuntimePaths,
  type WorkflowSupervisorRuntimeStateV1,
} from "../src/workflows/supervisor/runtime.ts";

const TOKEN = "a".repeat(64);
/**
 * A project of this suite's own: the supervised `getDelegationSession` seam
 * seeds the sandbox, and the shared `default` project is state other suites
 * assert freshness against.
 */
const PROJECT_ID = "s5-transport-probe";
const roots: string[] = [];
const servers: FakeSupervisor[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) await server.stop();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  fs.rmSync(resolvePaths(PROJECT_ID).root, { recursive: true, force: true });
});

function temporaryPaths(): WorkflowSupervisorRuntimePaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kady-s5-transport-"));
  roots.push(root);
  const stateDir = path.join(root, "state");
  return {
    stateDir,
    stateFile: path.join(stateDir, "supervisor.json"),
    launchLock: path.join(stateDir, "launch.lock"),
    socketPath: process.platform === "win32"
      ? `\\\\.\\pipe\\kady-s5-transport-${path.basename(root)}`
      : path.join(root, "supervisor.sock"),
    stdoutLog: path.join(stateDir, "supervisor.stdout.log"),
    stderrLog: path.join(stateDir, "supervisor.stderr.log"),
  };
}

function runtimeState(
  paths: WorkflowSupervisorRuntimePaths,
): WorkflowSupervisorRuntimeStateV1 {
  return {
    version: WORKFLOW_SUPERVISOR_RUNTIME_VERSION,
    protocolVersion: 1,
    repositoryDigest: workflowSupervisorRepositoryDigest(),
    pid: process.pid,
    token: TOKEN,
    socketPath: paths.socketPath,
    startedAt: Date.now(),
  };
}

type FakeHandler = (
  request: WorkflowSupervisorRequest,
) => WorkflowSupervisorResponse | Promise<WorkflowSupervisorResponse>;

/**
 * A supervisor socket that speaks the real protocol. Requests reach it as
 * `parseWorkflowSupervisorRequestLine` decodes them, so anything the client
 * drops or the frame validator rejects never arrives.
 */
class FakeSupervisor {
  private readonly server: net.Server;
  private readonly sockets = new Set<net.Socket>();
  private stopping: Promise<void> | undefined;

  private constructor(
    private readonly paths: WorkflowSupervisorRuntimePaths,
    handler: FakeHandler,
  ) {
    this.server = net.createServer((socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        let newline = buffer.indexOf(0x0a);
        while (newline >= 0) {
          const frame = buffer.subarray(0, newline + 1);
          buffer = buffer.subarray(newline + 1);
          const request = parseWorkflowSupervisorRequestLine(frame);
          void Promise.resolve(handler(request)).then((response) => {
            if (socket.destroyed) return;
            socket.write(encodeWorkflowSupervisorResponseLine(response));
          });
          newline = buffer.indexOf(0x0a);
        }
      });
    });
  }

  static async start(
    paths: WorkflowSupervisorRuntimePaths,
    handler: FakeHandler,
  ): Promise<FakeSupervisor> {
    const fake = new FakeSupervisor(paths, handler);
    await new Promise<void>((resolve, reject) => {
      fake.server.once("error", reject);
      fake.server.listen(paths.socketPath, () => {
        fake.server.off("error", reject);
        resolve();
      });
    });
    writeWorkflowSupervisorRuntimeState(runtimeState(paths), paths);
    servers.push(fake);
    return fake;
  }

  static ok(
    request: WorkflowSupervisorRequest,
  ): WorkflowSupervisorResponse | undefined {
    switch (request.op) {
      case "ping":
        return {
          version: 1,
          messageId: request.messageId,
          ok: true,
          op: "ping",
          result: { pid: process.pid, state: "ready", attachedEpoch: null },
        };
      case "attach":
        return {
          version: 1,
          messageId: request.messageId,
          ok: true,
          op: "attach",
          result: { attached: true, epoch: request.epoch },
        };
      case "shutdown":
        return {
          version: 1,
          messageId: request.messageId,
          ok: true,
          op: "shutdown",
          result: { accepted: true },
        };
      default:
        return undefined;
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      for (const socket of this.sockets) socket.destroy();
      if (this.server.listening) {
        await new Promise<void>((resolve) => this.server.close(() => resolve()));
      }
      fs.rmSync(this.paths.stateFile, { force: true });
      if (process.platform !== "win32") {
        fs.rmSync(this.paths.socketPath, { force: true });
      }
    })();
    return this.stopping;
  }
}

/**
 * `ensureWorkflowSupervisor` drains whatever runtime it inherits and then
 * spawns a fresh one, so the fake has to be started through the client's own
 * spawn seam rather than pre-registered.
 */
async function supervisedClient(
  paths: WorkflowSupervisorRuntimePaths,
  handler: FakeHandler,
) {
  return ensureWorkflowSupervisor({
    paths,
    dependencies: {
      randomEpoch: () => 7,
      spawnSupervisor: async (runtimePaths) => {
        const fake = await FakeSupervisor.start(runtimePaths, handler);
        return {
          pid: process.pid,
          token: TOKEN,
          terminate: () => fake.stop(),
        };
      },
    },
  });
}

function openRouterModelRequest(model: string): ModelRequest {
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

function modelReceipt(model: string) {
  return {
    request: openRouterModelRequest(model),
    resolved: {
      provider: "openrouter",
      model,
      auth: { kind: "api-key" as const },
      reasoning: "high" as const,
      runtime: "openrouter-fusion" as const,
    },
    fallbackUsed: false,
  };
}

/** The bindings `resolveS4NodeExecutionBindings` produces for a node that authored a non-default temperature. */
function nodeControlBindings(
  overrides: Partial<S4NodeExecutionBindings> = {},
): S4NodeExecutionBindings {
  return {
    version: 1,
    harness: "pi",
    providerRequest: { temperature: 0.2, top_p: 0.9, sampling: { seed: 7 } },
    databases: [],
    skills: { mode: "auto", configured: [], delegated: [] },
    subagents: { mode: "auto", permitted: false },
    autonomy: "strict",
    toolPolicy: { allowedTools: ["read", "grep", "find", "ls"] },
    billingMode: "inherit",
    ...overrides,
  };
}

function hostedIdentity() {
  return {
    requestId: "dagfusion_run-1_fusion-1",
    ownerRunId: "wrun_0123456789abcdef",
    nodeId: "fusion-1:fusion-hosted-compound",
  };
}

function hostedFusionRequest(): HostedOpenRouterFusionRequest {
  const analyst = openRouterModelRequest("anthropic/claude-sonnet-4.5");
  const critic = openRouterModelRequest("openai/gpt-5.4");
  const judge = openRouterModelRequest("google/gemini-3-pro");
  return {
    projectId: PROJECT_ID,
    paths: resolvePaths(PROJECT_ID),
    identity: hostedIdentity(),
    fusion: {
      mode: "openrouter-router",
      router: openRouterModelRequest("openrouter/fusion"),
      members: [
        { id: "analyst", role: "Analyst", model: analyst },
        { id: "critic", role: "Critic", model: critic },
      ],
      judge,
    },
    resolved: {
      members: [
        { memberId: "analyst", role: "Analyst", receipt: modelReceipt("anthropic/claude-sonnet-4.5") },
        { memberId: "critic", role: "Critic", receipt: modelReceipt("openai/gpt-5.4") },
      ],
      judgeDeliberation: modelReceipt("google/gemini-3-pro"),
      judgeFinal: modelReceipt("google/gemini-3-pro"),
    },
    task: "Fuse the independent analyses.",
    maxTokens: 10_000,
    maxCostUsd: 12,
    timeoutMs: 120_000,
    signal: new AbortController().signal,
    reconcileUsage: () => undefined,
  } as unknown as HostedOpenRouterFusionRequest;
}

function hostedBudget(): SupervisedWorkflowBudgetDescriptorV1 {
  return createSupervisedWorkflowBudgetDescriptor({
    reservationId: workflowBudgetReservationId(
      PROJECT_ID,
      hostedIdentity().ownerRunId,
      "fusion-1",
      1,
      "fusion-hosted-compound",
    ),
    runId: hostedIdentity().ownerRunId,
    executionId: "fusion-1",
    attempt: 1,
    slotId: "fusion-hosted-compound",
    provider: "openrouter",
    authKind: "api-key",
  });
}

function hostedUsage() {
  return {
    input: 100,
    output: 40,
    cacheRead: 10,
    cacheWrite: 0,
    cost: 0.25,
    turns: 2,
    toolCalls: 0,
    durationMs: 1_200,
  };
}

/**
 * A real coordinator with only two stand-ins: the OpenRouter call itself, and
 * the hosted session factory (which would otherwise build a live Pi session).
 * `boundProviderRequests` records exactly what the supervisor bound onto the
 * session it created for this attempt.
 */
function hostedCoordinator(journalDirectory: string) {
  const boundProviderRequests: Array<
    Parameters<typeof createS4HostedFusionSession>[1]
  > = [];
  const journal = new WorkflowSupervisorJournal({
    stateDirectory: journalDirectory,
    now: () => 1_000,
  });
  const dependencies: Partial<WorkflowSupervisorCoordinatorDependencies> = {
    pathsForProject: resolvePaths,
    getDelegationSession: async () => {
      throw new Error("hosted Fusion must not request a delegation session");
    },
    disposeDelegationSession: async () => undefined,
    delegationSessionSnapshot: async () => undefined,
    disposeAllDelegationSessions: async () => undefined,
    hostedFusionSessionFactory: (async (_input, providerRequest) => {
      boundProviderRequests.push(providerRequest);
      return {} as never;
    }) as typeof createS4HostedFusionSession,
    runHostedFusion: async (request, dependencyOverrides) => {
      // The Fusion router session is what carries the S4 provider bindings, so
      // building it is part of the path under test even though the OpenRouter
      // exchange itself is not.
      await dependencyOverrides?.createSession?.({
        projectId: request.projectId,
        paths: request.paths,
        fusionConfig: {} as never,
        model: {} as Model<Api>,
      } as never);
      await request.reconcileUsage({
        identity: request.identity,
        reason: "terminal-response",
        responseStatus: "completed",
        usage: hostedUsage(),
        progress: {
          started: true,
          model: "openrouter/openrouter/fusion",
          tokens: 140,
          toolCalls: 0,
          durationMs: 1_200,
        },
      });
      return {
        text: "Fused.",
        textTruncated: false,
        usage: hostedUsage(),
      } satisfies HostedOpenRouterFusionResult;
    },
    hostedQuarantines: () => [],
    waitHostedQuarantines: async () => undefined,
    assertNoHostedQuarantine: () => undefined,
    settleBudget: async () => undefined,
    budgetReservation: (projectId, reservationId) => ({
      id: reservationId,
      projectId,
      runId: hostedIdentity().ownerRunId,
      status: "active" as const,
      expiresAt: 60_000,
      maxCostUsd: 12,
      maxTokens: 10_000,
      modelCallCount: 4,
    }),
    reloadCredentials: async () => undefined,
    now: () => 1_000,
  };
  return {
    boundProviderRequests,
    coordinator: new WorkflowSupervisorCoordinator({ journal, dependencies }),
  };
}

describe("supervised hosted Fusion node control", () => {
  it("carries a non-default temperature to the provider request the supervisor builds", async () => {
    const paths = temporaryPaths();
    const journalDirectory = path.join(paths.stateDir, "journal");
    const { coordinator, boundProviderRequests } = hostedCoordinator(journalDirectory);
    const wireRequests: WorkflowSupervisorRequest[] = [];

    const client = await supervisedClient(paths, async (request) => {
      wireRequests.push(structuredClone(request));
      if (request.op === "attach") await coordinator.attach(request.epoch);
      const generic = FakeSupervisor.ok(request);
      if (generic) return generic;
      if (request.op !== "hosted-fusion") {
        throw new Error(`unexpected supervised op ${request.op}`);
      }
      return {
        version: 1,
        messageId: request.messageId,
        ok: true,
        op: "hosted-fusion",
        result: await coordinator.hostedFusion({
          epoch: request.epoch,
          messageId: request.messageId,
          projectId: request.projectId,
          request: request.request,
          budget: request.budget,
        }),
      };
    });
    const nodeControl = nodeControlBindings();
    const settlements: DagFusionDelegationUsageSettlement[] = [];
    const result = await client.nodeExecutorDependencies().runHostedFusion(
      {
        ...hostedFusionRequest(),
        reconcileUsage: (observed) => {
          settlements.push(observed);
        },
      },
      { supervisedBudget: hostedBudget(), nodeControl },
    );
    await client.close();

    expect(result.text).toBe("Fused.");
    expect(settlements).toHaveLength(1);

    // 1. the bindings survived the wire exactly.
    const hostedFrame = wireRequests.find((entry) => entry.op === "hosted-fusion");
    expect(hostedFrame).toBeDefined();
    expect(
      (hostedFrame as { request: SerializedHostedOpenRouterFusionRequest }).request.nodeControl,
    ).toEqual(nodeControl);

    // 2. the supervisor bound them onto the session it created for the attempt.
    expect(boundProviderRequests).toEqual([nodeControl.providerRequest]);

    // 3. and that binding is what the router payload ends up carrying.
    expect(
      applyS4ProviderRequestBindings(
        { model: "openrouter/fusion", messages: [], temperature: 1, top_p: 1 },
        boundProviderRequests[0],
      ),
    ).toMatchObject({ temperature: 0.2, top_p: 0.9, seed: 7 });
  });

  it("fails a supervised hosted Fusion attempt closed when no node control crosses", async () => {
    const paths = temporaryPaths();
    const seen: string[] = [];
    const client = await supervisedClient(paths, (request) => {
      seen.push(request.op);
      const generic = FakeSupervisor.ok(request);
      if (generic) return generic;
      throw new Error(`unexpected supervised op ${request.op}`);
    });

    await expect(
      client.nodeExecutorDependencies().runHostedFusion(
        hostedFusionRequest(),
        { supervisedBudget: hostedBudget() },
      ),
    ).rejects.toThrow("no trusted S4 provider-request controls");
    await client.close();

    // The refusal happens before any provider work is requested at all.
    expect(seen).not.toContain("hosted-fusion");
  });

  it("refuses a hosted Fusion coordinator call whose bindings never arrived", async () => {
    const paths = temporaryPaths();
    const { coordinator } = hostedCoordinator(path.join(paths.stateDir, "journal"));
    await coordinator.attach(7);
    const { paths: _paths, signal: _signal, reconcileUsage: _reconcile, ...serialized } =
      hostedFusionRequest();

    await expect(coordinator.hostedFusion({
      epoch: 7,
      messageId: "msg-hosted-no-node-control",
      projectId: PROJECT_ID,
      request: serialized as unknown as SerializedHostedOpenRouterFusionRequest,
      budget: hostedBudget(),
    })).rejects.toThrow("no trusted S4 provider-request controls");
  });
});

function exactModel(provider = "ollama", model = "qwen3:32b"): ModelRequest {
  return {
    requested: {
      source: "fixed",
      provider,
      model,
      auth: { kind: "local" },
      reasoning: "high",
    },
    resolution: { mode: "exact" },
  };
}

interface HarnessGraphOptions {
  /** Omitted so `defaultHarness` inheritance can be exercised on its own. */
  harness?: WorkflowHarness;
  defaultHarness?: WorkflowHarness;
  /**
   * The provider the node's slots resolve to. `modelReference` turns it into
   * `` `${provider}/${id}` `` on the delegation request, which is exactly what
   * the relay has to decide whether `claude --model` can run.
   */
  modelProvider?: string;
  modelId?: string;
}

function harnessGraph(options: HarnessGraphOptions): WorkflowGraphDocument {
  const node: WorkflowNode = {
    id: "step",
    name: "Step",
    kind: "agent",
    terminal: true,
    workspace: { isolation: "read-only", writePaths: [] },
    prompt: "Answer from the supplied evidence only.",
    ...(options.harness ? { settings: { harness: options.harness } } : {}),
  } as WorkflowNode;
  return {
    ...(options.defaultHarness
      ? { settings: { defaultHarness: options.defaultHarness } }
      : {}),
    schemaVersion: "1.0",
    id: "harness-dispatch-graph",
    name: "Harness dispatch graph",
    entryNodeId: node.id,
    defaultModel: exactModel(options.modelProvider, options.modelId),
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
  };
}

function harnessContext(document: WorkflowGraphDocument): WorkflowNodeExecutorContext {
  const node = document.nodes[0];
  const expected = workflowModelCallSlotsForNode(document, node);
  const declared = new Map<string, WorkflowModelCallSlot>(
    expected.map((slot) => [slot.id, structuredClone(slot)]),
  );
  return {
    projectId: PROJECT_ID,
    runId: "wrun_0123456789abcdef",
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
    executionId: "dagx_harness-dispatch",
    branchId: "main",
    resumed: false,
    inbound: [],
    expectedModelCallSlots: expected,
    declareModelCallSlot(slotId) {
      const slot = workflowModelCallSlotForNode(document, node, slotId);
      if (!slot) throw new Error(`bad dynamic slot ${slotId}`);
      declared.set(slot.id, structuredClone(slot));
      return slot;
    },
    recordModelResolution() {},
    recordCompactionCheck() {},
    recordDeliberationStaffingReceipt() {},
    signal: new AbortController().signal,
  } as unknown as WorkflowNodeExecutorContext;
}

/**
 * The resolved model, parameterised by provider so a relayed node can be driven
 * with the *production* shape of `request.model` — `modelReference` emits
 * `` `${provider}/${id}` `` (`agent/models.ts:387-391`), which is why round 1's
 * hand-written `claude-opus-5` fixture could not catch the relay handing a
 * provider-qualified slug to `claude --model`.
 */
function localResolution(
  request: ModelRequest,
  provider = "ollama",
  id = "qwen3:32b",
) {
  return {
    model: {
      provider,
      id,
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    } as Model<Api>,
    receipt: {
      request: structuredClone(request),
      resolved: {
        provider,
        model: id,
        auth: { kind: "local" as const },
        reasoning: "high" as const,
        runtime: "local" as const,
      },
      fallbackUsed: false,
    },
  };
}

function delegationReceipt(request: OwnedDelegationRequest): DagFusionDelegationReceipt {
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
    requested: { agent: request.agent, model: request.model, thinking: request.thinking },
    resolved: {
      agent: request.agent,
      model: request.model,
      thinking: request.thinking,
      launchContractDigest: "launch-contract",
    },
    response: {
      requestId: request.requestId,
      ownerRunId: request.ownerRunId,
      nodeId: request.nodeId,
      status: "completed",
      agent: request.agent,
      model: request.model,
      thinking: request.thinking,
      launchContractDigest: "launch-contract",
      runId: `pirun-${request.requestId}`,
      result: {
        kind: "structured",
        value: {
          answer: "Supported by the supplied evidence.",
          evidence: ["evidence:supported"],
          uncertainties: [],
        },
      },
      usage,
    },
    usage: { ...usage, totalTokens: 15 },
    progress: {
      started: true,
      model: request.model,
      tokens: 15,
      toolCalls: 0,
      durationMs: 5,
    },
  } as unknown as DagFusionDelegationReceipt;
}

/** Executor wired to the production supervised transport for its two overridden seams. */
async function supervisedExecutorRun(options: HarnessGraphOptions) {
  const paths = temporaryPaths();
  const seen: string[] = [];
  const client = await supervisedClient(paths, (request) => {
    seen.push(request.op);
    const generic = FakeSupervisor.ok(request);
    if (generic) return generic;
    if (request.op !== "delegate") {
      throw new Error(`unexpected supervised op ${request.op}`);
    }
    return {
      version: 1,
      messageId: request.messageId,
      ok: true,
      op: "delegate",
      result: {
        receipt: delegationReceipt(request.request),
        settlement: {
          identity: {
            requestId: request.request.requestId,
            ownerRunId: request.request.ownerRunId,
            nodeId: request.request.nodeId,
          },
          reason: "terminal-response",
          responseStatus: "completed",
          usage: hostedUsage(),
          progress: {
            started: true,
            model: request.request.model,
            tokens: 150,
            toolCalls: 0,
            durationMs: 5,
          },
        },
      },
    } as unknown as WorkflowSupervisorResponse;
  });
  const document = harnessGraph(options);
  const admissions: KadyWorkflowUsageAdmission[] = [];
  // Capture what the *production* seam returned, so the assertion is on which
  // adapter the registry selected — not on the absence of an exception.
  const productionDependencies = client.nodeExecutorDependencies();
  const selections: Array<WorkflowHarnessAdapterSelection | undefined> = [];
  const piSessionFactoryCalls: string[] = [];
  const executor = createKadyWorkflowNodeExecutor({
    reserveUsage: (admission) => {
      admissions.push(admission);
      return {
        descriptor: createSupervisedWorkflowBudgetDescriptor({
          reservationId: workflowBudgetReservationId(
            admission.projectId,
            admission.runId,
            admission.executionId,
            admission.attempt,
            admission.slotId,
          ),
          runId: admission.runId,
          executionId: admission.executionId,
          attempt: admission.attempt,
          slotId: admission.slotId,
          provider: "ollama",
          authKind: "local",
        }),
        reconcile: () => undefined,
      };
    },
    dependencies: {
      ...productionDependencies,
      getDelegationSession: async (projectId, paths, harness) => {
        piSessionFactoryCalls.push(harness);
        const session = await productionDependencies.getDelegationSession(
          projectId,
          paths,
          harness,
        );
        selections.push(session.harnessSelection);
        return session;
      },
      pathsForProject: (projectId: string): ProjectPaths => resolvePaths(projectId),
      loadManifest: () => ({
        projectId: PROJECT_ID,
        workflowId: document.id,
        workflowRevision: 1,
      }),
      resolveModel: async (request: ModelRequest) =>
        localResolution(request, options.modelProvider, options.modelId),
      assertChildRuntimeReady: () => undefined,
      readCompactionAudit: () => ({ occurred: false, checks: [] }),
    },
  });
  const outcome = await executor(harnessContext(document)).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await client.close();
  return { admissions, outcome, seen, selections, piSessionFactoryCalls };
}

describe("supervised harness dispatch", () => {
  it("refuses an unbound harness before the node reserves budget", async () => {
    const { admissions, outcome, seen } = await supervisedExecutorRun({ harness: "codex" });

    // The whole point: no reservation, and no delegation ever left the backend.
    expect(admissions).toEqual([]);
    expect(seen).not.toContain("delegate");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBeInstanceOf(WorkflowHarnessDispatchError);
    expect((outcome.error as WorkflowHarnessDispatchError).code).toMatch(
      /^WORKFLOW_HARNESS_NOT_(INSTALLED|BOUND)$/,
    );
    expect((outcome.error as WorkflowHarnessDispatchError).harness).toBe("codex");
  });

  it("still dispatches a pi harness to the supervised session", async () => {
    const { admissions, outcome, seen, selections } = await supervisedExecutorRun({
      harness: "pi",
    });

    if (!outcome.ok) throw outcome.error;
    expect(admissions).toHaveLength(1);
    expect(admissions[0]?.nodeControl.harness).toBe("pi");
    expect(seen).toContain("delegate");
    expect(selections[0]).toEqual({
      harness: "pi",
      label: "Pi (built in)",
      adapter: "pi-delegation",
      executable: undefined,
    });
  });

  // Lane F2 / NodeSpec v1 "What BOUND will mean", condition 2. The bar is not
  // "validation accepts the literal" — it is that the production seam reaches a
  // registry row for a harness that did not exist before this lane, refuses it
  // before any budget is reserved, and never buys a Pi child instead.
  it("reaches the grok-cli row on the production seam and refuses it before budget", async () => {
    const { admissions, outcome, seen } = await supervisedExecutorRun({
      harness: "grok-cli",
    });

    expect(admissions).toEqual([]);
    expect(seen).not.toContain("delegate");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBeInstanceOf(WorkflowHarnessDispatchError);
    const dispatchError = outcome.error as WorkflowHarnessDispatchError;
    expect(dispatchError.harness).toBe("grok-cli");
    expect(dispatchError.code).toMatch(/^WORKFLOW_HARNESS_NOT_(INSTALLED|BOUND)$/);
    // #71: the diagnostic names the next action and no absolute path.
    expect(dispatchError.message).not.toMatch(/(^|\s)\//);
    expect(dispatchError.message).toContain("grok");
  });

  it("refuses deepseek and oh-my-pi on the same seam", async () => {
    for (const harness of ["deepseek", "oh-my-pi"] as const) {
      const { admissions, outcome } = await supervisedExecutorRun({ harness });
      expect(admissions).toEqual([]);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) continue;
      expect((outcome.error as WorkflowHarnessDispatchError).harness).toBe(harness);
    }
  });

  it("inherits workflow defaultHarness into the same decision", async () => {
    const { admissions, outcome, seen } = await supervisedExecutorRun({
      defaultHarness: "grok-cli",
    });

    expect(admissions).toEqual([]);
    expect(seen).not.toContain("delegate");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect((outcome.error as WorkflowHarnessDispatchError).harness).toBe("grok-cli");
  });

  it("lets a node harness win over the workflow defaultHarness", async () => {
    const { admissions, outcome, selections } = await supervisedExecutorRun({
      harness: "pi",
      defaultHarness: "grok-cli",
    });

    if (!outcome.ok) throw outcome.error;
    expect(admissions).toHaveLength(1);
    expect(admissions[0]?.nodeControl.harness).toBe("pi");
    expect(selections[0]?.adapter).toBe("pi-delegation");
  });

  // Row 16. The second adapter, end to end on the production seam: the registry
  // selects `claude-code-relay`, the relay resolves the *overridden* binary, and
  // that binary is invoked in print mode with the system-prompt override — while
  // the supervised Pi delegate path is never taken.
  it.skipIf(process.platform === "win32")(
    "selects the claude-code relay and invokes the resolved binary with -p",
    async () => {
      const relayDir = fs.mkdtempSync(path.join(os.tmpdir(), "f2-relay-"));
      const fakeBinary = path.join(relayDir, "fake-claude");
      const argvFile = path.join(relayDir, "argv.json");
      const stdinFile = path.join(relayDir, "stdin");
      const schemaFile = path.join(relayDir, "schema.json");
      // Round 1's fake binary `cat`ed a canned fixture, so a relay that never
      // sent the node's structured-output schema was invisible here. This one
      // answers *from the schema it was given*: with no schema it says so, the
      // node's `parse` rejects that, and the whole item goes red.
      fs.writeFileSync(
        fakeBinary,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          "const stdin = fs.readFileSync(0, 'utf8');",
          `fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));`,
          `fs.writeFileSync(${JSON.stringify(stdinFile)}, stdin);`,
          "const marker = 'It must validate against this JSON Schema:';",
          "const at = stdin.indexOf(marker);",
          "if (at === -1) {",
          "  process.stdout.write(JSON.stringify({ result: 'NO_SCHEMA_WAS_SENT', num_turns: 1 }));",
          "  process.exit(0);",
          "}",
          "const schema = JSON.parse(stdin.slice(at + marker.length).trim());",
          `fs.writeFileSync(${JSON.stringify(schemaFile)}, JSON.stringify(schema));`,
          "const canned = {",
          "  answer: 'Relayed through the Claude Code CLI.',",
          "  evidence: ['evidence:supported'],",
          "  uncertainties: [],",
          "};",
          "const value = {};",
          "for (const key of Object.keys(schema.properties ?? {})) {",
          "  if (canned[key] !== undefined) value[key] = canned[key];",
          "}",
          "process.stdout.write(JSON.stringify({",
          "  result: JSON.stringify(value),",
          "  total_cost_usd: 0,",
          "  num_turns: 1,",
          "  usage: { input_tokens: 11, output_tokens: 7 },",
          "}));",
          "",
        ].join("\n"),
      );
      fs.chmodSync(fakeBinary, 0o755);

      const settingsFile = path.join(relayDir, "harness-settings.json");
      fs.writeFileSync(
        settingsFile,
        JSON.stringify({
          version: 1,
          claudeCode: {
            binaryPath: fakeBinary,
            systemPrompt: "You are Kady's relayed reviewer.",
          },
        }),
      );
      const previousSettingsPath = process.env.KADY_HARNESS_SETTINGS_PATH;
      process.env.KADY_HARNESS_SETTINGS_PATH = settingsFile;
      try {
        const { admissions, outcome, seen, selections } = await supervisedExecutorRun({
          harness: "claude-code",
          // The production shape: `modelReference` emits `provider/id`.
          modelProvider: "anthropic",
          modelId: "claude-sonnet-4-5",
        });

        if (!outcome.ok) throw outcome.error;
        expect(selections[0]?.adapter).toBe("claude-code-relay");
        expect(selections[0]?.harness).toBe("claude-code");
        // The Pi delegate never left the backend for this node.
        expect(seen).not.toContain("delegate");
        // The decision preceded the reservation, and the reservation still ran.
        expect(admissions).toHaveLength(1);
        expect(admissions[0]?.nodeControl.harness).toBe("claude-code");

        const argv = JSON.parse(fs.readFileSync(argvFile, "utf-8")) as string[];
        expect(argv).toContain("-p");
        expect(argv).toContain("--output-format");
        expect(argv[argv.indexOf("--system-prompt") + 1]).toBe(
          "You are Kady's relayed reviewer.",
        );
        // The provider prefix is stripped, not relayed: `claude --model` takes
        // an Anthropic id, and `anthropic/claude-sonnet-4-5` is not one.
        expect(argv[argv.indexOf("--model") + 1]).toBe("claude-sonnet-4-5");
        // The node's tool policy (`resolveS4NodeExecutionBindings`,
        // `kady-node-executor.ts:337-340`) reached the operating system as real
        // flags — this is `autonomy` being BOUND on this harness.
        expect(argv[argv.indexOf("--allowedTools") + 1]).toBe("Read,Grep,Glob");
        expect(argv[argv.indexOf("--disallowedTools") + 1]?.split(","))
          .toContain("Bash");
        expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("default");
        expect(argv).toContain("--max-turns");

        const stdin = fs.readFileSync(stdinFile, "utf-8");
        // The Pi-only node-control envelope never reaches a Claude prompt.
        expect(stdin).not.toContain("KADY_NODE_CONTROL_V1:");
        expect(stdin).toContain("Answer from the supplied evidence only.");
        // The structured-output schema the executor demands reached the child;
        // its answer above could not have been assembled without it.
        const schema = JSON.parse(fs.readFileSync(schemaFile, "utf-8")) as {
          properties?: Record<string, unknown>;
        };
        expect(Object.keys(schema.properties ?? {})).toContain("answer");
        expect(stdin).toContain("It must validate against this JSON Schema:");
      } finally {
        if (previousSettingsPath === undefined) {
          delete process.env.KADY_HARNESS_SETTINGS_PATH;
        } else {
          process.env.KADY_HARNESS_SETTINGS_PATH = previousSettingsPath;
        }
        fs.rmSync(relayDir, { recursive: true, force: true });
      }
    },
  );

  // The model medium. `request.model` is `modelReference(resolution.model)` —
  // `provider/id` — and `claude --model` takes an Anthropic id. A node that
  // resolved anything else is refused rather than run somewhere other than the
  // run receipt says, and nothing is spawned.
  it.skipIf(process.platform === "win32")(
    "refuses a relayed node whose resolved model the CLI cannot run",
    async () => {
      const relayDir = fs.mkdtempSync(path.join(os.tmpdir(), "f2-relay-model-"));
      const fakeBinary = path.join(relayDir, "fake-claude");
      const spawnMarker = path.join(relayDir, "spawned");
      fs.writeFileSync(
        fakeBinary,
        [
          "#!/bin/sh",
          `touch ${JSON.stringify(spawnMarker)}`,
          `printf '%s' '{"result":"{}"}'`,
          "",
        ].join("\n"),
      );
      fs.chmodSync(fakeBinary, 0o755);
      const settingsFile = path.join(relayDir, "harness-settings.json");
      fs.writeFileSync(
        settingsFile,
        JSON.stringify({ version: 1, claudeCode: { binaryPath: fakeBinary } }),
      );
      const previousSettingsPath = process.env.KADY_HARNESS_SETTINGS_PATH;
      process.env.KADY_HARNESS_SETTINGS_PATH = settingsFile;
      try {
        // Default resolution is `ollama/qwen3:32b`, the shape a local-runtime
        // node really produces.
        const { outcome, selections, seen } = await supervisedExecutorRun({
          harness: "claude-code",
        });
        expect(selections[0]?.adapter).toBe("claude-code-relay");
        expect(seen).not.toContain("delegate");
        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.error).toBeInstanceOf(WorkflowHarnessDispatchError);
        const dispatchError = outcome.error as WorkflowHarnessDispatchError;
        expect(dispatchError.code).toBe("WORKFLOW_HARNESS_NOT_BOUND");
        expect(dispatchError.message).toContain("ollama/qwen3:32b");
        expect(dispatchError.message).toContain("run it on the pi harness");
        // Refused before the process, not after it.
        expect(fs.existsSync(spawnMarker)).toBe(false);
      } finally {
        if (previousSettingsPath === undefined) {
          delete process.env.KADY_HARNESS_SETTINGS_PATH;
        } else {
          process.env.KADY_HARNESS_SETTINGS_PATH = previousSettingsPath;
        }
        fs.rmSync(relayDir, { recursive: true, force: true });
      }
    },
  );
});
