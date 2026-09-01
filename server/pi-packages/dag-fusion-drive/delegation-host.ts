import {
  SUBAGENT_DELEGATION_CANCEL_EVENT,
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  SUBAGENT_DELEGATION_STARTED_EVENT,
  SUBAGENT_DELEGATION_UPDATE_EVENT,
  SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION,
  type SubagentDelegationV2Cancel,
  type SubagentDelegationV2Request,
  type SubagentDelegationV2Response,
  type SubagentDelegationV2Started,
  type SubagentDelegationV2TerminalResponse,
  type SubagentDelegationV2Thinking,
  type SubagentDelegationV2Update,
  type SubagentDelegationV2Usage,
} from "pi-subagents/delegation";

/** Minimal shared surface implemented by Pi's `pi.events` bus. */
export interface DagFusionEventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): (() => void) | void;
}

export interface DagFusionDelegationIdentity {
  requestId: string;
  ownerRunId: string;
  nodeId: string;
}

export type OwnedDelegationV2Request = SubagentDelegationV2Request & {
  model: string;
  thinking: SubagentDelegationV2Thinking;
  timeoutMs: number;
  turnBudget: NonNullable<SubagentDelegationV2Request["turnBudget"]>;
  toolBudget: NonNullable<SubagentDelegationV2Request["toolBudget"]> & {
    block: "*";
  };
};

export interface DagFusionDelegationUsageLimits {
  /** Pi progress and Kady's node ledger both count input + output tokens. */
  maxTokens: number;
  maxCostUsd: number;
}

export interface DagFusionDelegationProgress {
  started: boolean;
  model?: string;
  tokens: number;
  toolCalls: number;
  durationMs: number;
}

export type DagFusionDelegationSettlementReason =
  | "terminal-response"
  | "caller-cancelled"
  | "caller-aborted"
  | "host-timeout"
  | "host-disposed"
  | "protocol-error";

export interface DagFusionDelegationUsageSettlement {
  identity: DagFusionDelegationIdentity;
  reason: DagFusionDelegationSettlementReason;
  responseStatus?: SubagentDelegationV2Response["status"];
  usage?: SubagentDelegationV2Usage;
  progress: DagFusionDelegationProgress;
}

export interface DelegateDagFusionNodeOptions {
  limits: DagFusionDelegationUsageLimits;
  /**
   * Called exactly once before the returned promise settles. Kady uses this to
   * reconcile a pre-reserved node budget even when no terminal usage arrives.
   */
  reconcileUsage(
    settlement: DagFusionDelegationUsageSettlement,
  ): void | Promise<void>;
  signal?: AbortSignal;
  onStarted?(event: SubagentDelegationV2Started): void;
  onUpdate?(event: SubagentDelegationV2Update): void;
}

export interface DagFusionDelegationReceipt {
  identity: DagFusionDelegationIdentity;
  requested: {
    agent: string;
    model: string;
    thinking: SubagentDelegationV2Thinking;
  };
  resolved?: {
    agent: string;
    model: string;
    thinking: string;
    launchContractDigest?: string;
  };
  response: SubagentDelegationV2Response;
  usage?: SubagentDelegationV2Usage & { totalTokens: number };
  progress: DagFusionDelegationProgress;
}

export type DagFusionDelegationErrorCode =
  | "DAG_FUSION_ABORTED"
  | "DAG_FUSION_CALLBACK_FAILED"
  | "DAG_FUSION_CANCELLATION_UNCONFIRMED"
  | "DAG_FUSION_CANCELLED"
  | "DAG_FUSION_CAPACITY_EXHAUSTED"
  | "DAG_FUSION_DISPOSED"
  | "DAG_FUSION_DUPLICATE_IDENTITY"
  | "DAG_FUSION_DUPLICATE_NODE"
  | "DAG_FUSION_INVALID_REQUEST"
  | "DAG_FUSION_PROTOCOL_MISMATCH"
  | "DAG_FUSION_QUARANTINED"
  | "DAG_FUSION_RECONCILIATION_FAILED"
  | "DAG_FUSION_TIMEOUT"
  | "DAG_FUSION_USAGE_LIMIT_EXCEEDED"
  | "DAG_FUSION_USAGE_MISMATCH";

export class DagFusionDelegationError extends Error {
  constructor(
    message: string,
    readonly code: DagFusionDelegationErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DagFusionDelegationError";
  }
}

export interface DagFusionDelegationHostOptions {
  events: DagFusionEventBus;
  /** Concurrent owned leaves. */
  maxPending?: number;
  /**
   * Non-evicting identity history. Saturation fails closed so an old response
   * can never be mistaken for a later reuse of the same ownership tuple.
   */
  maxIdentityFacts?: number;
  maxRequestTimeoutMs?: number;
  responseGraceMs?: number;
  /** Time allowed for pi-subagents to emit the exact terminal response after cancel. */
  cancellationAckTimeoutMs?: number;
  reconciliationTimeoutMs?: number;
  maxUpdateBytes?: number;
  maxResponseBytes?: number;
}

export interface DagFusionDelegationHostSnapshot {
  disposed: boolean;
  saturated: boolean;
  pending: DagFusionDelegationIdentity[];
  quarantined: DagFusionDelegationIdentity[];
  identityFacts: number;
  rejectedEvents: number;
}

interface PendingDelegationQuarantine {
  /** Fail-closed full-charge settlement, intentionally without terminal usage. */
  settlement: DagFusionDelegationUsageSettlement;
  reconciled: boolean;
  reconciliation?: Promise<void>;
  terminalAcknowledged: boolean;
}

interface PendingDelegation {
  key: string;
  nodeKey: string;
  request: OwnedDelegationV2Request;
  expectedModel: string;
  options: DelegateDagFusionNodeOptions;
  progress: DagFusionDelegationProgress;
  resolve(receipt: DagFusionDelegationReceipt): void;
  reject(error: DagFusionDelegationError): void;
  timer: ReturnType<typeof setTimeout>;
  removeAbortListener?: () => void;
  settling: boolean;
  cancellation?: {
    reason: DagFusionDelegationSettlementReason;
    error: DagFusionDelegationError;
  };
  quarantine?: PendingDelegationQuarantine;
  settlementDone: Promise<void>;
  markSettlementDone(): void;
}

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly SubagentDelegationV2Thinking[];

const TERMINAL_STATUSES = new Set<SubagentDelegationV2Response["status"]>([
  "completed",
  "failed",
  "timed_out",
  "cancelled",
  "interrupted",
  "turn_budget_exhausted",
  "tool_budget_exhausted",
  "structured_output_failed",
  "acceptance_failed",
  "invalid_request",
  "unavailable_context",
  "duplicate_node",
]);

const DEFAULT_MAX_PENDING = 32;
const HARD_MAX_PENDING = 1_024;
const DEFAULT_MAX_IDENTITY_FACTS = 8_192;
const HARD_MAX_IDENTITY_FACTS = 65_536;
const DEFAULT_MAX_REQUEST_TIMEOUT_MS = 86_400_000;
const DEFAULT_RESPONSE_GRACE_MS = 1_000;
const DEFAULT_CANCELLATION_ACK_TIMEOUT_MS = 5_000;
const DEFAULT_RECONCILIATION_TIMEOUT_MS = 5_000;
const MAX_REQUEST_BYTES = 1_200 * 1024;
const DEFAULT_MAX_UPDATE_BYTES = 256 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 1_200 * 1024;

function ownedKey(identity: DagFusionDelegationIdentity): string {
  return JSON.stringify([
    identity.requestId,
    identity.ownerRunId,
    identity.nodeId,
  ]);
}

function logicalNodeKey(identity: DagFusionDelegationIdentity): string {
  return JSON.stringify([identity.ownerRunId, identity.nodeId]);
}

function requestIdentity(
  request: Pick<
    SubagentDelegationV2Request,
    "requestId" | "ownerRunId" | "nodeId"
  >,
): DagFusionDelegationIdentity {
  return {
    requestId: request.requestId,
    ownerRunId: request.ownerRunId,
    nodeId: request.nodeId,
  };
}

function validId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 256 &&
    !/[\r\n]/.test(value)
  );
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function nonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function boundedIntegerOption(
  value: number | undefined,
  fallback: number,
  name: string,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (!positiveInteger(resolved) || resolved > maximum) {
    throw new DagFusionDelegationError(
      `${name} must be an integer from 1 through ${maximum}.`,
      "DAG_FUSION_INVALID_REQUEST",
    );
  }
  return resolved;
}

function jsonBytes(value: unknown): number | undefined {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? undefined : Buffer.byteLength(encoded, "utf8");
  } catch {
    return undefined;
  }
}

/** Mirrors pi-subagents 0.40's public V2 launch projection. */
export function expectedDelegatedModel(
  model: string,
  thinking: SubagentDelegationV2Thinking,
): string {
  const suffix = THINKING_LEVELS.find((level) => model.endsWith(`:${level}`));
  const baseModel = suffix ? model.slice(0, -(suffix.length + 1)) : model;
  return `${baseModel}:${thinking}`;
}

function validateRequest(
  request: OwnedDelegationV2Request,
  limits: DagFusionDelegationUsageLimits,
  maxRequestTimeoutMs: number,
): void {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new DagFusionDelegationError(
      "Delegation request must be an object.",
      "DAG_FUSION_INVALID_REQUEST",
    );
  }
  if (request.version !== SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION) {
    throw new DagFusionDelegationError(
      "dag-fusion-drive accepts only Pi Delegation V2 requests.",
      "DAG_FUSION_INVALID_REQUEST",
    );
  }
  if (
    !validId(request.requestId) ||
    !validId(request.ownerRunId) ||
    !validId(request.nodeId)
  ) {
    throw new DagFusionDelegationError(
      "Delegation requestId, ownerRunId, and nodeId must be non-empty bounded IDs without newlines.",
      "DAG_FUSION_INVALID_REQUEST",
    );
  }
  if (
    typeof request.agent !== "string" ||
    !request.agent.trim() ||
    typeof request.task !== "string" ||
    !request.task.trim() ||
    typeof request.cwd !== "string" ||
    !request.cwd.trim()
  ) {
    throw new DagFusionDelegationError(
      "Delegation agent, task, and cwd must be non-empty strings.",
      "DAG_FUSION_INVALID_REQUEST",
    );
  }
  if (request.context !== "fresh" && request.context !== "fork") {
    throw new DagFusionDelegationError(
      "Delegation context must be fresh or fork.",
      "DAG_FUSION_INVALID_REQUEST",
    );
  }
  if (typeof request.model !== "string" || !request.model.trim()) {
    throw new DagFusionDelegationError(
      "An owned DAG delegation requires an explicit model.",
      "DAG_FUSION_INVALID_REQUEST",
    );
  }
  const requestBytes = jsonBytes(request);
  if (requestBytes === undefined || requestBytes > MAX_REQUEST_BYTES) {
    throw new DagFusionDelegationError(
      "Delegation request must be bounded plain JSON data.",
      "DAG_FUSION_INVALID_REQUEST",
    );
  }
  if (
    Buffer.byteLength(request.agent, "utf8") > 1024 ||
    Buffer.byteLength(request.model, "utf8") > 1024 ||
    Buffer.byteLength(request.task, "utf8") > 1024 * 1024 ||
    Buffer.byteLength(request.cwd, "utf8") > 32 * 1024
  ) {
    throw new DagFusionDelegationError(
      "Delegation agent/model/task/cwd exceeds the Pi Delegation V2 wire bound.",
      "DAG_FUSION_INVALID_REQUEST",
    );
  }
  if (!THINKING_LEVELS.includes(request.thinking)) {
    throw new DagFusionDelegationError(
      "An owned DAG delegation requires an explicit supported thinking level.",
      "DAG_FUSION_INVALID_REQUEST",
    );
  }
  if (
    !positiveInteger(request.timeoutMs) ||
    request.timeoutMs > maxRequestTimeoutMs
  ) {
    throw new DagFusionDelegationError(
      `Delegation timeoutMs must be an integer no greater than ${maxRequestTimeoutMs}.`,
      "DAG_FUSION_INVALID_REQUEST",
    );
  }
  if (
    !request.turnBudget ||
    !positiveInteger(request.turnBudget.maxTurns) ||
    (request.turnBudget.graceTurns !== undefined &&
      !nonNegativeInteger(request.turnBudget.graceTurns))
  ) {
    throw new DagFusionDelegationError(
      "An owned DAG delegation requires a valid hard-enforced turn budget.",
      "DAG_FUSION_INVALID_REQUEST",
    );
  }
  if (
    !request.toolBudget ||
    !nonNegativeInteger(request.toolBudget.hard) ||
    request.toolBudget.block !== "*" ||
    (request.toolBudget.soft !== undefined &&
      (!positiveInteger(request.toolBudget.soft) ||
        request.toolBudget.soft > request.toolBudget.hard))
  ) {
    throw new DagFusionDelegationError(
      'An owned DAG delegation requires a tool budget with block: "*".',
      "DAG_FUSION_INVALID_REQUEST",
    );
  }
  if (
    !request.result ||
    (request.result.kind !== "text" && request.result.kind !== "structured")
  ) {
    throw new DagFusionDelegationError(
      "Delegation result must request text or structured output.",
      "DAG_FUSION_INVALID_REQUEST",
    );
  }
  if (
    !limits ||
    !positiveInteger(limits.maxTokens) ||
    !nonNegativeFinite(limits.maxCostUsd)
  ) {
    throw new DagFusionDelegationError(
      "Delegation usage limits require a positive integer maxTokens and a non-negative finite maxCostUsd.",
      "DAG_FUSION_INVALID_REQUEST",
    );
  }
}

function eventIdentity(data: unknown): DagFusionDelegationIdentity | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const value = data as Record<string, unknown>;
  if (
    value.version !== SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION ||
    !validId(value.requestId) ||
    !validId(value.ownerRunId) ||
    !validId(value.nodeId)
  ) {
    return undefined;
  }
  return {
    requestId: value.requestId,
    ownerRunId: value.ownerRunId,
    nodeId: value.nodeId,
  };
}

function cloneProgress(progress: DagFusionDelegationProgress): DagFusionDelegationProgress {
  return { ...progress };
}

function usageWithTotal(
  usage: SubagentDelegationV2Usage,
): SubagentDelegationV2Usage & { totalTokens: number } {
  return { ...usage, totalTokens: usage.input + usage.output };
}

/**
 * Trusted-host client for pi-subagents' public Delegation V2 event protocol.
 * It installs no model-facing tool: only the Kady workflow controller receives
 * this object and therefore owns delegation authority and budget settlement.
 */
export class DagFusionDelegationHost {
  readonly #events: DagFusionEventBus;
  readonly #maxPending: number;
  readonly #maxIdentityFacts: number;
  readonly #maxRequestTimeoutMs: number;
  readonly #responseGraceMs: number;
  readonly #cancellationAckTimeoutMs: number;
  readonly #reconciliationTimeoutMs: number;
  readonly #maxUpdateBytes: number;
  readonly #maxResponseBytes: number;
  readonly #pending = new Map<string, PendingDelegation>();
  readonly #activeNodes = new Map<string, string>();
  readonly #identityFacts = new Set<string>();
  readonly #subscriptions: Array<() => void> = [];
  #disposed = false;
  #saturated = false;
  #rejectedEvents = 0;

  constructor(options: DagFusionDelegationHostOptions) {
    this.#events = options.events;
    this.#maxPending = boundedIntegerOption(
      options.maxPending,
      DEFAULT_MAX_PENDING,
      "maxPending",
      HARD_MAX_PENDING,
    );
    this.#maxIdentityFacts = boundedIntegerOption(
      options.maxIdentityFacts,
      DEFAULT_MAX_IDENTITY_FACTS,
      "maxIdentityFacts",
      HARD_MAX_IDENTITY_FACTS,
    );
    this.#maxRequestTimeoutMs = boundedIntegerOption(
      options.maxRequestTimeoutMs,
      DEFAULT_MAX_REQUEST_TIMEOUT_MS,
      "maxRequestTimeoutMs",
      2_147_483_647,
    );
    this.#responseGraceMs = boundedIntegerOption(
      options.responseGraceMs,
      DEFAULT_RESPONSE_GRACE_MS,
      "responseGraceMs",
      60_000,
    );
    this.#cancellationAckTimeoutMs = boundedIntegerOption(
      options.cancellationAckTimeoutMs,
      DEFAULT_CANCELLATION_ACK_TIMEOUT_MS,
      "cancellationAckTimeoutMs",
      60_000,
    );
    this.#reconciliationTimeoutMs = boundedIntegerOption(
      options.reconciliationTimeoutMs,
      DEFAULT_RECONCILIATION_TIMEOUT_MS,
      "reconciliationTimeoutMs",
      60_000,
    );
    this.#maxUpdateBytes = boundedIntegerOption(
      options.maxUpdateBytes,
      DEFAULT_MAX_UPDATE_BYTES,
      "maxUpdateBytes",
      1024 * 1024,
    );
    this.#maxResponseBytes = boundedIntegerOption(
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      "maxResponseBytes",
      2 * 1024 * 1024,
    );

    this.#subscribe(SUBAGENT_DELEGATION_STARTED_EVENT, (data) => {
      this.#handleStarted(data);
    });
    this.#subscribe(SUBAGENT_DELEGATION_UPDATE_EVENT, (data) => {
      this.#handleUpdate(data);
    });
    this.#subscribe(SUBAGENT_DELEGATION_RESPONSE_EVENT, (data) => {
      void this.#handleResponse(data);
    });
  }

  snapshot(): DagFusionDelegationHostSnapshot {
    return {
      disposed: this.#disposed,
      saturated: this.#saturated,
      pending: [...this.#pending.values()].map((pending) =>
        requestIdentity(pending.request),
      ),
      quarantined: [...this.#pending.values()]
        .filter((pending) => pending.quarantine !== undefined)
        .map((pending) => requestIdentity(pending.request)),
      identityFacts: this.#identityFacts.size,
      rejectedEvents: this.#rejectedEvents,
    };
  }

  async delegate(
    request: OwnedDelegationV2Request,
    options: DelegateDagFusionNodeOptions,
  ): Promise<DagFusionDelegationReceipt> {
    if (this.#disposed) {
      throw new DagFusionDelegationError(
        "The dag-fusion-drive delegation host is disposed.",
        "DAG_FUSION_DISPOSED",
      );
    }
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new DagFusionDelegationError(
        "Delegation options must be an object.",
        "DAG_FUSION_INVALID_REQUEST",
      );
    }
    validateRequest(request, options.limits, this.#maxRequestTimeoutMs);
    if (typeof options.reconcileUsage !== "function") {
      throw new DagFusionDelegationError(
        "An owned delegation requires an explicit usage reconciler.",
        "DAG_FUSION_INVALID_REQUEST",
      );
    }
    if (options.signal?.aborted) {
      throw new DagFusionDelegationError(
        "The delegation caller was already aborted.",
        "DAG_FUSION_ABORTED",
      );
    }
    if ([...this.#pending.values()].some((pending) => pending.quarantine)) {
      throw new DagFusionDelegationError(
        "This workflow host is quarantined until its unacknowledged child emits the exact terminal Delegation V2 response.",
        "DAG_FUSION_QUARANTINED",
      );
    }

    let ownedRequest: OwnedDelegationV2Request;
    try {
      ownedRequest = structuredClone(request);
    } catch (error) {
      throw new DagFusionDelegationError(
        "Delegation request must be cloneable plain data.",
        "DAG_FUSION_INVALID_REQUEST",
        { cause: error },
      );
    }
    const stableOptions: DelegateDagFusionNodeOptions = {
      ...options,
      limits: { ...options.limits },
    };
    const identity = requestIdentity(ownedRequest);
    const key = ownedKey(identity);
    const nodeKey = logicalNodeKey(identity);
    if (this.#identityFacts.has(key)) {
      throw new DagFusionDelegationError(
        "This Delegation V2 ownership tuple has already been used by this host.",
        "DAG_FUSION_DUPLICATE_IDENTITY",
      );
    }
    if (this.#activeNodes.has(nodeKey)) {
      throw new DagFusionDelegationError(
        "This workflow run already has an active attempt for the same logical node.",
        "DAG_FUSION_DUPLICATE_NODE",
      );
    }
    if (this.#pending.size >= this.#maxPending) {
      throw new DagFusionDelegationError(
        `The delegation host already owns its maximum of ${this.#maxPending} concurrent requests.`,
        "DAG_FUSION_CAPACITY_EXHAUSTED",
      );
    }
    if (this.#saturated || this.#identityFacts.size >= this.#maxIdentityFacts) {
      this.#saturated = true;
      throw new DagFusionDelegationError(
        "The delegation host's non-evicting identity capacity is exhausted; create a fresh dedicated workflow session.",
        "DAG_FUSION_CAPACITY_EXHAUSTED",
      );
    }

    this.#identityFacts.add(key);
    if (this.#identityFacts.size >= this.#maxIdentityFacts) this.#saturated = true;

    return new Promise<DagFusionDelegationReceipt>((resolve, reject) => {
      const timeoutMs = Math.min(
        2_147_483_647,
        ownedRequest.timeoutMs + this.#responseGraceMs,
      );
      let markSettlementDone: (() => void) | undefined;
      const settlementDone = new Promise<void>((settled) => {
        markSettlementDone = settled;
      });
      const pending: PendingDelegation = {
        key,
        nodeKey,
        request: ownedRequest,
        expectedModel: expectedDelegatedModel(
          ownedRequest.model,
          ownedRequest.thinking,
        ),
        options: stableOptions,
        progress: {
          started: false,
          tokens: 0,
          toolCalls: 0,
          durationMs: 0,
        },
        resolve,
        reject,
        timer: setTimeout(() => {
          void this.#settleLocal(
            pending,
            "host-timeout",
            new DagFusionDelegationError(
              `Delegation ${ownedRequest.requestId} did not return a terminal response within ${timeoutMs} ms.`,
              "DAG_FUSION_TIMEOUT",
            ),
            true,
          );
        }, timeoutMs),
        settling: false,
        settlementDone,
        markSettlementDone: () => markSettlementDone?.(),
      };
      pending.timer.unref?.();

      if (stableOptions.signal) {
        const onAbort = () => {
          void this.#settleLocal(
            pending,
            "caller-aborted",
            new DagFusionDelegationError(
              `Delegation ${ownedRequest.requestId} was aborted by its owner.`,
              "DAG_FUSION_ABORTED",
            ),
            true,
          );
        };
        stableOptions.signal.addEventListener("abort", onAbort, { once: true });
        pending.removeAbortListener = () =>
          stableOptions.signal?.removeEventListener("abort", onAbort);
      }

      this.#pending.set(key, pending);
      this.#activeNodes.set(nodeKey, key);
      try {
        this.#events.emit(
          SUBAGENT_DELEGATION_REQUEST_EVENT,
          structuredClone(ownedRequest),
        );
      } catch (error) {
        void this.#settleLocal(
          pending,
          "protocol-error",
          new DagFusionDelegationError(
            "The Pi event bus rejected the Delegation V2 request.",
            "DAG_FUSION_PROTOCOL_MISMATCH",
            { cause: error },
          ),
          false,
        );
      }
    });
  }

  cancel(identity: DagFusionDelegationIdentity): boolean {
    const pending = this.#pending.get(ownedKey(identity));
    if (!pending || pending.settling || pending.cancellation) return false;
    void this.#settleLocal(
      pending,
      "caller-cancelled",
      new DagFusionDelegationError(
        `Delegation ${identity.requestId} was cancelled by its owner.`,
        "DAG_FUSION_CANCELLED",
      ),
      true,
    );
    return true;
  }

  cancelOwner(ownerRunId: string): number {
    if (!validId(ownerRunId)) return 0;
    const owned = [...this.#pending.values()].filter(
      (pending) => pending.request.ownerRunId === ownerRunId,
    );
    return owned.reduce(
      (cancelled, pending) =>
        cancelled + Number(this.cancel(requestIdentity(pending.request))),
      0,
    );
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const settlements = [...this.#pending.values()].map((pending) =>
      this.#settleLocal(
        pending,
        "host-disposed",
        new DagFusionDelegationError(
          "The dedicated dag-fusion-drive workflow host was disposed.",
          "DAG_FUSION_DISPOSED",
        ),
        true,
      ),
    );
    await Promise.allSettled(settlements);
    // Keep the response subscription alive while exact V2 cancellation
    // acknowledgements settle owned children. New work is already rejected by
    // #disposed, so this does not reopen admission during shutdown.
    for (const unsubscribe of this.#subscriptions.splice(0)) unsubscribe();
    this.#pending.clear();
    this.#activeNodes.clear();
    this.#identityFacts.clear();
    this.#saturated = false;
  }

  #subscribe(channel: string, handler: (data: unknown) => void): void {
    const unsubscribe = this.#events.on(channel, handler);
    if (typeof unsubscribe === "function") this.#subscriptions.push(unsubscribe);
  }

  #lookup(data: unknown): PendingDelegation | undefined {
    const identity = eventIdentity(data);
    if (!identity) {
      this.#rejectedEvents += 1;
      return undefined;
    }
    const pending = this.#pending.get(ownedKey(identity));
    if (!pending || pending.settling) {
      this.#rejectedEvents += 1;
      return undefined;
    }
    return pending;
  }

  #handleStarted(data: unknown): void {
    const pending = this.#lookup(data);
    if (!pending) return;
    if (jsonBytes(data) === undefined || jsonBytes(data)! > this.#maxUpdateBytes) {
      void this.#failProtocol(pending, "Delegation started event exceeded its bound.");
      return;
    }
    if (pending.progress.started) {
      void this.#failProtocol(pending, "Delegation emitted more than one started event.");
      return;
    }
    pending.progress.started = true;
    try {
      pending.options.onStarted?.(structuredClone(data) as SubagentDelegationV2Started);
    } catch (error) {
      void this.#settleLocal(
        pending,
        "protocol-error",
        new DagFusionDelegationError(
          "The delegation started callback failed.",
          "DAG_FUSION_CALLBACK_FAILED",
          { cause: error },
        ),
        true,
      );
    }
  }

  #handleUpdate(data: unknown): void {
    const pending = this.#lookup(data);
    if (!pending) return;
    const bytes = jsonBytes(data);
    if (bytes === undefined || bytes > this.#maxUpdateBytes) {
      void this.#failProtocol(pending, "Delegation update exceeded its bound.");
      return;
    }
    if (!pending.progress.started) {
      void this.#failProtocol(pending, "Delegation update arrived before its started event.");
      return;
    }
    const update = data as SubagentDelegationV2Update;
    if (update.model !== undefined && update.model !== pending.expectedModel) {
      void this.#failProtocol(
        pending,
        `Delegation update resolved ${update.model} instead of ${pending.expectedModel}.`,
      );
      return;
    }
    const counters = [update.tokens, update.toolCount, update.durationMs].filter(
      (value) => value !== undefined,
    );
    if (counters.some((value) => !nonNegativeInteger(value))) {
      void this.#failProtocol(pending, "Delegation update reported invalid usage counters.");
      return;
    }
    if (
      (update.tokens !== undefined && update.tokens < pending.progress.tokens) ||
      (update.toolCount !== undefined &&
        update.toolCount < pending.progress.toolCalls) ||
      (update.durationMs !== undefined &&
        update.durationMs < pending.progress.durationMs)
    ) {
      void this.#failProtocol(pending, "Delegation progress counters regressed.");
      return;
    }
    if (
      update.tokens !== undefined &&
      update.tokens > pending.options.limits.maxTokens
    ) {
      void this.#settleLocal(
        pending,
        "protocol-error",
        new DagFusionDelegationError(
          `Delegation exceeded its ${pending.options.limits.maxTokens}-token limit while running.`,
          "DAG_FUSION_USAGE_LIMIT_EXCEEDED",
        ),
        true,
      );
      return;
    }
    if (
      update.durationMs !== undefined &&
      update.durationMs > pending.request.timeoutMs + this.#responseGraceMs
    ) {
      void this.#settleLocal(
        pending,
        "protocol-error",
        new DagFusionDelegationError(
          "Delegation progress exceeded its bounded execution deadline.",
          "DAG_FUSION_USAGE_LIMIT_EXCEEDED",
        ),
        true,
      );
      return;
    }
    if (update.tokens !== undefined) pending.progress.tokens = update.tokens;
    if (update.toolCount !== undefined) {
      pending.progress.toolCalls = update.toolCount;
    }
    if (update.durationMs !== undefined) {
      pending.progress.durationMs = update.durationMs;
    }
    if (update.model !== undefined) pending.progress.model = update.model;
    try {
      pending.options.onUpdate?.(structuredClone(update));
    } catch (error) {
      void this.#settleLocal(
        pending,
        "protocol-error",
        new DagFusionDelegationError(
          "The delegation update callback failed.",
          "DAG_FUSION_CALLBACK_FAILED",
          { cause: error },
        ),
        true,
      );
    }
  }

  async #handleResponse(data: unknown): Promise<void> {
    const pending = this.#lookup(data);
    if (!pending) return;
    const bytes = jsonBytes(data);
    if (bytes === undefined || bytes > this.#maxResponseBytes) {
      const error = new DagFusionDelegationError(
        "Delegation terminal response exceeded its bound.",
        "DAG_FUSION_PROTOCOL_MISMATCH",
      );
      if (pending.quarantine) {
        this.#rejectedEvents += 1;
      } else if (pending.cancellation) {
        await this.#quarantineCancellation(pending, error);
      } else {
        await this.#failProtocol(pending, error.message);
      }
      return;
    }
    const response = data as SubagentDelegationV2Response;
    if (!TERMINAL_STATUSES.has(response.status)) {
      const error = new DagFusionDelegationError(
        "Delegation returned an unknown terminal status.",
        "DAG_FUSION_PROTOCOL_MISMATCH",
      );
      if (pending.quarantine) {
        this.#rejectedEvents += 1;
      } else if (pending.cancellation) {
        await this.#quarantineCancellation(pending, error);
      } else {
        await this.#failProtocol(pending, error.message);
      }
      return;
    }

    let reconciliableUsage: SubagentDelegationV2Usage | undefined;
    if (response.status !== "invalid_request" && response.usage) {
      try {
        this.#validateUsageShapeAndProgress(pending, response.usage);
        reconciliableUsage = structuredClone(response.usage);
      } catch {
        // Invalid counters are not safe to put in the durable cost ledger. The
        // progress snapshot still makes the missing terminal usage explicit.
      }
    }
    let receipt: DagFusionDelegationReceipt;
    try {
      receipt = this.#validateResponse(pending, response);
    } catch (error) {
      const protocolError =
        error instanceof DagFusionDelegationError
          ? error
          : new DagFusionDelegationError(
              "Delegation terminal response failed validation.",
              "DAG_FUSION_PROTOCOL_MISMATCH",
              { cause: error },
            );
      if (pending.quarantine) {
        // Exact identity plus a known status is insufficient: malformed
        // fields, mismatched model/thinking, or invalid usage are not trusted
        // proof that the owned V2 executor settled.
        this.#rejectedEvents += 1;
        return;
      }
      if (pending.cancellation) {
        // A same-tuple response is not an acknowledgement unless its complete
        // terminal shape validates. Full-charge and quarantine this attempt;
        // only a later valid exact terminal response may release ownership.
        await this.#quarantineCancellation(pending, protocolError);
        return;
      }
      await this.#settleLocal(
        pending,
        "protocol-error",
        protocolError,
        false,
        {
          responseStatus: response.status,
          // A malformed cancellation acknowledgement cannot release the
          // reservation at observed usage even when some counters look sane.
          // Omit terminal usage so the owner applies its maximum commitment.
          ...(!pending.cancellation && reconciliableUsage
            ? { usage: reconciliableUsage }
            : {}),
        },
      );
      return;
    }

    if (pending.quarantine) {
      pending.quarantine.terminalAcknowledged = true;
      try {
        await this.#ensureQuarantineReconciled(pending);
      } catch {
        // The validated child terminal is retained, but a failed durable
        // reconciliation still blocks release. dispose() can retry the same
        // idempotent full-charge settlement without accepting new work.
      }
      if (pending.quarantine.reconciled) this.#detach(pending);
      return;
    }

    if (pending.cancellation) {
      const cancellation = pending.cancellation;
      pending.settling = true;
      this.#stopDeadline(pending);
      try {
        await this.#reconcile(pending, {
          identity: requestIdentity(pending.request),
          reason: cancellation.reason,
          responseStatus: response.status,
          ...(response.status !== "invalid_request" && response.usage
            ? { usage: structuredClone(response.usage) }
            : {}),
          progress: cloneProgress(pending.progress),
        });
        this.#detach(pending);
        pending.reject(cancellation.error);
      } catch (error) {
        const reconciliationError =
          error instanceof DagFusionDelegationError
            ? error
            : new DagFusionDelegationError(
                "Delegation usage reconciliation failed after cancellation acknowledgement.",
                "DAG_FUSION_RECONCILIATION_FAILED",
                { cause: error },
              );
        this.#detach(pending);
        pending.reject(reconciliationError);
      }
      return;
    }

    pending.settling = true;
    this.#stopDeadline(pending);
    try {
      await this.#reconcile(pending, {
        identity: requestIdentity(pending.request),
        reason: "terminal-response",
        responseStatus: response.status,
        ...(response.status !== "invalid_request" && response.usage
          ? { usage: structuredClone(response.usage) }
          : {}),
        progress: cloneProgress(pending.progress),
      });
      this.#detach(pending);
      pending.resolve(receipt);
    } catch (error) {
      const reconciliationError =
        error instanceof DagFusionDelegationError
          ? error
          : new DagFusionDelegationError(
              "Delegation usage reconciliation failed.",
              "DAG_FUSION_RECONCILIATION_FAILED",
              { cause: error },
            );
      this.#detach(pending);
      pending.reject(reconciliationError);
    }
  }

  #validateResponse(
    pending: PendingDelegation,
    response: SubagentDelegationV2Response,
  ): DagFusionDelegationReceipt {
    if (response.status === "invalid_request") {
      const allowedFields = new Set([
        "version",
        "requestId",
        "ownerRunId",
        "nodeId",
        "status",
        "error",
      ]);
      if (Object.keys(response).some((field) => !allowedFields.has(field))) {
        throw new DagFusionDelegationError(
          "Delegation invalid-request response contained unsupported fields.",
          "DAG_FUSION_PROTOCOL_MISMATCH",
        );
      }
      if (
        response.error !== undefined &&
        (typeof response.error !== "string" || response.error.length > 64 * 1024)
      ) {
        throw new DagFusionDelegationError(
          "Delegation invalid-request response contained an invalid error.",
          "DAG_FUSION_PROTOCOL_MISMATCH",
        );
      }
      return {
        identity: requestIdentity(pending.request),
        requested: {
          agent: pending.request.agent,
          model: pending.request.model,
          thinking: pending.request.thinking,
        },
        response: structuredClone(response),
        progress: cloneProgress(pending.progress),
      };
    }
    const terminal: SubagentDelegationV2TerminalResponse = response;
    const completed = terminal.status === "completed";
    const allowedFields = new Set([
      "version",
      "requestId",
      "ownerRunId",
      "nodeId",
      "status",
      "error",
      "runId",
      "agent",
      "model",
      "thinking",
      "exitCode",
      "launchContractDigest",
      "result",
      "usage",
    ]);
    if (Object.keys(terminal).some((field) => !allowedFields.has(field))) {
      throw new DagFusionDelegationError(
        "Delegation terminal response contained unsupported fields.",
        "DAG_FUSION_PROTOCOL_MISMATCH",
      );
    }
    if (
      terminal.error !== undefined &&
      (typeof terminal.error !== "string" || terminal.error.length > 64 * 1024)
    ) {
      throw new DagFusionDelegationError(
        "Delegation terminal response contained an invalid error.",
        "DAG_FUSION_PROTOCOL_MISMATCH",
      );
    }
    if (
      terminal.runId !== undefined &&
      !validId(terminal.runId)
    ) {
      throw new DagFusionDelegationError(
        "Delegation terminal response contained an invalid child run id.",
        "DAG_FUSION_PROTOCOL_MISMATCH",
      );
    }
    if (
      terminal.exitCode !== undefined &&
      (!Number.isSafeInteger(terminal.exitCode) || terminal.exitCode < 0)
    ) {
      throw new DagFusionDelegationError(
        "Delegation terminal response contained an invalid exit code.",
        "DAG_FUSION_PROTOCOL_MISMATCH",
      );
    }
    if (
      terminal.launchContractDigest !== undefined &&
      (typeof terminal.launchContractDigest !== "string" ||
        !terminal.launchContractDigest.trim() ||
        terminal.launchContractDigest.length > 1024)
    ) {
      throw new DagFusionDelegationError(
        "Delegation returned an invalid launch-contract digest.",
        "DAG_FUSION_PROTOCOL_MISMATCH",
      );
    }
    if (terminal.agent !== undefined && terminal.agent !== pending.request.agent) {
      throw new DagFusionDelegationError(
        `Delegation ran agent ${terminal.agent} instead of ${pending.request.agent}.`,
        "DAG_FUSION_PROTOCOL_MISMATCH",
      );
    }
    if (terminal.model !== undefined && terminal.model !== pending.expectedModel) {
      throw new DagFusionDelegationError(
        `Delegation resolved ${terminal.model} instead of ${pending.expectedModel}; fallback is not allowed.`,
        "DAG_FUSION_PROTOCOL_MISMATCH",
      );
    }
    if (
      terminal.thinking !== undefined &&
      terminal.thinking !== pending.request.thinking
    ) {
      throw new DagFusionDelegationError(
        `Delegation used thinking=${terminal.thinking} instead of ${pending.request.thinking}.`,
        "DAG_FUSION_PROTOCOL_MISMATCH",
      );
    }
    const hasExecutionReceipt = Boolean(
      terminal.runId ||
        terminal.agent ||
        terminal.model ||
        terminal.thinking ||
        terminal.launchContractDigest ||
        terminal.result ||
        terminal.usage,
    );
    if (
      (completed || hasExecutionReceipt) &&
      (!terminal.agent ||
        !terminal.model ||
        !terminal.thinking ||
        !terminal.launchContractDigest)
    ) {
      throw new DagFusionDelegationError(
        "A delegation with execution evidence omitted its agent/model/thinking/launch receipt.",
        "DAG_FUSION_PROTOCOL_MISMATCH",
      );
    }
    if (completed && !terminal.result) {
      throw new DagFusionDelegationError(
        "A completed delegation omitted its requested result.",
        "DAG_FUSION_PROTOCOL_MISMATCH",
      );
    }
    if (
      terminal.result &&
      terminal.result.kind !== pending.request.result.kind
    ) {
      throw new DagFusionDelegationError(
        `Delegation returned ${terminal.result.kind} instead of ${pending.request.result.kind}.`,
        "DAG_FUSION_PROTOCOL_MISMATCH",
      );
    }
    if (terminal.result) {
      if (
        typeof terminal.result !== "object" ||
        Array.isArray(terminal.result) ||
        (terminal.result.kind !== "text" && terminal.result.kind !== "structured")
      ) {
        throw new DagFusionDelegationError(
          "Delegation returned a malformed result envelope.",
          "DAG_FUSION_PROTOCOL_MISMATCH",
        );
      }
      if (terminal.result.kind === "text") {
        if (
          Object.keys(terminal.result).some((field) => field !== "kind" && field !== "text") ||
          typeof terminal.result.text !== "string" ||
          Buffer.byteLength(terminal.result.text, "utf8") > 1024 * 1024
        ) {
          throw new DagFusionDelegationError(
            "Delegation returned an invalid bounded text result.",
            "DAG_FUSION_PROTOCOL_MISMATCH",
          );
        }
      } else {
        const valueBytes = jsonBytes(terminal.result.value);
        if (
          Object.keys(terminal.result).some((field) => field !== "kind" && field !== "value") ||
          valueBytes === undefined ||
          valueBytes > 1024 * 1024
        ) {
          throw new DagFusionDelegationError(
            "Delegation returned an invalid bounded structured result.",
            "DAG_FUSION_PROTOCOL_MISMATCH",
          );
        }
      }
    }

    const usage = terminal.usage;
    if (completed && !usage) {
      throw new DagFusionDelegationError(
        "A completed delegation omitted auditable usage.",
        "DAG_FUSION_USAGE_MISMATCH",
      );
    }
    if (usage) this.#validateUsage(pending, usage);

    return {
      identity: requestIdentity(pending.request),
      requested: {
        agent: pending.request.agent,
        model: pending.request.model,
        thinking: pending.request.thinking,
      },
      ...(terminal.agent && terminal.model && terminal.thinking
        ? {
            resolved: {
              agent: terminal.agent,
              model: terminal.model,
              thinking: terminal.thinking,
              ...(terminal.launchContractDigest
                ? { launchContractDigest: terminal.launchContractDigest }
                : {}),
            },
          }
        : {}),
      response: structuredClone(terminal),
      ...(usage ? { usage: usageWithTotal(structuredClone(usage)) } : {}),
      progress: cloneProgress(pending.progress),
    };
  }

  #validateUsage(
    pending: PendingDelegation,
    usage: SubagentDelegationV2Usage,
  ): void {
    this.#validateUsageShapeAndProgress(pending, usage);
    const totalTokens = usage.input + usage.output;
    if (
      totalTokens > pending.options.limits.maxTokens ||
      usage.cost > pending.options.limits.maxCostUsd
    ) {
      throw new DagFusionDelegationError(
        "Delegation terminal usage exceeded its reserved token or cost limit.",
        "DAG_FUSION_USAGE_LIMIT_EXCEEDED",
      );
    }
    if (usage.durationMs > pending.request.timeoutMs + this.#responseGraceMs) {
      throw new DagFusionDelegationError(
        "Delegation terminal duration exceeded its bounded execution deadline.",
        "DAG_FUSION_USAGE_LIMIT_EXCEEDED",
      );
    }
    const graceTurns = pending.request.turnBudget.graceTurns ?? 1;
    if (usage.turns > pending.request.turnBudget.maxTurns + graceTurns) {
      throw new DagFusionDelegationError(
        "Delegation terminal usage exceeded its hard turn budget.",
        "DAG_FUSION_USAGE_LIMIT_EXCEEDED",
      );
    }
    if (usage.toolCalls > pending.request.toolBudget.hard) {
      throw new DagFusionDelegationError(
        "Delegation terminal usage exceeded its all-tools hard budget.",
        "DAG_FUSION_USAGE_LIMIT_EXCEEDED",
      );
    }
  }

  #validateUsageShapeAndProgress(
    pending: PendingDelegation,
    usage: SubagentDelegationV2Usage,
  ): void {
    const tokenFields = [
      usage.input,
      usage.output,
      usage.cacheRead,
      usage.cacheWrite,
      usage.turns,
      usage.toolCalls,
      usage.durationMs,
    ];
    if (
      tokenFields.some((value) => !nonNegativeInteger(value)) ||
      !nonNegativeFinite(usage.cost)
    ) {
      throw new DagFusionDelegationError(
        "Delegation returned invalid usage counters.",
        "DAG_FUSION_USAGE_MISMATCH",
      );
    }
    const totalTokens = usage.input + usage.output;
    if (!Number.isSafeInteger(totalTokens)) {
      throw new DagFusionDelegationError(
        "Delegation token usage overflowed the safe integer range.",
        "DAG_FUSION_USAGE_MISMATCH",
      );
    }
    if (
      totalTokens < pending.progress.tokens ||
      usage.toolCalls < pending.progress.toolCalls ||
      usage.durationMs < pending.progress.durationMs
    ) {
      throw new DagFusionDelegationError(
        "Delegation terminal usage was lower than its last cumulative progress update.",
        "DAG_FUSION_USAGE_MISMATCH",
      );
    }
  }

  async #failProtocol(
    pending: PendingDelegation,
    message: string,
  ): Promise<void> {
    await this.#settleLocal(
      pending,
      "protocol-error",
      new DagFusionDelegationError(
        message,
        "DAG_FUSION_PROTOCOL_MISMATCH",
      ),
      true,
    );
  }

  async #settleLocal(
    pending: PendingDelegation,
    reason: DagFusionDelegationSettlementReason,
    error: DagFusionDelegationError,
    emitCancel: boolean,
    terminal?: {
      responseStatus: SubagentDelegationV2Response["status"];
      usage?: SubagentDelegationV2Usage;
    },
  ): Promise<void> {
    if (pending.quarantine) {
      try {
        await this.#ensureQuarantineReconciled(pending);
      } catch {
        // Keep the process-owning host and exact tuple quarantined. A later
        // dispose call may retry the same idempotent settlement, but it still
        // cannot tear down the Pi session without a terminal acknowledgement.
      }
      if (
        pending.quarantine.terminalAcknowledged &&
        pending.quarantine.reconciled
      ) {
        this.#detach(pending);
      }
      await pending.settlementDone;
      return;
    }
    if (pending.settling) {
      await pending.settlementDone;
      return;
    }
    if (emitCancel) {
      this.#beginCancellation(pending, reason, error);
      await pending.settlementDone;
      return;
    }

    pending.settling = true;
    this.#stopDeadline(pending);
    try {
      await this.#reconcile(pending, {
        identity: requestIdentity(pending.request),
        reason,
        ...(terminal?.responseStatus
          ? { responseStatus: terminal.responseStatus }
          : {}),
        ...(terminal?.usage ? { usage: terminal.usage } : {}),
        progress: cloneProgress(pending.progress),
      });
      this.#detach(pending);
      pending.reject(error);
    } catch (reconciliationError) {
      this.#detach(pending);
      pending.reject(
        reconciliationError instanceof DagFusionDelegationError
          ? reconciliationError
          : new DagFusionDelegationError(
              "Delegation usage reconciliation failed.",
              "DAG_FUSION_RECONCILIATION_FAILED",
              { cause: reconciliationError },
            ),
      );
    }
  }

  #beginCancellation(
    pending: PendingDelegation,
    reason: DagFusionDelegationSettlementReason,
    error: DagFusionDelegationError,
  ): void {
    if (pending.settling) return;
    if (pending.cancellation) {
      // A protocol/callback/usage failure discovered while cancellation is in
      // flight must remain visible instead of being downgraded to the earlier
      // expected abort code when the child eventually acknowledges.
      if (
        reason === "protocol-error" &&
        pending.cancellation.reason !== "protocol-error"
      ) {
        pending.cancellation = { reason, error };
      }
      return;
    }

    pending.cancellation = { reason, error };
    this.#stopDeadline(pending);
    const cancel: SubagentDelegationV2Cancel = {
      version: SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION,
      ...requestIdentity(pending.request),
    };
    try {
      this.#events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, cancel);
    } catch (emitError) {
      void this.#quarantineCancellation(
        pending,
        new DagFusionDelegationError(
          "The Pi event bus rejected the Delegation V2 cancellation; child settlement is unconfirmed.",
          "DAG_FUSION_CANCELLATION_UNCONFIRMED",
          { cause: emitError },
        ),
      );
      return;
    }

    // The exact V2 terminal response is the only positive acknowledgement that
    // pi-subagents' child executor has settled. A missing response fails closed
    // with no terminal usage, causing the owner ledger to retain/charge its
    // maximum commitment; it never becomes an abort-settled acknowledgement.
    if (pending.settling || this.#pending.get(pending.key) !== pending) return;
    pending.timer = setTimeout(() => {
      void this.#quarantineCancellation(
        pending,
        new DagFusionDelegationError(
          `Delegation ${pending.request.requestId} did not acknowledge cancellation within ${this.#cancellationAckTimeoutMs} ms; child settlement is unconfirmed.`,
          "DAG_FUSION_CANCELLATION_UNCONFIRMED",
        ),
      );
    }, this.#cancellationAckTimeoutMs);
    pending.timer.unref?.();
  }

  async #quarantineCancellation(
    pending: PendingDelegation,
    publicError: DagFusionDelegationError,
  ): Promise<void> {
    if (pending.settling || this.#pending.get(pending.key) !== pending) return;
    if (!pending.quarantine) {
      this.#stopDeadline(pending);
      pending.quarantine = {
        settlement: {
          identity: requestIdentity(pending.request),
          reason: "protocol-error",
          progress: cloneProgress(pending.progress),
        },
        reconciled: false,
        terminalAcknowledged: false,
      };
    }
    try {
      await this.#ensureQuarantineReconciled(pending);
      pending.reject(publicError);
    } catch (reconciliationError) {
      pending.reject(
        reconciliationError instanceof DagFusionDelegationError
          ? reconciliationError
          : new DagFusionDelegationError(
              "Delegation usage reconciliation failed while quarantining an unacknowledged child.",
              "DAG_FUSION_RECONCILIATION_FAILED",
              { cause: reconciliationError },
            ),
      );
    }
    if (
      pending.quarantine.terminalAcknowledged &&
      pending.quarantine.reconciled
    ) {
      this.#detach(pending);
    }
  }

  #ensureQuarantineReconciled(pending: PendingDelegation): Promise<void> {
    const quarantine = pending.quarantine;
    if (!quarantine) return Promise.resolve();
    if (quarantine.reconciled) return Promise.resolve();
    if (quarantine.reconciliation) return quarantine.reconciliation;

    const reconciliation = (async () => {
      await this.#reconcile(pending, quarantine.settlement);
      quarantine.reconciled = true;
    })().finally(() => {
      if (quarantine.reconciliation === reconciliation) {
        quarantine.reconciliation = undefined;
      }
    });
    quarantine.reconciliation = reconciliation;
    return reconciliation;
  }

  #stopDeadline(pending: PendingDelegation): void {
    clearTimeout(pending.timer);
    pending.removeAbortListener?.();
    pending.removeAbortListener = undefined;
  }

  #detach(pending: PendingDelegation): void {
    this.#stopDeadline(pending);
    if (this.#pending.get(pending.key) === pending) {
      this.#pending.delete(pending.key);
    }
    if (this.#activeNodes.get(pending.nodeKey) === pending.key) {
      this.#activeNodes.delete(pending.nodeKey);
    }
    pending.markSettlementDone();
  }

  async #reconcile(
    pending: PendingDelegation,
    settlement: DagFusionDelegationUsageSettlement,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve(pending.options.reconcileUsage(settlement)),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new DagFusionDelegationError(
                  `Delegation usage reconciliation exceeded ${this.#reconciliationTimeoutMs} ms.`,
                  "DAG_FUSION_RECONCILIATION_FAILED",
                ),
              ),
            this.#reconciliationTimeoutMs,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export function createDagFusionDelegationHost(
  options: DagFusionDelegationHostOptions,
): DagFusionDelegationHost {
  return new DagFusionDelegationHost(options);
}
