import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  ExtensionAPI,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";
import {
  getAgentDir,
  ProjectTrustStore,
} from "@earendil-works/pi-coding-agent";
import { SUBAGENT_DELEGATION_RESPONSE_EVENT } from "pi-subagents/delegation";
import { PROJECTS_ROOT } from "../config.ts";
import type { ProjectPaths } from "../projects.ts";
import {
  createDagFusionDelegationHost,
  type DagFusionDelegationHost,
  type DagFusionDelegationHostOptions,
} from "../../pi-packages/dag-fusion-drive/index.ts";

export interface DagFusionCompactionEvent {
  ownerRunId: string;
  nodeId: string;
  childRunId: string;
}

export type DagFusionCompactionEventSink = (
  event: DagFusionCompactionEvent,
) => void | Promise<void>;

export interface DagFusionCompactionEventQueueOptions {
  queueRoot?: string;
  retryBaseMs?: number;
  retryMaxMs?: number;
  onError?(error: unknown): void;
}

interface QueuedCompactionEvent {
  version: 1;
  id: string;
  event: DagFusionCompactionEvent;
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
}

const MAX_QUEUE_RECORD_BYTES = 16 * 1024;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_RETRY_MAX_MS = 30_000;

function queueEventId(event: DagFusionCompactionEvent): string {
  return createHash("sha256")
    .update(event.ownerRunId)
    .update("\0")
    .update(event.nodeId)
    .update("\0")
    .update(event.childRunId)
    .digest("hex");
}

function boundedQueueDelay(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) >= 1 && (value ?? 0) <= 60_000
    ? value!
    : fallback;
}

function ensureQueueDirectory(queueRoot: string): string {
  const directory = path.resolve(queueRoot);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stats = fs.lstatSync(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("Compaction event queue must be a real directory.");
  }
  return fs.realpathSync(directory);
}

function fsyncDirectory(directory: string): void {
  try {
    const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    // Some supported Windows filesystems cannot fsync directories.
  }
}

function atomicWriteQueueRecord(directory: string, record: QueuedCompactionEvent): void {
  const target = path.join(directory, `${record.id}.json`);
  const temporary = path.join(directory, `.${record.id}.${process.pid}.${randomUUID()}.tmp`);
  const serialized = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_QUEUE_RECORD_BYTES) {
    throw new Error("Compaction event queue record exceeds its size bound.");
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, serialized, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, target);
    fsyncDirectory(directory);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

function isQueuedCompactionEvent(value: unknown, expectedId: string): value is QueuedCompactionEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const event = record.event as Record<string, unknown> | undefined;
  return record.version === 1 && record.id === expectedId &&
    Number.isSafeInteger(record.createdAt) && (record.createdAt as number) >= 0 &&
    Number.isSafeInteger(record.attempts) && (record.attempts as number) >= 0 &&
    Number.isSafeInteger(record.nextAttemptAt) && (record.nextAttemptAt as number) >= 0 &&
    (record.lastError === undefined || typeof record.lastError === "string") &&
    !!event && typeof event.ownerRunId === "string" &&
    typeof event.nodeId === "string" && typeof event.childRunId === "string" &&
    queueEventId(event as unknown as DagFusionCompactionEvent) === expectedId;
}

function readQueueRecord(file: string): QueuedCompactionEvent {
  const descriptor = fs.openSync(
    file,
    fs.constants.O_RDONLY |
      ((fs.constants as Record<string, number | undefined>).O_NOFOLLOW ?? 0),
  );
  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile() || stats.nlink !== 1 || stats.size > MAX_QUEUE_RECORD_BYTES) {
      throw new Error("Compaction event queue record is unsafe or oversized.");
    }
    const serialized = fs.readFileSync(descriptor, "utf8");
    const expectedId = path.basename(file, ".json");
    const parsed: unknown = JSON.parse(serialized);
    if (!/^[a-f0-9]{64}$/.test(expectedId) || !isQueuedCompactionEvent(parsed, expectedId)) {
      throw new Error("Compaction event queue record is malformed.");
    }
    return parsed;
  } finally {
    fs.closeSync(descriptor);
  }
}

class DurableCompactionEventQueue {
  readonly #directory: string;
  readonly #retryBaseMs: number;
  readonly #retryMaxMs: number;
  readonly #onError: (error: unknown) => void;
  #draining: Promise<void> | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  constructor(
    private readonly sink: DagFusionCompactionEventSink,
    options: DagFusionCompactionEventQueueOptions,
  ) {
    this.#directory = ensureQueueDirectory(
      options.queueRoot ?? path.join(PROJECTS_ROOT, ".context-engineering", "compaction-events"),
    );
    this.#retryBaseMs = boundedQueueDelay(options.retryBaseMs, DEFAULT_RETRY_BASE_MS);
    this.#retryMaxMs = boundedQueueDelay(options.retryMaxMs, DEFAULT_RETRY_MAX_MS);
    this.#onError = options.onError ?? (() => {});
    void this.drain(true);
  }

  enqueue(event: DagFusionCompactionEvent): void {
    if (this.#closed) throw new Error("Compaction event queue is closed.");
    const id = queueEventId(event);
    const file = path.join(this.#directory, `${id}.json`);
    if (!fs.existsSync(file)) {
      try {
        atomicWriteQueueRecord(this.#directory, {
          version: 1,
          id,
          event: structuredClone(event),
          createdAt: Date.now(),
          attempts: 0,
          nextAttemptAt: 0,
        });
      } catch (error) {
        this.#onError(error);
        throw error;
      }
    }
    void this.drain();
  }

  drain(ignoreBackoff = false): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#draining) return this.#draining;
    const draining = this.#drainOnce(ignoreBackoff)
      .catch((error) => this.#onError(error))
      .finally(() => {
        if (this.#draining === draining) this.#draining = undefined;
        this.#scheduleNextDrain();
      });
    this.#draining = draining;
    return draining;
  }

  close(): void {
    this.#closed = true;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
  }

  async #drainOnce(ignoreBackoff: boolean): Promise<void> {
    const files = fs.readdirSync(this.#directory)
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .sort();
    for (const name of files) {
      if (this.#closed) return;
      const file = path.join(this.#directory, name);
      let record: QueuedCompactionEvent;
      try {
        record = readQueueRecord(file);
      } catch (error) {
        this.#onError(error);
        continue;
      }
      if (!ignoreBackoff && record.nextAttemptAt > Date.now()) continue;
      try {
        await this.sink(structuredClone(record.event));
        fs.unlinkSync(file);
        fsyncDirectory(this.#directory);
      } catch (error) {
        const attempts = record.attempts + 1;
        const delay = Math.min(
          this.#retryBaseMs * 2 ** Math.min(attempts - 1, 16),
          this.#retryMaxMs,
        );
        atomicWriteQueueRecord(this.#directory, {
          ...record,
          attempts,
          nextAttemptAt: Date.now() + delay,
          lastError: error instanceof Error ? error.message.slice(0, 2_048) : "Sink failed.",
        });
        this.#onError(error);
      }
    }
  }

  #scheduleNextDrain(): void {
    if (this.#closed) return;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    const nextAttempt = fs.readdirSync(this.#directory)
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .flatMap((name) => {
        try {
          return [readQueueRecord(path.join(this.#directory, name)).nextAttemptAt];
        } catch (error) {
          this.#onError(error);
          return [];
        }
      })
      .sort((left, right) => left - right)[0];
    if (nextAttempt === undefined) return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      void this.drain();
    }, Math.max(0, nextAttempt - Date.now()));
    this.#retryTimer.unref();
  }
}

const compactionEventQueues = new Set<DurableCompactionEventQueue>();

/** Install the process-level durable-compaction consumer used by server bootstrap. */
export function installDagFusionCompactionEventSink(
  sink: DagFusionCompactionEventSink,
  options: DagFusionCompactionEventQueueOptions = {},
): () => void {
  const queue = new DurableCompactionEventQueue(sink, options);
  compactionEventQueues.add(queue);
  return () => {
    compactionEventQueues.delete(queue);
    queue.close();
  };
}

function terminalCompactionEvent(value: unknown): DagFusionCompactionEvent | undefined {
  const response = value as Record<string, unknown> | undefined;
  if (
    !response || typeof response !== "object" ||
    typeof response.ownerRunId !== "string" ||
    !/^wrun_[a-f0-9]{32}$/.test(response.ownerRunId) ||
    typeof response.nodeId !== "string" || !response.nodeId ||
    Buffer.byteLength(response.nodeId, "utf8") > 1_024 ||
    typeof response.runId !== "string" || !response.runId ||
    Buffer.byteLength(response.runId, "utf8") > 1_024
  ) return undefined;
  return {
    ownerRunId: response.ownerRunId,
    nodeId: response.nodeId,
    childRunId: response.runId,
  };
}

function emitCompactionEvent(value: unknown): void {
  const event = terminalCompactionEvent(value);
  if (!event) return;
  // enqueue() fsyncs the record before scheduling delivery, so a provider or
  // process failure cannot turn this terminal notification into silent loss.
  for (const queue of compactionEventQueues) queue.enqueue(event);
}

/** Vendored package root; this becomes an external Pi package at release. */
export function dagFusionPackageDir(): string {
  return path.resolve(import.meta.dirname, "..", "..", "pi-packages", "dag-fusion-drive");
}

/** Canonical committed skill used by the dedicated Workflow Rescue session. */
export function scientificDagStudioSkillPath(): string {
  return path.resolve(
    import.meta.dirname,
    "..",
    "..",
    "seed",
    "skills",
    "scientific-dag-studio",
    "SKILL.md",
  );
}

/** Direct extension entry for a dedicated loader that does not use settings. */
export function dagFusionExtensionPath(): string {
  return path.join(dagFusionPackageDir(), "index.ts");
}

export interface DagFusionWorkflowSessionBridge {
  /** Add this hidden factory to the dedicated workflow session's resource loader. */
  extension: InlineExtension;
  /** Available after `DefaultResourceLoader.reload()` has invoked the factory. */
  getHost(): DagFusionDelegationHost;
  dispose(): Promise<void>;
}

/**
 * Bind a trusted host client to the exact `pi.events` bus owned by a dedicated
 * Kady workflow session. This closure is intentionally separate from ordinary
 * chat sessions: disposing/reloading a chat must not orphan DAG-owned leaves.
 */
export function createDagFusionWorkflowSessionBridge(
  options: Omit<DagFusionDelegationHostOptions, "events"> = {},
): DagFusionWorkflowSessionBridge {
  let host: DagFusionDelegationHost | undefined;
  let unsubscribeCompaction: (() => void) | undefined;
  let disposed = false;

  const extension: InlineExtension = {
    name: "dag-fusion-drive-kady-host",
    hidden: true,
    factory: async (pi: ExtensionAPI) => {
      if (disposed) {
        throw new Error("Cannot bind a disposed dag-fusion-drive session bridge.");
      }
      await host?.dispose();
      unsubscribeCompaction?.();
      unsubscribeCompaction = undefined;
      const boundHost = createDagFusionDelegationHost({
        ...options,
        events: pi.events,
      });
      host = boundHost;
      const registeredCompactionListener = pi.events.on(
        SUBAGENT_DELEGATION_RESPONSE_EVENT,
        emitCompactionEvent,
      );
      const unsubscribeBoundCompaction = typeof registeredCompactionListener === "function"
        ? registeredCompactionListener
        : undefined;
      unsubscribeCompaction = unsubscribeBoundCompaction;
      pi.on("session_shutdown", async () => {
        await boundHost.dispose();
        unsubscribeBoundCompaction?.();
        if (host === boundHost) {
          host = undefined;
          if (unsubscribeCompaction === unsubscribeBoundCompaction) {
            unsubscribeCompaction = undefined;
          }
        }
      });
    },
  };

  return {
    extension,
    getHost(): DagFusionDelegationHost {
      if (disposed) {
        throw new Error("The dag-fusion-drive session bridge is disposed.");
      }
      if (!host) {
        throw new Error(
          "The dag-fusion-drive host is unavailable until its dedicated resource loader has reloaded.",
        );
      }
      return host;
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      const activeHost = host;
      host = undefined;
      await activeHost?.dispose();
      unsubscribeCompaction?.();
      unsubscribeCompaction = undefined;
    },
  };
}

function isDagFusionSource(entry: unknown): entry is string {
  return (
    typeof entry === "string" &&
    /[/\\]dag-fusion-drive$/.test(entry.replace(/[/\\]+$/, ""))
  );
}

function isSettingsRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Fail before a workflow can dispatch provider work unless child Pi will load
 * the exact package that writes its mandatory compaction attestation.
 */
export function assertDagFusionPackageSeeded(
  paths: ProjectPaths,
  agentDir: string = getAgentDir(),
): void {
  const settingsPath = path.join(paths.sandbox, ".pi", "settings.json");
  let settings: unknown;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch (error) {
    throw new Error(
      "DAG workflow child settings are missing or malformed; dag-fusion-drive cannot be verified.",
      { cause: error },
    );
  }
  if (
    !isSettingsRecord(settings) ||
    !Array.isArray(settings.packages) ||
    !settings.packages.includes(dagFusionPackageDir())
  ) {
    throw new Error(
      "DAG workflow child settings do not contain the canonical dag-fusion-drive package.",
    );
  }
  if (new ProjectTrustStore(agentDir).get(paths.sandbox) !== true) {
    throw new Error(
      "DAG workflow child project resources are not trusted, so compaction auditing cannot load.",
    );
  }
}

/**
 * Make the package's skills available to the lead Kady session and child Pi
 * agents. Malformed user settings are left untouched rather than overwritten.
 */
export function seedDagFusionPackage(paths: ProjectPaths): boolean {
  const piDir = path.join(paths.sandbox, ".pi");
  const settingsPath = path.join(piDir, "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    if (!isSettingsRecord(parsed)) return false;
    settings = parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }

  const packageDir = dagFusionPackageDir();
  const packages = Array.isArray(settings.packages) ? [...settings.packages] : [];
  const kept = packages.filter(
    (entry) => !isDagFusionSource(entry) || entry === packageDir,
  );
  if (kept.includes(packageDir) && kept.length === packages.length) return false;
  if (!kept.includes(packageDir)) kept.push(packageDir);
  settings.packages = kept;
  fs.mkdirSync(piDir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  return true;
}
