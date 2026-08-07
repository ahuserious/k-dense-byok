import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DagFusionDelegationIdentity,
  DagFusionDelegationReceipt,
  DagFusionDelegationUsageSettlement,
  OwnedDelegationV2Request,
} from "../pi-packages/dag-fusion-drive/index.ts";
import { resolvePaths } from "../src/projects.ts";
import type { HostedOpenRouterFusionRequest } from "../src/workflows/hosted-fusion.ts";
import type { SupervisedWorkflowBudgetDescriptorV1 } from "../src/workflows/supervised-budget.ts";
import {
  WorkflowSupervisorClientError,
  WorkflowSupervisorRemoteError,
  ensureWorkflowSupervisor,
} from "../src/workflows/supervisor/client.ts";
import {
  encodeWorkflowSupervisorResponseLine,
  parseWorkflowSupervisorRequestLine,
  workflowSupervisorErrorResponse,
  type SerializedHostedOpenRouterFusionRequest,
  type WorkflowSupervisorRequest,
  type WorkflowSupervisorResponse,
} from "../src/workflows/supervisor/protocol.ts";
import {
  WORKFLOW_SUPERVISOR_RUNTIME_VERSION,
  readWorkflowSupervisorRuntimeState,
  workflowSupervisorProcessMayBeAlive,
  workflowSupervisorRepositoryDigest,
  writeWorkflowSupervisorRuntimeState,
  type WorkflowSupervisorRuntimePaths,
  type WorkflowSupervisorRuntimeStateV1,
} from "../src/workflows/supervisor/runtime.ts";

const TOKEN = "a".repeat(64);
const roots: string[] = [];
const fakeServers: FakeSupervisor[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const server of fakeServers.splice(0)) await server.stop();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function temporaryPaths(): WorkflowSupervisorRuntimePaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kady-supervisor-client-"));
  roots.push(root);
  const stateDir = path.join(root, "state");
  return {
    stateDir,
    stateFile: path.join(stateDir, "supervisor.json"),
    launchLock: path.join(stateDir, "launch.lock"),
    socketPath: process.platform === "win32"
      ? `\\\\.\\pipe\\kady-supervisor-client-${path.basename(root)}`
      : path.join(root, "supervisor.sock"),
    stdoutLog: path.join(stateDir, "supervisor.stdout.log"),
    stderrLog: path.join(stateDir, "supervisor.stderr.log"),
  };
}

function runtimeState(
  paths: WorkflowSupervisorRuntimePaths,
  pid = process.pid,
): WorkflowSupervisorRuntimeStateV1 {
  return {
    version: WORKFLOW_SUPERVISOR_RUNTIME_VERSION,
    protocolVersion: 1,
    repositoryDigest: workflowSupervisorRepositoryDigest(),
    pid,
    token: TOKEN,
    socketPath: paths.socketPath,
    startedAt: Date.now(),
  };
}

type FakeHandler = (
  request: WorkflowSupervisorRequest,
  socket: net.Socket,
) => WorkflowSupervisorResponse | undefined | Promise<WorkflowSupervisorResponse | undefined>;

class FakeSupervisor {
  private readonly server: net.Server;
  private readonly sockets = new Set<net.Socket>();
  private stopping: Promise<void> | undefined;

  private constructor(
    private readonly paths: WorkflowSupervisorRuntimePaths,
    handler: FakeHandler,
    private readonly shutdownOnRequest: boolean,
  ) {
    this.server = net.createServer((socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) return;
        socket.removeAllListeners("data");
        const request = parseWorkflowSupervisorRequestLine(
          buffer.subarray(0, newline + 1),
        );
        void Promise.resolve(handler(request, socket)).then((response) => {
          if (!response || socket.destroyed) return;
          const encoded = encodeWorkflowSupervisorResponseLine(response);
          if (request.op === "attach") socket.write(encoded);
          else {
            socket.end(encoded, () => {
              if (request.op === "shutdown" && this.shutdownOnRequest) {
                void this.stop();
              }
            });
          }
        });
      });
    });
  }

  static async start(
    paths: WorkflowSupervisorRuntimePaths,
    handler: FakeHandler,
    pid = process.pid,
    options: { shutdownOnRequest?: boolean } = {},
  ): Promise<FakeSupervisor> {
    const fake = new FakeSupervisor(
      paths,
      handler,
      options.shutdownOnRequest ?? false,
    );
    await new Promise<void>((resolve, reject) => {
      fake.server.once("error", reject);
      fake.server.listen(paths.socketPath, () => {
        fake.server.off("error", reject);
        resolve();
      });
    });
    writeWorkflowSupervisorRuntimeState(runtimeState(paths, pid), paths);
    fakeServers.push(fake);
    return fake;
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

function identity(request: OwnedDelegationV2Request): DagFusionDelegationIdentity {
  return {
    requestId: request.requestId,
    ownerRunId: request.ownerRunId,
    nodeId: request.nodeId,
  };
}

function usage() {
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

function budget(
  suffix: string,
  ownedIdentity: DagFusionDelegationIdentity,
  provider = "openai-codex",
  authType: SupervisedWorkflowBudgetDescriptorV1["authType"] = "oauth",
): SupervisedWorkflowBudgetDescriptorV1 {
  const separator = ownedIdentity.nodeId.lastIndexOf(":");
  if (separator < 1 || separator === ownedIdentity.nodeId.length - 1) {
    throw new Error("Test identity must contain an execution:slot node id.");
  }
  return {
    version: 1,
    reservationId: `wbres_${suffix.repeat(32).slice(0, 32)}`,
    runId: ownedIdentity.ownerRunId,
    executionId: ownedIdentity.nodeId.slice(0, separator),
    attempt: 1,
    slotId: ownedIdentity.nodeId.slice(separator + 1),
    provider,
    authType,
  };
}

function settlement(
  ownedIdentity: DagFusionDelegationIdentity,
): DagFusionDelegationUsageSettlement {
  return {
    identity: ownedIdentity,
    reason: "terminal-response",
    responseStatus: "completed",
    usage: usage(),
    progress: {
      started: true,
      model: "openai-codex/gpt-5.4",
      tokens: 150,
      toolCalls: 0,
      durationMs: 1_200,
    },
  };
}

function delegationRequest(projectId = "default"): OwnedDelegationV2Request {
  return {
    version: 2,
    requestId: "dagcall_run-1_node-1_agent",
    ownerRunId: "wrun_0123456789abcdef",
    nodeId: "node-1:agent",
    agent: "dag-workflow-readonly-executor",
    task: "Analyze the supplied evidence.",
    context: "fresh",
    cwd: resolvePaths(projectId).sandbox,
    model: "openai-codex/gpt-5.4",
    thinking: "high",
    timeoutMs: 60_000,
    turnBudget: { maxTurns: 12, graceTurns: 2 },
    toolBudget: { soft: 20, hard: 30, block: "*" },
    skill: false,
    artifacts: false,
    result: {
      kind: "structured",
      schema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      },
    },
  };
}

function receipt(request: OwnedDelegationV2Request): DagFusionDelegationReceipt {
  return {
    identity: identity(request),
    requested: {
      agent: request.agent,
      model: request.model,
      thinking: request.thinking,
    },
    resolved: {
      agent: request.agent,
      model: request.model,
      thinking: request.thinking,
      launchContractDigest: "b".repeat(64),
    },
    response: {
      version: 2,
      requestId: request.requestId,
      ownerRunId: request.ownerRunId,
      nodeId: request.nodeId,
      status: "completed",
      agent: request.agent,
      model: request.model,
      thinking: request.thinking,
      result: { kind: "structured", value: { answer: "Supported." } },
      usage: usage(),
    },
    usage: { ...usage(), totalTokens: 150 },
    progress: {
      started: true,
      model: request.model,
      tokens: 150,
      toolCalls: 0,
      durationMs: 1_200,
    },
  };
}

function openRouterModelRequest(model: string) {
  return {
    requested: {
      source: "fixed" as const,
      provider: "openrouter",
      model,
      auth: { kind: "api-key" as const },
      reasoning: "high" as const,
    },
    resolution: { mode: "exact" as const },
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

function hostedSerialized(): SerializedHostedOpenRouterFusionRequest {
  const router = openRouterModelRequest("openrouter/fusion");
  const analyst = openRouterModelRequest("anthropic/claude-sonnet-4.5");
  const critic = openRouterModelRequest("openai/gpt-5.4");
  const judge = openRouterModelRequest("google/gemini-3-pro");
  return {
    projectId: "default",
    identity: {
      requestId: "dagfusion_run-1_fusion-1",
      ownerRunId: "wrun_0123456789abcdef",
      nodeId: "fusion-1:hosted",
    },
    fusion: {
      mode: "openrouter-router",
      router,
      members: [
        { id: "analyst", role: "Analyst", model: analyst },
        { id: "critic", role: "Critic", model: critic },
      ],
      judge,
    },
    resolved: {
      members: [
        {
          memberId: "analyst",
          role: "Analyst",
          receipt: modelReceipt("anthropic/claude-sonnet-4.5"),
        },
        {
          memberId: "critic",
          role: "Critic",
          receipt: modelReceipt("openai/gpt-5.4"),
        },
      ],
      judgeDeliberation: modelReceipt("google/gemini-3-pro"),
      judgeFinal: modelReceipt("google/gemini-3-pro"),
    },
    task: "Fuse the independent analyses.",
    maxTokens: 10_000,
    maxCostUsd: 12,
    timeoutMs: 120_000,
  };
}

function success(
  request: WorkflowSupervisorRequest,
  pid: number,
  epoch: number,
): WorkflowSupervisorResponse {
  switch (request.op) {
    case "ping":
      return {
        version: 1,
        messageId: request.messageId,
        ok: true,
        op: "ping",
        result: { pid, state: "ready", attachedEpoch: null },
      };
    case "attach":
      return {
        version: 1,
        messageId: request.messageId,
        ok: true,
        op: "attach",
        result: { attached: true, epoch: request.epoch },
      };
    case "delegate":
      return {
        version: 1,
        messageId: request.messageId,
        ok: true,
        op: "delegate",
        result: {
          receipt: receipt(request.request),
          settlement: settlement(identity(request.request)),
        },
      };
    case "hosted-fusion":
      return {
        version: 1,
        messageId: request.messageId,
        ok: true,
        op: "hosted-fusion",
        result: {
          result: { text: "Fused.", textTruncated: false, usage: usage() },
          settlement: settlement(request.request.identity),
        },
      };
    case "reload-credentials":
      return {
        version: 1,
        messageId: request.messageId,
        ok: true,
        op: "reload-credentials",
        result: { reloaded: true, keys: [...request.keys] },
      };
    case "quiesce-project":
      return {
        version: 1,
        messageId: request.messageId,
        ok: true,
        op: "quiesce-project",
        result: {
          projectId: request.projectId,
          quiescent: true,
          cancelledAttempts: 0,
        },
      };
    case "snapshot":
      return {
        version: 1,
        messageId: request.messageId,
        ok: true,
        op: "snapshot",
        result: {
          snapshot: {
            pid,
            state: "ready",
            attachedEpoch: epoch,
            quiescingProjectIds: [],
            attempts: [],
          },
        },
      };
    case "shutdown":
      return {
        version: 1,
        messageId: request.messageId,
        ok: true,
        op: "shutdown",
        result: { accepted: true },
      };
  }
}

describe("workflow supervisor client", () => {
  it("drains an inherited supervisor, attaches a fresh lease, and reconciles exact terminal settlements", async () => {
    const paths = temporaryPaths();
    const inheritedSeen: WorkflowSupervisorRequest["op"][] = [];
    const freshSeen: WorkflowSupervisorRequest["op"][] = [];
    let controlClosed = false;
    await FakeSupervisor.start(paths, (request, socket) => {
      inheritedSeen.push(request.op);
      return success(request, process.pid, 17);
    }, process.pid, { shutdownOnRequest: true });

    const spawnSupervisor = vi.fn(async () => {
      const supervisor = await FakeSupervisor.start(paths, (request, socket) => {
        freshSeen.push(request.op);
        if (request.op === "attach") {
          socket.once("close", () => {
            controlClosed = true;
          });
        }
        return success(request, process.pid, 42);
      }, process.pid, { shutdownOnRequest: true });
      return {
        pid: process.pid,
        token: TOKEN,
        terminate: () => supervisor.stop(),
      };
    });
    const client = await ensureWorkflowSupervisor({
      paths,
      dependencies: { spawnSupervisor, randomEpoch: () => 42 },
    });

    const request = delegationRequest();
    let delegateReconciliations = 0;
    const delegated = await client.delegate("default", request, {
      limits: { maxTokens: 10_000, maxCostUsd: 2 },
      supervisedBudget: budget("1", identity(request)),
      reconcileUsage: (observed) => {
        delegateReconciliations += 1;
        expect(observed).toEqual(settlement(identity(request)));
      },
    });
    expect(delegated).toEqual(receipt(request));
    expect(delegateReconciliations).toBe(1);

    const hosted = hostedSerialized();
    let hostedReconciliations = 0;
    const hostedResult = await client.runHostedFusion(
      {
        ...hosted,
        paths: resolvePaths("default"),
        signal: new AbortController().signal,
        reconcileUsage: (observed) => {
          hostedReconciliations += 1;
          expect(observed).toEqual(settlement(hosted.identity));
        },
      } as HostedOpenRouterFusionRequest,
      {
        supervisedBudget: budget("2", hosted.identity, "openrouter", "api_key"),
      },
    );
    expect(hostedResult).toEqual({
      text: "Fused.",
      textTruncated: false,
      usage: usage(),
    });
    expect(hostedReconciliations).toBe(1);

    expect(await client.quiesceProject("default", "project-delete")).toEqual({
      projectId: "default",
      quiescent: true,
      cancelledAttempts: 0,
    });
    expect(await client.snapshot("default")).toMatchObject({
      pid: process.pid,
      attachedEpoch: 42,
    });
    expect(await client.reloadCredentials(["openrouter", "exa"])).toEqual([
      "openrouter",
      "exa",
    ]);
    await client.shutdown();
    await vi.waitFor(() => expect(controlClosed).toBe(true));

    expect(spawnSupervisor).toHaveBeenCalledOnce();
    expect(inheritedSeen).toEqual(["ping", "attach", "shutdown"]);
    expect(freshSeen).toEqual([
      "ping",
      "attach",
      "delegate",
      "hosted-fusion",
      "quiesce-project",
      "snapshot",
      "reload-credentials",
      "shutdown",
    ]);
  });

  it("reconciles an error settlement exactly once before surfacing the safe remote error", async () => {
    const paths = temporaryPaths();
    const ownedRequest = delegationRequest();
    const spawnSupervisor = async (runtimePaths: WorkflowSupervisorRuntimePaths) => {
      const supervisor = await FakeSupervisor.start(runtimePaths, (request) => {
        if (request.op === "delegate") {
          return workflowSupervisorErrorResponse(
            request.messageId,
            "OPERATION_FAILED",
            settlement(identity(request.request)),
          );
        }
        return success(request, process.pid, 73);
      });
      return {
        pid: process.pid,
        token: TOKEN,
        terminate: () => supervisor.stop(),
      };
    };
    const client = await ensureWorkflowSupervisor({
      paths,
      dependencies: { randomEpoch: () => 73, spawnSupervisor },
    });

    let reconciliations = 0;
    await expect(client.delegate("default", ownedRequest, {
      limits: { maxTokens: 10_000, maxCostUsd: 2 },
      supervisedBudget: budget("3", identity(ownedRequest)),
      reconcileUsage: () => {
        reconciliations += 1;
      },
    })).rejects.toMatchObject({
      name: "WorkflowSupervisorRemoteError",
      code: "OPERATION_FAILED",
    } satisfies Partial<WorkflowSupervisorRemoteError>);
    expect(reconciliations).toBe(1);
    await client.close();
  });

  it("cancels an aborted operation out of band and still takes its settlement", async () => {
    // Dropping the operation socket also cancels, but discards the terminal
    // settlement the supervisor is about to send, which is what let the backend
    // settle zero usage against work the supervisor had already admitted.
    const paths = temporaryPaths();
    let operationReceived!: () => void;
    const received = new Promise<void>((resolve) => {
      operationReceived = resolve;
    });
    const cancelledTargets: string[] = [];
    let respondToOperation!: () => void;
    const spawnSupervisor = async (runtimePaths: WorkflowSupervisorRuntimePaths) => {
      const supervisor = await FakeSupervisor.start(runtimePaths, (request, socket) => {
        if (request.op === "delegate") {
          respondToOperation = () => {
            socket.write(encodeWorkflowSupervisorResponseLine(
              workflowSupervisorErrorResponse(
                request.messageId,
                "OPERATION_FAILED",
                {
                  ...settlement(identity(delegationRequest())),
                  reason: "caller-aborted",
                  responseStatus: "cancelled",
                },
              ),
            ));
          };
          operationReceived();
          return undefined;
        }
        if (request.op === "cancel") {
          cancelledTargets.push(request.targetMessageId);
          respondToOperation();
          return {
            version: 1,
            messageId: request.messageId,
            ok: true,
            op: "cancel",
            result: { targetMessageId: request.targetMessageId, cancelled: true },
          } as const;
        }
        return success(request, process.pid, 91);
      });
      return {
        pid: process.pid,
        token: TOKEN,
        terminate: () => supervisor.stop(),
      };
    };
    const client = await ensureWorkflowSupervisor({
      paths,
      dependencies: { randomEpoch: () => 91, spawnSupervisor },
    });
    const controller = new AbortController();
    const reconcileUsage = vi.fn();
    const pending = client.delegate("default", delegationRequest(), {
      limits: { maxTokens: 10_000, maxCostUsd: 2 },
      supervisedBudget: budget("4", identity(delegationRequest())),
      signal: controller.signal,
      reconcileUsage,
    });
    await received;
    controller.abort();

    // The caller sees the supervisor's own terminal outcome, not a bare abort,
    // and the observed usage reaches reconciliation exactly once.
    await expect(pending).rejects.toMatchObject({
      name: "WorkflowSupervisorRemoteError",
      code: "OPERATION_FAILED",
    });
    expect(cancelledTargets).toHaveLength(1);
    expect(reconcileUsage).toHaveBeenCalledTimes(1);
    expect(reconcileUsage.mock.calls[0][0]).toMatchObject({
      reason: "caller-aborted",
      usage: { input: 100, output: 40 },
    });

    expect(await client.snapshot()).toMatchObject({ attachedEpoch: 91 });
    await client.close();
  });

  it("falls back to dropping the operation socket when a cancelled supervisor stays silent", async () => {
    const paths = temporaryPaths();
    let operationReceived!: () => void;
    const received = new Promise<void>((resolve) => {
      operationReceived = resolve;
    });
    let operationClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      operationClosed = resolve;
    });
    const spawnSupervisor = async (runtimePaths: WorkflowSupervisorRuntimePaths) => {
      const supervisor = await FakeSupervisor.start(runtimePaths, (request, socket) => {
        if (request.op === "delegate") {
          operationReceived();
          socket.once("close", operationClosed);
          return undefined;
        }
        if (request.op === "cancel") {
          // Accepted, then deliberately never followed by a terminal frame.
          return {
            version: 1,
            messageId: request.messageId,
            ok: true,
            op: "cancel",
            result: { targetMessageId: request.targetMessageId, cancelled: true },
          } as const;
        }
        return success(request, process.pid, 91);
      });
      return {
        pid: process.pid,
        token: TOKEN,
        terminate: () => supervisor.stop(),
      };
    };
    const client = await ensureWorkflowSupervisor({
      paths,
      cancelSettlementTimeoutMs: 250,
      dependencies: { randomEpoch: () => 91, spawnSupervisor },
    });
    const controller = new AbortController();
    const pending = client.delegate("default", delegationRequest(), {
      limits: { maxTokens: 10_000, maxCostUsd: 2 },
      supervisedBudget: budget("4", identity(delegationRequest())),
      signal: controller.signal,
      reconcileUsage: vi.fn(),
    });
    await received;
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      name: "WorkflowSupervisorClientError",
      code: "ABORTED",
    } satisfies Partial<WorkflowSupervisorClientError>);
    await closed;

    // The independent attach lease survives the bounded fallback drop.
    expect(await client.snapshot()).toMatchObject({ attachedEpoch: 91 });
    await client.close();
  });

  it("removes state only for a confirmed dead pid, launches under a private lock, and refuses an ambiguous live pid", async () => {
    const deadPaths = temporaryPaths();
    writeWorkflowSupervisorRuntimeState(runtimeState(deadPaths, 999_999), deadPaths);
    let launched: FakeSupervisor | undefined;
    const spawnSupervisor = vi.fn(async (paths: WorkflowSupervisorRuntimePaths) => {
      if (process.platform !== "win32") {
        expect(fs.statSync(paths.launchLock).mode & 0o777).toBe(0o600);
        expect(fs.statSync(paths.stateDir).mode & 0o777).toBe(0o700);
      }
      launched = await FakeSupervisor.start(
        paths,
        (request) => success(request, process.pid, 101),
      );
      return {
        pid: process.pid,
        token: TOKEN,
        terminate: () => launched!.stop(),
      };
    });
    const client = await ensureWorkflowSupervisor({
      paths: deadPaths,
      dependencies: {
        processMayBeAlive: (pid) => pid === process.pid,
        spawnSupervisor,
        randomEpoch: () => 101,
      },
    });
    expect(launched).toBeDefined();
    expect(spawnSupervisor).toHaveBeenCalledOnce();
    expect(fs.existsSync(deadPaths.launchLock)).toBe(false);
    await client.close();

    const livePaths = temporaryPaths();
    writeWorkflowSupervisorRuntimeState(runtimeState(livePaths), livePaths);
    const forbiddenSpawn = vi.fn(async () => ({
      pid: process.pid,
      token: TOKEN,
      terminate: async () => {},
    }));
    await expect(ensureWorkflowSupervisor({
      paths: livePaths,
      connectTimeoutMs: 50,
      pingTimeoutMs: 50,
      dependencies: {
        spawnSupervisor: forbiddenSpawn,
        processMayBeAlive: () => true,
      },
    })).rejects.toMatchObject({
      name: "WorkflowSupervisorClientError",
      code: "STARTUP_AMBIGUOUS",
    } satisfies Partial<WorkflowSupervisorClientError>);
    expect(forbiddenSpawn).not.toHaveBeenCalled();
    expect(fs.existsSync(livePaths.stateFile)).toBe(true);
  });

  it("terminates its exact fresh child and removes artifacts after state timeout or malformed state", async () => {
    for (const scenario of ["timeout", "malformed"] as const) {
      const paths = temporaryPaths();
      let now = 0;
      let alive = true;
      const terminate = vi.fn(async () => {
        alive = false;
      });
      const spawnSupervisor = vi.fn(async () => {
        if (scenario === "malformed") {
          fs.writeFileSync(paths.stateFile, "{malformed-runtime-state\n", { mode: 0o600 });
        }
        return { pid: process.pid, token: TOKEN, terminate };
      });

      await expect(ensureWorkflowSupervisor({
        paths,
        startupTimeoutMs: 1,
        dependencies: {
          spawnSupervisor,
          processMayBeAlive: () => alive,
          now: () => now,
          sleep: async (milliseconds) => {
            now += milliseconds;
          },
        },
      })).rejects.toMatchObject({
        name: "WorkflowSupervisorClientError",
        code: "STARTUP_FAILED",
      } satisfies Partial<WorkflowSupervisorClientError>);
      expect(terminate).toHaveBeenCalledOnce();
      expect(alive).toBe(false);
      expect(fs.existsSync(paths.stateFile)).toBe(false);
      expect(fs.existsSync(paths.socketPath)).toBe(false);
    }
  });

  it.skipIf(process.platform === "win32")(
    "leaves no real detached child orphaned when fresh readiness authentication fails",
    async () => {
      const paths = temporaryPaths();
      vi.stubEnv(
        "KADY_PI_AGENT_DIR",
        path.join(path.dirname(paths.stateDir), "pi-agent"),
      );
      let launchedPid: number | undefined;

      await expect(ensureWorkflowSupervisor({
        paths,
        startupTimeoutMs: 10_000,
        connectTimeoutMs: 100,
        pingTimeoutMs: 100,
        dependencies: {
          connect: () => {
            launchedPid = readWorkflowSupervisorRuntimeState(paths)?.pid;
            return net.createConnection(
              path.join(path.dirname(paths.stateDir), "missing-supervisor.sock"),
            );
          },
        },
      })).rejects.toMatchObject({
        name: "WorkflowSupervisorClientError",
        code: "STARTUP_AMBIGUOUS",
      } satisfies Partial<WorkflowSupervisorClientError>);

      expect(launchedPid).toBeTypeOf("number");
      expect(workflowSupervisorProcessMayBeAlive(launchedPid!)).toBe(false);
      expect(fs.existsSync(paths.stateFile)).toBe(false);
      expect(fs.existsSync(paths.socketPath)).toBe(false);
    },
    30_000,
  );

  it.each([
    ["pid", process.pid + 10_000, TOKEN],
    ["token", process.pid, "b".repeat(64)],
  ] as const)(
    "terminates and cleans a fresh child after published %s identity mismatch",
    async (_mismatch, publishedPid, publishedToken) => {
      const paths = temporaryPaths();
      let alive = true;
      const terminate = vi.fn(async () => {
        alive = false;
      });
      const spawnSupervisor = async () => {
        writeWorkflowSupervisorRuntimeState(
          runtimeState(paths, publishedPid),
          paths,
        );
        const published = JSON.parse(fs.readFileSync(paths.stateFile, "utf8"));
        published.token = publishedToken;
        fs.writeFileSync(paths.stateFile, `${JSON.stringify(published)}\n`, { mode: 0o600 });
        return { pid: process.pid, token: TOKEN, terminate };
      };

      await expect(ensureWorkflowSupervisor({
        paths,
        dependencies: {
          spawnSupervisor,
          processMayBeAlive: () => alive,
        },
      })).rejects.toMatchObject({
        name: "WorkflowSupervisorClientError",
        code: "STARTUP_AMBIGUOUS",
      } satisfies Partial<WorkflowSupervisorClientError>);
      expect(terminate).toHaveBeenCalledOnce();
      expect(alive).toBe(false);
      expect(fs.existsSync(paths.stateFile)).toBe(false);
    },
  );

  it("terminates and cleans a fresh child after readiness or attach mismatch", async () => {
    for (const mismatch of ["readiness", "attach"] as const) {
      const paths = temporaryPaths();
      const epoch = mismatch === "attach" ? 401 : 301;
      let supervisor!: FakeSupervisor;
      const terminate = vi.fn(async () => supervisor.stop());
      const spawnSupervisor = async (runtimePaths: WorkflowSupervisorRuntimePaths) => {
        supervisor = await FakeSupervisor.start(
          runtimePaths,
          (request) => {
            if (mismatch === "attach" && request.op === "attach") {
              return {
                version: 1,
                messageId: request.messageId,
                ok: true,
                op: "attach",
                result: { attached: true, epoch: request.epoch + 1 },
              };
            }
            return success(
              request,
              mismatch === "readiness" && request.op === "ping"
                ? process.pid + 1
                : process.pid,
              epoch,
            );
          },
        );
        return { pid: process.pid, token: TOKEN, terminate };
      };

      await expect(ensureWorkflowSupervisor({
        paths,
        dependencies: {
          spawnSupervisor,
          processMayBeAlive: () => true,
          randomEpoch: () => epoch,
        },
      })).rejects.toMatchObject({
        name: "WorkflowSupervisorClientError",
        code: mismatch === "readiness" ? "STARTUP_AMBIGUOUS" : "PROTOCOL_ERROR",
      } satisfies Partial<WorkflowSupervisorClientError>);
      expect(terminate).toHaveBeenCalledOnce();
      expect(fs.existsSync(paths.stateFile)).toBe(false);
      expect(fs.existsSync(paths.socketPath)).toBe(false);
    }
  });

  it("waits for exact shutdown disappearance before allowing an immediate restart", async () => {
    const paths = temporaryPaths();
    let releaseFirstShutdown!: () => void;
    const firstShutdownGate = new Promise<void>((resolve) => {
      releaseFirstShutdown = resolve;
    });
    let firstShutdownSeen!: () => void;
    const firstShutdownReceived = new Promise<void>((resolve) => {
      firstShutdownSeen = resolve;
    });
    let launches = 0;
    const spawnSupervisor = vi.fn(async (runtimePaths: WorkflowSupervisorRuntimePaths) => {
      launches += 1;
      const thisLaunch = launches;
      let supervisor!: FakeSupervisor;
      supervisor = await FakeSupervisor.start(
        runtimePaths,
        (request) => {
          if (thisLaunch === 1 && request.op === "shutdown") {
            firstShutdownSeen();
            void firstShutdownGate.then(() => supervisor.stop());
          }
          return success(request, process.pid, thisLaunch);
        },
        process.pid,
        { shutdownOnRequest: thisLaunch > 1 },
      );
      return {
        pid: process.pid,
        token: TOKEN,
        terminate: () => supervisor.stop(),
      };
    });

    const first = await ensureWorkflowSupervisor({
      paths,
      shutdownTimeoutMs: 2_000,
      dependencies: { spawnSupervisor, randomEpoch: () => 1 },
    });
    let shutdownResolved = false;
    const shutdown = first.shutdown().then(() => {
      shutdownResolved = true;
    });
    await firstShutdownReceived;
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(shutdownResolved).toBe(false);
    releaseFirstShutdown();
    await shutdown;
    expect(fs.existsSync(paths.stateFile)).toBe(false);
    expect(fs.existsSync(paths.socketPath)).toBe(false);

    const restarted = await ensureWorkflowSupervisor({
      paths,
      dependencies: { spawnSupervisor, randomEpoch: () => 2 },
    });
    expect(spawnSupervisor).toHaveBeenCalledTimes(2);
    await restarted.shutdown();
  });

  it("fails boundedly when shutdown acknowledgement is not followed by disappearance", async () => {
    const paths = temporaryPaths();
    const spawnSupervisor = async (runtimePaths: WorkflowSupervisorRuntimePaths) => {
      const supervisor = await FakeSupervisor.start(
        runtimePaths,
        (request) => success(request, process.pid, 501),
      );
      return {
        pid: process.pid,
        token: TOKEN,
        terminate: () => supervisor.stop(),
      };
    };
    const client = await ensureWorkflowSupervisor({
      paths,
      shutdownTimeoutMs: 50,
      dependencies: { spawnSupervisor, randomEpoch: () => 501 },
    });

    await expect(client.shutdown()).rejects.toMatchObject({
      name: "WorkflowSupervisorClientError",
      code: "STARTUP_FAILED",
    } satisfies Partial<WorkflowSupervisorClientError>);
    expect(fs.existsSync(paths.stateFile)).toBe(true);
  });
});
