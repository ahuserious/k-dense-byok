import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OwnedDelegationRequest } from "../pi-packages/dag-fusion-drive/index.ts";
import { workflowBudgetReservationId } from "../src/workflows/budget.ts";
import type { SupervisedWorkflowBudgetDescriptorV1 } from "../src/workflows/supervised-budget.ts";
import {
  MAX_WORKFLOW_SUPERVISOR_FRAME_BYTES,
  WORKFLOW_SUPERVISOR_PROTOCOL_VERSION,
  encodeWorkflowSupervisorRequestLine,
  parseWorkflowSupervisorResponseLine,
  type WorkflowSupervisorRequest,
  type WorkflowSupervisorResponse,
  type WorkflowSupervisorSnapshot,
} from "../src/workflows/supervisor/protocol.ts";
import {
  createWorkflowSupervisorSocketServer,
  type WorkflowSupervisorCoordinatorPort,
  type WorkflowSupervisorSocketServer,
} from "../src/workflows/supervisor/server.ts";

const TOKEN = "workflow_supervisor_test_token_123456789";
const WRONG_TOKEN = "workflow_supervisor_wrong_token_12345678";

interface CancelledMessage {
  epoch: number;
  messageId: string;
}

class FakeCoordinator implements WorkflowSupervisorCoordinatorPort {
  attachedEpoch: number | null = null;
  readonly detached: number[] = [];
  readonly cancelled: CancelledMessage[] = [];
  readonly shutdownEpochs: number[] = [];
  delegateStarted: (() => void) | undefined;
  snapshotError: unknown;
  delegateError: Error | undefined;
  private rejectDelegate: ((error: Error) => void) | undefined;

  async attach(epoch: number): Promise<void> {
    if (this.attachedEpoch !== null) {
      throw Object.assign(new Error("busy"), { code: "SUPERVISOR_BUSY" });
    }
    this.attachedEpoch = epoch;
  }

  detach(epoch: number): void {
    if (this.attachedEpoch !== epoch) return;
    this.attachedEpoch = null;
    this.detached.push(epoch);
  }

  cancelMessage(epoch: number, messageId: string): boolean {
    this.cancelled.push({ epoch, messageId });
    this.rejectDelegate?.(new Error("cancelled"));
    this.rejectDelegate = undefined;
    return true;
  }

  delegate(): ReturnType<WorkflowSupervisorCoordinatorPort["delegate"]> {
    if (this.delegateError) return Promise.reject(this.delegateError);
    this.delegateStarted?.();
    return new Promise((_, reject) => {
      this.rejectDelegate = reject;
    });
  }

  async hostedFusion(): ReturnType<WorkflowSupervisorCoordinatorPort["hostedFusion"]> {
    throw new Error("not used");
  }

  async reloadCredentials(): Promise<void> {}

  async quiesceProject(): Promise<number> {
    return 0;
  }

  snapshot(projectId?: string): WorkflowSupervisorSnapshot {
    void projectId;
    if (this.snapshotError !== undefined) throw this.snapshotError;
    return {
      pid: process.pid,
      state: "ready",
      attachedEpoch: this.attachedEpoch,
      quiescingProjectIds: [],
      attempts: [],
    };
  }

  async shutdown(epoch: number): Promise<void> {
    this.shutdownEpochs.push(epoch);
  }
}

let temporaryRoot: string;
let socketPath: string;
let coordinator: FakeCoordinator;
let server: WorkflowSupervisorSocketServer;

beforeEach(async () => {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-supervisor-server-"));
  socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\kady-supervisor-${process.pid}-${Date.now()}`
    : path.join(temporaryRoot, "supervisor.sock");
  coordinator = new FakeCoordinator();
  server = createWorkflowSupervisorSocketServer({
    socketPath,
    token: TOKEN,
    coordinator,
    frameTimeoutMs: 2_000,
  });
  await server.listen();
});

afterEach(async () => {
  await server.close();
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

function common(messageId: string, token = TOKEN) {
  return {
    version: WORKFLOW_SUPERVISOR_PROTOCOL_VERSION,
    messageId,
    token,
  } as const;
}

function delegationRequest(): OwnedDelegationRequest {
  return {
    requestId: "dagcall_server_test",
    ownerRunId: "wrun_server_test",
    nodeId: "research-node",
    agent: "dag-workflow-readonly-executor",
    task: "Analyze the evidence.",
    context: "fresh",
    cwd: "/tmp/kady-project/sandbox",
    model: "openai-codex/gpt-5.4",
    thinking: "high",
    timeoutMs: 60_000,
    turnBudget: { maxTurns: 4 },
    toolBudget: { hard: 8, block: "*" },
    result: { kind: "text" },
  };
}

function delegationBudget(): SupervisedWorkflowBudgetDescriptorV1 {
  const runId = "wrun_server_test";
  const executionId = "research-node";
  const attempt = 1;
  const slotId = "agent";
  return {
    version: 1,
    reservationId: workflowBudgetReservationId(runId, executionId, attempt, slotId),
    runId,
    executionId,
    attempt,
    slotId,
    provider: "openai-codex",
    authType: "oauth",
  };
}

function connect(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function readResponse(socket: net.Socket): Promise<WorkflowSupervisorResponse> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.byteLength;
      const bytes = Buffer.concat(chunks, total);
      const newlineAt = bytes.indexOf(0x0a);
      if (newlineAt < 0) return;
      cleanup();
      try {
        resolve(parseWorkflowSupervisorResponseLine(bytes.subarray(0, newlineAt + 1)));
      } catch (error) {
        reject(error);
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Supervisor socket closed before a response frame."));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.off("error", onError);
    };
    socket.on("data", onData);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

async function exchange(
  request: WorkflowSupervisorRequest,
): Promise<WorkflowSupervisorResponse> {
  const socket = await connect();
  const response = readResponse(socket);
  socket.write(encodeWorkflowSupervisorRequestLine(request));
  try {
    return await response;
  } finally {
    socket.destroy();
  }
}

async function restartServer(
  options: Partial<Parameters<typeof createWorkflowSupervisorSocketServer>[0]>,
): Promise<void> {
  await server.close();
  coordinator = new FakeCoordinator();
  server = createWorkflowSupervisorSocketServer({
    socketPath,
    token: TOKEN,
    coordinator,
    frameTimeoutMs: 2_000,
    ...options,
  });
  await server.listen();
}

interface WorkloadSaturation {
  sockets: net.Socket[];
  delegateStartCount: () => number;
}

/**
 * Fills every workload slot of a maximumConnections: 8 server (4 slots after
 * the reserved lifecycle pool): one attach lease plus three in-flight
 * delegates, mirroring how the cancel test builds its connections.
 */
async function saturateWorkloadCapacity(epoch: number): Promise<WorkloadSaturation> {
  let started = 0;
  coordinator.delegateStarted = () => {
    started += 1;
  };
  const sockets: net.Socket[] = [];
  const control = await connect();
  const attached = readResponse(control);
  control.write(encodeWorkflowSupervisorRequestLine({
    ...common(`msg-saturate-attach-${epoch}`),
    op: "attach",
    epoch,
  }));
  expect((await attached).ok).toBe(true);
  sockets.push(control);
  for (let index = 0; index < 3; index += 1) {
    const socket = await connect();
    socket.write(encodeWorkflowSupervisorRequestLine({
      ...common(`msg-saturate-delegate-${epoch}-${index}`),
      op: "delegate",
      epoch,
      projectId: "default",
      request: delegationRequest(),
      limits: { maxTokens: 1_000, maxCostUsd: 1 },
      budget: delegationBudget(),
    }));
    sockets.push(socket);
  }
  await waitUntil(() => started === 3);
  return { sockets, delegateStartCount: () => started };
}

/** Resolves once the socket closes; asserts it never received a byte. */
function expectDestroyedSilently(socket: net.Socket): Promise<void> {
  let receivedBytes = false;
  socket.on("data", () => {
    receivedBytes = true;
  });
  return new Promise((resolve) => {
    socket.once("close", () => {
      expect(receivedBytes).toBe(false);
      resolve();
    });
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for supervisor state.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("workflow supervisor socket server", () => {
  it("authenticates with a fixed safe error and does not let rejected clients consume ids", async () => {
    const unauthorized = await exchange({
      ...common("msg-auth", WRONG_TOKEN),
      op: "ping",
    });
    expect(unauthorized).toEqual(expect.objectContaining({
      messageId: "msg-auth",
      ok: false,
      error: expect.objectContaining({ code: "UNAUTHORIZED" }),
    }));

    const authorized = await exchange({ ...common("msg-auth"), op: "ping" });
    expect(authorized).toEqual({
      version: 1,
      messageId: "msg-auth",
      ok: true,
      op: "ping",
      result: { pid: process.pid, state: "ready", attachedEpoch: null },
    });
  });

  it("rejects trailing frames and oversized frames without dispatching them", async () => {
    const firstSocket = await connect();
    const trailingResponse = readResponse(firstSocket);
    const ping = encodeWorkflowSupervisorRequestLine({
      ...common("msg-trailing"),
      op: "ping",
    });
    firstSocket.write(`${ping}${ping}`);
    expect(await trailingResponse).toEqual(expect.objectContaining({
      messageId: null,
      ok: false,
      error: expect.objectContaining({ code: "INVALID_MESSAGE" }),
    }));
    firstSocket.destroy();

    const secondSocket = await connect();
    const oversizedResponse = readResponse(secondSocket);
    secondSocket.write(Buffer.alloc(MAX_WORKFLOW_SUPERVISOR_FRAME_BYTES + 1, 0x78));
    expect(await oversizedResponse).toEqual(expect.objectContaining({
      messageId: null,
      ok: false,
      error: expect.objectContaining({ code: "FRAME_TOO_LARGE" }),
    }));
    secondSocket.destroy();
  });

  it("keeps attach as a control lease and detaches its exact epoch on close", async () => {
    const socket = await connect();
    const response = readResponse(socket);
    socket.write(encodeWorkflowSupervisorRequestLine({
      ...common("msg-attach"),
      op: "attach",
      epoch: 42,
    }));
    expect(await response).toEqual(expect.objectContaining({
      ok: true,
      op: "attach",
      result: { attached: true, epoch: 42 },
    }));
    expect(socket.destroyed).toBe(false);
    expect(coordinator.attachedEpoch).toBe(42);

    socket.destroy();
    await waitUntil(() => coordinator.detached.length === 1);
    expect(coordinator.detached).toEqual([42]);
  });

  it("cancels the exact live operation when its one-shot socket disappears", async () => {
    const control = await connect();
    const attached = readResponse(control);
    control.write(encodeWorkflowSupervisorRequestLine({
      ...common("msg-control"),
      op: "attach",
      epoch: 17,
    }));
    await attached;

    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    coordinator.delegateStarted = markStarted;
    const operation = await connect();
    operation.write(encodeWorkflowSupervisorRequestLine({
      ...common("msg-delegate"),
      op: "delegate",
      epoch: 17,
      projectId: "default",
      request: delegationRequest(),
      limits: { maxTokens: 1_000, maxCostUsd: 1 },
      budget: delegationBudget(),
    }));
    await started;
    operation.destroy();

    await waitUntil(() => coordinator.cancelled.length === 1);
    expect(coordinator.cancelled).toEqual([{ epoch: 17, messageId: "msg-delegate" }]);
    control.destroy();
  });

  it("cancels an in-flight operation from an independent connection while its transport stays open", async () => {
    const control = await connect();
    const attached = readResponse(control);
    control.write(encodeWorkflowSupervisorRequestLine({
      ...common("msg-cancel-control"),
      op: "attach",
      epoch: 29,
    }));
    await attached;

    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    coordinator.delegateStarted = markStarted;
    const operation = await connect();
    const operationResponse = readResponse(operation);
    operation.write(encodeWorkflowSupervisorRequestLine({
      ...common("msg-cancel-target"),
      op: "delegate",
      epoch: 29,
      projectId: "default",
      request: delegationRequest(),
      limits: { maxTokens: 1_000, maxCostUsd: 1 },
      budget: delegationBudget(),
    }));
    await started;

    // The cancel travels over its own short-lived second connection, not the
    // delegating one, so the operation transport survives to deliver the
    // supervisor's terminal frame instead of being destroyed to cancel.
    const cancelResponse = await exchange({
      ...common("msg-cancel-request"),
      op: "cancel",
      epoch: 29,
      targetMessageId: "msg-cancel-target",
    });
    expect(cancelResponse).toEqual(expect.objectContaining({
      ok: true,
      op: "cancel",
      result: { targetMessageId: "msg-cancel-target", cancelled: true },
    }));
    expect(coordinator.cancelled).toEqual([
      { epoch: 29, messageId: "msg-cancel-target" },
    ]);

    // The delegating connection was never destroyed: it still receives the
    // outcome of its own cancelled operation as a response frame.
    expect(operation.destroyed).toBe(false);
    expect(await operationResponse).toEqual(expect.objectContaining({
      messageId: "msg-cancel-target",
      ok: false,
      error: expect.objectContaining({ code: "OPERATION_FAILED" }),
    }));
    operation.destroy();
    control.destroy();
  });

  it("fails provider work closed at replay capacity while preserving control and shutdown", async () => {
    await server.close();
    coordinator = new FakeCoordinator();
    server = createWorkflowSupervisorSocketServer({
      socketPath,
      token: TOKEN,
      coordinator,
      maximumRememberedMessageIds: 2,
      maximumRememberedControlMessageIds: 2,
    });
    await server.listen();

    coordinator.delegateError = new Error("expected test rejection");
    const operationRequest = (messageId: string): WorkflowSupervisorRequest => ({
      ...common(messageId),
      op: "delegate",
      epoch: 73,
      projectId: "default",
      request: delegationRequest(),
      limits: { maxTokens: 1_000, maxCostUsd: 1 },
      budget: delegationBudget(),
    });
    expect((await exchange(operationRequest("msg-one"))).ok).toBe(false);
    expect((await exchange(operationRequest("msg-two"))).ok).toBe(false);
    expect(await exchange(operationRequest("msg-three"))).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: "SUPERVISOR_BUSY" }),
      }),
    );
    expect(await exchange(operationRequest("msg-one"))).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: "DUPLICATE_MESSAGE" }),
      }),
    );

    expect((await exchange({ ...common("control-ping-1"), op: "ping" })).ok).toBe(true);
    expect((await exchange({ ...common("control-ping-2"), op: "ping" })).ok).toBe(true);
    expect((await exchange({ ...common("control-ping-3"), op: "ping" })).ok).toBe(true);

    const control = await connect();
    const attached = readResponse(control);
    control.write(encodeWorkflowSupervisorRequestLine({
      ...common("control-attach"),
      op: "attach",
      epoch: 73,
    }));
    expect((await attached).ok).toBe(true);
    expect(await exchange({
      ...common("control-shutdown"),
      op: "shutdown",
      epoch: 73,
      reason: "supervisor-restart",
    })).toEqual(expect.objectContaining({ ok: true, op: "shutdown" }));
    await server.closed;
    control.destroy();
  });

  it("bounds unauthenticated connection count and aggregate unread frame bytes", async () => {
    await server.close();
    coordinator = new FakeCoordinator();
    server = createWorkflowSupervisorSocketServer({
      socketPath,
      token: TOKEN,
      coordinator,
      maximumConnections: 2,
      maximumBufferedBytes: 12,
      frameTimeoutMs: 2_000,
    });
    await server.listen();

    const first = await connect();
    first.write("12345678");
    const second = await connect();
    const secondResponse = readResponse(second);
    second.write("12345678");
    expect(await secondResponse).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: "SUPERVISOR_BUSY" }),
    }));

    const refused = net.createConnection(socketPath);
    await new Promise<void>((resolve) => {
      refused.once("close", () => resolve());
      refused.once("error", () => resolve());
    });
    expect(refused.destroyed).toBe(true);
    first.destroy();
    second.destroy();
  });

  it("maps coordinator failures to fixed protocol errors without leaking their messages", async () => {
    coordinator.snapshotError = Object.assign(new Error("secret provider detail"), {
      code: "PROJECT_QUIESCING",
    });
    const known = await exchange({ ...common("msg-known-error"), op: "ping" });
    expect(known).toEqual(expect.objectContaining({
      ok: false,
      error: {
        code: "PROJECT_QUIESCING",
        message: "The workflow project is quiescing.",
        retryable: true,
      },
    }));
    expect(JSON.stringify(known)).not.toContain("secret provider detail");

    coordinator.snapshotError = new Error("another secret provider detail");
    const unknown = await exchange({ ...common("msg-unknown-error"), op: "ping" });
    expect(unknown).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: "OPERATION_FAILED" }),
    }));
    expect(JSON.stringify(unknown)).not.toContain("another secret provider detail");
  });

  it.skipIf(process.platform === "win32")(
    "does not unlink a live supervisor socket after a competing bind fails",
    async () => {
      const contender = createWorkflowSupervisorSocketServer({
        socketPath,
        token: TOKEN,
        coordinator: new FakeCoordinator(),
      });
      await expect(contender.listen()).rejects.toMatchObject({ code: "EADDRINUSE" });
      await contender.close();

      expect(fs.lstatSync(socketPath).isSocket()).toBe(true);
      expect(await exchange({ ...common("msg-after-bind-conflict"), op: "ping" }))
        .toEqual(expect.objectContaining({ ok: true, op: "ping" }));
    },
  );

  it("admits lifecycle cancel over a reserved lane while workload saturation stays capped", async () => {
    await server.close();
    coordinator = new FakeCoordinator();
    server = createWorkflowSupervisorSocketServer({
      socketPath,
      token: TOKEN,
      coordinator,
      maximumConnections: 8,
      frameTimeoutMs: 2_000,
    });
    await server.listen();

    let startedDelegates = 0;
    coordinator.delegateStarted = () => {
      startedDelegates += 1;
    };

    const control = await connect();
    const attached = readResponse(control);
    control.write(encodeWorkflowSupervisorRequestLine({
      ...common("msg-reserve-attach"),
      op: "attach",
      epoch: 61,
    }));
    expect((await attached).ok).toBe(true);

    // Saturate the server's workload admission with in-flight delegates. An
    // excess workload connection is refused by destruction without a response
    // frame, so across capacity regimes: started + refused === opened.
    const delegates: net.Socket[] = [];
    let closedDelegates = 0;
    for (let index = 0; index < 7; index += 1) {
      const socket = await connect();
      socket.once("close", () => {
        closedDelegates += 1;
      });
      delegates.push(socket);
      socket.write(encodeWorkflowSupervisorRequestLine({
        ...common(`msg-reserve-delegate-${index}`),
        op: "delegate",
        epoch: 61,
        projectId: "default",
        request: delegationRequest(),
        limits: { maxTokens: 1_000, maxCostUsd: 1 },
        budget: delegationBudget(),
      }));
    }
    await waitUntil(() => startedDelegates + closedDelegates === 7);
    expect(startedDelegates).toBeGreaterThanOrEqual(1);

    // Saturation invariant: one more workload connection is destroyed without
    // ever receiving a response frame.
    const excess = await connect();
    const excessOutcome = readResponse(excess);
    excess.write(encodeWorkflowSupervisorRequestLine({
      ...common("msg-reserve-excess"),
      op: "delegate",
      epoch: 61,
      projectId: "default",
      request: delegationRequest(),
      limits: { maxTokens: 1_000, maxCostUsd: 1 },
      budget: delegationBudget(),
    }));
    await expect(excessOutcome).rejects.toThrow(
      /closed before a response frame|ECONNRESET|EPIPE/,
    );

    // The lifecycle lane: a cancel on a fresh independent connection must get
    // through even though workload connections hold the supervisor at
    // saturation. Pre-fix this connection is destroyed at accept before
    // classification, so a saturated supervisor cannot be cancelled at all.
    const cancelResponse = await exchange({
      ...common("msg-reserve-cancel"),
      op: "cancel",
      epoch: 61,
      targetMessageId: "msg-reserve-delegate-0",
    });
    expect(cancelResponse).toEqual(expect.objectContaining({
      ok: true,
      op: "cancel",
      result: { targetMessageId: "msg-reserve-delegate-0", cancelled: true },
    }));
    expect(coordinator.cancelled).toContainEqual({
      epoch: 61,
      messageId: "msg-reserve-delegate-0",
    });

    excess.destroy();
    for (const socket of delegates) socket.destroy();
    control.destroy();
  });

  it("destroys idle provisional connections at the first-frame deadline and reclaims the seat", async () => {
    await restartServer({ maximumConnections: 8, frameTimeoutMs: 300 });
    const saturation = await saturateWorkloadCapacity(11);

    // At workload saturation an idle connection is admitted provisionally and
    // then destroyed, without a response, when its first frame never arrives.
    const idle = await connect();
    await expectDestroyedSilently(idle);

    // Its classification seat was reclaimed: a control op still gets through.
    expect((await exchange({ ...common("msg-idle-ping"), op: "ping" })).ok).toBe(true);
    for (const socket of saturation.sockets) socket.destroy();
  });

  it("destroys slow-loris connections at the classification byte cap and reclaims the seat", async () => {
    await restartServer({ maximumConnections: 8 });
    const saturation = await saturateWorkloadCapacity(12);

    // Trickle newline-free bytes past the 8 KiB classification byte cap, well
    // under both the frame limit and the first-frame deadline.
    const loris = await connect();
    const lorisDestroyed = expectDestroyedSilently(loris);
    loris.write(Buffer.alloc(5_000, 0x61));
    loris.write(Buffer.alloc(5_000, 0x61));
    await lorisDestroyed;

    expect((await exchange({ ...common("msg-loris-ping"), op: "ping" })).ok).toBe(true);
    for (const socket of saturation.sockets) socket.destroy();
  });

  it("destroys malformed first frames at saturation and reclaims the seat", async () => {
    await restartServer({ maximumConnections: 8 });
    const saturation = await saturateWorkloadCapacity(13);

    const malformed = await connect();
    const malformedDestroyed = expectDestroyedSilently(malformed);
    malformed.write("this is not a supervisor protocol frame\n");
    await malformedDestroyed;

    expect((await exchange({ ...common("msg-malformed-ping"), op: "ping" })).ok).toBe(true);
    for (const socket of saturation.sockets) socket.destroy();
  });

  it("refuses workload frames on the provisional path without consuming the reserved pool", async () => {
    await restartServer({ maximumConnections: 8 });
    const saturation = await saturateWorkloadCapacity(14);

    // A delegate disguised through the classification buffer is destroyed at
    // classification, without a response, and never reaches the coordinator.
    const disguised = await connect();
    const disguisedDestroyed = expectDestroyedSilently(disguised);
    disguised.write(encodeWorkflowSupervisorRequestLine({
      ...common("msg-disguised-delegate"),
      op: "delegate",
      epoch: 14,
      projectId: "default",
      request: delegationRequest(),
      limits: { maxTokens: 1_000, maxCostUsd: 1 },
      budget: delegationBudget(),
    }));
    await disguisedDestroyed;
    expect(saturation.delegateStartCount()).toBe(3);

    // No reserved slot was consumed: a control op still gets through.
    expect((await exchange({ ...common("msg-disguised-ping"), op: "ping" })).ok).toBe(true);
    for (const socket of saturation.sockets) socket.destroy();
  });

  it("bounds the lifecycle pool itself and readmits control once it drains", async () => {
    await restartServer({ maximumConnections: 8 });
    let quiesceCalls = 0;
    let releaseQuiesce!: () => void;
    const quiesceGate = new Promise<void>((resolve) => {
      releaseQuiesce = resolve;
    });
    coordinator.quiesceProject = async () => {
      quiesceCalls += 1;
      await quiesceGate;
      return 0;
    };
    const saturation = await saturateWorkloadCapacity(15);

    // Fill the reserved pool with in-flight control operations.
    const quiesces: net.Socket[] = [];
    const quiesceResponses: Promise<WorkflowSupervisorResponse>[] = [];
    for (let index = 0; index < 4; index += 1) {
      const socket = await connect();
      quiesceResponses.push(readResponse(socket));
      socket.write(encodeWorkflowSupervisorRequestLine({
        ...common(`msg-pool-quiesce-${index}`),
        op: "quiesce-project",
        epoch: 15,
        projectId: "default",
        reason: "caller-request",
      }));
      quiesces.push(socket);
    }
    await waitUntil(() => quiesceCalls === 4);

    // Park idle connections on every classification seat...
    const parked: net.Socket[] = [];
    for (let index = 0; index < 4; index += 1) parked.push(await connect());
    // ...so a connection beyond reserve + buffer is refused at accept.
    const overflow = net.createConnection(socketPath);
    await new Promise<void>((resolve) => {
      overflow.once("close", () => resolve());
      overflow.once("error", () => resolve());
    });
    expect(overflow.destroyed).toBe(true);

    // A control frame that classifies while the reserved pool is full is
    // destroyed without a response instead of waiting on a slot.
    const starved = parked[0]!;
    const starvedDestroyed = expectDestroyedSilently(starved);
    starved.write(encodeWorkflowSupervisorRequestLine({
      ...common("msg-pool-starved-ping"),
      op: "ping",
    }));
    await starvedDestroyed;

    // Once the in-flight control operations complete, control admission works
    // again over the reclaimed reserved slots.
    for (const socket of parked.slice(1)) socket.destroy();
    releaseQuiesce();
    for (const response of quiesceResponses) {
      expect((await response).ok).toBe(true);
    }
    expect((await exchange({ ...common("msg-pool-recovered-ping"), op: "ping" })).ok).toBe(true);
    for (const socket of quiesces) socket.destroy();
    for (const socket of saturation.sockets) socket.destroy();
  });

  it("reclaims every admission lane so full capacity is admissible again after teardown", async () => {
    await restartServer({ maximumConnections: 8 });
    const saturation = await saturateWorkloadCapacity(16);

    // Churn the provisional path with rejected traffic of both kinds.
    const malformed = await connect();
    const malformedDestroyed = expectDestroyedSilently(malformed);
    malformed.write("garbage\n");
    await malformedDestroyed;
    const idle = await connect();

    idle.destroy();
    for (const socket of saturation.sockets) socket.destroy();
    await waitUntil(() => coordinator.attachedEpoch === null);

    // Every lane drained: a full workload complement is admissible again, and
    // with the workload pool refilled a control op still rides the reserved
    // lane.
    const refilled = await saturateWorkloadCapacity(17);
    expect(refilled.delegateStartCount()).toBe(3);
    expect((await exchange({ ...common("msg-reclaimed-ping"), op: "ping" })).ok).toBe(true);
    for (const socket of refilled.sockets) socket.destroy();
  });

  it("flushes shutdown acceptance and then closes the listener and control lease", async () => {
    const control = await connect();
    const attached = readResponse(control);
    control.write(encodeWorkflowSupervisorRequestLine({
      ...common("msg-shutdown-control"),
      op: "attach",
      epoch: 99,
    }));
    await attached;

    const response = await exchange({
      ...common("msg-shutdown"),
      op: "shutdown",
      epoch: 99,
      reason: "backend-shutdown",
    });
    expect(response).toEqual(expect.objectContaining({
      ok: true,
      op: "shutdown",
      result: { accepted: true },
    }));
    await server.closed;
    expect(coordinator.shutdownEpochs).toEqual([99]);
    await waitUntil(() => coordinator.detached.includes(99));
    if (process.platform !== "win32") expect(fs.existsSync(socketPath)).toBe(false);
  });
});
