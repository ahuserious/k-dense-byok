import fs from "node:fs";
import { promptOptimizationNodeDemand, validatePromptOptimizationNode } from "./prompt-opt-node.ts";
import { s4NodeBindingIssues } from "../agent/workflow-delegation-session.ts";
import path from "node:path";
import { Value } from "typebox/value";
import { isWithin } from "../sandbox-fs.ts";
import {
  workflowHarnessDefinition,
  type WorkflowHarnessId,
} from "./harness-registry.ts";
import {
  MAX_WORKFLOW_DOCUMENT_BYTES,
  WorkflowGraphDocumentSchema,
  type EvidencePolicy,
  type ModelRequest,
  type NodeSpecV1,
  type NodeLimits,
  type RequestedModel,
  type RescuePolicy,
  type WorkflowEdge,
  type WorkflowGraphDocument,
  type WorkflowNode,
} from "./schema.ts";
import {
  effectiveWorkflowEvidencePolicy,
  requiresWorkflowEvidencePolicyEvaluation,
  workflowEvidenceGateEvaluator,
  workflowEvidencePolicyEvaluator,
} from "./evidence-policy.ts";
import {
  pendingNodeKindSpecEnforcements,
  pendingNodeSpecEnforcementMessage,
  pendingNodeSpecEnforcements,
  pendingWorkflowSettingsEnforcements,
} from "./node-spec-enforcement.ts";
import {
  effectiveHostedFusionDefinition,
  type HostedOpenRouterFusionNode,
} from "./hosted-fusion-definition.ts";

export interface WorkflowValidationIssue {
  code: string;
  path: string;
  message: string;
}

export type WorkflowValidationResult =
  | { ok: true; document: WorkflowGraphDocument }
  | { ok: false; issues: WorkflowValidationIssue[] };

export const DEFAULT_WORKFLOW_RESCUE_POLICY: RescuePolicy = {
  enabled: true,
  maxAttempts: 2,
  triggers: [
    "failure",
    "stalled",
    "unsupported-output",
    "pre-compaction",
    "post-compaction",
  ],
};

export const DEFAULT_NODE_SPEC_V1 = {
  version: 1,
  reasoningEffort: "high",
  hyperparameters: { temperature: 1, top_p: 1, sampling: {} },
  conditions: { exists: [] },
  harness: "pi",
  databases: [],
  skills: { mode: "auto", list: [] },
  subagents: { mode: "auto" },
  autonomy: "strict",
  deliberation: {
    bestOfNPersonalityCount: 2,
    mimeographs: { mode: "auto", personalityRefs: [] },
  },
  billingMode: "inherit",
} as const;

export interface ResolvedNodeSpecV1 {
  version: 1;
  model?: ModelRequest;
  reasoningEffort: RequestedModel["reasoning"];
  hyperparameters: {
    temperature: number;
    top_p: number;
    sampling: Record<string, string | number | boolean>;
  };
  conditions: { when?: string; exists: string[] };
  harness: WorkflowHarnessId;
  databases: string[];
  skills: { mode: "auto" | "auto-manual" | "manual"; list: string[] };
  subagents: { mode: "auto" | "auto-manual" };
  autonomy: "strict" | "loose";
  deliberation: {
    personalityStoreRef?: string;
    bestOfNPersonalityCount: number;
    mimeographs: {
      mode: "auto" | "manual";
      personalityRefs: string[];
    };
  };
  billingMode: "inherit" | "api" | "subscription";
  budget: { maxTokens: number; maxCostUsd: number };
}

/**
 * Apply canonical defaults without repairing invalid references or topology.
 * Invalid input stays invalid and is reported by validateWorkflowGraphDocument.
 */
export function normalizeWorkflowGraphDocument(
  document: WorkflowGraphDocument,
): WorkflowGraphDocument {
  const normalized = structuredClone(document);
  normalized.rescue = cloneRescuePolicy(
    normalized.rescue ?? DEFAULT_WORKFLOW_RESCUE_POLICY,
  );
  normalized.artifacts ??= [];
  normalized.nodes = normalized.nodes.map(normalizeNode);
  normalized.edges = normalized.edges.map((edge) => ({
    ...edge,
    condition: edge.condition ?? "always",
  }));
  return normalized;
}

export function validateWorkflowGraphDocument(
  value: unknown,
): WorkflowValidationResult {
  let serializedDocument: string | undefined;
  try {
    serializedDocument = JSON.stringify(value);
  } catch {
    return {
      ok: false,
      issues: [{ code: "schema", path: "/", message: "Document must be JSON serializable." }],
    };
  }
  if (serializedDocument === undefined) {
    return {
      ok: false,
      issues: [{ code: "schema", path: "/", message: "Document must be a JSON value." }],
    };
  }
  if (new TextEncoder().encode(serializedDocument).byteLength > MAX_WORKFLOW_DOCUMENT_BYTES) {
    return {
      ok: false,
      issues: [
        {
          code: "document-too-large",
          path: "/",
          message: `Serialized workflow exceeds ${MAX_WORKFLOW_DOCUMENT_BYTES} bytes.`,
        },
      ],
    };
  }

  const schemaIssues = [...Value.Errors(WorkflowGraphDocumentSchema, value)].map(
    (error): WorkflowValidationIssue => ({
      code: "schema",
      path: error.instancePath || "/",
      message: error.message,
    }),
  );
  if (schemaIssues.length > 0) return { ok: false, issues: schemaIssues };

  const document = value as WorkflowGraphDocument;
  const semanticIssues = validateWorkflowGraphSemantics(document);
  if (semanticIssues.length > 0) return { ok: false, issues: semanticIssues };

  return { ok: true, document: normalizeWorkflowGraphDocument(document) };
}

/** Validate constraints that JSON Schema cannot express. */
export function validateWorkflowGraphSemantics(
  document: WorkflowGraphDocument,
): WorkflowValidationIssue[] {
  const issues: WorkflowValidationIssue[] = [];
  let maximumConfiguredModelCalls = 0;
  let maximumConfiguredIterations = 0;
  const nodeById = uniqueItemsById(document.nodes, "/nodes", "duplicate-node-id", issues);
  const artifactById = uniqueItemsById(
    document.artifacts ?? [],
    "/artifacts",
    "duplicate-artifact-id",
    issues,
  );
  validateScientificWorkflowPreconditionKeys(document, issues);

  for (const finding of pendingWorkflowSettingsEnforcements(document.settings)) {
    issues.push({
      code: finding.code,
      path: `/settings/${finding.pathSuffix}`,
      message: pendingNodeSpecEnforcementMessage(finding),
    });
  }

  validateRescuePolicy(
    document.rescue ?? DEFAULT_WORKFLOW_RESCUE_POLICY,
    "/rescue",
    issues,
  );
  validateEvidenceRescueAvailability(
    document.evidence,
    document.rescue ?? DEFAULT_WORKFLOW_RESCUE_POLICY,
    "/evidence/onUnsupportedOutput",
    issues,
  );
  if (document.evidence.evaluator) {
    validateModelRequest(document.evidence.evaluator, "/evidence/evaluator", issues);
  }
  if (document.defaultModel) {
    validateModelRequest(document.defaultModel, "/defaultModel", issues);
  }

  for (const [index, node] of document.nodes.entries()) {
    const nodePath = `/nodes/${index}`;
    validateNode(node, nodePath, document, artifactById, issues);
    const demand = deriveWorkflowNodeDemand(node, document);
    validateWorkflowNodeDemand(node, nodePath, document, demand, issues);
    maximumConfiguredModelCalls += demand.maximumModelCalls;
    maximumConfiguredIterations += demand.maximumIterations;
  }
  if (maximumConfiguredModelCalls > document.limits.maxModelCalls) {
    issues.push({
      code: "workflow-model-call-demand-exceeds-limit",
      path: "/limits/maxModelCalls",
      message:
        `The configured compound-node paths can require up to ${maximumConfiguredModelCalls} ` +
        `model calls before retries or rescue, exceeding the workflow limit ${document.limits.maxModelCalls}.`,
    });
  }
  if (maximumConfiguredIterations > document.limits.maxIterations) {
    issues.push({
      code: "workflow-iteration-demand-exceeds-limit",
      path: "/limits/maxIterations",
      message:
        `The configured compound nodes can require up to ${maximumConfiguredIterations} ` +
        `bounded iterations, exceeding the workflow limit ${document.limits.maxIterations}.`,
    });
  }
  validateWorkspaceOwnership(document.nodes, issues);

  for (const [index, artifact] of (document.artifacts ?? []).entries()) {
    const writerNode = nodeById.get(artifact.writerNodeId);
    if (!writerNode) {
      issues.push({
        code: "unknown-artifact-writer",
        path: `/artifacts/${index}/writerNodeId`,
        message: `Artifact ${artifact.id} names unknown writer node ${artifact.writerNodeId}.`,
      });
      continue;
    }
    if (writerNode.workspace.isolation === "read-only") {
      issues.push({
        code: "read-only-artifact-writer",
        path: `/artifacts/${index}/writerNodeId`,
        message: `Artifact writer ${writerNode.id} is declared read-only.`,
      });
    }
    if (artifact.path) {
      const normalizedArtifactPath = normalizeWorkflowProjectPath(artifact.path);
      if (normalizedArtifactPath === undefined) {
        issues.push({
          code: "unsafe-artifact-path",
          path: `/artifacts/${index}/path`,
          message: "Artifact paths must use canonical, portable sandbox-relative syntax.",
        });
      } else {
        const ownedByWriter = writerNode.workspace.writePaths.some((writePath) => {
          const normalizedWritePath = normalizeWorkflowProjectPath(writePath);
          return (
            normalizedWritePath !== undefined &&
            pathIsSameOrDescendant(normalizedArtifactPath, normalizedWritePath)
          );
        });
        if (!ownedByWriter) {
          issues.push({
            code: "artifact-outside-write-paths",
            path: `/artifacts/${index}/path`,
            message: `Artifact path ${artifact.path} is not owned by writer ${writerNode.id}.`,
          });
        }
      }
    }
  }

  validateGraphTopology(document, nodeById, issues);
  return issues;
}

function validateScientificWorkflowPreconditionKeys(
  document: WorkflowGraphDocument,
  issues: WorkflowValidationIssue[],
): void {
  if (!document.preconditions) return;
  const keyedRequirements = [
    ["/preconditions/requiredInputs", document.preconditions.requiredInputs],
    ["/preconditions/requiredFiles", document.preconditions.requiredFiles],
  ] as const;
  for (const [requirementPath, requirements] of keyedRequirements) {
    const seenKeys = new Set<string>();
    for (const [index, requirement] of requirements.entries()) {
      if (seenKeys.has(requirement.key)) {
        issues.push({
          code: "duplicate-precondition-key",
          path: `${requirementPath}/${index}/key`,
          message: `Duplicate precondition key ${requirement.key}.`,
        });
      }
      seenKeys.add(requirement.key);
    }
  }
}

function normalizeNode(node: WorkflowNode): WorkflowNode {
  if (node.kind === "best-of-n") {
    return {
      ...node,
      candidateCount: node.candidateCount ?? node.candidateModels?.length ?? 2,
    };
  }
  return node;
}

function cloneRescuePolicy(policy: RescuePolicy): RescuePolicy {
  return { ...policy, triggers: [...policy.triggers] };
}

function inheritedNodeModel(
  node: WorkflowNode,
  document: WorkflowGraphDocument,
): ModelRequest | undefined {
  if (
    node.kind === "agent" || node.kind === "research-until-goal" ||
    node.kind === "best-of-n"
  ) {
    return node.model ?? document.defaultModel;
  }
  return document.defaultModel;
}

/** Resolve optional NodeSpec v1 fields without mutating the persisted graph. */
export function resolveNodeSpecV1(
  document: WorkflowGraphDocument,
  node: WorkflowNode,
  legacyModel?: ModelRequest,
  applySettingsModel = true,
): ResolvedNodeSpecV1 {
  const settings: NodeSpecV1 = node.settings ?? {};
  const model = applySettingsModel
    ? settings.model ?? legacyModel ?? inheritedNodeModel(node, document)
    : legacyModel;
  const reasoningOverride =
    node.kind === "fusion" &&
      node.fusion.mode === "openrouter-router" &&
      settings.reasoningEffort === "high"
      ? undefined
      : settings.reasoningEffort;
  const reasoningEffort =
    settings.reasoningEffort ?? model?.requested.reasoning ??
    DEFAULT_NODE_SPEC_V1.reasoningEffort;
  const executableModel = model === undefined
    ? undefined
    : modelRequestWithReasoningOverride(model, reasoningOverride);
  const effectiveLimits = effectiveNodeLimits(node, document);
  const workflowDatabases = document.settings?.databases ?? [];
  const nodeDatabases = settings.databases ?? [];
  return {
    version: 1,
    ...(executableModel ? { model: executableModel } : {}),
    reasoningEffort,
    hyperparameters: {
      temperature:
        settings.hyperparameters?.temperature ??
        DEFAULT_NODE_SPEC_V1.hyperparameters.temperature,
      top_p:
        settings.hyperparameters?.top_p ??
        DEFAULT_NODE_SPEC_V1.hyperparameters.top_p,
      sampling: { ...(settings.hyperparameters?.sampling ?? {}) },
    },
    conditions: {
      ...(settings.conditions?.when ? { when: settings.conditions.when } : {}),
      exists: [...(settings.conditions?.exists ?? [])],
    },
    harness:
      settings.harness ?? document.settings?.defaultHarness ??
      DEFAULT_NODE_SPEC_V1.harness,
    databases: [...new Set([...workflowDatabases, ...nodeDatabases])],
    skills: {
      mode: settings.skills?.mode ?? DEFAULT_NODE_SPEC_V1.skills.mode,
      list: [...(settings.skills?.list ?? [])],
    },
    subagents: {
      mode: settings.subagents?.mode ?? DEFAULT_NODE_SPEC_V1.subagents.mode,
    },
    autonomy: settings.autonomy ?? DEFAULT_NODE_SPEC_V1.autonomy,
    deliberation: {
      ...(settings.deliberation?.personalityStoreRef
        ? { personalityStoreRef: settings.deliberation.personalityStoreRef }
        : {}),
      bestOfNPersonalityCount:
        settings.deliberation?.bestOfNPersonalityCount ??
        DEFAULT_NODE_SPEC_V1.deliberation.bestOfNPersonalityCount,
      mimeographs: {
        mode:
          settings.deliberation?.mimeographs?.mode ??
          DEFAULT_NODE_SPEC_V1.deliberation.mimeographs.mode,
        personalityRefs: [
          ...(settings.deliberation?.mimeographs?.personalityRefs ?? []),
        ],
      },
    },
    billingMode: settings.billingMode ?? DEFAULT_NODE_SPEC_V1.billingMode,
    budget: {
      maxTokens: effectiveLimits.maxTokens,
      maxCostUsd: effectiveLimits.maxCostUsd,
    },
  };
}

function modelRequestWithReasoningOverride(
  request: ModelRequest,
  reasoningEffort: RequestedModel["reasoning"] | undefined,
): ModelRequest {
  const resolved = structuredClone(request);
  if (reasoningEffort === undefined) return resolved;
  resolved.requested.reasoning = reasoningEffort;
  if (resolved.resolution.mode === "explicit-fallback") {
    for (const alternative of resolved.resolution.alternatives) {
      alternative.reasoning = reasoningEffort;
    }
  }
  return resolved;
}

export interface WorkflowNodeDemand {
  minimumModelCalls: number;
  maximumModelCalls: number;
  maximumIterations: number;
  minimumConcurrentSubagents: 0 | 1;
  preferredParallelism: number;
  /** Shared hard envelopes; runtime accounting remains cumulative across nodes. */
  maxTokens: number;
  maxCostUsd: number;
}

function effectiveNodeLimits(
  node: WorkflowNode,
  document: WorkflowGraphDocument,
): WorkflowGraphDocument["limits"] {
  return {
    maxIterations: node.limits?.maxIterations ?? document.limits.maxIterations,
    maxModelCalls: node.limits?.maxModelCalls ?? document.limits.maxModelCalls,
    maxParallelism: node.limits?.maxParallelism ?? document.limits.maxParallelism,
    maxSubagents: node.limits?.maxSubagents ?? document.limits.maxSubagents,
    timeoutMs: node.limits?.timeoutMs ?? document.limits.timeoutMs,
    maxTokens: Math.min(
      node.limits?.maxTokens ?? document.limits.maxTokens,
      node.settings?.budget?.maxTokens ?? document.limits.maxTokens,
    ),
    maxCostUsd: Math.min(
      node.limits?.maxCostUsd ?? document.limits.maxCostUsd,
      node.settings?.budget?.maxCostUsd ?? document.limits.maxCostUsd,
    ),
    maxRetries: node.limits?.maxRetries ?? document.limits.maxRetries,
  };
}

/**
 * Derive structural demand from one normalized node. Token/cost values are the
 * node's effective share of the run-wide envelope, not predicted spend.
 */
export function deriveWorkflowNodeDemand(
  node: WorkflowNode,
  document: WorkflowGraphDocument,
): WorkflowNodeDemand {
  const limits = effectiveNodeLimits(node, document);
  let minimumModelCalls = 0;
  let maximumModelCalls = 0;
  let maximumIterations = 1;
  let preferredParallelism = 1;

  switch (node.kind) {
    case "agent":
      minimumModelCalls = maximumModelCalls = 1;
      break;
    case "research-until-goal":
      minimumModelCalls = 1;
      maximumModelCalls = limits.maxIterations;
      maximumIterations = limits.maxIterations;
      break;
    case "council":
      minimumModelCalls = maximumModelCalls = (node.members.length + 1) * node.rounds;
      maximumIterations = node.rounds;
      preferredParallelism = node.members.length;
      break;
    case "fusion":
      if (node.fusion.mode === "openrouter-router") {
        // Hosted Fusion performs each panel analysis plus analyst deliberation
        // and final-answer generation, despite being one HTTP router request.
        minimumModelCalls = maximumModelCalls = node.fusion.members.length + 2;
        preferredParallelism = 0;
      } else {
        minimumModelCalls = maximumModelCalls =
          node.fusion.members.length * node.fusion.rounds + 1;
        maximumIterations = node.fusion.rounds;
        preferredParallelism = node.fusion.members.length;
      }
      break;
    case "prompt-optimization": ({ minimumModelCalls, maximumModelCalls, maximumIterations, preferredParallelism } = promptOptimizationNodeDemand(node)); break;
    case "best-of-n": {
      const candidateCount =
        node.candidateCount ?? node.candidateModels?.length ?? 2;
      minimumModelCalls = maximumModelCalls = candidateCount + 1;
      preferredParallelism = candidateCount;
      break;
    }
    case "evidence-gate": {
      const usesModel = node.evaluator !== undefined ||
        node.checks.some((check) => check !== "artifact-exists");
      minimumModelCalls = maximumModelCalls = usesModel ? 1 : 0;
      preferredParallelism = usesModel ? 1 : 0;
      break;
    }
    case "lean4":
      minimumModelCalls = maximumModelCalls = node.mode === "solve" ? 1 : 0;
      preferredParallelism = node.mode === "solve" ? 1 : 0;
      break;
  }

  if (requiresWorkflowEvidencePolicyEvaluation(document, node)) {
    minimumModelCalls += 1;
    maximumModelCalls += 1;
    preferredParallelism = Math.max(preferredParallelism, 1);
  }

  const needsKadySubagent =
    maximumModelCalls > 0 &&
    !(
      node.kind === "fusion" && node.fusion.mode === "openrouter-router" &&
      !requiresWorkflowEvidencePolicyEvaluation(document, node)
    );
  return {
    minimumModelCalls,
    maximumModelCalls,
    maximumIterations,
    minimumConcurrentSubagents: needsKadySubagent ? 1 : 0,
    preferredParallelism,
    maxTokens: limits.maxTokens,
    maxCostUsd: limits.maxCostUsd,
  };
}

function validateWorkflowNodeDemand(
  node: WorkflowNode,
  nodePath: string,
  document: WorkflowGraphDocument,
  demand: WorkflowNodeDemand,
  issues: WorkflowValidationIssue[],
): void {
  const limits = effectiveNodeLimits(node, document);
  if (demand.maximumModelCalls > limits.maxModelCalls) {
    issues.push({
      code: "node-model-call-demand-exceeds-limit",
      path: `${nodePath}/limits/maxModelCalls`,
      message:
        `${node.kind} can require ${demand.maximumModelCalls} model calls before retries or rescue, ` +
        `but its effective limit is ${limits.maxModelCalls}.`,
    });
  }
  if (demand.maximumIterations > limits.maxIterations) {
    issues.push({
      code: "node-iteration-demand-exceeds-limit",
      path: `${nodePath}/limits/maxIterations`,
      message:
        `${node.kind} requires ${demand.maximumIterations} bounded iterations, ` +
        `but its effective limit is ${limits.maxIterations}.`,
    });
  }
  if (demand.minimumConcurrentSubagents > limits.maxSubagents) {
    issues.push({
      code: "node-subagent-demand-exceeds-limit",
      path: `${nodePath}/limits/maxSubagents`,
      message:
        `${node.kind} requires a Pi-subagent execution slot, but its effective maxSubagents limit is zero.`,
    });
  }
}

function uniqueItemsById<T extends { id: string }>(
  items: T[],
  path: string,
  code: string,
  issues: WorkflowValidationIssue[],
): Map<string, T> {
  const uniqueItems = new Map<string, T>();
  for (const [index, item] of items.entries()) {
    if (uniqueItems.has(item.id)) {
      issues.push({
        code,
        path: `${path}/${index}/id`,
        message: `Duplicate id ${item.id}.`,
      });
      continue;
    }
    uniqueItems.set(item.id, item);
  }
  return uniqueItems;
}

function nodeHasModelOrEvidenceEvaluatorSlot(
  node: WorkflowNode,
  document: WorkflowGraphDocument,
): boolean {
  if (
    requiresWorkflowEvidencePolicyEvaluation(document, node) &&
    workflowEvidencePolicyEvaluator(document, node) !== undefined
  ) {
    return true;
  }

  switch (node.kind) {
    case "agent":
    case "research-until-goal":
      return node.settings?.model !== undefined || node.model !== undefined ||
        document.defaultModel !== undefined;
    case "council":
    case "fusion":
      return true;
    case "prompt-optimization": return true;
    case "best-of-n":
      return node.candidateModels !== undefined || node.settings?.model !== undefined ||
        node.model !== undefined || node.evaluator !== undefined ||
        document.defaultModel !== undefined;
    case "evidence-gate":
      return (
        node.evaluator !== undefined ||
        node.checks.some((check) => check !== "artifact-exists")
      ) && workflowEvidenceGateEvaluator(document, node) !== undefined;
    case "lean4":
      return node.mode === "solve" &&
        (node.settings?.model !== undefined || node.solverModel !== undefined ||
          document.defaultModel !== undefined);
  }
}

function validateNode(
  node: WorkflowNode,
  nodePath: string,
  document: WorkflowGraphDocument,
  artifactById: Map<string, { id: string }>,
  issues: WorkflowValidationIssue[],
): void {
  if (node.limits) validateNodeLimits(node.limits, nodePath, document, issues);
  issues.push(...s4NodeBindingIssues(resolveNodeSpecV1(document, node), `${nodePath}/settings`));
  for (const finding of pendingNodeSpecEnforcements(node.settings)) {
    if (finding.unit === "S5") continue;
    issues.push({
      code: finding.code,
      path: `${nodePath}/settings/${finding.pathSuffix}`,
      message: pendingNodeSpecEnforcementMessage(finding),
    });
  }
  for (const finding of pendingNodeKindSpecEnforcements(node)) {
    if (finding.unit === "S5") continue;
    issues.push({
      code: finding.code,
      path: `${nodePath}/settings/${finding.pathSuffix}`,
      message: pendingNodeSpecEnforcementMessage(finding),
    });
  }
  const resolveModel = (
    legacyModel?: ModelRequest,
    inheritNodeModel = true,
    applySettingsModel = true,
  ): ModelRequest | undefined => {
    if (
      !inheritNodeModel &&
      !legacyModel &&
      (!applySettingsModel || !node.settings?.model)
    ) return undefined;
    return resolveNodeSpecV1(document, node, legacyModel, applySettingsModel).model;
  };
  const nodeSpecModel = node.settings?.model ? resolveModel() : undefined;
  if (nodeSpecModel) {
    validateModelRequest(nodeSpecModel, `${nodePath}/settings/model`, issues);
  }
  const validateResolvedModel = (
    legacyModel: ModelRequest | undefined,
    legacyPath: string,
    inheritNodeModel = true,
    applySettingsModel = true,
  ): ModelRequest | undefined => {
    const resolvedModel = resolveModel(
      legacyModel,
      inheritNodeModel,
      applySettingsModel,
    );
    if (resolvedModel && (!nodeSpecModel || !applySettingsModel)) {
      validateModelRequest(resolvedModel, legacyPath, issues);
    }
    return resolvedModel;
  };
  if (
    node.settings?.budget?.maxTokens !== undefined &&
    node.settings.budget.maxTokens > document.limits.maxTokens
  ) {
    issues.push({
      code: "node-budget-exceeds-workflow-limit",
      path: `${nodePath}/settings/budget/maxTokens`,
      message: "NodeSpec maxTokens cannot exceed the workflow maxTokens limit.",
    });
  }
  if (
    node.settings?.budget?.maxCostUsd !== undefined &&
    node.settings.budget.maxCostUsd > document.limits.maxCostUsd
  ) {
    issues.push({
      code: "node-budget-exceeds-workflow-limit",
      path: `${nodePath}/settings/budget/maxCostUsd`,
      message: "NodeSpec maxCostUsd cannot exceed the workflow maxCostUsd limit.",
    });
  }
  if (node.rescue) validateRescuePolicy(node.rescue, `${nodePath}/rescue`, issues);
  if (node.evidence) {
    if (node.evidence.evaluator) {
      validateResolvedModel(
        node.evidence.evaluator,
        `${nodePath}/evidence/evaluator`,
        false,
        false,
      );
    }
    validateEvidenceRescueAvailability(
      node.evidence,
      node.rescue ?? document.rescue ?? DEFAULT_WORKFLOW_RESCUE_POLICY,
      `${nodePath}/evidence/onUnsupportedOutput`,
      issues,
    );
  }
  if (
    requiresWorkflowEvidencePolicyEvaluation(document, node) &&
    !resolveModel(workflowEvidencePolicyEvaluator(document, node), false, false)
  ) {
    issues.push({
      code: "missing-evidence-policy-evaluator",
      path: `${nodePath}/evidence/evaluator`,
      message:
        "Enabled evidence policy requires a node evaluator, workflow evaluator, or workflow default model.",
    });
  }
  validateWorkspacePolicy(node, nodePath, issues);
  validateDeliberationNodeSpec(node, nodePath, issues);
  validateHarnessReachesDispatch(document, node, nodePath, issues);

  if (
    node.settings?.reasoningEffort !== undefined &&
    node.settings.reasoningEffort !== DEFAULT_NODE_SPEC_V1.reasoningEffort &&
    !nodeHasModelOrEvidenceEvaluatorSlot(node, document)
  ) {
    issues.push({
      code: "slotless-node-reasoning-effort",
      path: `${nodePath}/settings/reasoningEffort`,
      message:
        "Non-default NodeSpec reasoningEffort requires a model slot or evidence-evaluator slot.",
    });
  }

  if (
    node.settings?.model !== undefined &&
    (node.kind === "council" || node.kind === "fusion" || node.kind === "evidence-gate")
  ) {
    issues.push({
      code: "ambiguous-node-spec-model",
      path: `${nodePath}/settings/model`,
      message:
        `NodeSpec model has no unambiguous primary slot on ${node.kind}; explicit role models remain authoritative.`,
    });
  }

  switch (node.kind) {
    case "agent":
    case "research-until-goal": {
      const model = validateResolvedModel(node.model, `${nodePath}/model`);
      validateInheritedModel(model, nodePath, document, issues);
      break;
    }
    case "prompt-optimization": validatePromptOptimizationNode(node, nodePath, document, issues); break;
    case "best-of-n":
      if (
        (node.settings?.model !== undefined || node.model !== undefined) &&
        node.candidateModels !== undefined
      ) {
        issues.push({
          code: "ambiguous-candidate-models",
          path: `${nodePath}/candidateModels`,
          message: "Best-of-N must use either one repeated model or candidateModels, not both.",
        });
      }
      if (!node.candidateModels) {
        const model = validateResolvedModel(node.model, `${nodePath}/model`);
        validateInheritedModel(model, nodePath, document, issues);
      }
      if (node.model && node.candidateModels) {
        validateResolvedModel(node.model, `${nodePath}/model`, false, false);
      }
      for (const [index, candidateModel] of (node.candidateModels ?? []).entries()) {
        validateResolvedModel(
          candidateModel,
          `${nodePath}/candidateModels/${index}`,
          false,
          false,
        );
      }
      if (
        node.candidateCount !== undefined &&
        node.candidateModels !== undefined &&
        node.candidateCount !== node.candidateModels.length
      ) {
        issues.push({
          code: "candidate-count-mismatch",
          path: `${nodePath}/candidateCount`,
          message: "candidateCount must match the explicit candidateModels list.",
        });
      }
      if (!validateResolvedModel(
        node.evaluator ?? document.defaultModel,
        `${nodePath}/evaluator`,
        false,
        false,
      )) {
        issues.push({
          code: "missing-evaluator-model",
          path: `${nodePath}/evaluator`,
          message: "Best-of-N needs an explicit evaluator or the workflow default model.",
        });
      }
      break;
    case "council":
      validateUniqueMemberIds(node.members, `${nodePath}/members`, issues);
      validateResolvedModel(node.chair, `${nodePath}/chair`, false, false);
      for (const [index, member] of node.members.entries()) {
        validateResolvedModel(
          member.model,
          `${nodePath}/members/${index}/model`,
          false,
          false,
        );
      }
      break;
    case "fusion":
      if (node.fusion.mode === "openrouter-router") {
        const fusion = effectiveHostedFusionDefinition(
          node as HostedOpenRouterFusionNode,
        ).fusion;
        const router = validateResolvedModel(
          fusion.router,
          `${nodePath}/fusion/router`,
          false,
          false,
        )!;
        validateHostedOpenRouterModelRequest(
          router,
          `${nodePath}/fusion/router`,
          "invalid-openrouter-router",
          true,
          issues,
        );
        validateUniqueMemberIds(fusion.members, `${nodePath}/fusion/members`, issues);
        const participants: Array<{ request: ModelRequest; path: string }> = [];
        for (const [index, member] of fusion.members.entries()) {
          const path = `${nodePath}/fusion/members/${index}/model`;
          const request = validateResolvedModel(
            member.model,
            path,
            false,
            false,
          )!;
          participants.push({ request, path: `${path}/requested/reasoning` });
          validateHostedOpenRouterModelRequest(
            request,
            path,
            "invalid-openrouter-panel-model",
            false,
            issues,
          );
        }
        const judge = validateResolvedModel(
          fusion.judge,
          `${nodePath}/fusion/judge`,
          false,
          false,
        )!;
        participants.push({
          request: judge,
          path: `${nodePath}/fusion/judge/requested/reasoning`,
        });
        validateHostedOpenRouterModelRequest(
          judge,
          `${nodePath}/fusion/judge`,
          "invalid-openrouter-judge",
          false,
          issues,
        );
        validateHostedFusionReasoning(router, participants, issues);
      } else {
        validateUniqueMemberIds(node.fusion.members, `${nodePath}/fusion/members`, issues);
        for (const [index, member] of node.fusion.members.entries()) {
          validateResolvedModel(
            member.model,
            `${nodePath}/fusion/members/${index}/model`,
            false,
            false,
          );
        }
        validateResolvedModel(
          node.fusion.synthesizer,
          `${nodePath}/fusion/synthesizer`,
          false,
          false,
        );
      }
      break;
    case "evidence-gate": {
      validateUniqueStrings(node.checks, `${nodePath}/checks`, "duplicate-check", issues);
      validateUniqueStrings(
        node.artifactIds,
        `${nodePath}/artifactIds`,
        "duplicate-artifact-reference",
        issues,
      );
      for (const [index, artifactId] of node.artifactIds.entries()) {
        if (!artifactById.has(artifactId)) {
          issues.push({
            code: "unknown-artifact",
            path: `${nodePath}/artifactIds/${index}`,
            message: `Evidence gate names unknown artifact ${artifactId}.`,
          });
        }
      }
      const needsModelEvaluator = node.checks.some((check) => check !== "artifact-exists");
      let evaluator: ModelRequest | undefined;
      if (node.evaluator) {
        evaluator = validateResolvedModel(
          node.evaluator,
          `${nodePath}/evaluator`,
          false,
          false,
        );
      } else if (needsModelEvaluator) {
        evaluator = validateResolvedModel(
          workflowEvidenceGateEvaluator(document, node),
          `${nodePath}/evaluator`,
          false,
          false,
        );
      }
      if (needsModelEvaluator && !evaluator) {
        issues.push({
          code: "missing-evidence-evaluator",
          path: `${nodePath}/evaluator`,
          message: "Model-based evidence checks need an evaluator or workflow default model.",
        });
      }
      if (node.onUnsupportedOutput === "rescue") {
        validateRescueEnabled(
          node.rescue ?? document.rescue ?? DEFAULT_WORKFLOW_RESCUE_POLICY,
          `${nodePath}/onUnsupportedOutput`,
          issues,
        );
      }
      break;
    }
    case "lean4":
      if (node.mode === "verify" && node.settings?.model) {
        issues.push({
          code: "unexpected-lean-node-spec-model",
          path: `${nodePath}/settings/model`,
          message:
            "Lean verify mode is deterministic and has no primary model slot; settings.model would be discarded.",
        });
      }
      if (node.mode === "verify" && node.solverModel) {
        issues.push({
          code: "unexpected-lean-solver-model",
          path: `${nodePath}/solverModel`,
          message: "Lean verify mode is deterministic and must not declare a solver model.",
        });
      }
      if (
        node.mode === "solve" &&
        !validateResolvedModel(
          node.solverModel ?? document.defaultModel,
          `${nodePath}/solverModel`,
          false,
        )
      ) {
        issues.push({
          code: "missing-lean-solver-model",
          path: `${nodePath}/solverModel`,
          message: "Lean solve mode needs an explicit solverModel or workflow default.",
        });
      }
      {
        const leanEvidence = effectiveWorkflowEvidencePolicy(document, node);
        if (leanEvidence.enabled && !leanEvidence.requireArtifactReferences) {
          issues.push({
            code: "unsafe-lean-evidence-policy",
            path: `${nodePath}/evidence`,
            message:
              "Enabled Lean evidence checking must require normalized host artifact receipts.",
          });
        }
        if (leanEvidence.enabled && leanEvidence.onUnsupportedOutput === "route") {
          issues.push({
            code: "unsafe-lean-evidence-routing",
            path: `${nodePath}/evidence/onUnsupportedOutput`,
            message: "A failed Lean verification must fail or enter rescue, not succeed by routing.",
          });
        }
      }
      break;
  }
}

/**
 * Gap (B) of the harness binding, closed here rather than in the executor.
 *
 * `kady-node-executor.ts` only asks for a delegation session when
 * `requiresPiSubagent` — `callCeiling > 0 && !hostedFusionWithoutPolicyEvaluator`.
 * A hosted-Fusion node whose entire ceiling is served by the OpenRouter router,
 * with no evidence-policy evaluation, therefore never reaches the dispatch
 * decision, and `harness` was inert for it on every transport.
 *
 * Reaching the decision anyway would select an adapter that then executes
 * nothing: such a node has no CLI child for any harness to *be*. So the honest
 * branch the contract offers (NodeSpec v1, "What BOUND will mean", condition 6,
 * second clause) is taken — the declaration is refused, with a message naming
 * the user's next action. Silently ignoring the field is what #55 was.
 */
function validateHarnessReachesDispatch(
  document: WorkflowGraphDocument,
  node: WorkflowNode,
  nodePath: string,
  issues: WorkflowValidationIssue[],
): void {
  const declaredOnNode = node.settings?.harness;
  const effective = declaredOnNode ??
    document.settings?.defaultHarness ??
    DEFAULT_NODE_SPEC_V1.harness;
  if (effective === "pi") return;
  const hostedFusionOnly = node.kind === "fusion" &&
    node.fusion.mode === "openrouter-router" &&
    !requiresWorkflowEvidencePolicyEvaluation(document, node);
  if (!hostedFusionOnly) return;
  const label = workflowHarnessDefinition(effective).label;
  issues.push({
    code: declaredOnNode
      ? "unreachable-node-harness"
      : "unreachable-inherited-harness",
    path: declaredOnNode ? `${nodePath}/settings/harness` : `${nodePath}/settings`,
    message:
      `Hosted Fusion runs this node entirely through the OpenRouter router, so no ${label} process is ever started and the harness would be discarded. Set this node's harness to pi, or give the node work that runs on a CLI harness.`,
  });
}

function validateDeliberationNodeSpec(
  node: WorkflowNode,
  nodePath: string,
  issues: WorkflowValidationIssue[],
): void {
  const deliberation = node.settings?.deliberation;
  if (!deliberation) return;
  if (node.kind !== "best-of-n" && node.kind !== "council" && node.kind !== "fusion") {
    issues.push({
      code: "deliberation-node-kind-unsupported",
      path: `${nodePath}/settings/deliberation`,
      message: "NodeSpec deliberation is executable only on best-of-n, council, and fusion nodes.",
    });
    return;
  }
  const mode = deliberation.mimeographs?.mode ?? "auto";
  const refs = deliberation.mimeographs?.personalityRefs ?? [];
  const count = deliberation.bestOfNPersonalityCount ??
    DEFAULT_NODE_SPEC_V1.deliberation.bestOfNPersonalityCount;
  if (new Set(refs).size !== refs.length) {
    issues.push({
      code: "duplicate-mimeograph-personality-ref",
      path: `${nodePath}/settings/deliberation/mimeographs/personalityRefs`,
      message: "Manual mimeograph personality refs must be unique.",
    });
  }
  if (mode === "auto" && refs.length > 0) {
    issues.push({
      code: "auto-mimeographs-with-manual-refs",
      path: `${nodePath}/settings/deliberation/mimeographs/personalityRefs`,
      message: "Auto mimeograph staffing selects from the store and cannot also name manual personality refs.",
    });
  }
  if (mode === "manual" && refs.length !== count) {
    issues.push({
      code: "manual-mimeograph-count-mismatch",
      path: `${nodePath}/settings/deliberation/mimeographs/personalityRefs`,
      message:
        `Manual mimeograph staffing requires exactly bestOfNPersonalityCount (${count}) personality refs.`,
    });
  }
}

function validateInheritedModel(
  nodeModel: ModelRequest | undefined,
  nodePath: string,
  document: WorkflowGraphDocument,
  issues: WorkflowValidationIssue[],
): void {
  if (!nodeModel && !document.defaultModel) {
    issues.push({
      code: "missing-model-request",
      path: `${nodePath}/model`,
      message: "Model-driven nodes need an exact or explicit-fallback model request.",
    });
  }
}

function validateModelRequest(
  request: ModelRequest,
  path: string,
  issues: WorkflowValidationIssue[],
): void {
  if (request.resolution.mode !== "explicit-fallback") return;

  if (
    request.requested.source === "kady-current" ||
    request.resolution.alternatives.some(
      (alternative) => alternative.source === "kady-current",
    )
  ) {
    issues.push({
      code: "ambiguous-kady-current-fallback",
      path: `${path}/resolution`,
      message:
        "Kady Current is an exact runtime selection and cannot appear in an explicit fallback list.",
    });
  }

  const requestedIdentity = modelIdentity(request.requested);
  const fallbackIdentities = new Set<string>();
  for (const [index, alternative] of request.resolution.alternatives.entries()) {
    const identity = modelIdentity(alternative);
    if (identity === requestedIdentity) {
      issues.push({
        code: "fallback-repeats-request",
        path: `${path}/resolution/alternatives/${index}`,
        message: "An explicit fallback must differ from the requested model and auth.",
      });
    }
    if (fallbackIdentities.has(identity)) {
      issues.push({
        code: "duplicate-model-fallback",
        path: `${path}/resolution/alternatives/${index}`,
        message: "Explicit model fallbacks must be unique.",
      });
    }
    fallbackIdentities.add(identity);
  }
}

function validateHostedOpenRouterModelRequest(
  request: ModelRequest,
  path: string,
  code: string,
  requireFusionRouterAlias: boolean,
  issues: WorkflowValidationIssue[],
): void {
  if (request.resolution.mode !== "exact") {
    issues.push({
      code,
      path: `${path}/resolution`,
      message: "Hosted OpenRouter Fusion cannot represent per-model fallback policies.",
    });
  }

  const selection = request.requested;
  const isAdapterRepresentable =
    selection.source === "fixed" &&
    selection.provider.toLowerCase() === "openrouter" &&
    selection.auth.kind === "api-key" &&
    selection.auth.profile === undefined;
  if (!isAdapterRepresentable) {
    issues.push({
      code,
      path: `${path}/requested`,
      message:
        "Hosted OpenRouter Fusion accepts only fixed OpenRouter models using Kady's API-key auth.",
    });
    return;
  }

  if (requireFusionRouterAlias && selection.model !== "openrouter/fusion") {
    issues.push({
      code,
      path: `${path}/requested/model`,
      message: "The hosted Fusion router must be the exact openrouter/fusion alias.",
    });
  }
  if (!requireFusionRouterAlias && selection.model === "openrouter/fusion") {
    issues.push({
      code,
      path: `${path}/requested/model`,
      message: "A hosted Fusion panel member or judge cannot recursively select openrouter/fusion.",
    });
  }
  if (selection.reasoning === "max") {
    issues.push({
      code: "unsupported-openrouter-reasoning",
      path: `${path}/requested/reasoning`,
      message: "Hosted OpenRouter Fusion has no exact max reasoning level; select xhigh explicitly.",
    });
  }
}

function validateHostedFusionReasoning(
  router: ModelRequest,
  participants: Array<{ request: ModelRequest; path: string }>,
  issues: WorkflowValidationIssue[],
): void {
  if (router.requested.source !== "fixed") return;
  const routerReasoning = router.requested.reasoning;
  for (const participant of participants) {
    if (
      participant.request.requested.source === "fixed" &&
      participant.request.requested.reasoning !== routerReasoning
    ) {
      issues.push({
        code: "openrouter-reasoning-mismatch",
        path: participant.path,
        message:
          "Hosted Fusion exposes one shared reasoning level; every panel model and judge must match the router.",
      });
    }
  }
}

function modelIdentity(model: RequestedModel): string {
  if (model.source === "kady-current") {
    return [model.source, model.auth.kind, model.reasoning].join("\u0000");
  }
  return [
    model.source,
    model.provider.toLowerCase(),
    model.model,
    model.auth.kind,
    model.auth.profile ?? "",
    model.reasoning,
  ].join("\u0000");
}

function validateWorkspacePolicy(
  node: WorkflowNode,
  nodePath: string,
  issues: WorkflowValidationIssue[],
): void {
  validateUniqueStrings(
    node.workspace.writePaths,
    `${nodePath}/workspace/writePaths`,
    "duplicate-write-path",
    issues,
  );
  if (node.workspace.isolation === "read-only" && node.workspace.writePaths.length > 0) {
    issues.push({
      code: "read-only-write-path",
      path: `${nodePath}/workspace/writePaths`,
      message: "A read-only node cannot own write paths.",
    });
  }
  if (node.workspace.isolation !== "read-only" && node.workspace.writePaths.length === 0) {
    issues.push({
      code: "missing-write-path",
      path: `${nodePath}/workspace/writePaths`,
      message: "A writable node needs at least one bounded write path.",
    });
  }
  for (const [index, writePath] of node.workspace.writePaths.entries()) {
    if (normalizeWorkflowProjectPath(writePath) !== undefined) continue;
    issues.push({
      code: "unsafe-write-path",
      path: `${nodePath}/workspace/writePaths/${index}`,
      message: "Write paths must use canonical, portable sandbox-relative syntax.",
    });
  }
}

const WINDOWS_RESERVED_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const WINDOWS_INVALID_PATH_CHARACTER = /[<>:"|?*\u0000-\u001f]/u;

/**
 * Return Kady's canonical project-relative path or undefined when the spelling
 * is unsafe or cannot round-trip on every supported desktop platform.
 */
export function normalizeWorkflowProjectPath(writePath: string): string | undefined {
  if (
    writePath.length === 0 ||
    writePath.includes("\\") ||
    writePath.startsWith("/") ||
    /^[A-Za-z]:/.test(writePath)
  ) {
    return undefined;
  }

  const normalizedSegments: string[] = [];
  for (const rawSegment of writePath.split("/")) {
    const segment = rawSegment.normalize("NFC");
    if (
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      segment.length > 255 ||
      WINDOWS_INVALID_PATH_CHARACTER.test(segment) ||
      segment.endsWith(".") ||
      segment.endsWith(" ") ||
      WINDOWS_RESERVED_SEGMENT.test(segment)
    ) {
      return undefined;
    }
    normalizedSegments.push(segment);
  }
  return normalizedSegments.join("/");
}

/**
 * Resolve a validated workflow path and reject lexical or symlink traversal.
 * Future executors must use this helper at the mutation boundary, not trust a
 * graph merely because it passed admission earlier.
 */
export function resolveWorkflowProjectPath(projectRoot: string, writePath: string): string {
  const normalized = normalizeWorkflowProjectPath(writePath);
  if (normalized === undefined) {
    throw new Error(`Unsafe workflow project path: ${writePath}`);
  }

  const resolvedRoot = path.resolve(projectRoot);
  const resolvedTarget = path.resolve(resolvedRoot, ...normalized.split("/"));
  if (!isWithin(resolvedRoot, resolvedTarget)) {
    throw new Error(`Workflow path escapes the project root: ${writePath}`);
  }

  const realRoot = fs.realpathSync(resolvedRoot);
  let deepestExistingPath = resolvedTarget;
  while (!fs.existsSync(deepestExistingPath)) {
    const parentPath = path.dirname(deepestExistingPath);
    if (parentPath === deepestExistingPath) break;
    deepestExistingPath = parentPath;
  }
  const realExistingPath = fs.realpathSync(deepestExistingPath);
  if (!isWithin(realRoot, realExistingPath)) {
    throw new Error(
      `Workflow path resolves through a symlink outside the project: ${writePath}`,
    );
  }
  return resolvedTarget;
}

function validateWorkspaceOwnership(
  nodes: WorkflowNode[],
  issues: WorkflowValidationIssue[],
): void {
  interface OwnedPath {
    nodeId: string;
    nodeIndex: number;
    pathIndex: number;
    path: string;
    comparisonSegments: string[];
  }

  const ownedPaths: OwnedPath[] = [];
  for (const [nodeIndex, node] of nodes.entries()) {
    if (node.workspace.isolation === "read-only") continue;
    for (const [pathIndex, writePath] of node.workspace.writePaths.entries()) {
      const normalizedPath = normalizeWorkflowProjectPath(writePath);
      if (normalizedPath === undefined) continue;
      ownedPaths.push({
        nodeId: node.id,
        nodeIndex,
        pathIndex,
        path: normalizedPath,
        comparisonSegments: pathComparisonSegments(normalizedPath),
      });
    }
  }

  // Segment-wise sorting keeps every descendant adjacent to its ancestor
  // subtree. The active prefix stack then makes collision detection O(P log P)
  // for P owned paths instead of comparing every pair.
  ownedPaths.sort(compareOwnedPaths);
  const activePrefixes: OwnedPath[] = [];
  const activeOwnerCounts = new Map<string, number>();

  for (const current of ownedPaths) {
    while (
      activePrefixes.length > 0 &&
      !segmentsArePrefix(
        activePrefixes[activePrefixes.length - 1].comparisonSegments,
        current.comparisonSegments,
      )
    ) {
      const removed = activePrefixes.pop()!;
      const remainingCount = (activeOwnerCounts.get(removed.nodeId) ?? 1) - 1;
      if (remainingCount === 0) activeOwnerCounts.delete(removed.nodeId);
      else activeOwnerCounts.set(removed.nodeId, remainingCount);
    }

    const conflictingOwner = differentActiveOwner(activeOwnerCounts, current.nodeId);
    if (conflictingOwner !== undefined) {
      issues.push({
        code: "overlapping-write-ownership",
        path: `/nodes/${current.nodeIndex}/workspace/writePaths/${current.pathIndex}`,
        message: `Write path ${current.path} overlaps ownership held by node ${conflictingOwner}.`,
      });
    }

    activePrefixes.push(current);
    activeOwnerCounts.set(current.nodeId, (activeOwnerCounts.get(current.nodeId) ?? 0) + 1);
  }
}

function pathComparisonSegments(normalizedPath: string): string[] {
  return normalizedPath.split("/").map((segment) => segment.toLowerCase());
}

function differentActiveOwner(
  activeOwnerCounts: Map<string, number>,
  currentNodeId: string,
): string | undefined {
  const owners = activeOwnerCounts.keys();
  const firstOwner = owners.next().value;
  if (firstOwner === undefined || firstOwner !== currentNodeId) return firstOwner;
  return owners.next().value;
}

function compareOwnedPaths(
  left: { comparisonSegments: string[] },
  right: { comparisonSegments: string[] },
): number {
  const sharedLength = Math.min(
    left.comparisonSegments.length,
    right.comparisonSegments.length,
  );
  for (let index = 0; index < sharedLength; index++) {
    const leftSegment = left.comparisonSegments[index];
    const rightSegment = right.comparisonSegments[index];
    if (leftSegment < rightSegment) return -1;
    if (leftSegment > rightSegment) return 1;
  }
  return left.comparisonSegments.length - right.comparisonSegments.length;
}

function segmentsArePrefix(prefix: string[], candidate: string[]): boolean {
  return (
    prefix.length <= candidate.length &&
    prefix.every((segment, index) => segment === candidate[index])
  );
}

function pathIsSameOrDescendant(candidate: string, owner: string): boolean {
  return segmentsArePrefix(pathComparisonSegments(owner), pathComparisonSegments(candidate));
}

const NODE_LIMIT_KEYS = [
  "maxIterations",
  "maxModelCalls",
  "maxParallelism",
  "maxSubagents",
  "timeoutMs",
  "maxTokens",
  "maxCostUsd",
  "maxRetries",
] as const satisfies readonly (keyof NodeLimits)[];

function validateNodeLimits(
  limits: NodeLimits,
  nodePath: string,
  document: WorkflowGraphDocument,
  issues: WorkflowValidationIssue[],
): void {
  for (const key of NODE_LIMIT_KEYS) {
    const nodeValue = limits[key];
    if (nodeValue === undefined || nodeValue <= document.limits[key]) continue;
    issues.push({
      code: "node-limit-exceeds-workflow",
      path: `${nodePath}/limits/${key}`,
      message: `Node limit ${key} (${nodeValue}) exceeds workflow limit (${document.limits[key]}).`,
    });
  }
}

function validateRescuePolicy(
  policy: RescuePolicy,
  path: string,
  issues: WorkflowValidationIssue[],
): void {
  validateUniqueStrings(policy.triggers, `${path}/triggers`, "duplicate-rescue-trigger", issues);
  if (policy.enabled && policy.maxAttempts === 0) {
    issues.push({
      code: "unbounded-rescue-disabled",
      path: `${path}/maxAttempts`,
      message: "Enabled rescue needs at least one and at most ten attempts.",
    });
  }
  if (policy.enabled && policy.triggers.length === 0) {
    issues.push({
      code: "missing-rescue-trigger",
      path: `${path}/triggers`,
      message: "Enabled rescue needs at least one explicit trigger.",
    });
  }
  if (!policy.enabled && policy.maxAttempts !== 0) {
    issues.push({
      code: "disabled-rescue-attempts",
      path: `${path}/maxAttempts`,
      message: "Disabled rescue must set maxAttempts to zero.",
    });
  }
}

function validateEvidenceRescueAvailability(
  evidencePolicy: EvidencePolicy,
  effectiveRescuePolicy: RescuePolicy,
  path: string,
  issues: WorkflowValidationIssue[],
): void {
  if (!evidencePolicy.enabled || evidencePolicy.onUnsupportedOutput !== "rescue") return;
  validateRescueEnabled(effectiveRescuePolicy, path, issues);
}

function validateRescueEnabled(
  effectiveRescuePolicy: RescuePolicy,
  path: string,
  issues: WorkflowValidationIssue[],
): void {
  if (effectiveRescuePolicy.enabled) return;
  issues.push({
    code: "rescue-unavailable",
    path,
    message: "This policy requests rescue, but the effective rescue policy is disabled.",
  });
}

function validateUniqueMemberIds(
  members: { id: string }[],
  path: string,
  issues: WorkflowValidationIssue[],
): void {
  const memberIds = members.map((member) => member.id);
  validateUniqueStrings(memberIds, path, "duplicate-member-id", issues, "/id");
}

function validateUniqueStrings(
  values: readonly string[],
  path: string,
  code: string,
  issues: WorkflowValidationIssue[],
  pathSuffix = "",
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      issues.push({
        code,
        path: `${path}/${index}${pathSuffix}`,
        message: `Duplicate value ${value}.`,
      });
    }
    seen.add(value);
  }
}

function validateGraphTopology(
  document: WorkflowGraphDocument,
  nodeById: Map<string, WorkflowNode>,
  issues: WorkflowValidationIssue[],
): void {
  if (!nodeById.has(document.entryNodeId)) {
    issues.push({
      code: "unknown-entry-node",
      path: "/entryNodeId",
      message: `Entry node ${document.entryNodeId} does not exist.`,
    });
  }

  const edgeIds = new Set<string>();
  const edgeRoutes = new Set<string>();
  const adjacency = new Map<string, string[]>();
  const reverseAdjacency = new Map<string, string[]>();
  const incomingCounts = new Map<string, number>();
  for (const nodeId of nodeById.keys()) {
    adjacency.set(nodeId, []);
    reverseAdjacency.set(nodeId, []);
    incomingCounts.set(nodeId, 0);
  }

  for (const [index, edge] of document.edges.entries()) {
    const edgePath = `/edges/${index}`;
    if (edgeIds.has(edge.id)) {
      issues.push({
        code: "duplicate-edge-id",
        path: `${edgePath}/id`,
        message: `Duplicate edge id ${edge.id}.`,
      });
    }
    edgeIds.add(edge.id);

    const condition = edge.condition ?? "always";
    const routeIdentity = `${edge.from}\u0000${edge.to}\u0000${condition}`;
    if (edgeRoutes.has(routeIdentity)) {
      issues.push({
        code: "duplicate-edge-endpoints",
        path: edgePath,
        message: `Only one ${condition} edge may connect ${edge.from} to ${edge.to}.`,
      });
    }
    edgeRoutes.add(routeIdentity);

    const fromExists = nodeById.has(edge.from);
    const toExists = nodeById.has(edge.to);
    if (!fromExists) {
      issues.push({
        code: "unknown-edge-source",
        path: `${edgePath}/from`,
        message: `Edge source ${edge.from} does not exist.`,
      });
    }
    if (!toExists) {
      issues.push({
        code: "unknown-edge-target",
        path: `${edgePath}/to`,
        message: `Edge target ${edge.to} does not exist.`,
      });
    }
    if (edge.from === edge.to) {
      issues.push({
        code: "self-edge",
        path: edgePath,
        message: "Workflow loops belong inside compound nodes; graph self-edges are invalid.",
      });
    }
    validateEdgeCondition(edge, edgePath, document, nodeById, issues);

    if (!fromExists || !toExists) continue;
    adjacency.get(edge.from)?.push(edge.to);
    reverseAdjacency.get(edge.to)?.push(edge.from);
    incomingCounts.set(edge.to, (incomingCounts.get(edge.to) ?? 0) + 1);
  }

  if ((incomingCounts.get(document.entryNodeId) ?? 0) > 0) {
    issues.push({
      code: "entry-has-incoming-edge",
      path: "/entryNodeId",
      message: "The entry node must not have incoming edges.",
    });
  }

  validateEvidenceRoutes(document, issues);
  validateOutcomeRoutes(document, issues);
  validateAcyclic(nodeById, adjacency, incomingCounts, issues);
  validateReachability(document.entryNodeId, nodeById, adjacency, issues);
  validateTerminals(nodeById, adjacency, reverseAdjacency, issues);
}

function validateOutcomeRoutes(
  document: WorkflowGraphDocument,
  issues: WorkflowValidationIssue[],
): void {
  for (const [nodeIndex, node] of document.nodes.entries()) {
    if (node.terminal || usesEvidenceRoutes(document, node)) continue;
    const outgoingConditions = document.edges
      .filter((edge) => edge.from === node.id)
      .map((edge) => edge.condition ?? "always");
    const alwaysCount = outgoingConditions.filter((condition) => condition === "always").length;
    const successCount = outgoingConditions.filter((condition) => condition === "success").length;
    const failureCount = outgoingConditions.filter((condition) => condition === "failure").length;

    if (alwaysCount > 0 && (successCount > 0 || failureCount > 0)) {
      issues.push({
        code: "mixed-always-and-outcome-routes",
        path: `/nodes/${nodeIndex}`,
        message: "A node must use unconditional fan-out or outcome routes, not both.",
      });
      continue;
    }
    if (alwaysCount > 0) continue;
    if (successCount === 0) {
      issues.push({
        code: "missing-success-route",
        path: `/nodes/${nodeIndex}`,
        message: "A nonterminal node needs a success route or an unconditional route.",
      });
    }
    if (failureCount === 0) {
      issues.push({
        code: "missing-failure-route",
        path: `/nodes/${nodeIndex}`,
        message: "A nonterminal node needs a failure route or an unconditional route.",
      });
    }
  }
}

function validateEdgeCondition(
  edge: WorkflowEdge,
  edgePath: string,
  document: WorkflowGraphDocument,
  nodeById: Map<string, WorkflowNode>,
  issues: WorkflowValidationIssue[],
): void {
  const source = nodeById.get(edge.from);
  if (!source) return;
  const condition = edge.condition ?? "always";
  const isEvidenceCondition =
    condition === "evidence-supported" || condition === "evidence-unsupported";
  const evidenceRoutes = usesEvidenceRoutes(document, source);
  if (isEvidenceCondition && !evidenceRoutes) {
    issues.push({
      code: "invalid-evidence-edge",
      path: `${edgePath}/condition`,
      message:
        "Evidence edge conditions require an Evidence Gate or enabled route-mode evidence policy.",
    });
  }
  if (evidenceRoutes && !isEvidenceCondition) {
    issues.push({
      code: "invalid-gate-edge",
      path: `${edgePath}/condition`,
      message: "Evidence-routed nodes must use supported or unsupported conditions.",
    });
  }
}

function usesEvidenceRoutes(
  document: WorkflowGraphDocument,
  node: WorkflowNode,
): boolean {
  return node.kind === "evidence-gate" || (
    effectiveWorkflowEvidencePolicy(document, node).enabled &&
    effectiveWorkflowEvidencePolicy(document, node).onUnsupportedOutput === "route"
  );
}

function validateEvidenceRoutes(
  document: WorkflowGraphDocument,
  issues: WorkflowValidationIssue[],
): void {
  for (const [nodeIndex, node] of document.nodes.entries()) {
    if (!usesEvidenceRoutes(document, node)) continue;
    const outgoing = document.edges.filter((edge) => edge.from === node.id);
    const supportedCount = outgoing.filter(
      (edge) => edge.condition === "evidence-supported",
    ).length;
    const unsupportedCount = outgoing.filter(
      (edge) => edge.condition === "evidence-unsupported",
    ).length;
    if (supportedCount === 0) {
      issues.push({
        code: "missing-supported-route",
        path: `/nodes/${nodeIndex}`,
        message: "An evidence-routed node needs an evidence-supported outgoing route.",
      });
    }
    const onUnsupportedOutput = node.kind === "evidence-gate"
      ? node.onUnsupportedOutput
      : effectiveWorkflowEvidencePolicy(document, node).onUnsupportedOutput;
    if (onUnsupportedOutput === "route" && unsupportedCount === 0) {
      const policyPath = node.kind === "evidence-gate"
        ? `/nodes/${nodeIndex}/onUnsupportedOutput`
        : `/nodes/${nodeIndex}/evidence/onUnsupportedOutput`;
      issues.push({
        code: "missing-unsupported-route",
        path: policyPath,
        message: "A routed unsupported output needs an evidence-unsupported edge.",
      });
    }
    if (onUnsupportedOutput !== "route" && unsupportedCount > 0) {
      const policyPath = node.kind === "evidence-gate"
        ? `/nodes/${nodeIndex}/onUnsupportedOutput`
        : `/nodes/${nodeIndex}/evidence/onUnsupportedOutput`;
      issues.push({
        code: "unexpected-unsupported-route",
        path: policyPath,
        message: "Unsupported edges require onUnsupportedOutput=route.",
      });
    }
  }
}

function validateAcyclic(
  nodeById: Map<string, WorkflowNode>,
  adjacency: Map<string, string[]>,
  incomingCounts: Map<string, number>,
  issues: WorkflowValidationIssue[],
): void {
  const remainingIncoming = new Map(incomingCounts);
  const ready = [...nodeById.keys()].filter(
    (nodeId) => (remainingIncoming.get(nodeId) ?? 0) === 0,
  );
  let visitedCount = 0;
  for (let cursor = 0; cursor < ready.length; cursor++) {
    const nodeId = ready[cursor];
    visitedCount++;
    for (const targetId of adjacency.get(nodeId) ?? []) {
      const nextIncoming = (remainingIncoming.get(targetId) ?? 0) - 1;
      remainingIncoming.set(targetId, nextIncoming);
      if (nextIncoming === 0) ready.push(targetId);
    }
  }
  if (visitedCount === nodeById.size) return;

  const cyclicNodeIds = [...nodeById.keys()].filter(
    (nodeId) => (remainingIncoming.get(nodeId) ?? 0) > 0,
  );
  issues.push({
    code: "cycle",
    path: "/edges",
    message: `The outer workflow must be a DAG; cycle includes ${cyclicNodeIds.join(", ")}.`,
  });
}

function validateReachability(
  entryNodeId: string,
  nodeById: Map<string, WorkflowNode>,
  adjacency: Map<string, string[]>,
  issues: WorkflowValidationIssue[],
): void {
  if (!nodeById.has(entryNodeId)) return;
  const reachable = visitFrom([entryNodeId], adjacency);
  for (const [index, node] of [...nodeById.values()].entries()) {
    if (reachable.has(node.id)) continue;
    issues.push({
      code: "unreachable-node",
      path: `/nodes/${index}/id`,
      message: `Node ${node.id} is not reachable from entry node ${entryNodeId}.`,
    });
  }
}

function validateTerminals(
  nodeById: Map<string, WorkflowNode>,
  adjacency: Map<string, string[]>,
  reverseAdjacency: Map<string, string[]>,
  issues: WorkflowValidationIssue[],
): void {
  const terminalNodeIds: string[] = [];
  for (const [index, node] of [...nodeById.values()].entries()) {
    const outgoingCount = adjacency.get(node.id)?.length ?? 0;
    if (node.terminal) {
      terminalNodeIds.push(node.id);
      if (outgoingCount > 0) {
        issues.push({
          code: "terminal-has-outgoing-edge",
          path: `/nodes/${index}/terminal`,
          message: `Terminal node ${node.id} must not have outgoing edges.`,
        });
      }
    } else if (outgoingCount === 0) {
      issues.push({
        code: "unterminated-sink",
        path: `/nodes/${index}/terminal`,
        message: `Sink node ${node.id} must be marked terminal.`,
      });
    }
  }

  if (terminalNodeIds.length === 0) {
    issues.push({
      code: "missing-terminal",
      path: "/nodes",
      message: "A workflow needs at least one terminal node.",
    });
    return;
  }

  const canReachTerminal = visitFrom(terminalNodeIds, reverseAdjacency);
  for (const [index, node] of [...nodeById.values()].entries()) {
    if (canReachTerminal.has(node.id)) continue;
    issues.push({
      code: "no-terminal-path",
      path: `/nodes/${index}/id`,
      message: `Node ${node.id} has no path to a terminal node.`,
    });
  }
}

function visitFrom(
  startNodeIds: string[],
  adjacency: Map<string, string[]>,
): Set<string> {
  const visited = new Set<string>();
  const pending = [...startNodeIds];
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const nodeId = pending[cursor];
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    for (const nextNodeId of adjacency.get(nodeId) ?? []) {
      if (!visited.has(nextNodeId)) pending.push(nextNodeId);
    }
  }
  return visited;
}
