import {
  DagFusionDelegationError,
  type DagFusionDelegationErrorCode,
  type DagFusionDelegationHost,
  type DagFusionDelegationReceipt,
  type DagFusionDelegationUsageSettlement,
  type DelegateDagFusionNodeOptions,
  type OwnedDelegationV2Request,
} from "./delegation-host.ts";

export const DAG_FUSION_GRAPH_CONTRACT_VERSION = "1.0" as const;
export const MAX_DAG_FUSION_GRAPH_NODES = 64;
export const MAX_DAG_FUSION_GRAPH_EDGES = 256;
export const MAX_DAG_FUSION_GRAPH_BYTES = 1024 * 1024;
export const MAX_DAG_FUSION_NODE_RESULT_BYTES = 1024 * 1024;

export type DagFusionReasoningLevelV1 =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/** An identifier for host-owned authentication. It never contains credentials. */
export interface DagFusionAuthSelectorV1 {
  kind: "api-key" | "oauth" | "local" | "custom";
  profile?: string;
}

/**
 * Exact provider-neutral model request. Contract v1 intentionally has no
 * implicit or ordered fallback: a different resolved selector is rejected.
 */
export interface DagFusionModelSelectorV1 {
  provider: string;
  model: string;
  auth: DagFusionAuthSelectorV1;
  reasoning: DagFusionReasoningLevelV1;
}

export interface DagFusionExecutionLimitsV1 {
  timeoutMs: number;
  maxTokens: number;
  maxCostUsd: number;
  maxModelCalls: number;
}

export interface DagFusionAgentNodeV1 {
  id: string;
  kind: "agent";
  label?: string;
  specialist: string;
  instruction: string;
  model: DagFusionModelSelectorV1;
  limits: DagFusionExecutionLimitsV1;
}

export interface DagFusionPanelMemberV1 {
  id: string;
  role: string;
  model: DagFusionModelSelectorV1;
}

/**
 * A bounded, host-executed panel with one logical judge slot. Providers whose
 * billing invokes the judge more than once must report that in `modelCalls`.
 */
export interface DagFusionPanelJudgeRequestV1 {
  mode: "panel-judge";
  members: DagFusionPanelMemberV1[];
  judge: DagFusionModelSelectorV1;
  preserveDissent: boolean;
}

export type DagFusionFusionRequestV1 = DagFusionPanelJudgeRequestV1;

export interface DagFusionFusionNodeV1 {
  id: string;
  kind: "fusion";
  label?: string;
  instruction: string;
  fusion: DagFusionFusionRequestV1;
  limits: DagFusionExecutionLimitsV1;
}

/** Contract v1's intentionally small executable node subset. */
export type DagFusionNodeV1 = DagFusionAgentNodeV1 | DagFusionFusionNodeV1;

export interface DagFusionEdgeV1 {
  from: string;
  to: string;
}

export interface DagFusionGraphV1 {
  version: typeof DAG_FUSION_GRAPH_CONTRACT_VERSION;
  id: string;
  name?: string;
  limits: DagFusionExecutionLimitsV1;
  nodes: DagFusionNodeV1[];
  edges: DagFusionEdgeV1[];
}

export type DagFusionJsonValue =
  | null
  | boolean
  | number
  | string
  | DagFusionJsonValue[]
  | { [key: string]: DagFusionJsonValue };

export interface DagFusionUsageV1 {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  modelCalls: number;
}

export interface DagFusionModelResolutionV1 {
  slot: string;
  requested: DagFusionModelSelectorV1;
  resolved: DagFusionModelSelectorV1;
}

export interface DagFusionInboundResultV1 {
  fromNodeId: string;
  output: DagFusionJsonValue;
}

export interface DagFusionNodeExecutionResultV1 {
  output: DagFusionJsonValue;
  usage: DagFusionUsageV1;
  modelResolutions: DagFusionModelResolutionV1[];
}

/**
 * Explicit trusted-host acknowledgement for a node cancelled by the portable
 * runtime. Returning this value promises that provider activity has stopped and
 * host-owned usage reconciliation has completed. A host must reject instead if
 * it cannot make that promise.
 */
export interface DagFusionHostAbortSettlementV1 {
  contractVersion: typeof DAG_FUSION_GRAPH_CONTRACT_VERSION;
  status: "abort-settled";
}

export type DagFusionHostExecutionOutcomeV1 =
  | DagFusionNodeExecutionResultV1
  | DagFusionHostAbortSettlementV1;

export function dagFusionHostAbortSettledV1(): DagFusionHostAbortSettlementV1 {
  return {
    contractVersion: DAG_FUSION_GRAPH_CONTRACT_VERSION,
    status: "abort-settled",
  };
}

export interface DagFusionNodeAdmissionV1 extends DagFusionExecutionLimitsV1 {}

interface DagFusionNodeExecutionRequestBaseV1 {
  contractVersion: typeof DAG_FUSION_GRAPH_CONTRACT_VERSION;
  runId: string;
  graphId: string;
  inbound: DagFusionInboundResultV1[];
  /** The smaller of the node ceiling and the graph's remaining budget. */
  admission: DagFusionNodeAdmissionV1;
  signal: AbortSignal;
}

export interface DagFusionAgentExecutionRequestV1
  extends DagFusionNodeExecutionRequestBaseV1 {
  node: DagFusionAgentNodeV1;
}

export interface DagFusionFusionExecutionRequestV1
  extends DagFusionNodeExecutionRequestBaseV1 {
  node: DagFusionFusionNodeV1;
}

/**
 * Privileged boundary supplied by an external Pi host. The package owns graph
 * order and contract checks; the host owns credentials, tools, and processes.
 * After its signal aborts, a callback must remain pending until cleanup and
 * reconciliation finish, then resolve with dagFusionHostAbortSettledV1().
 */
export interface DagFusionTrustedHostV1 {
  executeAgent(
    request: DagFusionAgentExecutionRequestV1,
  ): Promise<DagFusionHostExecutionOutcomeV1>;
  executeFusion(
    request: DagFusionFusionExecutionRequestV1,
  ): Promise<DagFusionHostExecutionOutcomeV1>;
}

export interface DagFusionCompletedNodeV1 extends DagFusionNodeExecutionResultV1 {
  nodeId: string;
}

export interface DagFusionGraphExecutionResultV1 {
  contractVersion: typeof DAG_FUSION_GRAPH_CONTRACT_VERSION;
  runId: string;
  graphId: string;
  nodes: DagFusionCompletedNodeV1[];
  terminalNodeIds: string[];
  usage: DagFusionUsageV1;
}

export interface ExecuteDagFusionGraphOptionsV1 {
  runId: string;
  signal?: AbortSignal;
}

export type DagFusionValidationIssueCode =
  | "budget_mismatch"
  | "cycle"
  | "duplicate"
  | "invalid_type"
  | "invalid_value"
  | "missing_reference"
  | "out_of_range"
  | "unknown_property";

export interface DagFusionValidationIssue {
  path: string;
  code: DagFusionValidationIssueCode;
  message: string;
}

export type DagFusionGraphValidationResult =
  | { ok: true; value: DagFusionGraphV1 }
  | { ok: false; issues: DagFusionValidationIssue[] };

export type DagFusionRuntimeErrorCode =
  | "DAG_FUSION_RUNTIME_ABORTED"
  | "DAG_FUSION_RUNTIME_BUDGET_EXCEEDED"
  | "DAG_FUSION_RUNTIME_HOST_FAILED"
  | "DAG_FUSION_RUNTIME_INVALID_DELEGATION_PLAN"
  | "DAG_FUSION_RUNTIME_INVALID_GRAPH"
  | "DAG_FUSION_RUNTIME_INVALID_HOST_RESULT"
  | "DAG_FUSION_RUNTIME_INVALID_RUN"
  | "DAG_FUSION_RUNTIME_TIMEOUT";

export class DagFusionRuntimeError extends Error {
  constructor(
    message: string,
    readonly code: DagFusionRuntimeErrorCode,
    readonly nodeId?: string,
    readonly issues?: DagFusionValidationIssue[],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DagFusionRuntimeError";
  }
}

const IDENTIFIER = /^[a-z][a-z0-9_-]{0,63}$/;
const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REASONING_LEVELS = new Set<DagFusionReasoningLevelV1>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const AUTH_KINDS = new Set<DagFusionAuthSelectorV1["kind"]>([
  "api-key",
  "oauth",
  "local",
  "custom",
]);
const INVALID = Symbol("invalid-plain-json");

interface PlainJsonCloneState {
  bytes: number;
  readonly maximumBytes: number;
  readonly seen: Set<object>;
  readonly issues: DagFusionValidationIssue[];
}

function consumeJsonBytes(
  state: PlainJsonCloneState,
  bytes: number,
  path: string,
): boolean {
  state.bytes += bytes;
  if (state.bytes <= state.maximumBytes) return true;
  if (!state.issues.some((issue) => issue.message === `Plain JSON exceeds ${state.maximumBytes} bytes.`)) {
    state.issues.push({
      path,
      code: "out_of_range",
      message: `Plain JSON exceeds ${state.maximumBytes} bytes.`,
    });
  }
  return false;
}

function clonePlainJson(
  value: unknown,
  path: string,
  state: PlainJsonCloneState,
  depth = 0,
): DagFusionJsonValue | typeof INVALID {
  if (depth > 24) {
    state.issues.push({
      path,
      code: "out_of_range",
      message: "Plain JSON nesting may not exceed 24 levels.",
    });
    return INVALID;
  }
  if (value === null) {
    return consumeJsonBytes(state, 4, path) ? value : INVALID;
  }
  if (typeof value === "boolean") {
    return consumeJsonBytes(state, value ? 4 : 5, path) ? value : INVALID;
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) {
      return consumeJsonBytes(state, Buffer.byteLength(JSON.stringify(value), "utf8"), path)
        ? value
        : INVALID;
    }
    state.issues.push({ path, code: "invalid_value", message: "Numbers must be finite." });
    return INVALID;
  }
  if (typeof value === "string") {
    return consumeJsonBytes(
      state,
      Buffer.byteLength(JSON.stringify(value), "utf8"),
      path,
    ) ? value : INVALID;
  }
  if (!value || typeof value !== "object") {
    state.issues.push({
      path,
      code: "invalid_type",
      message: "Value must be plain JSON data.",
    });
    return INVALID;
  }
  if (state.seen.has(value)) {
    state.issues.push({ path, code: "invalid_value", message: "Plain JSON may not be cyclic." });
    return INVALID;
  }
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > 2_048) {
        state.issues.push({
          path,
          code: "out_of_range",
          message: "Plain JSON arrays may not exceed 2048 entries.",
        });
        return INVALID;
      }
      const ownKeys = Reflect.ownKeys(value);
      if (
        ownKeys.some((key) => typeof key !== "string") ||
        ownKeys.some((key) => key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key as string)) ||
        ownKeys.length !== value.length + 1
      ) {
        state.issues.push({
          path,
          code: "invalid_type",
          message: "Plain JSON arrays may not have sparse or custom properties.",
        });
        return INVALID;
      }
      if (!consumeJsonBytes(state, 2 + Math.max(0, value.length - 1), path)) {
        return INVALID;
      }
      const cloned: DagFusionJsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)) {
          state.issues.push({
            path: `${path}[${index}]`,
            code: "invalid_type",
            message: "Plain JSON arrays must be dense data properties.",
          });
          return INVALID;
        }
        const entry = clonePlainJson(
          descriptor.value,
          `${path}[${index}]`,
          state,
          depth + 1,
        );
        if (entry === INVALID) return INVALID;
        cloned.push(entry);
      }
      return cloned;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      state.issues.push({
        path,
        code: "invalid_type",
        message: "Objects must be plain JSON records.",
      });
      return INVALID;
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string") || ownKeys.length > 64) {
      state.issues.push({
        path,
        code: "out_of_range",
        message: "Plain JSON records may have at most 64 string keys.",
      });
      return INVALID;
    }
    if (!consumeJsonBytes(state, 2 + Math.max(0, ownKeys.length - 1), path)) {
      return INVALID;
    }
    const cloned: Record<string, DagFusionJsonValue> = Object.create(null) as Record<
      string,
      DagFusionJsonValue
    >;
    for (const key of (ownKeys as string[]).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        state.issues.push({
          path: `${path}.${key}`,
          code: "invalid_type",
          message: "Plain JSON records require enumerable data properties.",
        });
        return INVALID;
      }
      if (!consumeJsonBytes(
        state,
        Buffer.byteLength(JSON.stringify(key), "utf8") + 1,
        `${path}.${key}`,
      )) {
        return INVALID;
      }
      const entry = clonePlainJson(descriptor.value, `${path}.${key}`, state, depth + 1);
      if (entry === INVALID) return INVALID;
      cloned[key] = entry;
    }
    return cloned;
  } finally {
    state.seen.delete(value);
  }
}

function plainRecord(
  value: unknown,
  path: string,
  allowed: readonly string[],
  issues: DagFusionValidationIssue[],
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push({ path, code: "invalid_type", message: "Expected an object." });
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(record).filter((key) => !allowedKeys.has(key)).sort()) {
    issues.push({
      path: `${path}.${key}`,
      code: "unknown_property",
      message: `Property ${key} is not part of contract v1.`,
    });
  }
  return record;
}

function stringField(
  value: unknown,
  path: string,
  issues: DagFusionValidationIssue[],
  options: { maximumBytes: number; pattern?: RegExp },
): string | undefined {
  if (typeof value !== "string") {
    issues.push({ path, code: "invalid_type", message: "Expected a string." });
    return undefined;
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < 1 || bytes > options.maximumBytes) {
    issues.push({
      path,
      code: "out_of_range",
      message: `String must contain 1 through ${options.maximumBytes} UTF-8 bytes.`,
    });
    return undefined;
  }
  if (options.pattern && !options.pattern.test(value)) {
    issues.push({ path, code: "invalid_value", message: "String has an invalid format." });
    return undefined;
  }
  return value;
}

function integerField(
  value: unknown,
  path: string,
  issues: DagFusionValidationIssue[],
  minimum: number,
  maximum: number,
): number | undefined {
  if (!Number.isSafeInteger(value)) {
    issues.push({ path, code: "invalid_type", message: "Expected a safe integer." });
    return undefined;
  }
  const numberValue = value as number;
  if (numberValue < minimum || numberValue > maximum) {
    issues.push({
      path,
      code: "out_of_range",
      message: `Integer must be from ${minimum} through ${maximum}.`,
    });
    return undefined;
  }
  return numberValue;
}

function finiteField(
  value: unknown,
  path: string,
  issues: DagFusionValidationIssue[],
  minimum: number,
  maximum: number,
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push({ path, code: "invalid_type", message: "Expected a finite number." });
    return undefined;
  }
  if (value < minimum || value > maximum) {
    issues.push({
      path,
      code: "out_of_range",
      message: `Number must be from ${minimum} through ${maximum}.`,
    });
    return undefined;
  }
  return value;
}

function usdField(
  value: unknown,
  path: string,
  issues: DagFusionValidationIssue[],
): number | undefined {
  const parsed = finiteField(value, path, issues, 0, 1_000_000);
  if (parsed === undefined) return undefined;
  const normalized = Number(parsed.toFixed(12));
  if (Math.abs(parsed - normalized) > 0.5e-12) {
    issues.push({
      path,
      code: "invalid_value",
      message: "USD values may contain at most 12 decimal places.",
    });
    return undefined;
  }
  return normalized;
}

function validateLimits(
  value: unknown,
  path: string,
  issues: DagFusionValidationIssue[],
): DagFusionExecutionLimitsV1 | undefined {
  const before = issues.length;
  const record = plainRecord(
    value,
    path,
    ["timeoutMs", "maxTokens", "maxCostUsd", "maxModelCalls"],
    issues,
  );
  if (!record) return undefined;
  const timeoutMs = integerField(record.timeoutMs, `${path}.timeoutMs`, issues, 1_000, 86_400_000);
  const maxTokens = integerField(record.maxTokens, `${path}.maxTokens`, issues, 1, 100_000_000);
  const maxCostUsd = usdField(record.maxCostUsd, `${path}.maxCostUsd`, issues);
  const maxModelCalls = integerField(record.maxModelCalls, `${path}.maxModelCalls`, issues, 1, 10_000);
  if (issues.length !== before) return undefined;
  return { timeoutMs: timeoutMs!, maxTokens: maxTokens!, maxCostUsd: maxCostUsd!, maxModelCalls: maxModelCalls! };
}

function validateModel(
  value: unknown,
  path: string,
  issues: DagFusionValidationIssue[],
): DagFusionModelSelectorV1 | undefined {
  const before = issues.length;
  const record = plainRecord(value, path, ["provider", "model", "auth", "reasoning"], issues);
  if (!record) return undefined;
  const provider = stringField(record.provider, `${path}.provider`, issues, {
    maximumBytes: 64,
    pattern: PROVIDER,
  });
  const model = stringField(record.model, `${path}.model`, issues, { maximumBytes: 256 });
  const auth = plainRecord(record.auth, `${path}.auth`, ["kind", "profile"], issues);
  let kind: DagFusionAuthSelectorV1["kind"] | undefined;
  let profile: string | undefined;
  if (auth) {
    if (typeof auth.kind !== "string" || !AUTH_KINDS.has(auth.kind as DagFusionAuthSelectorV1["kind"])) {
      issues.push({
        path: `${path}.auth.kind`,
        code: "invalid_value",
        message: "Authentication kind must be api-key, oauth, local, or custom.",
      });
    } else {
      kind = auth.kind as DagFusionAuthSelectorV1["kind"];
    }
    if (auth.profile !== undefined) {
      profile = stringField(auth.profile, `${path}.auth.profile`, issues, { maximumBytes: 128 });
    }
  }
  let reasoning: DagFusionReasoningLevelV1 | undefined;
  if (
    typeof record.reasoning !== "string" ||
    !REASONING_LEVELS.has(record.reasoning as DagFusionReasoningLevelV1)
  ) {
    issues.push({
      path: `${path}.reasoning`,
      code: "invalid_value",
      message: "Reasoning level is not supported by contract v1.",
    });
  } else {
    reasoning = record.reasoning as DagFusionReasoningLevelV1;
  }
  if (issues.length !== before) return undefined;
  return {
    provider: provider!,
    model: model!,
    auth: profile === undefined ? { kind: kind! } : { kind: kind!, profile },
    reasoning: reasoning!,
  };
}

function validateNode(
  value: unknown,
  path: string,
  issues: DagFusionValidationIssue[],
): DagFusionNodeV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push({ path, code: "invalid_type", message: "Expected a node object." });
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== "agent" && candidate.kind !== "fusion") {
    issues.push({
      path: `${path}.kind`,
      code: "invalid_value",
      message: "Contract v1 supports only agent and fusion nodes.",
    });
    return undefined;
  }
  const before = issues.length;
  const commonKeys = ["id", "kind", "label", "instruction", "limits"];
  const record = plainRecord(
    value,
    path,
    candidate.kind === "agent"
      ? [...commonKeys, "specialist", "model"]
      : [...commonKeys, "fusion"],
    issues,
  )!;
  const id = stringField(record.id, `${path}.id`, issues, { maximumBytes: 64, pattern: IDENTIFIER });
  const label = record.label === undefined
    ? undefined
    : stringField(record.label, `${path}.label`, issues, { maximumBytes: 256 });
  const instruction = stringField(record.instruction, `${path}.instruction`, issues, { maximumBytes: 32_768 });
  const limits = validateLimits(record.limits, `${path}.limits`, issues);

  if (candidate.kind === "agent") {
    const specialist = stringField(record.specialist, `${path}.specialist`, issues, { maximumBytes: 128 });
    const model = validateModel(record.model, `${path}.model`, issues);
    if (issues.length !== before) return undefined;
    return {
      id: id!,
      kind: "agent",
      ...(label === undefined ? {} : { label }),
      specialist: specialist!,
      instruction: instruction!,
      model: model!,
      limits: limits!,
    };
  }

  const fusionRecord = plainRecord(
    record.fusion,
    `${path}.fusion`,
    ["mode", "members", "judge", "preserveDissent"],
    issues,
  );
  const members: DagFusionPanelMemberV1[] = [];
  if (fusionRecord) {
    if (fusionRecord.mode !== "panel-judge") {
      issues.push({
        path: `${path}.fusion.mode`,
        code: "invalid_value",
        message: "Contract v1 supports only panel-judge fusion.",
      });
    }
    if (!Array.isArray(fusionRecord.members)) {
      issues.push({
        path: `${path}.fusion.members`,
        code: "invalid_type",
        message: "Fusion members must be an array.",
      });
    } else if (fusionRecord.members.length < 2 || fusionRecord.members.length > 8) {
      issues.push({
        path: `${path}.fusion.members`,
        code: "out_of_range",
        message: "Panel-judge fusion requires 2 through 8 members.",
      });
    } else {
      for (let index = 0; index < fusionRecord.members.length; index += 1) {
        const memberPath = `${path}.fusion.members[${index}]`;
        const memberBefore = issues.length;
        const member = plainRecord(
          fusionRecord.members[index],
          memberPath,
          ["id", "role", "model"],
          issues,
        );
        if (!member) continue;
        const memberId = stringField(member.id, `${memberPath}.id`, issues, {
          maximumBytes: 64,
          pattern: IDENTIFIER,
        });
        const role = stringField(member.role, `${memberPath}.role`, issues, { maximumBytes: 256 });
        const model = validateModel(member.model, `${memberPath}.model`, issues);
        if (issues.length === memberBefore) {
          members.push({ id: memberId!, role: role!, model: model! });
        }
      }
      const memberIds = new Set<string>();
      for (let index = 0; index < members.length; index += 1) {
        if (memberIds.has(members[index]!.id)) {
          issues.push({
            path: `${path}.fusion.members[${index}].id`,
            code: "duplicate",
            message: `Fusion member ${members[index]!.id} is duplicated.`,
          });
        }
        memberIds.add(members[index]!.id);
      }
    }
    if (typeof fusionRecord.preserveDissent !== "boolean") {
      issues.push({
        path: `${path}.fusion.preserveDissent`,
        code: "invalid_type",
        message: "preserveDissent must be a boolean.",
      });
    }
  }
  const judge = fusionRecord
    ? validateModel(fusionRecord.judge, `${path}.fusion.judge`, issues)
    : undefined;
  if (limits && members.length >= 2 && limits.maxModelCalls < members.length + 1) {
    issues.push({
      path: `${path}.limits.maxModelCalls`,
      code: "budget_mismatch",
      message: `Panel-judge fusion needs at least ${members.length + 1} model calls.`,
    });
  }
  if (issues.length !== before || !fusionRecord) return undefined;
  return {
    id: id!,
    kind: "fusion",
    ...(label === undefined ? {} : { label }),
    instruction: instruction!,
    fusion: {
      mode: "panel-judge",
      members,
      judge: judge!,
      preserveDissent: fusionRecord.preserveDissent as boolean,
    },
    limits: limits!,
  };
}

function minimumModelCalls(node: DagFusionNodeV1): number {
  return node.kind === "agent" ? 1 : node.fusion.members.length + 1;
}

function validateSemanticGraph(
  graph: DagFusionGraphV1,
  issues: DagFusionValidationIssue[],
): void {
  const nodeIndex = new Map<string, number>();
  for (let index = 0; index < graph.nodes.length; index += 1) {
    const node = graph.nodes[index]!;
    if (nodeIndex.has(node.id)) {
      issues.push({
        path: `$.nodes[${index}].id`,
        code: "duplicate",
        message: `Node ${node.id} is duplicated.`,
      });
    } else {
      nodeIndex.set(node.id, index);
    }
    for (const field of ["timeoutMs", "maxTokens", "maxCostUsd", "maxModelCalls"] as const) {
      if (node.limits[field] > graph.limits[field]) {
        issues.push({
          path: `$.nodes[${index}].limits.${field}`,
          code: "budget_mismatch",
          message: `Node ${field} exceeds the graph ceiling.`,
        });
      }
    }
  }

  const seenEdges = new Set<string>();
  const adjacency = new Map(graph.nodes.map((node) => [node.id, [] as string[]]));
  const indegree = new Map(graph.nodes.map((node) => [node.id, 0]));
  for (let index = 0; index < graph.edges.length; index += 1) {
    const edge = graph.edges[index]!;
    if (!nodeIndex.has(edge.from)) {
      issues.push({
        path: `$.edges[${index}].from`,
        code: "missing_reference",
        message: `Edge source ${edge.from} does not exist.`,
      });
    }
    if (!nodeIndex.has(edge.to)) {
      issues.push({
        path: `$.edges[${index}].to`,
        code: "missing_reference",
        message: `Edge target ${edge.to} does not exist.`,
      });
    }
    if (edge.from === edge.to) {
      issues.push({
        path: `$.edges[${index}]`,
        code: "cycle",
        message: "Self edges are not allowed.",
      });
    }
    const key = `${edge.from}\u0000${edge.to}`;
    if (seenEdges.has(key)) {
      issues.push({
        path: `$.edges[${index}]`,
        code: "duplicate",
        message: `Edge ${edge.from} -> ${edge.to} is duplicated.`,
      });
    }
    seenEdges.add(key);
    if (nodeIndex.has(edge.from) && nodeIndex.has(edge.to) && edge.from !== edge.to) {
      adjacency.get(edge.from)!.push(edge.to);
      indegree.set(edge.to, indegree.get(edge.to)! + 1);
    }
  }

  if (!issues.some((issue) => issue.code === "missing_reference" || issue.code === "duplicate")) {
    const queue = graph.nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
    let visited = 0;
    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      visited += 1;
      for (const target of adjacency.get(nodeId)!) {
        indegree.set(target, indegree.get(target)! - 1);
        if (indegree.get(target) === 0) queue.push(target);
      }
    }
    if (visited !== graph.nodes.length) {
      const cyclic = graph.nodes
        .filter((node) => indegree.get(node.id)! > 0)
        .map((node) => node.id)
        .sort();
      issues.push({
        path: "$.edges",
        code: "cycle",
        message: `Graph contains a cycle involving: ${cyclic.join(", ")}.`,
      });
    }
  }

  const minimumCalls = graph.nodes.reduce((total, node) => total + minimumModelCalls(node), 0);
  if (graph.limits.maxModelCalls < minimumCalls) {
    issues.push({
      path: "$.limits.maxModelCalls",
      code: "budget_mismatch",
      message: `Graph needs at least ${minimumCalls} model calls for its declared nodes.`,
    });
  }
}

/** Validate and clone an untrusted plain-JSON graph with stable issue ordering. */
export function validateDagFusionGraphV1(value: unknown): DagFusionGraphValidationResult {
  const issues: DagFusionValidationIssue[] = [];
  let cloned: DagFusionJsonValue | typeof INVALID = INVALID;
  try {
    cloned = clonePlainJson(value, "$", {
      bytes: 0,
      maximumBytes: MAX_DAG_FUSION_GRAPH_BYTES,
      seen: new Set(),
      issues,
    });
  } catch {
    issues.push({
      path: "$",
      code: "invalid_type",
      message: "Graph must be inspectable plain JSON data.",
    });
    return { ok: false, issues };
  }
  if (cloned === INVALID) return { ok: false, issues };
  const root = plainRecord(cloned, "$", ["version", "id", "name", "limits", "nodes", "edges"], issues);
  if (!root) return { ok: false, issues };
  if (root.version !== DAG_FUSION_GRAPH_CONTRACT_VERSION) {
    issues.push({
      path: "$.version",
      code: "invalid_value",
      message: `Expected graph contract version ${DAG_FUSION_GRAPH_CONTRACT_VERSION}.`,
    });
  }
  const id = stringField(root.id, "$.id", issues, { maximumBytes: 64, pattern: IDENTIFIER });
  const name = root.name === undefined
    ? undefined
    : stringField(root.name, "$.name", issues, { maximumBytes: 256 });
  const limits = validateLimits(root.limits, "$.limits", issues);
  const nodes: DagFusionNodeV1[] = [];
  if (!Array.isArray(root.nodes)) {
    issues.push({ path: "$.nodes", code: "invalid_type", message: "Nodes must be an array." });
  } else if (root.nodes.length < 1 || root.nodes.length > MAX_DAG_FUSION_GRAPH_NODES) {
    issues.push({
      path: "$.nodes",
      code: "out_of_range",
      message: `Graph must contain 1 through ${MAX_DAG_FUSION_GRAPH_NODES} nodes.`,
    });
  } else {
    for (let index = 0; index < root.nodes.length; index += 1) {
      const node = validateNode(root.nodes[index], `$.nodes[${index}]`, issues);
      if (node) nodes.push(node);
    }
  }
  const edges: DagFusionEdgeV1[] = [];
  if (!Array.isArray(root.edges)) {
    issues.push({ path: "$.edges", code: "invalid_type", message: "Edges must be an array." });
  } else if (root.edges.length > MAX_DAG_FUSION_GRAPH_EDGES) {
    issues.push({
      path: "$.edges",
      code: "out_of_range",
      message: `Graph may contain at most ${MAX_DAG_FUSION_GRAPH_EDGES} edges.`,
    });
  } else {
    for (let index = 0; index < root.edges.length; index += 1) {
      const edgePath = `$.edges[${index}]`;
      const before = issues.length;
      const edge = plainRecord(root.edges[index], edgePath, ["from", "to"], issues);
      if (!edge) continue;
      const from = stringField(edge.from, `${edgePath}.from`, issues, { maximumBytes: 64, pattern: IDENTIFIER });
      const to = stringField(edge.to, `${edgePath}.to`, issues, { maximumBytes: 64, pattern: IDENTIFIER });
      if (issues.length === before) edges.push({ from: from!, to: to! });
    }
  }
  if (issues.length > 0 || !id || !limits || nodes.length !== (root.nodes as unknown[])?.length) {
    return { ok: false, issues };
  }
  const graph: DagFusionGraphV1 = {
    version: DAG_FUSION_GRAPH_CONTRACT_VERSION,
    id,
    ...(name === undefined ? {} : { name }),
    limits,
    nodes,
    edges,
  };
  validateSemanticGraph(graph, issues);
  return issues.length === 0 ? { ok: true, value: graph } : { ok: false, issues };
}

export function assertDagFusionGraphV1(value: unknown): DagFusionGraphV1 {
  const validation = validateDagFusionGraphV1(value);
  if (!validation.ok) {
    throw new DagFusionRuntimeError(
      "DAG graph does not satisfy dag-fusion-drive contract v1.",
      "DAG_FUSION_RUNTIME_INVALID_GRAPH",
      undefined,
      validation.issues,
    );
  }
  return validation.value;
}

export function sameDagFusionModelSelectorV1(
  left: DagFusionModelSelectorV1,
  right: DagFusionModelSelectorV1,
): boolean {
  return (
    left.provider === right.provider &&
    left.model === right.model &&
    left.auth.kind === right.auth.kind &&
    left.auth.profile === right.auth.profile &&
    left.reasoning === right.reasoning
  );
}

export function dagFusionExpectedModelSlotsV1(
  node: DagFusionNodeV1,
): Array<{ slot: string; requested: DagFusionModelSelectorV1 }> {
  if (node.kind === "agent") return [{ slot: "agent", requested: node.model }];
  return [
    ...node.fusion.members.map((member) => ({
      slot: `member:${member.id}`,
      requested: member.model,
    })),
    { slot: "judge", requested: node.fusion.judge },
  ];
}

function topologicalNodes(graph: DagFusionGraphV1): DagFusionNodeV1[] {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const indegree = new Map(graph.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(graph.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of graph.edges) {
    outgoing.get(edge.from)!.push(edge.to);
    indegree.set(edge.to, indegree.get(edge.to)! + 1);
  }
  const queue = graph.nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  const ordered: DagFusionNodeV1[] = [];
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    ordered.push(nodeById.get(nodeId)!);
    for (const target of outgoing.get(nodeId)!) {
      indegree.set(target, indegree.get(target)! - 1);
      if (indegree.get(target) === 0) {
        const targetIndex = graph.nodes.findIndex((node) => node.id === target);
        const insertion = queue.findIndex(
          (queued) => graph.nodes.findIndex((node) => node.id === queued) > targetIndex,
        );
        if (insertion === -1) queue.push(target);
        else queue.splice(insertion, 0, target);
      }
    }
  }
  return ordered;
}

function emptyUsage(): DagFusionUsageV1 {
  return { inputTokens: 0, outputTokens: 0, costUsd: 0, modelCalls: 0 };
}

function totalTokens(usage: DagFusionUsageV1): number {
  return usage.inputTokens + usage.outputTokens;
}

function addUsage(target: DagFusionUsageV1, added: DagFusionUsageV1): void {
  target.inputTokens += added.inputTokens;
  target.outputTokens += added.outputTokens;
  // USD limits are JSON decimals. Normalizing at twelve decimal places avoids
  // false budget exhaustion from binary additions such as 0.1 + 0.2.
  target.costUsd = Number((target.costUsd + added.costUsd).toFixed(12));
  target.modelCalls += added.modelCalls;
}

function cloneSelector(selector: DagFusionModelSelectorV1): DagFusionModelSelectorV1 {
  return {
    provider: selector.provider,
    model: selector.model,
    auth: selector.auth.profile === undefined
      ? { kind: selector.auth.kind }
      : { kind: selector.auth.kind, profile: selector.auth.profile },
    reasoning: selector.reasoning,
  };
}

function validateHostResult(
  value: unknown,
  node: DagFusionNodeV1,
  admission: DagFusionNodeAdmissionV1,
): DagFusionNodeExecutionResultV1 {
  const issues: DagFusionValidationIssue[] = [];
  const fail = (message: string): never => {
    throw new DagFusionRuntimeError(
      message,
      "DAG_FUSION_RUNTIME_INVALID_HOST_RESULT",
      node.id,
      issues,
    );
  };
  let cloned: DagFusionJsonValue | typeof INVALID = INVALID;
  try {
    cloned = clonePlainJson(value, "$result", {
      bytes: 0,
      maximumBytes: MAX_DAG_FUSION_NODE_RESULT_BYTES,
      seen: new Set(),
      issues,
    });
  } catch {
    fail("Trusted host result must be inspectable plain JSON data.");
  }
  if (cloned === INVALID) fail("Trusted host returned non-JSON or oversized data.");
  const result = plainRecord(cloned, "$result", ["output", "usage", "modelResolutions"], issues);
  if (!result || !("output" in result)) fail("Trusted host result is missing output.");
  const usageRecord = result ? plainRecord(
    result.usage,
    "$result.usage",
    ["inputTokens", "outputTokens", "costUsd", "modelCalls"],
    issues,
  ) : undefined;
  const usage = usageRecord ? {
    inputTokens: integerField(usageRecord.inputTokens, "$result.usage.inputTokens", issues, 0, 100_000_000),
    outputTokens: integerField(usageRecord.outputTokens, "$result.usage.outputTokens", issues, 0, 100_000_000),
    costUsd: usdField(usageRecord.costUsd, "$result.usage.costUsd", issues),
    modelCalls: integerField(usageRecord.modelCalls, "$result.usage.modelCalls", issues, 1, 10_000),
  } : undefined;
  if (!Array.isArray(result?.modelResolutions)) {
    issues.push({
      path: "$result.modelResolutions",
      code: "invalid_type",
      message: "Model resolutions must be an array.",
    });
  }
  const expected = dagFusionExpectedModelSlotsV1(node);
  const resolutions = new Map<string, DagFusionModelResolutionV1>();
  if (Array.isArray(result?.modelResolutions)) {
    for (let index = 0; index < result.modelResolutions.length; index += 1) {
      const path = `$result.modelResolutions[${index}]`;
      const entry = plainRecord(result.modelResolutions[index], path, ["slot", "requested", "resolved"], issues);
      if (!entry) continue;
      const slot = stringField(entry.slot, `${path}.slot`, issues, { maximumBytes: 128 });
      const requested = validateModel(entry.requested, `${path}.requested`, issues);
      const resolved = validateModel(entry.resolved, `${path}.resolved`, issues);
      if (slot && requested && resolved) {
        if (resolutions.has(slot)) {
          issues.push({ path: `${path}.slot`, code: "duplicate", message: `Resolution slot ${slot} is duplicated.` });
        } else {
          resolutions.set(slot, { slot, requested, resolved });
        }
      }
    }
  }
  const orderedResolutions: DagFusionModelResolutionV1[] = [];
  for (const expectedResolution of expected) {
    const reported = resolutions.get(expectedResolution.slot);
    if (!reported) {
      issues.push({
        path: "$result.modelResolutions",
        code: "missing_reference",
        message: `Missing model resolution for ${expectedResolution.slot}.`,
      });
      continue;
    }
    if (
      !sameDagFusionModelSelectorV1(reported.requested, expectedResolution.requested) ||
      !sameDagFusionModelSelectorV1(reported.resolved, expectedResolution.requested)
    ) {
      issues.push({
        path: `$result.modelResolutions.${expectedResolution.slot}`,
        code: "invalid_value",
        message: `Model slot ${expectedResolution.slot} did not resolve exactly as requested.`,
      });
    }
    orderedResolutions.push({
      slot: expectedResolution.slot,
      requested: cloneSelector(reported.requested),
      resolved: cloneSelector(reported.resolved),
    });
    resolutions.delete(expectedResolution.slot);
  }
  for (const extra of [...resolutions.keys()].sort()) {
    issues.push({
      path: "$result.modelResolutions",
      code: "missing_reference",
      message: `Unexpected model resolution slot ${extra}.`,
    });
  }
  if (issues.length > 0) fail("Trusted host result violates contract v1.");
  if (!usage) {
    throw new DagFusionRuntimeError(
      "Trusted host result is missing usage.",
      "DAG_FUSION_RUNTIME_INVALID_HOST_RESULT",
      node.id,
    );
  }
  const completeUsage: DagFusionUsageV1 = {
    inputTokens: usage.inputTokens!,
    outputTokens: usage.outputTokens!,
    costUsd: usage.costUsd!,
    modelCalls: usage.modelCalls!,
  };
  if (completeUsage.modelCalls < minimumModelCalls(node)) {
    throw new DagFusionRuntimeError(
      "Trusted host under-reported the node's minimum model calls.",
      "DAG_FUSION_RUNTIME_INVALID_HOST_RESULT",
      node.id,
    );
  }
  if (
    totalTokens(completeUsage) > admission.maxTokens ||
    completeUsage.costUsd > admission.maxCostUsd ||
    completeUsage.modelCalls > admission.maxModelCalls
  ) {
    throw new DagFusionRuntimeError(
      "Trusted host exceeded the node's admitted budget.",
      "DAG_FUSION_RUNTIME_BUDGET_EXCEEDED",
      node.id,
    );
  }
  return {
    output: result!.output as DagFusionJsonValue,
    usage: completeUsage,
    modelResolutions: orderedResolutions,
  };
}

function validRunId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 256 &&
    !/[\r\n]/.test(value)
  );
}

function isHostAbortSettlement(value: unknown): value is DagFusionHostAbortSettlementV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 2 &&
    record.contractVersion === DAG_FUSION_GRAPH_CONTRACT_VERSION &&
    record.status === "abort-settled"
  );
}

async function callHostWithDeadline<T>(
  nodeId: string,
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
  call: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (parentSignal?.aborted) {
    throw new DagFusionRuntimeError(
      "DAG execution was aborted before the node started.",
      "DAG_FUSION_RUNTIME_ABORTED",
      nodeId,
    );
  }
  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = () => controller.abort(parentSignal?.reason);
  let acknowledgeAbort: (() => void) | undefined;
  const abort = new Promise<"aborted">((resolve) => {
    acknowledgeAbort = () => resolve("aborted");
  });
  controller.signal.addEventListener("abort", () => {
    acknowledgeAbort?.();
  }, { once: true });
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  if (parentSignal?.aborted) onParentAbort();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("DAG node deadline exceeded."));
  }, timeoutMs);
  timer.unref?.();
  try {
    const hostCall = Promise.resolve().then(() => call(controller.signal));
    const hostSettlement = hostCall.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    const first = await Promise.race([hostSettlement, abort]);
    if (first !== "aborted" && !controller.signal.aborted) {
      if (first.status === "rejected") throw first.error;
      return first.value;
    }

    // Sending an AbortSignal is not evidence that provider work stopped or a
    // reservation reconciled. The trusted callback promise is the settlement
    // boundary, so keep the public call pending until it confirms settlement.
    // If host completion and abort became observable in the same turn, the
    // aborted signal wins. Reuse the already-observed settlement so a late
    // ordinary result cannot slip through a Promise.race ordering edge.
    const settled = first === "aborted" ? await hostSettlement : first;
    if (settled.status === "rejected") {
      throw new DagFusionRuntimeError(
        timedOut
          ? "Trusted host failed while settling a timed-out DAG node."
          : "Trusted host failed while settling an aborted DAG node.",
        "DAG_FUSION_RUNTIME_HOST_FAILED",
        nodeId,
        undefined,
        { cause: settled.error },
      );
    }
    if (!isHostAbortSettlement(settled.value)) {
      throw new DagFusionRuntimeError(
        timedOut
          ? "Trusted host did not confirm settlement for a timed-out DAG node."
          : "Trusted host did not confirm settlement for an aborted DAG node.",
        "DAG_FUSION_RUNTIME_HOST_FAILED",
        nodeId,
      );
    }
    throw new DagFusionRuntimeError(
      timedOut ? "DAG node execution timed out." : "DAG execution was aborted.",
      timedOut ? "DAG_FUSION_RUNTIME_TIMEOUT" : "DAG_FUSION_RUNTIME_ABORTED",
      nodeId,
    );
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

/**
 * Execute the validated v1 subset serially in stable topological order.
 * Serial execution is intentional: parallel scheduling and durable recovery
 * remain host/runtime policy outside this portable contract.
 */
export async function executeDagFusionGraphV1(
  value: unknown,
  host: DagFusionTrustedHostV1,
  options: ExecuteDagFusionGraphOptionsV1,
): Promise<DagFusionGraphExecutionResultV1> {
  const graph = assertDagFusionGraphV1(value);
  if (!options || typeof options !== "object" || !validRunId(options.runId)) {
    throw new DagFusionRuntimeError(
      "runId must be a non-empty bounded identifier without newlines.",
      "DAG_FUSION_RUNTIME_INVALID_RUN",
    );
  }
  if (!host || typeof host.executeAgent !== "function" || typeof host.executeFusion !== "function") {
    throw new DagFusionRuntimeError(
      "A trusted host must implement executeAgent and executeFusion.",
      "DAG_FUSION_RUNTIME_HOST_FAILED",
    );
  }
  const startedAt = Date.now();
  const usage = emptyUsage();
  const completed: DagFusionCompletedNodeV1[] = [];
  const outputByNode = new Map<string, DagFusionJsonValue>();
  for (const node of topologicalNodes(graph)) {
    if (options.signal?.aborted) {
      throw new DagFusionRuntimeError(
        "DAG execution was aborted.",
        "DAG_FUSION_RUNTIME_ABORTED",
        node.id,
      );
    }
    const graphTimeRemaining = graph.limits.timeoutMs - (Date.now() - startedAt);
    const graphTokensRemaining = graph.limits.maxTokens - totalTokens(usage);
    const graphCostRemaining = graph.limits.maxCostUsd - usage.costUsd;
    const graphCallsRemaining = graph.limits.maxModelCalls - usage.modelCalls;
    const admission: DagFusionNodeAdmissionV1 = {
      timeoutMs: Math.min(node.limits.timeoutMs, graphTimeRemaining),
      maxTokens: Math.min(node.limits.maxTokens, graphTokensRemaining),
      maxCostUsd: Math.min(node.limits.maxCostUsd, graphCostRemaining),
      maxModelCalls: Math.min(node.limits.maxModelCalls, graphCallsRemaining),
    };
    if (
      admission.timeoutMs < 1 ||
      admission.maxTokens < 1 ||
      admission.maxCostUsd < 0 ||
      admission.maxModelCalls < minimumModelCalls(node)
    ) {
      throw new DagFusionRuntimeError(
        "The graph has no remaining budget to admit this node.",
        "DAG_FUSION_RUNTIME_BUDGET_EXCEEDED",
        node.id,
      );
    }
    const inbound = graph.edges
      .filter((edge) => edge.to === node.id)
      .map((edge) => ({ fromNodeId: edge.from, output: outputByNode.get(edge.from)! }));
    let rawResult: DagFusionHostExecutionOutcomeV1;
    try {
      rawResult = await callHostWithDeadline(
        node.id,
        admission.timeoutMs,
        options.signal,
        (signal) => {
          const request = {
            contractVersion: DAG_FUSION_GRAPH_CONTRACT_VERSION,
            runId: options.runId,
            graphId: graph.id,
            node: structuredClone(node),
            inbound: structuredClone(inbound),
            admission: { ...admission },
            signal,
          };
          return node.kind === "agent"
            ? host.executeAgent(request as DagFusionAgentExecutionRequestV1)
            : host.executeFusion(request as DagFusionFusionExecutionRequestV1);
        },
      );
    } catch (error) {
      if (error instanceof DagFusionRuntimeError) throw error;
      throw new DagFusionRuntimeError(
        `Trusted host failed while executing node ${node.id}.`,
        "DAG_FUSION_RUNTIME_HOST_FAILED",
        node.id,
        undefined,
        { cause: error },
      );
    }
    const result = validateHostResult(rawResult, node, admission);
    addUsage(usage, result.usage);
    outputByNode.set(node.id, result.output);
    completed.push({ nodeId: node.id, ...result });
  }
  const hasOutgoing = new Set(graph.edges.map((edge) => edge.from));
  return {
    contractVersion: DAG_FUSION_GRAPH_CONTRACT_VERSION,
    runId: options.runId,
    graphId: graph.id,
    nodes: completed,
    terminalNodeIds: graph.nodes.filter((node) => !hasOutgoing.has(node.id)).map((node) => node.id),
    usage,
  };
}

export interface DagFusionDelegationPlanV1 {
  request: OwnedDelegationV2Request;
  reconcileUsage(
    settlement: DagFusionDelegationUsageSettlement,
  ): void | Promise<void>;
  onStarted?: DelegateDagFusionNodeOptions["onStarted"];
  onUpdate?: DelegateDagFusionNodeOptions["onUpdate"];
}

/** Adapter options for hosts that use the package's owned Delegation V2 client. */
export interface DagFusionDelegatingTrustedHostOptionsV1 {
  delegationHost: Pick<DagFusionDelegationHost, "delegate">;
  prepareAgent(
    request: DagFusionAgentExecutionRequestV1,
  ): DagFusionDelegationPlanV1 | Promise<DagFusionDelegationPlanV1>;
  mapAgentReceipt(
    receipt: DagFusionDelegationReceipt,
    request: DagFusionAgentExecutionRequestV1,
  ): DagFusionNodeExecutionResultV1 | Promise<DagFusionNodeExecutionResultV1>;
  executeFusion(
    request: DagFusionFusionExecutionRequestV1,
  ): Promise<DagFusionHostExecutionOutcomeV1>;
}

const RECONCILED_DELEGATION_ABORT_CODES = new Set<DagFusionDelegationErrorCode>([
  "DAG_FUSION_ABORTED",
  "DAG_FUSION_CANCELLED",
  "DAG_FUSION_DISPOSED",
  "DAG_FUSION_TIMEOUT",
]);

/**
 * Compose contract-v1 agent nodes with the existing owned Delegation V2
 * client. Ownership IDs, deadline, signal, token ceiling, and cost ceiling are
 * enforced here; model-reference mapping remains an explicit host concern.
 */
export function createDagFusionDelegatingTrustedHostV1(
  options: DagFusionDelegatingTrustedHostOptionsV1,
): DagFusionTrustedHostV1 {
  return {
    async executeAgent(request) {
      const plan = await options.prepareAgent(request);
      if (
        !plan ||
        typeof plan !== "object" ||
        !plan.request ||
        plan.request.ownerRunId !== request.runId ||
        plan.request.nodeId !== request.node.id ||
        !Number.isSafeInteger(plan.request.timeoutMs) ||
        plan.request.timeoutMs < 1 ||
        plan.request.timeoutMs > request.admission.timeoutMs ||
        typeof plan.reconcileUsage !== "function"
      ) {
        throw new DagFusionRuntimeError(
          "Delegation plan must preserve run/node ownership and fit the admitted deadline.",
          "DAG_FUSION_RUNTIME_INVALID_DELEGATION_PLAN",
          request.node.id,
        );
      }
      let receipt: DagFusionDelegationReceipt;
      let usageReconciled = false;
      const reconcileUsage = async (
        settlement: DagFusionDelegationUsageSettlement,
      ): Promise<void> => {
        await plan.reconcileUsage(settlement);
        usageReconciled = true;
      };
      try {
        receipt = await options.delegationHost.delegate(plan.request, {
          limits: {
            maxTokens: request.admission.maxTokens,
            maxCostUsd: request.admission.maxCostUsd,
          },
          reconcileUsage,
          signal: request.signal,
          ...(plan.onStarted === undefined ? {} : { onStarted: plan.onStarted }),
          ...(plan.onUpdate === undefined ? {} : { onUpdate: plan.onUpdate }),
        });
      } catch (error) {
        if (
          request.signal.aborted &&
          error instanceof DagFusionDelegationError &&
          RECONCILED_DELEGATION_ABORT_CODES.has(error.code)
        ) {
          // A pre-aborted or already-disposed host can reject before taking
          // ownership and therefore before invoking the supplied reconciler.
          // Close that reservation explicitly before acknowledging settlement.
          if (!usageReconciled) {
            await reconcileUsage({
              identity: {
                requestId: plan.request.requestId,
                ownerRunId: plan.request.ownerRunId,
                nodeId: plan.request.nodeId,
              },
              reason: "caller-aborted",
              progress: {
                started: false,
                tokens: 0,
                toolCalls: 0,
                durationMs: 0,
              },
            });
          }
          return dagFusionHostAbortSettledV1();
        }
        throw error;
      }
      return options.mapAgentReceipt(receipt, request);
    },
    executeFusion(request) {
      return options.executeFusion(request);
    },
  };
}
