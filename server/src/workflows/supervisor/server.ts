import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import type {
  WorkflowSupervisorCoordinator,
} from "./coordinator.ts";
import {
  MAX_WORKFLOW_SUPERVISOR_FRAME_BYTES,
  WORKFLOW_SUPERVISOR_PROTOCOL_VERSION,
  WorkflowSupervisorProtocolError,
  encodeWorkflowSupervisorResponseLine,
  parseWorkflowSupervisorRequestLine,
  workflowSupervisorErrorResponse,
  type WorkflowSupervisorErrorCode,
  type WorkflowSupervisorRequest,
  type WorkflowSupervisorResponse,
} from "./protocol.ts";

const DEFAULT_MAXIMUM_REMEMBERED_OPERATION_IDS = 100_000;
const DEFAULT_MAXIMUM_REMEMBERED_CONTROL_IDS = 4_096;
const DEFAULT_MAXIMUM_CONNECTIONS = 64;
const DEFAULT_MAXIMUM_BUFFERED_BYTES = 16 * 1024 * 1024;
const DEFAULT_FRAME_TIMEOUT_MS = 15_000;

export interface WorkflowSupervisorCoordinatorPort {
  attach(epoch: number): Promise<void>;
  detach(epoch: number): void;
  cancelMessage(epoch: number, messageId: string): boolean;
  delegate(
    input: Parameters<WorkflowSupervisorCoordinator["delegate"]>[0],
  ): ReturnType<WorkflowSupervisorCoordinator["delegate"]>;
  hostedFusion(
    input: Parameters<WorkflowSupervisorCoordinator["hostedFusion"]>[0],
  ): ReturnType<WorkflowSupervisorCoordinator["hostedFusion"]>;
  reloadCredentials(
    epoch: number,
    keys: Parameters<WorkflowSupervisorCoordinator["reloadCredentials"]>[1],
  ): ReturnType<WorkflowSupervisorCoordinator["reloadCredentials"]>;
  quiesceProject(
    epoch: number,
    projectId: string,
  ): ReturnType<WorkflowSupervisorCoordinator["quiesceProject"]>;
  snapshot(
    projectId?: string,
  ): ReturnType<WorkflowSupervisorCoordinator["snapshot"]>;
  shutdown(epoch: number): ReturnType<WorkflowSupervisorCoordinator["shutdown"]>;
}

export interface WorkflowSupervisorSocketServerOptions {
  socketPath: string;
  token: string;
  coordinator: WorkflowSupervisorCoordinatorPort;
  /** Non-evicting capacity for provider-executing delegate/fusion identities. */
  maximumRememberedMessageIds?: number;
  /** Bounded replay window for idempotent lifecycle/control messages. */
  maximumRememberedControlMessageIds?: number;
  maximumConnections?: number;
  maximumBufferedBytes?: number;
  frameTimeoutMs?: number;
}

export interface WorkflowSupervisorSocketServer {
  /** Resolves only after the socket is bound and has its private permissions. */
  listen(): Promise<void>;
  /** Stops accepting clients, cancels disconnected work, and closes all sockets. */
  close(): Promise<void>;
  /** Resolves after the underlying listening socket has closed. */
  readonly closed: Promise<void>;
}

interface ActiveOperation {
  epoch: number;
  messageId: string;
  pending: boolean;
}

function isProviderOperation(request: WorkflowSupervisorRequest): boolean {
  return request.op === "delegate" || request.op === "hosted-fusion";
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function unhandledProtocolOperation(request: never): never {
  void request;
  throw new Error("Workflow supervisor protocol dispatch is incomplete.");
}

function authenticatedToken(actual: string, expected: string): boolean {
  // Hash both inputs to a fixed width before comparing. This avoids a
  // length-dependent early return and keeps the bearer-token comparison on
  // Node's constant-time primitive.
  const actualDigest = crypto.createHash("sha256").update(actual).digest();
  const expectedDigest = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(actualDigest, expectedDigest);
}

function mappedCoordinatorError(error: unknown): {
  code: WorkflowSupervisorErrorCode;
  settlement?: Parameters<typeof workflowSupervisorErrorResponse>[2];
} {
  if (error !== null && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (
      typeof code === "string" &&
      [
        "NOT_ATTACHED",
        "STALE_EPOCH",
        "SUPERVISOR_BUSY",
        "PROJECT_QUIESCING",
        "SHUTTING_DOWN",
        "OPERATION_FAILED",
      ].includes(code)
    ) {
      const candidateSettlement = "settlement" in error
        ? (error as { settlement?: Parameters<typeof workflowSupervisorErrorResponse>[2] }).settlement
        : undefined;
      let settlement: Parameters<typeof workflowSupervisorErrorResponse>[2];
      if (candidateSettlement !== undefined) {
        try {
          // Reuse the protocol's strict settlement validator before reflecting
          // accounting data from an error object onto the wire.
          workflowSupervisorErrorResponse(
            "settlement-validation",
            code as WorkflowSupervisorErrorCode,
            candidateSettlement,
          );
          settlement = candidateSettlement;
        } catch {
          settlement = undefined;
        }
      }
      return {
        code: code as WorkflowSupervisorErrorCode,
        ...(settlement === undefined ? {} : { settlement }),
      };
    }
  }
  return { code: "OPERATION_FAILED" };
}

interface UnixSocketIdentity {
  dev: number;
  ino: number;
}

function unixSocketIdentity(socketPath: string): UnixSocketIdentity | undefined {
  if (process.platform === "win32") return;
  try {
    const stat = fs.lstatSync(socketPath);
    if (!stat.isSocket()) return undefined;
    return { dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function removeExactUnixSocket(
  socketPath: string,
  expected: UnixSocketIdentity | undefined,
): void {
  if (process.platform === "win32" || expected === undefined) return;
  const current = unixSocketIdentity(socketPath);
  if (!current) return;
  // Never follow or remove a replacement socket, regular file, or symlink.
  if (current.dev === expected.dev && current.ino === expected.ino) {
    fs.unlinkSync(socketPath);
  }
}

class WorkflowSupervisorSocketServerImpl implements WorkflowSupervisorSocketServer {
  private readonly socketPath: string;
  private readonly token: string;
  private readonly coordinator: WorkflowSupervisorCoordinatorPort;
  private readonly maximumRememberedOperationIds: number;
  private readonly maximumRememberedControlIds: number;
  private readonly maximumConnections: number;
  private readonly maximumBufferedBytes: number;
  private readonly frameTimeoutMs: number;
  private readonly rememberedOperationIds = new Set<string>();
  private readonly rememberedControlIds = new Set<string>();
  private readonly sockets = new Set<net.Socket>();
  private totalBufferedBytes = 0;
  private readonly server: net.Server;
  private listening = false;
  private socketIdentity: UnixSocketIdentity | undefined;
  private closePromise: Promise<void> | undefined;
  private resolveClosed!: () => void;
  readonly closed: Promise<void>;

  constructor(options: WorkflowSupervisorSocketServerOptions) {
    if (!options.socketPath.trim()) {
      throw new Error("Workflow supervisor socket path must be non-empty.");
    }
    if (!options.token.trim()) {
      throw new Error("Workflow supervisor token must be non-empty.");
    }
    const maximumRememberedOperationIds =
      options.maximumRememberedMessageIds ?? DEFAULT_MAXIMUM_REMEMBERED_OPERATION_IDS;
    if (!isPositiveSafeInteger(maximumRememberedOperationIds)) {
      throw new Error("Workflow supervisor message-id capacity must be a positive integer.");
    }
    const maximumRememberedControlIds =
      options.maximumRememberedControlMessageIds ?? DEFAULT_MAXIMUM_REMEMBERED_CONTROL_IDS;
    if (!isPositiveSafeInteger(maximumRememberedControlIds)) {
      throw new Error("Workflow supervisor control message-id capacity must be a positive integer.");
    }
    const maximumConnections = options.maximumConnections ?? DEFAULT_MAXIMUM_CONNECTIONS;
    if (!isPositiveSafeInteger(maximumConnections)) {
      throw new Error("Workflow supervisor connection capacity must be a positive integer.");
    }
    const maximumBufferedBytes = options.maximumBufferedBytes ?? DEFAULT_MAXIMUM_BUFFERED_BYTES;
    if (!isPositiveSafeInteger(maximumBufferedBytes)) {
      throw new Error("Workflow supervisor buffered-byte capacity must be a positive integer.");
    }
    const frameTimeoutMs = options.frameTimeoutMs ?? DEFAULT_FRAME_TIMEOUT_MS;
    if (!isPositiveSafeInteger(frameTimeoutMs)) {
      throw new Error("Workflow supervisor frame timeout must be a positive integer.");
    }

    this.socketPath = options.socketPath;
    this.token = options.token;
    this.coordinator = options.coordinator;
    this.maximumRememberedOperationIds = maximumRememberedOperationIds;
    this.maximumRememberedControlIds = maximumRememberedControlIds;
    this.maximumConnections = maximumConnections;
    this.maximumBufferedBytes = maximumBufferedBytes;
    this.frameTimeoutMs = frameTimeoutMs;
    this.closed = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
    this.server = net.createServer((socket) => this.accept(socket));
    this.server.once("close", () => {
      this.listening = false;
      try {
        removeExactUnixSocket(this.socketPath, this.socketIdentity);
      } finally {
        this.socketIdentity = undefined;
        this.resolveClosed();
      }
    });
  }

  async listen(): Promise<void> {
    if (this.listening) return;
    if (this.closePromise) {
      throw new Error("Workflow supervisor socket server is already closing.");
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        this.listening = true;
        this.socketIdentity = unixSocketIdentity(this.socketPath);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.socketPath);
    });
    if (process.platform !== "win32") fs.chmodSync(this.socketPath, 0o600);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = new Promise<void>((resolve, reject) => {
      if (!this.listening) {
        try {
          removeExactUnixSocket(this.socketPath, this.socketIdentity);
          this.socketIdentity = undefined;
          this.resolveClosed();
          resolve();
        } catch (error) {
          reject(error);
        }
        return;
      }

      this.server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
      for (const socket of this.sockets) socket.destroy();
    });
    return this.closePromise;
  }

  private accept(socket: net.Socket): void {
    if (this.sockets.size >= this.maximumConnections) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.setNoDelay(true);

    let receivedBytes = 0;
    let accountedBufferedBytes = 0;
    let chunks: Buffer[] = [];
    let receivedFrame = false;
    let responded = false;
    let connectionClosed = false;
    let attachedEpoch: number | undefined;
    let activeOperation: ActiveOperation | undefined;

    const releaseBufferedBytes = () => {
      if (accountedBufferedBytes === 0) return;
      this.totalBufferedBytes -= accountedBufferedBytes;
      accountedBufferedBytes = 0;
      if (this.totalBufferedBytes < 0) this.totalBufferedBytes = 0;
    };

    const cancelActiveOperation = () => {
      if (!activeOperation?.pending) return;
      activeOperation.pending = false;
      try {
        this.coordinator.cancelMessage(
          activeOperation.epoch,
          activeOperation.messageId,
        );
      } catch {
        // Socket teardown must never surface as an uncaught process error. The
        // coordinator retains/quarantines an attempt whose cancellation cannot
        // prove terminal ownership.
      }
    };

    const detach = () => {
      if (attachedEpoch === undefined) return;
      const epoch = attachedEpoch;
      attachedEpoch = undefined;
      try {
        this.coordinator.detach(epoch);
      } catch {
        // detach() is synchronous and idempotent by contract. A defensive
        // catch keeps malformed client teardown from killing the supervisor.
      }
    };

    const sendResponse = (
      response: WorkflowSupervisorResponse,
      keepOpen = false,
      afterFlush?: () => void,
    ): boolean => {
      if (responded || connectionClosed || socket.destroyed) return false;
      const encoded = encodeWorkflowSupervisorResponseLine(response);
      responded = true;
      const flushed = () => {
        afterFlush?.();
      };
      if (keepOpen) socket.write(encoded, flushed);
      else socket.end(encoded, flushed);
      return true;
    };

    const sendError = (
      messageId: unknown,
      code: WorkflowSupervisorErrorCode,
      settlement?: Parameters<typeof workflowSupervisorErrorResponse>[2],
    ) => {
      sendResponse(workflowSupervisorErrorResponse(messageId, code, settlement));
    };

    const frameTimer = setTimeout(() => {
      receivedFrame = true;
      chunks = [];
      releaseBufferedBytes();
      sendError(null, "INVALID_MESSAGE");
    }, this.frameTimeoutMs);
    frameTimer.unref();

    socket.on("close", () => {
      connectionClosed = true;
      clearTimeout(frameTimer);
      this.sockets.delete(socket);
      releaseBufferedBytes();
      cancelActiveOperation();
      detach();
    });
    socket.on("error", () => {
      // The close handler owns cancellation and detachment.
    });

    const handleRequest = async (request: WorkflowSupervisorRequest) => {
      if (!authenticatedToken(request.token, this.token)) {
        sendError(request.messageId, "UNAUTHORIZED");
        return;
      }
      const rememberedIds = isProviderOperation(request)
        ? this.rememberedOperationIds
        : this.rememberedControlIds;
      if (rememberedIds.has(request.messageId)) {
        sendError(request.messageId, "DUPLICATE_MESSAGE");
        return;
      }
      if (isProviderOperation(request)) {
        if (rememberedIds.size >= this.maximumRememberedOperationIds) {
          sendError(request.messageId, "SUPERVISOR_BUSY");
          return;
        }
      } else if (rememberedIds.size >= this.maximumRememberedControlIds) {
        // Control operations are pure or idempotent and epoch-gated. Keep a
        // bounded replay window for them so provider-operation saturation can
        // never prevent inspection, quiescence, or exact shutdown/replacement.
        const oldest = rememberedIds.values().next().value as string | undefined;
        if (oldest !== undefined) rememberedIds.delete(oldest);
      }
      rememberedIds.add(request.messageId);

      try {
        switch (request.op) {
          case "ping": {
            const snapshot = this.coordinator.snapshot();
            sendResponse({
              version: WORKFLOW_SUPERVISOR_PROTOCOL_VERSION,
              messageId: request.messageId,
              ok: true,
              op: "ping",
              result: {
                pid: snapshot.pid,
                state: snapshot.state,
                attachedEpoch: snapshot.attachedEpoch,
              },
            });
            return;
          }
          case "attach": {
            await this.coordinator.attach(request.epoch);
            attachedEpoch = request.epoch;
            if (connectionClosed || socket.destroyed) {
              detach();
              return;
            }
            sendResponse({
              version: WORKFLOW_SUPERVISOR_PROTOCOL_VERSION,
              messageId: request.messageId,
              ok: true,
              op: "attach",
              result: { attached: true, epoch: request.epoch },
            }, true);
            return;
          }
          case "delegate": {
            activeOperation = {
              epoch: request.epoch,
              messageId: request.messageId,
              pending: true,
            };
            const result = await this.coordinator.delegate({
              epoch: request.epoch,
              messageId: request.messageId,
              projectId: request.projectId,
              request: request.request,
              limits: request.limits,
              budget: request.budget,
            });
            activeOperation.pending = false;
            sendResponse({
              version: WORKFLOW_SUPERVISOR_PROTOCOL_VERSION,
              messageId: request.messageId,
              ok: true,
              op: "delegate",
              result,
            });
            return;
          }
          case "hosted-fusion": {
            activeOperation = {
              epoch: request.epoch,
              messageId: request.messageId,
              pending: true,
            };
            const result = await this.coordinator.hostedFusion({
              epoch: request.epoch,
              messageId: request.messageId,
              projectId: request.projectId,
              request: request.request,
              budget: request.budget,
            });
            activeOperation.pending = false;
            sendResponse({
              version: WORKFLOW_SUPERVISOR_PROTOCOL_VERSION,
              messageId: request.messageId,
              ok: true,
              op: "hosted-fusion",
              result,
            });
            return;
          }
          case "reload-credentials": {
            await this.coordinator.reloadCredentials(request.epoch, request.keys);
            sendResponse({
              version: WORKFLOW_SUPERVISOR_PROTOCOL_VERSION,
              messageId: request.messageId,
              ok: true,
              op: "reload-credentials",
              result: {
                reloaded: true,
                keys: [...request.keys],
              },
            });
            return;
          }
          case "quiesce-project": {
            const cancelledAttempts = await this.coordinator.quiesceProject(
              request.epoch,
              request.projectId,
            );
            sendResponse({
              version: WORKFLOW_SUPERVISOR_PROTOCOL_VERSION,
              messageId: request.messageId,
              ok: true,
              op: "quiesce-project",
              result: {
                projectId: request.projectId,
                quiescent: true,
                cancelledAttempts,
              },
            });
            return;
          }
          case "snapshot": {
            sendResponse({
              version: WORKFLOW_SUPERVISOR_PROTOCOL_VERSION,
              messageId: request.messageId,
              ok: true,
              op: "snapshot",
              result: { snapshot: this.coordinator.snapshot(request.projectId) },
            });
            return;
          }
          case "shutdown": {
            await this.coordinator.shutdown(request.epoch);
            sendResponse({
              version: WORKFLOW_SUPERVISOR_PROTOCOL_VERSION,
              messageId: request.messageId,
              ok: true,
              op: "shutdown",
              result: { accepted: true },
            }, false, () => {
              void this.close().catch(() => undefined);
            });
            return;
          }
          default:
            return unhandledProtocolOperation(request);
        }
      } catch (error) {
        if (activeOperation) activeOperation.pending = false;
        const mapped = mappedCoordinatorError(error);
        sendError(request.messageId, mapped.code, mapped.settlement);
      }
    };

    socket.on("data", (chunk: Buffer) => {
      if (receivedFrame) {
        cancelActiveOperation();
        if (!responded) sendError(null, "INVALID_MESSAGE");
        else socket.destroy();
        return;
      }

      const newlineAt = chunk.indexOf(0x0a);
      if (newlineAt >= 0 && newlineAt !== chunk.byteLength - 1) {
        receivedFrame = true;
        clearTimeout(frameTimer);
        releaseBufferedBytes();
        sendError(null, "INVALID_MESSAGE");
        return;
      }

      if (this.totalBufferedBytes + chunk.byteLength > this.maximumBufferedBytes) {
        receivedFrame = true;
        clearTimeout(frameTimer);
        chunks = [];
        releaseBufferedBytes();
        sendError(null, "SUPERVISOR_BUSY");
        return;
      }
      this.totalBufferedBytes += chunk.byteLength;
      accountedBufferedBytes += chunk.byteLength;
      receivedBytes += chunk.byteLength;
      if (receivedBytes > MAX_WORKFLOW_SUPERVISOR_FRAME_BYTES) {
        receivedFrame = true;
        clearTimeout(frameTimer);
        chunks = [];
        releaseBufferedBytes();
        sendError(null, "FRAME_TOO_LARGE");
        return;
      }
      chunks.push(chunk);
      if (newlineAt < 0) return;

      receivedFrame = true;
      clearTimeout(frameTimer);
      const frame = Buffer.concat(chunks, receivedBytes);
      chunks = [];
      releaseBufferedBytes();
      let request: WorkflowSupervisorRequest;
      try {
        request = parseWorkflowSupervisorRequestLine(frame);
      } catch (error) {
        sendError(
          null,
          error instanceof WorkflowSupervisorProtocolError
            ? error.code
            : "INVALID_MESSAGE",
        );
        return;
      }
      void handleRequest(request);
    });
  }
}

export function createWorkflowSupervisorSocketServer(
  options: WorkflowSupervisorSocketServerOptions,
): WorkflowSupervisorSocketServer {
  return new WorkflowSupervisorSocketServerImpl(options);
}
