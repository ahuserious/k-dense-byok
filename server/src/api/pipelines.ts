/**
 * Kady "Pipelines" routes: a thin proxy in front of the vendored workflow
 * engine (server/vendor/pipeline-engine, spawned by start.mjs — the "Scientific
 * DAG Workflow Designer"). The web app talks to Kady same-origin; Kady
 * forwards to the engine over its REST surface. Keeping it a proxy (rather
 * than re-implementing a second DAG engine in-process) is the whole point of
 * vendoring the engine — Kady owns the project/session/cost machinery, the
 * engine owns its workflow execution.
 *
 * Two Kady-specific responsibilities live here on top of the forwarding:
 *   - graceful degradation: if the engine is down, answer 503 (not a 500) so
 *     the UI can show "the workflow engine is not running" instead of a broken
 *     page;
 *   - cost reconciliation: durably reserve before dispatch, correlate the
 *     async engine run by an echoed admission label, and settle actual
 *     cap-counted usage after a terminal snapshot.
 *
 * PORT NOTE (E1): the reference tree additionally wired a background rescue
 * watchdog and a /verify-node adversarial-verification hook into these routes.
 * Both lean on reference-era agent code (pre-0.42 protocol) and belong to the
 * background-watch epic (E5); they are intentionally NOT ported here.
 */
import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import * as pipelineEngine from "../agent/pipeline-engine/client.ts";
import {
  PipelineEngineUnavailableError,
  sumRunCost,
} from "../agent/pipeline-engine/client.ts";
import { PIPELINE_ENGINE_BASE_URL } from "../config.ts";
import {
  billingForProvider,
  billingForWorkflowResolution,
  declaredBillingModeMatches,
} from "../cost/billing.ts";
import { currentProjectId } from "../scope.ts";
import { corsResponseHeaders } from "../cors.ts";
import { createProjectRunSnapshot, listProjects, resolvePaths } from "../projects.ts";
import { resolveWorkflowModel } from "../agent/workflow-model-resolution.ts";
import type { ModelRequest } from "../workflows/schema.ts";
import {
  dagNodeSchema,
  providerCallCountForDagNode,
} from "../../vendor/pipeline-engine/packages/workflows/src/schemas/dag-node.ts";
import {
  completePipelineAdmissionSettlement,
  findPipelineAdmission,
  findPipelineAdmissionByEngineKey,
  listPipelineAdmissions,
  persistPipelineAdmission,
  pipelineAdmissionCorrelationLabel,
  pipelineAdmissionId,
  pipelineAdmissionIdFromEngineSnapshot,
  pipelineAdmissionProjectLabel,
  pipelineProjectIdFromEngineSnapshot,
  PIPELINE_ADMISSION_OWNER_INSTANCE_ID,
  recoverPipelineAdmissionIntents,
  PIPELINE_ADMISSION_LABEL_PREFIX,
  recoverPipelineAdmission,
  reservePipelineNodeBudgets,
  settlePipelineAdmission,
  updatePipelineAdmission,
  WorkflowBudgetError,
  type PipelineBudgetAdmission,
  type PipelineAdmissionRecordV1,
  type PipelineNodeBudgetHook,
} from "../workflows/budget.ts";

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

const ZERO_PIPELINE_USAGE = {
  input: 0,
  output: 0,
  total: 0,
  cost: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const;

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? value as number
    : undefined;
}

function strictest(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length === 0 ? undefined : Math.min(...present);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = recordOf(value);
  if (record) {
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function pipelineRequestSha256(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function workflowRoot(definition: unknown): Record<string, unknown> | undefined {
  let root = recordOf(definition);
  for (const key of ["workflow", "definition", "data"] as const) {
    const nested = recordOf(root?.[key]);
    if (nested && Array.isArray(nested.nodes)) root = nested;
  }
  return root;
}

function workflowNodeCount(definition: unknown): number {
  const nodes = workflowRoot(definition)?.nodes;
  if (!Array.isArray(nodes) || nodes.length < 1) {
    throw new WorkflowBudgetError("INVALID_ARGUMENT", "Pipeline workflow has no nodes to correlate.");
  }
  return nodes.length;
}

function workflowRevisionSha256(definition: unknown): string {
  const root = workflowRoot(definition);
  if (!root) {
    throw new WorkflowBudgetError("INVALID_ARGUMENT", "Pipeline workflow has no revision-bearing definition.");
  }
  return pipelineRequestSha256(root);
}

interface UnresolvedPipelineNodeBudgetHook {
  nodeId: string;
  modelCallCount: number;
  maxTokens: number;
  maxCostUsd: number;
  declaredBillingMode: "inherit" | "api" | "subscription";
  modelRequest?: ModelRequest;
  resolvedLegacyBilling?: ReturnType<typeof billingForProvider>;
}

const LEGACY_PIPELINE_MAX_TOKENS = 100_000_000;

function legacyBilling(provider: string, model: string): ReturnType<typeof billingForProvider> {
  const slash = model.indexOf("/");
  const modelProvider = provider === "pi" && slash > 0 ? model.slice(0, slash) : provider;
  const authType = modelProvider === "ollama" || modelProvider === "openai-compatible" ? "local"
    : modelProvider === "openai-codex" || modelProvider === "github-copilot" || modelProvider === "xai"
      ? "oauth"
      : modelProvider === "openrouter" || modelProvider === "nvidia"
        ? "api_key"
        : "none";
  return billingForProvider(modelProvider, authType);
}

/** Extract settings-bearing hooks, falling back to the current engine's legacy fields. */
export function unresolvedPipelineNodeBudgetHooks(
  definition: unknown,
): UnresolvedPipelineNodeBudgetHook[] {
  const root = workflowRoot(definition);
  const nodes = root?.nodes;
  if (!Array.isArray(nodes)) {
    throw new WorkflowBudgetError(
      "INVALID_ARGUMENT",
      "Pipeline engine workflow response has no executable nodes array.",
    );
  }
  const workflowLimits = recordOf(root?.limits);
  const workflowProvider = typeof root?.provider === "string" ? root.provider : undefined;
  const workflowModel = typeof root?.model === "string" ? root.model : undefined;
  const hooks: UnresolvedPipelineNodeBudgetHook[] = [];
  for (const [index, candidate] of nodes.entries()) {
    const node = recordOf(candidate);
    if (!node) {
      throw new WorkflowBudgetError(
        "INVALID_ARGUMENT",
        `Pipeline node ${String(index)} is not an object accepted by the engine schema.`,
      );
    }
    const parsedNode = dagNodeSchema.safeParse(node);
    if (!parsedNode.success) {
      const providerShaped = typeof node.kind === "string" || typeof node.prompt === "string" ||
        typeof node.command === "string" || recordOf(node.loop) !== undefined;
      throw new WorkflowBudgetError(
        "INVALID_ARGUMENT",
        providerShaped
          ? `Provider-backed pipeline node ${String(node.id ?? index)} is not supported by the engine node schema.`
          : `Pipeline node ${String(node.id ?? index)} is not accepted by the engine node schema.`,
      );
    }
    const modelCallCount = providerCallCountForDagNode(parsedNode.data);
    if (modelCallCount === 0) continue;
    const settings = recordOf(node?.settings);
    const budget = recordOf(settings?.budget);
    const legacyMaxCostUsd = finiteNonNegative(node.maxBudgetUsd);
    if (!budget && legacyMaxCostUsd === undefined) {
      throw new WorkflowBudgetError(
        "INVALID_ARGUMENT",
        `Executable pipeline node ${String(node?.id ?? index)} has neither settings.budget nor legacy maxBudgetUsd.`,
      );
    }
    if (budget && positiveInteger(budget.maxTokens) === undefined) {
      throw new WorkflowBudgetError(
        "INVALID_ARGUMENT",
        `Pipeline node ${String(node?.id ?? index)} has invalid budget.maxTokens.`,
      );
    }
    if (budget && finiteNonNegative(budget.maxCostUsd) === undefined) {
      throw new WorkflowBudgetError("INVALID_ARGUMENT", `Pipeline node ${String(node?.id ?? index)} has invalid budget.maxCostUsd.`);
    }
    const nodeLimits = recordOf(node?.limits);
    const maxTokens = strictest([
      budget ? positiveInteger(budget.maxTokens) : LEGACY_PIPELINE_MAX_TOKENS,
      positiveInteger(nodeLimits?.maxTokens),
      positiveInteger(workflowLimits?.maxTokens),
    ]);
    const maxCostUsd = strictest([
      budget ? finiteNonNegative(budget.maxCostUsd) : legacyMaxCostUsd,
      finiteNonNegative(nodeLimits?.maxCostUsd),
      finiteNonNegative(workflowLimits?.maxCostUsd),
    ]);
    if (maxTokens === undefined || maxCostUsd === undefined) {
      throw new WorkflowBudgetError(
        "INVALID_ARGUMENT",
        `Pipeline node ${String(node?.id ?? index)} has an incomplete NodeSpec budget; maxTokens and maxCostUsd must resolve before provider access.`,
      );
    }
    const configuredBillingMode = settings?.billingMode;
    if (
      configuredBillingMode !== undefined && configuredBillingMode !== "inherit" &&
      configuredBillingMode !== "api" && configuredBillingMode !== "subscription"
    ) {
      throw new WorkflowBudgetError(
        "INVALID_ARGUMENT",
        `Pipeline node ${String(node?.id ?? index)} has invalid settings.billingMode.`,
      );
    }
    const billingMode = configuredBillingMode ?? "inherit";
    const settingsModelRequest = recordOf(settings?.model);
    const provider = typeof node.provider === "string" ? node.provider : workflowProvider;
    const model = typeof node.model === "string" ? node.model : workflowModel;
    if (!settingsModelRequest && (!provider || !model)) {
      throw new WorkflowBudgetError(
        "INVALID_ARGUMENT",
        `Executable pipeline node ${String(node?.id ?? index)} has no settings.model or legacy provider/model resolution basis.`,
      );
    }
    hooks.push({
      nodeId: String(node?.id ?? `node-${index}`),
      modelCallCount,
      maxTokens,
      maxCostUsd,
      declaredBillingMode: billingMode,
      ...(settingsModelRequest
        ? { modelRequest: settingsModelRequest as ModelRequest }
        : { resolvedLegacyBilling: legacyBilling(provider as string, model as string) }),
    });
  }
  if (hooks.length === 0) throw new WorkflowBudgetError("INVALID_ARGUMENT", "Pipeline workflow has no executable nodes.");
  return hooks;
}

export async function pipelineNodeBudgetHooks(
  definition: unknown,
  context: { projectId: string; sessionId: string },
  resolveModel: typeof resolveWorkflowModel = resolveWorkflowModel,
): Promise<PipelineNodeBudgetHook[]> {
  const paths = resolvePaths(context.projectId);
  const unresolved = unresolvedPipelineNodeBudgetHooks(definition);
  return Promise.all(unresolved.map(async (hook) => {
    if (hook.resolvedLegacyBilling) {
      if (!declaredBillingModeMatches(hook.declaredBillingMode, hook.resolvedLegacyBilling)) {
        throw new WorkflowBudgetError(
          "INVALID_ARGUMENT",
          `Pipeline node ${hook.nodeId} declares billingMode ${hook.declaredBillingMode}, but resolved ${hook.resolvedLegacyBilling.provider}/${hook.resolvedLegacyBilling.authType} is ${hook.resolvedLegacyBilling.billingMode}.`,
        );
      }
      return { ...hook, billing: hook.resolvedLegacyBilling };
    }
    let resolution: Awaited<ReturnType<typeof resolveWorkflowModel>>;
    try {
      resolution = await resolveModel(hook.modelRequest as ModelRequest, {
        manifest: { projectId: context.projectId, sessionId: context.sessionId },
        paths,
      });
    } catch (error) {
      throw new WorkflowBudgetError(
        "INVALID_ARGUMENT",
        `Pipeline node ${hook.nodeId} model could not be resolved before admission: ${(error as Error).message}`,
      );
    }
    const billing = billingForWorkflowResolution(resolution.receipt.resolved);
    if (!declaredBillingModeMatches(hook.declaredBillingMode, billing)) {
      throw new WorkflowBudgetError(
        "INVALID_ARGUMENT",
        `Pipeline node ${hook.nodeId} declares billingMode ${hook.declaredBillingMode}, but resolved ${billing.provider}/${billing.authType} is ${billing.billingMode}.`,
      );
    }
    return {
      nodeId: hook.nodeId,
      modelCallCount: hook.modelCallCount,
      maxTokens: hook.maxTokens,
      maxCostUsd: hook.maxCostUsd,
      declaredBillingMode: hook.declaredBillingMode,
      billing,
    };
  }));
}

function mapPipelineRunError(reply: FastifyReply, error: unknown): unknown {
  if (error instanceof WorkflowBudgetError) {
    reply.code(error.code === "LIMIT_EXCEEDED" ? 402 : error.code === "INVALID_ARGUMENT" ? 400 : 409);
    return { detail: error.message, budget: "rejected", code: error.code };
  }
  return mapError(reply, error);
}

// Map an engine-call failure to the right HTTP status: 503 when the engine is simply
// down (recoverable — it just needs to start), 502 for any other upstream error.
function mapError(reply: FastifyReply, err: unknown): { detail: string; engine: "down" | "error" } {
  if (err instanceof PipelineEngineUnavailableError) {
    reply.code(503);
    return { detail: err.message, engine: "down" };
  }
  reply.code(502);
  return { detail: (err as Error).message, engine: "error" };
}

function engineRunRecord(snapshot: unknown): Record<string, unknown> | undefined {
  const root = recordOf(snapshot);
  return recordOf(root?.run) ?? root;
}

function engineRunBelongsToCodebase(snapshot: unknown, codebaseId: string): boolean {
  const run = engineRunRecord(snapshot);
  return run?.codebase_id === codebaseId || run?.codebaseId === codebaseId;
}

function scopedRunNotFound(reply: FastifyReply): { detail: string } {
  reply.code(404);
  return { detail: "Pipeline run not found." };
}

export type AdmissionQueryResult =
  | { status: "found"; runId: string; run: Record<string, unknown>; dispatchState?: string }
  | { status: "not-found" }
  | { status: "unknown" };

const CLAIMED_ENGINE_DISPATCH_STATES = new Set(["queued", "running", "dispatched"]);

function engineDispatchState(run: Record<string, unknown>): string | undefined {
  const metadata = recordOf(run.metadata);
  const value = metadata?.kadyDispatchState ?? metadata?.kady_dispatch_state;
  return typeof value === "string" ? value : undefined;
}

function engineRunHasDurableDispatchClaim(query: Extract<AdmissionQueryResult, { status: "found" }>): boolean {
  const runStatus = String(query.run.status ?? query.run.state ?? "").toLowerCase();
  return TERMINAL_RUN_STATUSES.has(runStatus) ||
    runStatus === "running" || runStatus === "paused" ||
    (runStatus === "pending" && query.dispatchState !== undefined &&
      CLAIMED_ENGINE_DISPATCH_STATES.has(query.dispatchState));
}

function engineRunNeedsIdempotentReplay(
  query: Extract<AdmissionQueryResult, { status: "found" }>,
): boolean {
  const runStatus = String(query.run.status ?? query.run.state ?? "").toLowerCase();
  return runStatus === "pending" && query.dispatchState === "pre_dispatch";
}

function engineRunSnapshotSha(run: Record<string, unknown>): string | undefined {
  const metadata = recordOf(run.metadata);
  const value = metadata?.kadyRunSnapshotSha ?? metadata?.kady_run_snapshot_sha;
  return typeof value === "string" && /^[a-f0-9]{40,64}$/.test(value) ? value : undefined;
}

/** A paginated legacy response can prove presence, but only the merge-time
 * authoritative admission-query watermark can prove absence. */
export async function queryEngineRunByAdmissionId(
  projectId: string,
  engineAdmissionKey: string,
): Promise<AdmissionQueryResult> {
  let response: Response;
  try {
    response = await fetch(
      `${PIPELINE_ENGINE_BASE_URL}/api/workflows/runs?projectId=${encodeURIComponent(projectId)}` +
        `&admissionId=${encodeURIComponent(engineAdmissionKey)}&limit=200`,
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (error) {
    throw new PipelineEngineUnavailableError(
      `Pipeline engine admission lookup failed at ${PIPELINE_ENGINE_BASE_URL}: ${(error as Error).message}`,
    );
  }
  if (!response.ok) {
    throw new Error(`Pipeline engine admission lookup returned HTTP ${response.status}.`);
  }
  const root = recordOf(await response.json()) ?? {};
  const runs = Array.isArray(root.runs) ? root.runs : [];
  const matches = runs.filter((candidate): candidate is Record<string, unknown> => {
    const run = recordOf(candidate);
    if (!run) return false;
    const metadata = recordOf(run.metadata);
    const metadataKey = metadata?.kadyEngineAdmissionKey ?? metadata?.kady_engine_admission_key ??
      metadata?.kadyAdmissionId ?? metadata?.kady_admission_id;
    const metadataProjectId = metadata?.kadyProjectId ?? metadata?.kady_project_id;
    return (metadataKey === engineAdmissionKey && metadataProjectId === projectId) ||
      (pipelineAdmissionIdFromEngineSnapshot(run) === engineAdmissionKey &&
        pipelineProjectIdFromEngineSnapshot(run) === projectId);
  });
  if (matches.length > 1) {
    throw new Error(`Pipeline engine returned duplicate runs for project admission ${projectId}/${engineAdmissionKey}.`);
  }
  if (matches.length === 1) {
    if (typeof matches[0].id !== "string" || matches[0].id.length < 1) {
      throw new Error(`Pipeline engine admission ${projectId}/${engineAdmissionKey} has no run id.`);
    }
    const query = recordOf(root.admissionQuery ?? root.admission_query);
    const queryDispatchState = query?.dispatchState ?? query?.dispatch_state;
    const dispatchState = engineDispatchState(matches[0]) ??
      (typeof queryDispatchState === "string" ? queryDispatchState : undefined);
    return {
      status: "found",
      runId: matches[0].id,
      run: matches[0],
      ...(dispatchState === undefined ? {} : { dispatchState }),
    };
  }
  const query = recordOf(root.admissionQuery ?? root.admission_query);
  return query?.authoritative === true &&
      (query.admissionId === engineAdmissionKey || query.admission_id === engineAdmissionKey) &&
      (query.projectId === projectId || query.project_id === projectId)
    ? { status: "not-found" }
    : { status: "unknown" };
}

// --- run-status helpers (used by the SSE relay) ------------------------------
//
// The engine's run object reports status under `status` or `state` in snake/camel
// case and across versions; we read both and lowercase.
const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/** The engine's run JSON is `{ run, events }`; pull the top-level run status string. */
function runStatusOf(snapshot: unknown): string {
  if (!snapshot || typeof snapshot !== "object") return "";
  const run = (snapshot as { run?: Record<string, unknown> }).run ?? {};
  return String(run.status ?? run.state ?? "").toLowerCase();
}

function isTerminalRunStatus(snapshot: unknown): boolean {
  return TERMINAL_RUN_STATUSES.has(runStatusOf(snapshot));
}

function engineSnapshotRun(snapshot: unknown): Record<string, unknown> | undefined {
  const root = recordOf(snapshot);
  return recordOf(root?.run) ?? root;
}

interface PipelineCompletionUsage {
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
}

function durableCompletionUsage(
  snapshot: unknown,
  admission: PipelineAdmissionRecordV1,
): PipelineCompletionUsage | undefined {
  const run = engineSnapshotRun(snapshot);
  const metadata = recordOf(run?.metadata);
  const watermark = recordOf(metadata?.kady_completion_watermark ?? metadata?.kadyCompletionWatermark);
  if (!watermark || watermark.version !== 1) return undefined;
  const watermarkAdmissionId = watermark.engineAdmissionKey ?? watermark.engine_admission_key ??
    watermark.admissionId ?? watermark.admission_id;
  const watermarkProjectId = watermark.projectId ?? watermark.project_id;
  if (watermarkAdmissionId !== admission.engineAdmissionKey ||
    watermarkProjectId !== admission.projectId) return undefined;
  const nodeIds = watermark.nodeIds ?? watermark.node_ids;
  const usageByNode = recordOf(watermark.usageByNode ?? watermark.usage_by_node);
  if (!Array.isArray(nodeIds) || !usageByNode ||
    nodeIds.length !== admission.nodeIds.length ||
    !admission.nodeIds.every((nodeId) => nodeIds.includes(nodeId))) return undefined;
  let costUsd = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  const capCounted = new Set(admission.capCountedNodeIds);
  for (const nodeId of admission.nodeIds) {
    const usage = recordOf(usageByNode[nodeId]);
    const nodeCost = finiteNonNegative(usage?.costUsd ?? usage?.cost_usd);
    const nodeTokensIn = finiteNonNegative(
      usage?.tokensIn ?? usage?.tokens_in ?? usage?.inputTokens ?? usage?.input_tokens,
    );
    const nodeTokensOut = finiteNonNegative(
      usage?.tokensOut ?? usage?.tokens_out ?? usage?.outputTokens ?? usage?.output_tokens,
    );
    if (nodeCost === undefined || nodeTokensIn === undefined || nodeTokensOut === undefined ||
      !Number.isSafeInteger(nodeTokensIn) || !Number.isSafeInteger(nodeTokensOut)) return undefined;
    tokensIn += nodeTokensIn;
    tokensOut += nodeTokensOut;
    if (capCounted.has(nodeId)) costUsd += nodeCost;
  }
  return { costUsd, tokensIn, tokensOut };
}

// Read a run snapshot's events array defensively (the engine returns `{ run, events }`;
// `events` may be absent on an empty/just-started run).
function eventsOf(snapshot: unknown): Record<string, unknown>[] {
  if (!snapshot || typeof snapshot !== "object") return [];
  const events = (snapshot as { events?: unknown }).events;
  return Array.isArray(events) ? (events as Record<string, unknown>[]) : [];
}

// A stable per-event key so the SSE relay only emits each event ONCE across polls.
// The engine assigns an id/seq on most events; when it doesn't we fall back to a
// composite of the fields we read, so a re-polled identical event isn't re-sent.
function eventKey(ev: Record<string, unknown>, indexInPoll: number): string {
  const id = ev.id ?? ev.event_id ?? ev.seq ?? ev.sequence;
  if (id !== undefined && id !== null) return `id:${String(id)}`;
  const type = ev.type ?? ev.event_type ?? "";
  const node = ev.node_id ?? ev.nodeId ?? ev.node ?? "";
  const ts = ev.ts ?? ev.timestamp ?? ev.created_at ?? "";
  return `c:${String(type)}|${String(node)}|${String(ts)}|${indexInPoll}`;
}

// Pull the node id off an event (snake/camel/nested).
function eventNode(ev: Record<string, unknown>): string | undefined {
  const data = (ev.data as Record<string, unknown> | undefined) ?? undefined;
  const id = ev.node_id ?? ev.nodeId ?? ev.node ?? data?.node_id;
  return id !== undefined && id !== null ? String(id) : undefined;
}

// Classify an event type into the lifecycle bucket the relay surfaces. Returns
// "node" for ordinary node lifecycle, or the verify_*/rescue_* family when the
// engine tagged the event with one of those types. Unknown types fall through
// as a generic "node" frame so the UI still sees activity.
function eventType(ev: Record<string, unknown>): string {
  return String(ev.type ?? ev.event_type ?? "").toLowerCase();
}

export async function reconcilePipelineTerminalSnapshot(
  projectId: string,
  engineRunId: string,
  snapshot: unknown,
  missingEvidence: "retain" | "full-charge",
): Promise<Record<string, unknown>> {
  if (!isTerminalRunStatus(snapshot)) {
    throw new WorkflowBudgetError(
      "CONFLICT",
      `Pipeline run ${engineRunId} is ${runStatusOf(snapshot) || "nonterminal"}; reconciliation requires a terminal run.`,
    );
  }
  const run = engineSnapshotRun(snapshot);
  if (run?.id !== engineRunId) {
    throw new WorkflowBudgetError("CONFLICT", "Pipeline snapshot does not own the requested engine run id.");
  }
  const engineAdmissionKey = pipelineAdmissionIdFromEngineSnapshot(snapshot);
  const snapshotProjectId = pipelineProjectIdFromEngineSnapshot(snapshot);
  if (!engineAdmissionKey || snapshotProjectId !== projectId) {
    throw new WorkflowBudgetError("NOT_FOUND", "Pipeline run has no durable Kady admission owner.");
  }
  let recovered = findPipelineAdmissionByEngineKey(projectId, engineAdmissionKey);
  if (!recovered) {
    throw new WorkflowBudgetError("NOT_FOUND", "Pipeline run admission key is not owned by this project.");
  }
  const admissionId = recovered.record.admissionId;
  const runMetadata = recordOf(run.metadata);
  const workflowIdentity = typeof runMetadata?.kadyWorkflowId === "string"
    ? runMetadata.kadyWorkflowId
    : run.workflow_name ?? run.workflowName;
  if (workflowIdentity !== recovered.record.workflowName) {
    throw new WorkflowBudgetError("CONFLICT", "Pipeline run workflow does not match its admission owner.");
  }
  if (recovered.record.status === "intent") {
    updatePipelineAdmission(projectId, admissionId, { status: "dispatching" });
    updatePipelineAdmission(projectId, admissionId, { status: "dispatched", engineRunId });
  } else if (recovered.record.status === "dispatching" || recovered.record.status === "indeterminate") {
    updatePipelineAdmission(projectId, admissionId, { status: "dispatched", engineRunId });
  } else if (recovered.record.status === "dispatched") {
    updatePipelineAdmission(projectId, admissionId, { status: "dispatched", engineRunId });
  }
  recovered = recoverPipelineAdmission(projectId, admissionId);
  const usage = durableCompletionUsage(snapshot, recovered.record);
  if (!usage && missingEvidence === "retain") {
    await recovered.admission.handle.renew();
    throw new WorkflowBudgetError(
      "CONFLICT",
      `Pipeline run ${engineRunId} has no complete durable usage watermark; reservation retained.`,
    );
  }
  const status = runStatusOf(snapshot);
  const entry = await settlePipelineAdmission(projectId, admissionId, {
    status: status === "completed" ? "completed" : status === "cancelled" ? "aborted" : "failed",
    ...(usage
      ? {
          usage: {
            input: usage.tokensIn,
            output: usage.tokensOut,
            total: usage.tokensIn + usage.tokensOut,
            cost: usage.costUsd,
            cacheRead: 0,
            cacheWrite: 0,
          },
        }
      : { reason: "terminal pipeline run lacks a complete durable usage watermark" }),
  }, engineRunId);
  return {
    reconciled: usage ?? null,
    evidence: usage ? "durable-completion-watermark" : "full-charge",
    entry,
    budgetAdmission: {
      admissionId,
      runId: recovered.admission.runId,
      nodeIds: recovered.record.nodeIds,
      capCountedNodeIds: recovered.record.capCountedNodeIds,
    },
  };
}

export interface PipelineReconciliationWorkerOptions {
  intervalMs?: number;
  projects?: () => Array<{ id: string }>;
  admissions?: (projectId: string) => PipelineAdmissionRecordV1[];
  queryAdmission?: (projectId: string, engineAdmissionKey: string) => Promise<AdmissionQueryResult>;
  getRun?: (runId: string) => Promise<unknown>;
  onError?: (error: unknown, admission?: PipelineAdmissionRecordV1) => void;
}

export class PipelineReconciliationWorker {
  readonly intervalMs: number;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly options: PipelineReconciliationWorkerOptions = {}) {
    this.intervalMs = options.intervalMs ?? 5_000;
  }

  private async renewIfNeeded(projectId: string, admissionId: string): Promise<void> {
    const recovered = recoverPipelineAdmission(projectId, admissionId);
    const reservation = recovered.admission.handle.record;
    const renewalWindowMs = Math.max(this.intervalMs * 2, reservation.leaseDurationMs / 2);
    if (reservation.expiresAt - Date.now() <= renewalWindowMs) {
      await recovered.admission.handle.renew();
    }
  }

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const projects = this.options.projects?.() ?? listProjects();
      for (const project of projects) {
        recoverPipelineAdmissionIntents(project.id);
        const records = (this.options.admissions ?? listPipelineAdmissions)(project.id);
        for (const record of records) {
          if (record.status === "settled") continue;
          try {
            if (record.status === "settling") {
              await completePipelineAdmissionSettlement(project.id, record.admissionId);
              continue;
            }
            if (record.status === "intent") {
              if (record.ownerInstanceId === PIPELINE_ADMISSION_OWNER_INSTANCE_ID) {
                await this.renewIfNeeded(project.id, record.admissionId);
                continue;
              }
              await settlePipelineAdmission(project.id, record.admissionId, {
                status: "failed",
                usage: ZERO_PIPELINE_USAGE,
                reason: "admission owner exited before write-ahead dispatch intent",
              });
              continue;
            }
            let engineRunId = record.engineRunId;
            if (!engineRunId) {
              const query = await (this.options.queryAdmission ?? queryEngineRunByAdmissionId)(
                project.id,
                record.engineAdmissionKey,
              );
              if (query.status === "found") {
                if (!engineRunHasDurableDispatchClaim(query)) {
                  await this.renewIfNeeded(project.id, record.admissionId);
                  continue;
                }
                engineRunId = query.runId;
                updatePipelineAdmission(project.id, record.admissionId, {
                  status: "dispatched",
                  engineRunId,
                });
              } else if (query.status === "not-found" &&
                (record.status === "dispatching" || record.status === "indeterminate")) {
                await settlePipelineAdmission(project.id, record.admissionId, {
                  status: "failed",
                  usage: ZERO_PIPELINE_USAGE,
                  reason: "authoritative engine admission query reported not found",
                });
                continue;
              } else {
                await this.renewIfNeeded(project.id, record.admissionId);
                continue;
              }
            }
            const snapshot = await (this.options.getRun ?? pipelineEngine.getRun)(engineRunId);
            if (!isTerminalRunStatus(snapshot)) {
              await this.renewIfNeeded(project.id, record.admissionId);
              continue;
            }
            await reconcilePipelineTerminalSnapshot(project.id, engineRunId, snapshot, "full-charge");
          } catch (error) {
            this.options.onError?.(error, record);
          }
        }
      }
    } finally {
      this.running = false;
    }
  }

  start(): void {
    if (this.timer) return;
    void this.runOnce().catch((error) => this.options.onError?.(error));
    this.timer = setInterval(
      () => void this.runOnce().catch((error) => this.options.onError?.(error)),
      this.intervalMs,
    );
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

export interface PipelineRouteOverrides {
  resolveBudgetHooks?: typeof pipelineNodeBudgetHooks;
  getWorkflow?: typeof pipelineEngine.getWorkflow;
  runWorkflow?: typeof pipelineEngine.runWorkflow;
  queryAdmission?: typeof queryEngineRunByAdmissionId;
  getRun?: typeof pipelineEngine.getRun;
  listRuns?: typeof pipelineEngine.listRuns;
  resumeRun?: typeof pipelineEngine.resumeRun;
  cancelRun?: typeof pipelineEngine.cancelRun;
  resolveWorkflowScope?: (
    projectId: string,
  ) => Promise<pipelineEngine.PipelineWorkflowScope>;
  reconciliationWorker?: PipelineReconciliationWorker | false;
}

async function resolveProjectWorkflowScope(
  projectId: string,
): Promise<pipelineEngine.PipelineWorkflowScope> {
  const cwd = resolvePaths(projectId).sandbox;
  const registered = recordOf(await pipelineEngine.registerCodebase(cwd, {
    name: `kady/${projectId}`,
  }));
  const codebaseId = registered?.id;
  const registeredCwd = registered?.default_cwd;
  if (typeof codebaseId !== "string" || registeredCwd !== cwd) {
    throw new PipelineEngineUnavailableError(
      `Pipeline engine did not return an exact codebase registration for project ${projectId}.`,
    );
  }
  return { cwd, codebaseId };
}

export async function registerPipelineRoutes(
  app: FastifyInstance,
  overrides: PipelineRouteOverrides = {},
): Promise<void> {
  const resolveBudgetHooks = overrides.resolveBudgetHooks ?? pipelineNodeBudgetHooks;
  const getWorkflowForAdmission = overrides.getWorkflow ?? pipelineEngine.getWorkflow;
  const runWorkflow = overrides.runWorkflow ?? pipelineEngine.runWorkflow;
  const queryAdmission = overrides.queryAdmission ?? queryEngineRunByAdmissionId;
  const getRun = overrides.getRun ?? pipelineEngine.getRun;
  const listRuns = overrides.listRuns ?? pipelineEngine.listRuns;
  const resumeRun = overrides.resumeRun ?? pipelineEngine.resumeRun;
  const cancelRun = overrides.cancelRun ?? pipelineEngine.cancelRun;
  const resolveWorkflowScope = overrides.resolveWorkflowScope ?? resolveProjectWorkflowScope;
  if (overrides.reconciliationWorker !== false) {
    const worker = overrides.reconciliationWorker ?? new PipelineReconciliationWorker({
      queryAdmission,
      getRun,
      onError: (error, admission) => app.log.error(
        { error, admissionId: admission?.admissionId },
        "pipeline reconciliation worker failed closed",
      ),
    });
    worker.start();
    app.addHook("onClose", async () => worker.stop());
  }
  // Health: lets the UI decide whether to offer Pipelines or show setup help.
  app.get("/pipelines/health", async () => ({ healthy: await pipelineEngine.pipelineEngineHealthy() }));

  // --- workflow CRUD (proxied) ---
  app.get("/pipelines", async (req, reply) => {
    const requestAbortController = new AbortController();
    const abortForClosedRequest = () => requestAbortController.abort();
    req.raw.once("close", abortForClosedRequest);
    try {
      const scope = await resolveWorkflowScope(currentProjectId());
      const result = await pipelineEngine.listWorkflows(scope, requestAbortController.signal);
      const resultRecord = recordOf(result);
      const workflows = resultRecord?.workflows;
      if (!Array.isArray(workflows)) return result;
      return {
        ...resultRecord,
        workflows: workflows.map((candidate) => {
          const workflow = recordOf(candidate);
          return workflow ? { ...workflow, codebaseId: scope.codebaseId } : candidate;
        }),
      };
    } catch (err) {
      return mapError(reply, err);
    } finally {
      req.raw.off("close", abortForClosedRequest);
    }
  });

  app.get("/pipelines/runs", async (_req, reply) => {
    try {
      const scope = await resolveWorkflowScope(currentProjectId());
      const result = await listRuns(scope.codebaseId);
      const resultRecord = recordOf(result);
      const runs = resultRecord?.runs;
      if (!Array.isArray(runs)) return result;
      return {
        ...resultRecord,
        runs: runs.filter((run) => engineRunBelongsToCodebase(run, scope.codebaseId)),
      };
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.get<{ Params: { name: string } }>("/pipelines/:name", async (req, reply) => {
    try {
      const scope = await resolveWorkflowScope(currentProjectId());
      return await pipelineEngine.getWorkflow(req.params.name, scope);
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.put<{ Params: { name: string } }>("/pipelines/:name", async (req, reply) => {
    try {
      const scope = await resolveWorkflowScope(currentProjectId());
      return await pipelineEngine.saveWorkflow(req.params.name, req.body, scope);
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.delete<{ Params: { name: string } }>("/pipelines/:name", async (req, reply) => {
    try {
      const scope = await resolveWorkflowScope(currentProjectId());
      return await pipelineEngine.deleteWorkflow(req.params.name, scope);
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.post("/pipelines/validate", async (req, reply) => {
    try {
      return await pipelineEngine.validateWorkflow(req.body);
    } catch (err) {
      return mapError(reply, err);
    }
  });

  // --- run lifecycle (proxied) ---
  app.post<{ Params: { name: string } }>("/pipelines/:name/run", async (req, reply) => {
    let admission: PipelineBudgetAdmission | undefined;
    let admissionRecord: PipelineAdmissionRecordV1 | undefined;
    let ownershipPersisted = false;
    let dispatchAttempted = false;
    let replayRunSnapshotSha: string | undefined;
    try {
      const body = recordOf(req.body) ?? {};
      const conversationId = body.conversationId;
      const message = body.message;
      if (typeof conversationId !== "string" || conversationId.length < 1) {
        throw new WorkflowBudgetError("INVALID_ARGUMENT", "Pipeline run requires conversationId.");
      }
      if (typeof message !== "string" || message.length < 1) {
        throw new WorkflowBudgetError("INVALID_ARGUMENT", "Pipeline run requires a non-empty message.");
      }
      if (message.includes(PIPELINE_ADMISSION_LABEL_PREFIX)) {
        throw new WorkflowBudgetError(
          "INVALID_ARGUMENT",
          "Pipeline run message contains a reserved Kady admission label.",
        );
      }
      const projectId = currentProjectId();
      const requestedAdmissionId = body.kadyAdmissionId;
      if (requestedAdmissionId !== undefined && (
        typeof requestedAdmissionId !== "string" ||
        pipelineAdmissionId(requestedAdmissionId) !== requestedAdmissionId
      )) {
        throw new WorkflowBudgetError("INVALID_ARGUMENT", "Invalid Kady pipeline admission id.");
      }
      const admissionId = typeof requestedAdmissionId === "string"
        ? requestedAdmissionId
        : pipelineAdmissionId(crypto.randomUUID());
      const workflowScope = await resolveWorkflowScope(projectId);
      const definition = await getWorkflowForAdmission(req.params.name, workflowScope);
      const admittedWorkflowRevision = workflowRevisionSha256(definition);
      const hooks = await resolveBudgetHooks(definition, {
        projectId,
        sessionId: typeof body.sessionId === "string" ? body.sessionId : conversationId,
      });
      const requestSha256 = pipelineRequestSha256({
        workflowName: req.params.name,
        projectId,
        conversationId,
        message,
      });
      const existing = findPipelineAdmission(projectId, admissionId);
      if (existing) {
        let replayingUnclaimedEngineRun = false;
        if (existing.record.workflowName !== req.params.name ||
          existing.record.requestSha256 !== requestSha256) {
          throw new WorkflowBudgetError("CONFLICT", `Pipeline admission ${admissionId} belongs to another request.`);
        }
        if (existing.record.status === "settling") {
          await completePipelineAdmissionSettlement(projectId, admissionId);
          throw new WorkflowBudgetError("CONFLICT", `Pipeline admission ${admissionId} completed its pending settlement.`);
        }
        if (existing.record.status === "settled") {
          throw new WorkflowBudgetError("CONFLICT", `Pipeline admission ${admissionId} is already settled.`);
        }
        if (existing.record.status !== "intent") {
          const query = await queryAdmission(projectId, existing.record.engineAdmissionKey)
            .catch((): AdmissionQueryResult => ({ status: "unknown" }));
          if (query.status === "found") {
            if (engineRunNeedsIdempotentReplay(query)) {
              replayRunSnapshotSha = engineRunSnapshotSha(query.run);
              if (!replayRunSnapshotSha) {
                throw new WorkflowBudgetError(
                  "CORRUPT",
                  `Pipeline admission ${admissionId} has an unclaimed engine row without its bound snapshot.`,
                );
              }
              admission = existing.admission;
              admissionRecord = existing.record;
              ownershipPersisted = true;
              replayingUnclaimedEngineRun = true;
            } else if (engineRunHasDurableDispatchClaim(query)) {
              updatePipelineAdmission(projectId, admissionId, {
                status: "dispatched",
                engineRunId: query.runId,
              });
              return {
                accepted: true,
                status: String(query.run.status ?? "accepted"),
                kadyAdmissionId: admissionId,
                recovered: true,
              };
            } else {
              reply.code(503);
              return { accepted: false, status: "indeterminate", kadyAdmissionId: admissionId };
            }
          }
          if ((existing.record.status === "dispatching" || existing.record.status === "indeterminate") &&
            query.status === "not-found") {
            await settlePipelineAdmission(projectId, admissionId, {
              status: "failed",
              usage: ZERO_PIPELINE_USAGE,
              reason: "authoritative engine admission query reported not found",
            });
            throw new WorkflowBudgetError("CONFLICT", `Pipeline admission ${admissionId} was not accepted and has been released.`);
          }
          if (!replayingUnclaimedEngineRun) {
            reply.code(503);
            return { accepted: false, status: "indeterminate", kadyAdmissionId: admissionId };
          }
        }
        if (!replayingUnclaimedEngineRun) {
          if (existing.record.ownerInstanceId === PIPELINE_ADMISSION_OWNER_INSTANCE_ID) {
            reply.code(503);
            return { accepted: false, status: "admission-pending", kadyAdmissionId: admissionId };
          }
          if (existing.record.workflowRevisionSha256 !== admittedWorkflowRevision) {
            await settlePipelineAdmission(projectId, admissionId, {
              status: "failed",
              usage: ZERO_PIPELINE_USAGE,
              reason: "workflow revision changed before recovered admission dispatch",
            });
            throw new WorkflowBudgetError("CONFLICT", "Pipeline workflow revision changed before dispatch.");
          }
          admission = existing.admission;
          admissionRecord = existing.record;
          ownershipPersisted = true;
        }
      } else {
        admission = await reservePipelineNodeBudgets({
          projectId,
          admissionId,
          workflowNodeCount: workflowNodeCount(definition),
          hooks,
          durableIntent: {
            workflowName: req.params.name,
            requestSha256,
            workflowRevisionSha256: admittedWorkflowRevision,
          },
        });
        admissionRecord = persistPipelineAdmission(
          admission,
          req.params.name,
          requestSha256,
          admittedWorkflowRevision,
        );
        ownershipPersisted = true;
      }
      if (!admission || !admissionRecord) {
        throw new WorkflowBudgetError(
          "CORRUPT",
          "Pipeline admission and its durable record were not available before dispatch.",
        );
      }
      const latestDefinition = await getWorkflowForAdmission(req.params.name, workflowScope);
      if (workflowRevisionSha256(latestDefinition) !== admissionRecord.workflowRevisionSha256) {
        throw new WorkflowBudgetError("CONFLICT", "Pipeline workflow revision changed between admission and dispatch.");
      }
      const correlationLabel = admissionRecord.correlationLabel;
      const projectLabel = admissionRecord.projectLabel;
      // If the client picked a Kady model (the chat-merged catalogue, an "openrouter/..."
      // ref), thread it into the engine's run options as `requestOptions.model` so its Pi
      // resolves the SAME model chat would. The body shape is otherwise loose/unknown, so
      // we pass it through untouched aside from lifting `model` into requestOptions.
      const { model, ...rest } = body;
      const baseRunBody =
        typeof model === "string" && model.length > 0
          ? {
              ...rest,
              requestOptions: {
                ...((rest.requestOptions as Record<string, unknown> | undefined) ?? {}),
                model,
              },
            }
          : body;
      const runSnapshotSha = replayRunSnapshotSha ??
        createProjectRunSnapshot(projectId, admissionRecord.engineAdmissionKey);
      const runBody = {
        ...baseRunBody,
        message: `${message}\n\n${projectLabel}\n${correlationLabel}`,
        kadyProjectId: projectId,
        kadyAdmissionId: admission.admissionId,
        kadyEngineAdmissionKey: admissionRecord.engineAdmissionKey,
        idempotencyKey: admissionRecord.engineAdmissionKey,
        workflowRevisionSha256: admissionRecord.workflowRevisionSha256,
        kadyRunSnapshotSha: runSnapshotSha,
        metadata: {
          ...(recordOf(baseRunBody.metadata) ?? {}),
          kadyProjectId: projectId,
          kadyAdmissionId: admission.admissionId,
          kadyEngineAdmissionKey: admissionRecord.engineAdmissionKey,
          kadyWorkflowRevisionSha256: admissionRecord.workflowRevisionSha256,
          kadyWorkflowId: req.params.name,
          kadyWorkflowNodeCount: admission.workflowNodeCount,
          kadyRunSnapshotSha: runSnapshotSha,
        },
      };
      // Write-ahead dispatch intent before crossing the process boundary.
      updatePipelineAdmission(projectId, admission.admissionId, { status: "dispatching" });
      dispatchAttempted = true;
      const result = await runWorkflow(req.params.name, runBody, workflowScope);
      const resultRecord = recordOf(result);
      if (resultRecord?.accepted === false && typeof resultRecord.status === "string") {
        await settlePipelineAdmission(projectId, admission.admissionId, {
          status: "failed",
          usage: ZERO_PIPELINE_USAGE,
          reason: "pipeline engine rejected the idempotent invocation",
        });
        dispatchAttempted = false;
        throw new WorkflowBudgetError("CONFLICT", "Pipeline engine rejected the correlated workflow invocation.");
      }
      if (resultRecord?.accepted !== true || typeof resultRecord.status !== "string") {
        throw new Error("Pipeline engine returned an indeterminate run response.");
      }
      const resultDispatchState = typeof resultRecord.dispatchState === "string"
        ? resultRecord.dispatchState
        : typeof resultRecord.dispatch_state === "string"
          ? resultRecord.dispatch_state
          : undefined;
      const resultRunId = typeof resultRecord.runId === "string"
        ? resultRecord.runId
        : typeof resultRecord.run_id === "string"
          ? resultRecord.run_id
          : undefined;
      let claimedRunId = resultRunId;
      let dispatchClaimDurable = resultDispatchState !== undefined &&
        CLAIMED_ENGINE_DISPATCH_STATES.has(resultDispatchState);
      if (!dispatchClaimDurable) {
        const query = await queryAdmission(projectId, admissionRecord.engineAdmissionKey)
          .catch((): AdmissionQueryResult => ({ status: "unknown" }));
        if (query.status === "found" && engineRunHasDurableDispatchClaim(query)) {
          dispatchClaimDurable = true;
          claimedRunId = query.runId;
        }
      }
      if (!dispatchClaimDurable) {
        reply.code(503);
        return {
          accepted: false,
          status: "indeterminate",
          kadyAdmissionId: admission.admissionId,
        };
      }
      try {
        updatePipelineAdmission(projectId, admission.admissionId, {
          status: "dispatched",
          ...(claimedRunId === undefined ? {} : { engineRunId: claimedRunId }),
        });
      } catch (error) {
        // The already-fsynced `dispatching` mapping proves uncertainty.
        // Never release its reservation after the engine has accepted work.
        req.log.error({ error, admissionId: admission.admissionId }, "pipeline admission status update failed");
      }
      return { ...resultRecord, kadyAdmissionId: admission.admissionId };
    } catch (err) {
      if (admission && dispatchAttempted) {
        const engineAdmissionKey = admissionRecord?.engineAdmissionKey ??
          findPipelineAdmission(admission.handle.record.projectId, admission.admissionId)?.record.engineAdmissionKey;
        if (!engineAdmissionKey) return mapPipelineRunError(reply, err);
        const query = await queryAdmission(admission.handle.record.projectId, engineAdmissionKey)
          .catch((): AdmissionQueryResult => ({ status: "unknown" }));
        if (query.status === "found" && engineRunHasDurableDispatchClaim(query)) {
          updatePipelineAdmission(admission.handle.record.projectId, admission.admissionId, {
            status: "dispatched",
            engineRunId: query.runId,
          });
          return { accepted: true, status: String(query.run.status ?? "accepted"), kadyAdmissionId: admission.admissionId, recovered: true };
        }
        if (query.status === "found") {
          reply.code(503);
          return { accepted: false, status: "indeterminate", kadyAdmissionId: admission.admissionId };
        }
        if (query.status === "not-found") {
          try {
            await settlePipelineAdmission(
              admission.handle.record.projectId,
              admission.admissionId,
              {
                status: "failed",
                usage: ZERO_PIPELINE_USAGE,
                reason: "authoritative engine admission query reported not found",
              },
            );
          } catch (settlementError) {
            return mapPipelineRunError(reply, settlementError);
          }
        } else {
          reply.code(503);
          return { accepted: false, status: "indeterminate", kadyAdmissionId: admission.admissionId };
        }
      } else if (admission) {
        try {
          if (ownershipPersisted) {
            await settlePipelineAdmission(
              admission.handle.record.projectId,
              admission.admissionId,
              {
                status: "failed",
                usage: ZERO_PIPELINE_USAGE,
                reason: "pipeline engine did not accept the durable correlated invocation",
              },
            );
          } else {
            await admission.handle.settle({
              status: "failed",
              reason: "pipeline admission ownership could not be persisted before dispatch",
            });
          }
        } catch (settlementError) {
          req.log.error(
            { settlementError, admissionId: admission.admissionId },
            "pipeline admission settlement failed closed",
          );
          return mapPipelineRunError(reply, settlementError);
        }
      }
      return mapPipelineRunError(reply, err);
    }
  });

  app.get<{ Params: { runId: string } }>("/pipelines/runs/:runId", async (req, reply) => {
    try {
      const scope = await resolveWorkflowScope(currentProjectId());
      const snapshot = await getRun(req.params.runId);
      if (!engineRunBelongsToCodebase(snapshot, scope.codebaseId)) return scopedRunNotFound(reply);
      return snapshot;
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.post<{ Params: { runId: string } }>("/pipelines/runs/:runId/resume", async (req, reply) => {
    try {
      const scope = await resolveWorkflowScope(currentProjectId());
      const snapshot = await getRun(req.params.runId);
      if (!engineRunBelongsToCodebase(snapshot, scope.codebaseId)) return scopedRunNotFound(reply);
      return await resumeRun(req.params.runId, req.body);
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.post<{ Params: { runId: string } }>("/pipelines/runs/:runId/cancel", async (req, reply) => {
    try {
      const scope = await resolveWorkflowScope(currentProjectId());
      const snapshot = await getRun(req.params.runId);
      if (!engineRunBelongsToCodebase(snapshot, scope.codebaseId)) return scopedRunNotFound(reply);
      return await cancelRun(req.params.runId);
    } catch (err) {
      return mapError(reply, err);
    }
  });

  // --- cost bridge ---
  // Only a durable Kady admission label may own reconciliation. Legacy runs
  // without that proof are rejected instead of taking a second ledger path.
  app.post<{ Params: { runId: string } }>(
    "/pipelines/runs/:runId/reconcile-cost",
    async (req, reply) => {
      try {
        const scope = await resolveWorkflowScope(currentProjectId());
        const snapshot = await getRun(req.params.runId);
        if (!engineRunBelongsToCodebase(snapshot, scope.codebaseId)) return scopedRunNotFound(reply);
        return await reconcilePipelineTerminalSnapshot(
          currentProjectId(),
          req.params.runId,
          snapshot,
          "retain",
        );
      } catch (err) {
        return mapPipelineRunError(reply, err);
      }
    },
  );

  // --- poll-backed SSE relay --------------------------------------------------
  // The engine has NO per-run SSE on the SQLite backend (its dashboard stream is
  // notification-only and lags ~10s), so we POLL getRun on an interval and
  // translate the diff into a text/event-stream the UI can consume same-origin.
  // We emit:
  //   - one `node` frame per NEW node lifecycle event (with the running cost delta,
  //     Kady-priced via sumRunCost on the whole snapshot),
  //   - `verify_*` / `rescue_*` frames for events the engine tags with those types,
  //   - a terminal `done` frame, then close, when the run reaches a terminal status.
  // Socket hygiene mirrors sessions.ts: hijack the reply, write the SSE head, and
  // raw.end() on every exit path (terminal, client close, error) so sockets don't
  // leak. The client-close handler aborts the poll loop.
  app.get<{ Params: { runId: string }; Querystring: { pollMs?: string } }>(
    "/pipelines/runs/:runId/stream",
    async (req, reply) => {
      const runId = req.params.runId;
      let scopedCodebaseId: string;
      try {
        const scope = await resolveWorkflowScope(currentProjectId());
        const initialSnapshot = await getRun(runId);
        if (!engineRunBelongsToCodebase(initialSnapshot, scope.codebaseId)) {
          return scopedRunNotFound(reply);
        }
        scopedCodebaseId = scope.codebaseId;
      } catch (err) {
        return mapError(reply, err);
      }
      // Clamp the poll period to a sane band: fast enough to feel live, slow
      // enough not to hammer a flaky SQLite engine. Default 2s.
      const requestedPollMs = Number(req.query.pollMs);
      const pollMs = Number.isFinite(requestedPollMs)
        ? Math.min(Math.max(requestedPollMs, 500), 15_000)
        : 2_000;

      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        ...corsResponseHeaders(req.headers.origin),
      });
      const write = (frame: unknown): void => {
        if (!raw.writableEnded) raw.write(`data: ${JSON.stringify(frame)}\n\n`);
      };

      // Client gone -> stop polling. `closed` is read by the loop between awaits so
      // an in-flight getRun resolves and then the loop exits without writing to a
      // dead socket.
      let closed = false;
      req.raw.on("close", () => {
        closed = true;
      });

      // De-dupe across polls: emit each engine event exactly once. Cost is reported
      // as a DELTA off the prior poll's Kady-priced total so the UI can attribute
      // spend incrementally (the absolute total is sent too).
      const seenEvents = new Set<string>();
      let lastCostUsd = 0;

      try {
        // Guard the loop with a hard iteration cap as a backstop against a run that
        // never terminates AND a client that never disconnects (e.g. a hung proxy).
        // 2s polls * 5400 = ~3h ceiling; the normal exit is terminal-status or close.
        const MAX_POLLS = 5_400;
        for (let poll = 0; poll < MAX_POLLS && !closed; poll++) {
          let snapshot: unknown;
          try {
            snapshot = await getRun(runId);
            if (!engineRunBelongsToCodebase(snapshot, scopedCodebaseId)) {
              write({ type: "error", engine: "error", message: "Pipeline run not found." });
              break;
            }
          } catch (err) {
            // Engine down or a flaky read. Surface it as an `error` frame; if the
            // engine is simply unavailable we close (no point polling a dead
            // engine), otherwise we keep polling through a transient blip.
            if (err instanceof PipelineEngineUnavailableError) {
              write({ type: "error", engine: "down", message: err.message });
              break;
            }
            write({ type: "error", engine: "error", message: (err as Error).message });
            // transient: wait one period and retry.
            await delay(pollMs, () => closed);
            continue;
          }

          if (closed) break;

          // Emit NEW events only. Cost delta is computed once per poll off the whole
          // snapshot (sumRunCost walks the run JSON; cheap relative to the model work).
          const totalCostUsd = sumRunCost(snapshot).costUsd;
          const costDeltaUsd = totalCostUsd - lastCostUsd;
          lastCostUsd = totalCostUsd;

          const events = eventsOf(snapshot);
          // Attribute the poll's whole cost delta to the FIRST new event we emit
          // this poll, so the UI's running sum of per-frame deltas equals the run
          // total. `costDeltaUnattributed` flips false once we've placed it.
          let costDeltaUnattributed = true;
          for (let i = 0; i < events.length; i++) {
            const ev = events[i];
            const key = eventKey(ev, i);
            if (seenEvents.has(key)) continue;
            seenEvents.add(key);

            const type = eventType(ev);
            // verify_* / rescue_* tags pass through with their family preserved so
            // the UI can badge them distinctly; everything else is a `node` frame.
            const family =
              type.startsWith("verify_") || type.startsWith("rescue_") ? type : "node";
            const frameCostDeltaUsd = costDeltaUnattributed ? costDeltaUsd : 0;
            costDeltaUnattributed = false;
            write({
              type: family,
              event: type || "node",
              nodeId: eventNode(ev) ?? null,
              // The poll's whole cost delta rides the first new frame; the absolute
              // Kady-priced total rides every frame for display.
              costDeltaUsd: frameCostDeltaUsd,
              totalCostUsd,
              data: ev.data ?? null,
            });
          }
          // If nothing new this poll but cost moved (e.g. a node still running and
          // streaming tokens that the engine folds into the run total without a fresh
          // event), surface the delta so spend stays live.
          if (costDeltaUnattributed && costDeltaUsd !== 0) {
            write({ type: "cost", costDeltaUsd, totalCostUsd });
          }

          if (isTerminalRunStatus(snapshot)) {
            write({
              type: "done",
              status: runStatusOf(snapshot),
              totalCostUsd,
            });
            break;
          }

          await delay(pollMs, () => closed);
        }
      } catch (err) {
        // Last-resort: a write/JSON/anything failure inside the loop. Try to tell
        // the client, then fall through to the socket close below.
        write({ type: "error", message: (err as Error).message });
      } finally {
        if (!raw.writableEnded) raw.end();
      }
    },
  );
}

// Sleep `ms`, but resolve early if `shouldStop()` flips true (checked on a short
// inner tick) so a client disconnect mid-wait ends the SSE loop promptly rather
// than after a full poll period.
function delay(ms: number, shouldStop: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const stepMs = Math.min(ms, 250);
    let elapsed = 0;
    const tick = (): void => {
      if (shouldStop() || elapsed >= ms) {
        resolve();
        return;
      }
      elapsed += stepMs;
      setTimeout(tick, stepMs);
    };
    setTimeout(tick, stepMs);
  });
}
