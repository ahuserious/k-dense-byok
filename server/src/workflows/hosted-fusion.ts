import { isDeepStrictEqual } from "node:util";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { ProjectPaths } from "../projects.ts";
import {
  makeFusionRequestExtension,
  setFusionConfig,
  type FusionConfig,
} from "../agent/fusion-bridge.ts";
import { buildFusionModel } from "../agent/models.ts";
import { getModelRuntime } from "../agent/session-registry.ts";
import type {
  DagFusionDelegationIdentity,
  DagFusionDelegationUsageSettlement,
} from "../../pi-packages/dag-fusion-drive/index.ts";
import type {
  WorkflowModelResolutionReceipt,
} from "./run-state.ts";
import type { ModelRequest, WorkflowNode } from "./schema.ts";

const MAX_HOSTED_FUSION_TEXT_BYTES = 8 * 1024;
const HOSTED_FUSION_MAX_TOOL_CALLS = 16;
export const DEFAULT_HOSTED_FUSION_CANCELLATION_ACK_TIMEOUT_MS = 5_000;
export const MIN_HOSTED_FUSION_CANCELLATION_ACK_TIMEOUT_MS = 1;
export const MAX_HOSTED_FUSION_CANCELLATION_ACK_TIMEOUT_MS = 60_000;
const HOSTED_FUSION_SYSTEM_PROMPT =
  "Answer the user's single request directly. Do not call local tools or assume access to local files.";

type HostedFusionDefinition = Extract<
  Extract<WorkflowNode, { kind: "fusion" }>["fusion"],
  { mode: "openrouter-router" }
>;

export type HostedFusionErrorCode =
  | "HOSTED_FUSION_ABORTED"
  | "HOSTED_FUSION_CANCELLATION_UNCONFIRMED"
  | "HOSTED_FUSION_CLEANUP_FAILED"
  | "HOSTED_FUSION_CONFIG_INVALID"
  | "HOSTED_FUSION_EMPTY_RESPONSE"
  | "HOSTED_FUSION_PROVIDER_FAILED"
  | "HOSTED_FUSION_RECONCILIATION_FAILED"
  | "HOSTED_FUSION_SESSION_QUARANTINED"
  | "HOSTED_FUSION_TIMEOUT"
  | "HOSTED_FUSION_USAGE_LIMIT_EXCEEDED"
  | "HOSTED_FUSION_USAGE_MISSING";

export class HostedFusionError extends Error {
  constructor(
    readonly code: HostedFusionErrorCode,
    message: string,
    readonly retryable = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HostedFusionError";
  }
}

export interface HostedFusionResolvedMember {
  memberId: string;
  role: string;
  receipt: WorkflowModelResolutionReceipt;
}

export interface HostedFusionResolvedModels {
  members: HostedFusionResolvedMember[];
  judgeDeliberation: WorkflowModelResolutionReceipt;
  judgeFinal: WorkflowModelResolutionReceipt;
}

export interface HostedOpenRouterFusionRequest {
  projectId: string;
  paths: ProjectPaths;
  identity: DagFusionDelegationIdentity;
  fusion: HostedFusionDefinition;
  resolved: HostedFusionResolvedModels;
  task: string;
  maxTokens: number;
  maxCostUsd: number;
  timeoutMs: number;
  signal: AbortSignal;
  reconcileUsage(
    settlement: DagFusionDelegationUsageSettlement,
  ): void | Promise<void>;
}

export interface HostedOpenRouterFusionResult {
  text: string;
  textTruncated: boolean;
  usage: NonNullable<DagFusionDelegationUsageSettlement["usage"]>;
}

interface HostedFusionSessionStats {
  assistantMessages: number;
  toolCalls: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
}

interface HostedFusionSession {
  readonly sessionId: string;
  readonly isIdle: boolean;
  readonly state: { errorMessage?: string };
  prompt(text: string): Promise<void>;
  getLastAssistantText(): string | undefined;
  getSessionStats(): HostedFusionSessionStats;
  clearQueue(): unknown;
  abort(): Promise<void>;
  dispose(): void;
}

interface CreateHostedFusionSessionInput {
  projectId: string;
  paths: ProjectPaths;
  fusionConfig: FusionConfig;
  model: Model<Api>;
}

export interface HostedFusionDependencies {
  buildModel(config: Record<string, unknown>): Model<Api>;
  createSession(input: CreateHostedFusionSessionInput): Promise<HostedFusionSession>;
  setConfig(projectId: string, sessionId: string, config: FusionConfig | null): void;
  now(): number;
  cancellationAckTimeoutMs: number;
}

export interface HostedFusionQuarantineSnapshot {
  projectId: string;
  sessionId: string;
  identity: DagFusionDelegationIdentity;
  quarantinedAt: number;
  reason: "ack-rejected" | "ack-timeout";
  lastError?: string;
}

interface HostedFusionQuarantineEntry extends HostedFusionQuarantineSnapshot {
  session: HostedFusionSession;
  releasePromise: Promise<void>;
}

const hostedFusionQuarantines = new Map<
  string,
  Map<string, HostedFusionQuarantineEntry>
>();

function hostedFusionOwnershipKey(identity: DagFusionDelegationIdentity): string {
  return `${identity.requestId}\0${identity.ownerRunId}\0${identity.nodeId}`;
}

function removeHostedFusionQuarantine(
  projectId: string,
  ownershipKey: string,
  entry: HostedFusionQuarantineEntry,
): void {
  const projectEntries = hostedFusionQuarantines.get(projectId);
  if (projectEntries?.get(ownershipKey) !== entry) return;
  projectEntries.delete(ownershipKey);
  if (projectEntries.size === 0) hostedFusionQuarantines.delete(projectId);
}

export function hostedFusionQuarantineSnapshot(
  projectId?: string,
): HostedFusionQuarantineSnapshot[] {
  const entries = projectId
    ? [...(hostedFusionQuarantines.get(projectId)?.values() ?? [])]
    : [...hostedFusionQuarantines.values()].flatMap((projectEntries) =>
        [...projectEntries.values()]
      );
  return entries
    .map(({ session: _session, releasePromise: _releasePromise, ...snapshot }) =>
      structuredClone(snapshot)
    )
    .sort((left, right) =>
      left.projectId.localeCompare(right.projectId) ||
      left.sessionId.localeCompare(right.sessionId) ||
      hostedFusionOwnershipKey(left.identity).localeCompare(
        hostedFusionOwnershipKey(right.identity),
      )
    );
}

export function assertNoHostedFusionQuarantine(projectId?: string): void {
  const quarantined = hostedFusionQuarantineSnapshot(projectId);
  if (quarantined.length === 0) return;
  const scope = projectId ? `Project ${projectId}` : "Kady";
  throw new HostedFusionError(
    "HOSTED_FUSION_SESSION_QUARANTINED",
    `${scope} owns ${quarantined.length} quarantined hosted Fusion session(s); ` +
      "the operation is blocked until prompt termination and abort acknowledgement prove quiescence.",
  );
}

/**
 * Graceful shutdown keeps the process alive until every already-owned hosted
 * request proves quiescence. A failed release rejects visibly; it never turns
 * an uncertain provider request into a successful shutdown.
 */
export async function waitForHostedFusionQuarantines(): Promise<void> {
  for (;;) {
    const entries = [...hostedFusionQuarantines.values()].flatMap(
      (projectEntries) => [...projectEntries.values()],
    );
    if (entries.length === 0) return;
    await Promise.all(entries.map((entry) => entry.releasePromise));
  }
}

function configError(message: string): never {
  throw new HostedFusionError("HOSTED_FUSION_CONFIG_INVALID", message);
}

function fixedOpenRouterRequest(
  request: ModelRequest,
  label: string,
  expectedModel?: string,
): Extract<ModelRequest["requested"], { source: "fixed" }> {
  if (request.resolution.mode !== "exact") {
    return configError(`${label} must use exact resolution; hosted Fusion cannot apply per-model fallbacks.`);
  }
  const requested = request.requested;
  if (
    requested.source !== "fixed" ||
    requested.provider !== "openrouter" ||
    requested.auth.kind !== "api-key" ||
    requested.auth.profile !== undefined
  ) {
    return configError(`${label} must be a fixed OpenRouter model using Kady's API-key auth without an auth profile.`);
  }
  if (expectedModel !== undefined && requested.model !== expectedModel) {
    return configError(`${label} must select the exact ${expectedModel} model.`);
  }
  if (expectedModel === undefined && requested.model === "openrouter/fusion") {
    return configError(`${label} cannot recursively select the openrouter/fusion router.`);
  }
  if (requested.reasoning === "max") {
    return configError(`${label} cannot request max reasoning because OpenRouter Fusion has no exact max tier.`);
  }
  return requested;
}

function assertResolvedReceipt(
  request: ModelRequest,
  receipt: WorkflowModelResolutionReceipt,
  sharedReasoning: string,
  label: string,
): void {
  const requested = fixedOpenRouterRequest(request, label);
  if (
    !isDeepStrictEqual(receipt.request, request) ||
    receipt.fallbackUsed ||
    receipt.resolutionReason !== undefined ||
    receipt.resolved.provider !== "openrouter" ||
    receipt.resolved.model !== requested.model ||
    receipt.resolved.auth.kind !== "api-key" ||
    receipt.resolved.auth.profile !== undefined ||
    receipt.resolved.reasoning !== sharedReasoning ||
    receipt.resolved.runtime !== "openrouter-fusion"
  ) {
    configError(`${label} does not have an exact immutable OpenRouter Fusion resolution receipt.`);
  }
}

/**
 * Runtime counterpart to graph validation. A saved run is immutable, but this
 * boundary still rechecks every identity before building a provider request.
 */
export function buildHostedFusionConfig(
  fusion: HostedFusionDefinition,
  resolved: HostedFusionResolvedModels,
): FusionConfig {
  const router = fixedOpenRouterRequest(
    fusion.router,
    "Hosted Fusion router",
    "openrouter/fusion",
  );
  if (fusion.members.length < 2 || fusion.members.length > 8) {
    configError("Hosted Fusion requires between two and eight panel members.");
  }
  if (resolved.members.length !== fusion.members.length) {
    configError("Hosted Fusion resolved panel membership does not match the immutable graph.");
  }

  const memberIds = new Set<string>();
  for (const [index, member] of fusion.members.entries()) {
    const resolvedMember = resolved.members[index];
    if (
      memberIds.has(member.id) ||
      !resolvedMember ||
      resolvedMember.memberId !== member.id ||
      resolvedMember.role !== member.role
    ) {
      configError("Hosted Fusion panel identities changed after graph validation.");
    }
    memberIds.add(member.id);
    const memberRequest = fixedOpenRouterRequest(
      member.model,
      `Hosted Fusion panel member ${member.id}`,
    );
    if (memberRequest.reasoning !== router.reasoning) {
      configError("Hosted Fusion exposes one shared reasoning level across router, panel, and judge.");
    }
    assertResolvedReceipt(
      member.model,
      resolvedMember.receipt,
      router.reasoning,
      `Hosted Fusion panel member ${member.id}`,
    );
  }

  const judge = fixedOpenRouterRequest(fusion.judge, "Hosted Fusion judge");
  if (judge.reasoning !== router.reasoning) {
    configError("Hosted Fusion exposes one shared reasoning level across router, panel, and judge.");
  }
  assertResolvedReceipt(
    fusion.judge,
    resolved.judgeDeliberation,
    router.reasoning,
    "Hosted Fusion judge deliberation",
  );
  assertResolvedReceipt(
    fusion.judge,
    resolved.judgeFinal,
    router.reasoning,
    "Hosted Fusion judge final answer",
  );
  if (
    resolved.judgeDeliberation.resolved.model !== resolved.judgeFinal.resolved.model
  ) {
    configError("Hosted Fusion judge receipts resolved to different models.");
  }

  return {
    model: "openrouter/fusion",
    // Workflow "off" is OpenRouter's documented "none" effort. Every other
    // admitted tier is represented verbatim; "max" was rejected above.
    reasoning_effort: router.reasoning === "off" ? "none" : router.reasoning,
    plugins: [
      {
        id: "fusion",
        preset: "general-high",
        analysis_models: resolved.members.map((member) => member.receipt.resolved.model),
        model: resolved.judgeFinal.resolved.model,
        max_tool_calls: HOSTED_FUSION_MAX_TOOL_CALLS,
      },
    ],
  };
}

async function createDefaultHostedFusionSession(
  input: CreateHostedFusionSessionInput,
): Promise<HostedFusionSession> {
  const holder: { session?: HostedFusionSession } = {};
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: input.paths.sandbox,
    agentDir: getAgentDir(),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: HOSTED_FUSION_SYSTEM_PROMPT,
    appendSystemPromptOverride: () => [],
    extensionFactories: [
      makeFusionRequestExtension(
        input.projectId,
        () => holder.session?.sessionId ?? "",
        { allowJudgeFallback: false },
      ),
    ],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: input.paths.sandbox,
    agentDir: getAgentDir(),
    model: input.model,
    modelRuntime: getModelRuntime(),
    resourceLoader,
    sessionManager: SessionManager.inMemory(input.paths.sandbox),
    settingsManager,
    noTools: "all",
    tools: [],
  });
  holder.session = session;
  return session;
}

function dependenciesWithDefaults(
  overrides: Partial<HostedFusionDependencies> | undefined,
): HostedFusionDependencies {
  return {
    buildModel: buildFusionModel,
    createSession: createDefaultHostedFusionSession,
    setConfig: setFusionConfig,
    now: Date.now,
    cancellationAckTimeoutMs: DEFAULT_HOSTED_FUSION_CANCELLATION_ACK_TIMEOUT_MS,
    ...overrides,
  };
}

type BoundedSettlement =
  | { status: "fulfilled" }
  | { status: "rejected"; error: unknown }
  | { status: "timed-out" };

async function boundedSettlement(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<BoundedSettlement> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: BoundedSettlement) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ status: "timed-out" }), timeoutMs);
    timer.unref?.();
    promise.then(
      () => finish({ status: "fulfilled" }),
      (error: unknown) => finish({ status: "rejected", error }),
    );
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 1_024)
    : String(error).slice(0, 1_024);
}

function registerHostedFusionQuarantine(input: {
  projectId: string;
  identity: DagFusionDelegationIdentity;
  session: HostedFusionSession;
  promptPromise: Promise<void>;
  abortPromise: Promise<void>;
  reason: HostedFusionQuarantineSnapshot["reason"];
  dependencies: HostedFusionDependencies;
}): HostedFusionQuarantineEntry {
  const ownershipKey = hostedFusionOwnershipKey(input.identity);
  let projectEntries = hostedFusionQuarantines.get(input.projectId);
  if (!projectEntries) {
    projectEntries = new Map();
    hostedFusionQuarantines.set(input.projectId, projectEntries);
  }
  if (projectEntries.has(ownershipKey)) {
    throw new HostedFusionError(
      "HOSTED_FUSION_SESSION_QUARANTINED",
      "Hosted Fusion attempted to replace an existing quarantined ownership record.",
    );
  }

  const entry: HostedFusionQuarantineEntry = {
    projectId: input.projectId,
    sessionId: input.session.sessionId,
    identity: structuredClone(input.identity),
    quarantinedAt: input.dependencies.now(),
    reason: input.reason,
    session: input.session,
    releasePromise: Promise.resolve(),
  };
  projectEntries.set(ownershipKey, entry);

  // A rejected acknowledgement is not positive proof of cancellation. Give
  // the session one process-owned retry while retaining the exact session and
  // Fusion configuration. A pending acknowledgement is never replaced: two
  // concurrent abort attempts would make ownership less knowable, not more.
  const acknowledgedAbort = input.reason === "ack-rejected"
    ? Promise.resolve().then(() => input.session.abort())
    : input.abortPromise;
  void acknowledgedAbort.catch(() => undefined);
  const promptSettled = input.promptPromise.then(
    () => undefined,
    () => undefined,
  );

  entry.releasePromise = Promise.all([promptSettled, acknowledgedAbort])
    .then(() => {
      if (!input.session.isIdle) {
        throw new Error(
          "Hosted Fusion prompt and abort settled, but the temporary Pi session is still active.",
        );
      }
      input.session.clearQueue();
      input.dependencies.setConfig(input.projectId, input.session.sessionId, null);
      input.session.dispose();
      removeHostedFusionQuarantine(input.projectId, ownershipKey, entry);
    })
    .catch((error: unknown) => {
      // Retain exact ownership on every failed release attempt. Project
      // deletion and new hosted Fusion admission remain blocked visibly.
      entry.lastError = errorMessage(error);
      throw error;
    });
  // Shutdown may not have started yet. Observe a failed late-release attempt
  // immediately so retaining the quarantined owner cannot create an unhandled
  // rejection in the meantime.
  void entry.releasePromise.catch(() => undefined);
  return entry;
}

function promptAbortError(timedOut: boolean): HostedFusionError {
  return new HostedFusionError(
    timedOut ? "HOSTED_FUSION_TIMEOUT" : "HOSTED_FUSION_ABORTED",
    timedOut ? "Hosted Fusion exceeded its deadline." : "Hosted Fusion was aborted.",
  );
}

async function waitForPromptOrAbort(
  promptPromise: Promise<void>,
  signal: AbortSignal,
  timedOut: () => boolean,
): Promise<void> {
  if (signal.aborted) throw promptAbortError(timedOut());
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = () => finish(() => reject(promptAbortError(timedOut())));
    signal.addEventListener("abort", onAbort, { once: true });
    promptPromise.then(
      () => finish(resolve),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function boundedText(text: string): { text: string; truncated: boolean } {
  const normalized = text.trim();
  if (!normalized) {
    throw new HostedFusionError(
      "HOSTED_FUSION_EMPTY_RESPONSE",
      "OpenRouter Fusion completed without a final text response.",
      true,
    );
  }
  if (Buffer.byteLength(normalized, "utf8") <= MAX_HOSTED_FUSION_TEXT_BYTES) {
    return { text: normalized, truncated: false };
  }
  let end = Math.min(normalized.length, MAX_HOSTED_FUSION_TEXT_BYTES - 32);
  while (end > 0 && Buffer.byteLength(normalized.slice(0, end), "utf8") > MAX_HOSTED_FUSION_TEXT_BYTES - 32) {
    end -= 1;
  }
  return { text: `${normalized.slice(0, end)}…[bounded by Kady]`, truncated: true };
}

function completeUsage(
  stats: HostedFusionSessionStats,
  durationMs: number,
): NonNullable<DagFusionDelegationUsageSettlement["usage"]> | undefined {
  const values = [
    stats.tokens.input,
    stats.tokens.output,
    stats.tokens.cacheRead,
    stats.tokens.cacheWrite,
    stats.tokens.total,
    stats.cost,
    stats.assistantMessages,
    stats.toolCalls,
    durationMs,
  ];
  if (
    values.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0) ||
    !values.slice(0, 4).every(Number.isSafeInteger) ||
    !Number.isSafeInteger(stats.tokens.total) ||
    !Number.isSafeInteger(stats.assistantMessages) ||
    !Number.isSafeInteger(stats.toolCalls) ||
    !Number.isSafeInteger(durationMs) ||
    stats.tokens.total !==
      stats.tokens.input + stats.tokens.output + stats.tokens.cacheRead + stats.tokens.cacheWrite
  ) {
    return undefined;
  }
  return {
    input: stats.tokens.input,
    output: stats.tokens.output,
    cacheRead: stats.tokens.cacheRead,
    cacheWrite: stats.tokens.cacheWrite,
    cost: stats.cost,
    turns: stats.assistantMessages,
    toolCalls: stats.toolCalls,
    durationMs,
  };
}

function usageProgress(
  usage: NonNullable<DagFusionDelegationUsageSettlement["usage"]> | undefined,
  started: boolean,
  durationMs: number,
) {
  return {
    started,
    model: started ? "openrouter/openrouter/fusion" : undefined,
    tokens: usage ? usage.input + usage.output : 0,
    toolCalls: usage?.toolCalls ?? 0,
    durationMs,
  };
}

/**
 * Execute one opaque hosted Fusion request. The caller must have reserved the
 * compound node envelope before entering this function. This function owns the
 * reservation settlement and invokes it exactly once on every terminal path.
 */
export async function runHostedOpenRouterFusion(
  request: HostedOpenRouterFusionRequest,
  dependencyOverrides?: Partial<HostedFusionDependencies>,
): Promise<HostedOpenRouterFusionResult> {
  const dependencies = dependenciesWithDefaults(dependencyOverrides);
  const startedAt = dependencies.now();
  let reconciliationStarted = false;
  const duration = () => Math.max(0, Math.floor(dependencies.now() - startedAt));
  const reconcileOnce = async (
    settlement: DagFusionDelegationUsageSettlement,
  ): Promise<void> => {
    if (reconciliationStarted) {
      throw new HostedFusionError(
        "HOSTED_FUSION_RECONCILIATION_FAILED",
        "Hosted Fusion attempted to reconcile its compound reservation more than once.",
      );
    }
    reconciliationStarted = true;
    try {
      await request.reconcileUsage(settlement);
    } catch (error) {
      throw new HostedFusionError(
        "HOSTED_FUSION_RECONCILIATION_FAILED",
        "Hosted Fusion could not reconcile its compound usage reservation.",
        false,
        { cause: error },
      );
    }
  };

  let fusionConfig: FusionConfig;
  let model: Model<Api>;
  try {
    if (
      request.projectId !== request.paths.id ||
      !Number.isSafeInteger(request.maxTokens) || request.maxTokens < 1 ||
      !Number.isFinite(request.maxCostUsd) || request.maxCostUsd <= 0 ||
      !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 ||
      !Number.isSafeInteger(dependencies.cancellationAckTimeoutMs) ||
      dependencies.cancellationAckTimeoutMs < MIN_HOSTED_FUSION_CANCELLATION_ACK_TIMEOUT_MS ||
      dependencies.cancellationAckTimeoutMs > MAX_HOSTED_FUSION_CANCELLATION_ACK_TIMEOUT_MS
    ) {
      configError("Hosted Fusion received an invalid project or compound usage envelope.");
    }
    assertNoHostedFusionQuarantine(request.projectId);
    fusionConfig = buildHostedFusionConfig(request.fusion, request.resolved);
    model = dependencies.buildModel(fusionConfig as Record<string, unknown>);
    if (model.provider !== "openrouter" || model.id !== "openrouter/fusion") {
      configError("Hosted Fusion pricing resolved to a non-router Pi model.");
    }
  } catch (error) {
    await reconcileOnce({
      identity: request.identity,
      reason: "protocol-error",
      responseStatus: "failed",
      progress: {
        started: false,
        tokens: 0,
        toolCalls: 0,
        durationMs: duration(),
      },
    });
    throw error;
  }

  const timeoutController = new AbortController();
  let timedOut = false;
  let session: HostedFusionSession | undefined;
  let configInstalled = false;
  let providerStarted = false;
  let usage: NonNullable<DagFusionDelegationUsageSettlement["usage"]> | undefined;
  let primaryError: unknown;
  let pendingSettlement: DagFusionDelegationUsageSettlement | undefined;
  let abortPromise: Promise<void> | undefined;
  let promptPromise: Promise<void> | undefined;

  const onCallerAbort = () => timeoutController.abort(request.signal.reason);
  if (request.signal.aborted) onCallerAbort();
  else request.signal.addEventListener("abort", onCallerAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    timeoutController.abort(new Error(`Hosted Fusion timed out after ${request.timeoutMs}ms.`));
  }, request.timeoutMs);
  timer.unref?.();

  const beginSessionAbort = (): Promise<void> | undefined => {
    try {
      session?.clearQueue();
    } catch {
      // The deterministic finally below retries cleanup and surfaces failure.
    }
    if (!session || session.isIdle) return abortPromise;
    if (!abortPromise) {
      try {
        abortPromise = session.abort();
      } catch (error) {
        abortPromise = Promise.reject(error);
      }
      // The deterministic finally owns the outcome. Attach a handler now so a
      // prompt rejection cannot leave a rejected abort promise unobserved while
      // control is still unwinding into that cleanup block.
      void abortPromise.catch(() => undefined);
    }
    return abortPromise;
  };
  const abortSession = () => {
    void beginSessionAbort();
  };
  timeoutController.signal.addEventListener("abort", abortSession, { once: true });

  try {
    if (timeoutController.signal.aborted) {
      throw new HostedFusionError(
        timedOut ? "HOSTED_FUSION_TIMEOUT" : "HOSTED_FUSION_ABORTED",
        timedOut ? "Hosted Fusion timed out before session creation." : "Hosted Fusion was aborted before session creation.",
      );
    }
    session = await dependencies.createSession({
      projectId: request.projectId,
      paths: request.paths,
      fusionConfig,
      model,
    });
    if (timeoutController.signal.aborted) {
      throw new HostedFusionError(
        timedOut ? "HOSTED_FUSION_TIMEOUT" : "HOSTED_FUSION_ABORTED",
        timedOut ? "Hosted Fusion timed out before its provider request." : "Hosted Fusion was aborted before its provider request.",
      );
    }

    configInstalled = true;
    dependencies.setConfig(request.projectId, session.sessionId, fusionConfig);
    if (timeoutController.signal.aborted) {
      throw new HostedFusionError(
        timedOut ? "HOSTED_FUSION_TIMEOUT" : "HOSTED_FUSION_ABORTED",
        timedOut ? "Hosted Fusion timed out before its provider request." : "Hosted Fusion was aborted before its provider request.",
      );
    }
    providerStarted = true;
    try {
      promptPromise = session.prompt(request.task);
    } catch (error) {
      promptPromise = Promise.reject(error);
    }
    // The abort race can return before the provider promise settles. Keep an
    // observer attached immediately; final cleanup or quarantine retains the
    // promise itself until provider work has genuinely terminated.
    void promptPromise.catch(() => undefined);
    await waitForPromptOrAbort(
      promptPromise,
      timeoutController.signal,
      () => timedOut,
    );
    if (timeoutController.signal.aborted) {
      throw new HostedFusionError(
        timedOut ? "HOSTED_FUSION_TIMEOUT" : "HOSTED_FUSION_ABORTED",
        timedOut ? "Hosted Fusion exceeded its deadline." : "Hosted Fusion was aborted.",
      );
    }

    const stats = session.getSessionStats();
    usage = completeUsage(stats, duration());
    if (!usage || usage.turns < 1 || usage.input + usage.output < 1) {
      throw new HostedFusionError(
        "HOSTED_FUSION_USAGE_MISSING",
        "OpenRouter Fusion returned without a complete finite Pi usage receipt; Kady will fail closed.",
      );
    }
    if (
      usage.input + usage.output > request.maxTokens ||
      usage.cost > request.maxCostUsd
    ) {
      throw new HostedFusionError(
        "HOSTED_FUSION_USAGE_LIMIT_EXCEEDED",
        "OpenRouter Fusion exceeded its reserved compound token or cost envelope.",
      );
    }
    if (session.state.errorMessage) {
      throw new HostedFusionError(
        "HOSTED_FUSION_PROVIDER_FAILED",
        `OpenRouter Fusion failed: ${session.state.errorMessage.slice(0, 1_024)}`,
        true,
      );
    }
    const answer = boundedText(session.getLastAssistantText() ?? "");
    pendingSettlement = {
      identity: request.identity,
      reason: "terminal-response",
      responseStatus: "completed",
      usage,
      progress: usageProgress(usage, true, duration()),
    };
    return {
      text: answer.text,
      textTruncated: answer.truncated,
      usage,
    };
  } catch (error) {
    primaryError = error;
    if (session && !usage) {
      try {
        usage = completeUsage(session.getSessionStats(), duration());
      } catch {
        // Missing/invalid usage is intentionally represented by omission below.
      }
    }
    if (!reconciliationStarted) {
      const aborted = timeoutController.signal.aborted;
      pendingSettlement = {
        identity: request.identity,
        reason: timedOut ? "host-timeout" : aborted ? "caller-aborted" : "protocol-error",
        responseStatus: timedOut ? "timed_out" : aborted ? "interrupted" : "failed",
        ...(usage ? { usage } : {}),
        progress: usageProgress(usage, providerStarted, duration()),
      };
    }
    if (error instanceof HostedFusionError) throw error;
    throw new HostedFusionError(
      timedOut
        ? "HOSTED_FUSION_TIMEOUT"
        : timeoutController.signal.aborted
          ? "HOSTED_FUSION_ABORTED"
          : "HOSTED_FUSION_PROVIDER_FAILED",
      timedOut
        ? "Hosted Fusion exceeded its deadline."
        : timeoutController.signal.aborted
          ? "Hosted Fusion was aborted."
          : `OpenRouter Fusion failed: ${error instanceof Error ? error.message.slice(0, 1_024) : "unknown provider error"}`,
      !timedOut && !timeoutController.signal.aborted,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", onCallerAbort);
    timeoutController.signal.removeEventListener("abort", abortSession);
    if (session) {
      const ownedSession = session;
      let cleanupError: unknown;
      try {
        ownedSession.clearQueue();
      } catch (error) {
        cleanupError ??= error;
      }

      const activeAbort = abortPromise ?? (!ownedSession.isIdle ? beginSessionAbort() : undefined);
      const promptForQuiescence = promptPromise ?? Promise.resolve();
      const promptSettled = promptForQuiescence.then(
        () => undefined,
        () => undefined,
      );
      const quiescence = Promise.all([
        promptSettled,
        activeAbort ?? Promise.resolve(),
      ]).then(() => {
        if (!ownedSession.isIdle) {
          throw new Error(
            "Hosted Fusion provider work settled without leaving the temporary Pi session idle.",
          );
        }
      });
      const acknowledgement = await boundedSettlement(
        quiescence,
        dependencies.cancellationAckTimeoutMs,
      );

      if (acknowledgement.status !== "fulfilled") {
        registerHostedFusionQuarantine({
          projectId: request.projectId,
          identity: request.identity,
          session: ownedSession,
          promptPromise: promptForQuiescence,
          // A settled prompt can still violate Pi's isIdle contract without an
          // abort having been issued. Quarantine must retain that exact session
          // too; the rejected-release path will make one process-owned retry.
          abortPromise: activeAbort ?? Promise.resolve(),
          reason: acknowledgement.status === "rejected"
            ? "ack-rejected"
            : "ack-timeout",
          dependencies,
        });
        const acknowledgementError = acknowledgement.status === "rejected"
          ? acknowledgement.error
          : new Error(
              `Hosted Fusion cancellation was not acknowledged within ${dependencies.cancellationAckTimeoutMs}ms.`,
            );
        const cancellationFailure = new HostedFusionError(
          "HOSTED_FUSION_CANCELLATION_UNCONFIRMED",
          "Hosted Fusion could not prove provider quiescence; Kady retained the exact temporary session and blocked further hosted Fusion work for this project.",
          false,
          {
            cause: primaryError === undefined
              ? acknowledgementError
              : new AggregateError(
                  [primaryError, acknowledgementError],
                  "Hosted Fusion execution ended without confirmed cancellation.",
                ),
          },
        );
        if (!reconciliationStarted) {
          try {
            // No partial receipt can safely release the reservation while a
            // provider request remains quarantined. Omitting usage charges
            // the full pre-reserved compound envelope exactly once.
            await reconcileOnce({
              identity: request.identity,
              reason: "protocol-error",
              responseStatus: "failed",
              progress: usageProgress(undefined, providerStarted, duration()),
            });
          } catch (reconciliationError) {
            throw new HostedFusionError(
              "HOSTED_FUSION_CANCELLATION_UNCONFIRMED",
              "Hosted Fusion cancellation was not confirmed and its reservation could not be reconciled; both ownership and the budget remain fail-closed.",
              false,
              {
                cause: new AggregateError(
                  [cancellationFailure, reconciliationError],
                  "Hosted Fusion cancellation and reconciliation both failed.",
                ),
              },
            );
          }
        }
        throw cancellationFailure;
      }

      // The provider prompt has settled, every issued abort fulfilled, and Pi
      // reports the session idle. Only now may the session-specific Fusion
      // configuration and ownership be discarded.
      try {
        if (configInstalled) {
          dependencies.setConfig(request.projectId, ownedSession.sessionId, null);
        }
      } catch (error) {
        cleanupError ??= error;
      }
      try {
        ownedSession.dispose();
      } catch (error) {
        cleanupError ??= error;
      }
      if (cleanupError) {
        const cleanupFailure = new HostedFusionError(
          "HOSTED_FUSION_CLEANUP_FAILED",
          "Hosted Fusion could not prove that its temporary Pi session was fully cleared, quiesced, and disposed.",
          false,
          {
            cause: primaryError === undefined
              ? cleanupError
              : new AggregateError(
                  [primaryError, cleanupError],
                  "Hosted Fusion execution and cleanup both failed.",
                ),
          },
        );
        if (!reconciliationStarted) {
          try {
            // Omit partial usage deliberately. The durable budget layer charges
            // the full reservation when cleanup cannot prove provider
            // quiescence, preserving the cap even if remote work outlives Kady.
            await reconcileOnce({
              identity: request.identity,
              reason: "protocol-error",
              responseStatus: "failed",
              progress: usageProgress(undefined, providerStarted, duration()),
            });
          } catch (reconciliationError) {
            throw new HostedFusionError(
              "HOSTED_FUSION_CLEANUP_FAILED",
              "Hosted Fusion cleanup failed and its compound reservation could not be reconciled; the reservation remains fail-closed.",
              false,
              {
                cause: new AggregateError(
                  [cleanupFailure, reconciliationError],
                  "Hosted Fusion cleanup and reconciliation both failed.",
                ),
              },
            );
          }
        }
        throw cleanupFailure;
      }
    }
    if (!reconciliationStarted && pendingSettlement) {
      // Terminal accounting follows provider quiescence. In particular, an
      // abort cannot release capacity while the same provider request remains
      // capable of producing usage or a late successful result.
      await reconcileOnce(pendingSettlement);
    }
  }
}
