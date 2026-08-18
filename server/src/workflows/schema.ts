import { Type, type Static } from "typebox";
import { PromptOptimizationNodeSchema } from "./prompt-opt-schema.ts";

export const WORKFLOW_GRAPH_SCHEMA_VERSION = "1.0" as const;
export const NODE_SPEC_V1_VERSION = 1 as const;
export const MAX_WORKFLOW_NODES = 256;
export const MAX_WORKFLOW_EDGES = 1_024;
export const MAX_WORKFLOW_ARTIFACTS = 512;
export const MAX_WORKFLOW_DOCUMENT_BYTES = 4 * 1024 * 1024;

const IdentifierSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-z][a-z0-9_-]*$",
});

const ShortTextSchema = Type.String({ minLength: 1, maxLength: 256 });
const DescriptionSchema = Type.String({ minLength: 1, maxLength: 4_096 });
const InstructionSchema = Type.String({ minLength: 1, maxLength: 32_768 });

const ReferenceSchema = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]*$",
});

export const WorkflowLimitsSchema = Type.Object(
  {
    maxIterations: Type.Integer({ minimum: 1, maximum: 1_000 }),
    maxModelCalls: Type.Integer({ minimum: 1, maximum: 10_000 }),
    maxParallelism: Type.Integer({ minimum: 1, maximum: 16 }),
    maxSubagents: Type.Integer({ minimum: 0, maximum: 256 }),
    timeoutMs: Type.Integer({ minimum: 1_000, maximum: 86_400_000 }),
    maxTokens: Type.Integer({ minimum: 1, maximum: 100_000_000 }),
    maxCostUsd: Type.Number({ minimum: 0, maximum: 1_000_000 }),
    maxRetries: Type.Integer({ minimum: 0, maximum: 3 }),
  },
  { additionalProperties: false },
);

export const NodeLimitsSchema = Type.Object(
  {
    maxIterations: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
    maxModelCalls: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
    maxParallelism: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
    maxSubagents: Type.Optional(Type.Integer({ minimum: 0, maximum: 256 })),
    timeoutMs: Type.Optional(
      Type.Integer({ minimum: 1_000, maximum: 86_400_000 }),
    ),
    maxTokens: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 100_000_000 }),
    ),
    maxCostUsd: Type.Optional(Type.Number({ minimum: 0, maximum: 1_000_000 })),
    maxRetries: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })),
  },
  { additionalProperties: false },
);

const ReasoningLevelSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);

const FixedRequestedModelSchema = Type.Object(
  {
    source: Type.Literal("fixed"),
    provider: Type.String({
      minLength: 1,
      maxLength: 64,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
    }),
    model: Type.String({ minLength: 1, maxLength: 256 }),
    auth: Type.Object(
      {
        kind: Type.Union([
          Type.Literal("api-key"),
          Type.Literal("oauth"),
          Type.Literal("local"),
          Type.Literal("custom"),
        ]),
        profile: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      },
      { additionalProperties: false },
    ),
    reasoning: ReasoningLevelSchema,
  },
  { additionalProperties: false },
);

const KadyCurrentRequestedModelSchema = Type.Object(
  {
    source: Type.Literal("kady-current"),
    auth: Type.Object(
      { kind: Type.Literal("kady-current") },
      { additionalProperties: false },
    ),
    reasoning: ReasoningLevelSchema,
  },
  { additionalProperties: false },
);

export const RequestedModelSchema = Type.Union([
  FixedRequestedModelSchema,
  KadyCurrentRequestedModelSchema,
]);

const ExactResolutionSchema = Type.Object(
  { mode: Type.Literal("exact") },
  { additionalProperties: false },
);

const ExplicitFallbackResolutionSchema = Type.Object(
  {
    mode: Type.Literal("explicit-fallback"),
    alternatives: Type.Array(RequestedModelSchema, { minItems: 1, maxItems: 8 }),
    reason: ShortTextSchema,
  },
  { additionalProperties: false },
);

export const ModelRequestSchema = Type.Object(
  {
    requested: RequestedModelSchema,
    resolution: Type.Union([
      ExactResolutionSchema,
      ExplicitFallbackResolutionSchema,
    ]),
  },
  { additionalProperties: false },
);

const HarnessSchema = Type.Union([
  Type.Literal("pi"),
  Type.Literal("claude-code"),
  Type.Literal("codex"),
  Type.Literal("opencode"),
  Type.Literal("copilot"),
]);

const SamplingValueSchema = Type.Union([
  Type.Number(),
  Type.String({ maxLength: 256 }),
  Type.Boolean(),
]);

const SamplingMapSchema = Type.Record(
  Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_.-]{0,63}$" }),
  SamplingValueSchema,
  { maxProperties: 16 },
);

const NodeHyperparametersSchema = Type.Object(
  {
    temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
    top_p: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    sampling: Type.Optional(SamplingMapSchema),
  },
  { additionalProperties: false },
);

const NodeConditionsSchema = Type.Object(
  {
    when: Type.Optional(InstructionSchema),
    exists: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 1_024 }), {
        maxItems: 64,
      }),
    ),
  },
  { additionalProperties: false },
);

const NodeSkillsSchema = Type.Object(
  {
    mode: Type.Optional(
      Type.Union([
        Type.Literal("auto"),
        Type.Literal("auto-manual"),
        Type.Literal("manual"),
      ]),
    ),
    list: Type.Optional(Type.Array(ReferenceSchema, { maxItems: 64 })),
  },
  { additionalProperties: false },
);

const NodeSubagentSchema = Type.Object(
  {
    mode: Type.Optional(
      Type.Union([Type.Literal("auto"), Type.Literal("auto-manual")]),
    ),
  },
  { additionalProperties: false },
);

const MimeographsStaffingSchema = Type.Object(
  {
    mode: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("manual")])),
    personalityRefs: Type.Optional(Type.Array(ReferenceSchema, { maxItems: 32 })),
  },
  { additionalProperties: false },
);

const NodeDeliberationSchema = Type.Object(
  {
    personalityStoreRef: Type.Optional(ReferenceSchema),
    bestOfNPersonalityCount: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 32 }),
    ),
    mimeographs: Type.Optional(MimeographsStaffingSchema),
  },
  { additionalProperties: false },
);

const NodeBudgetHooksSchema = Type.Object(
  {
    maxTokens: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 100_000_000 }),
    ),
    maxCostUsd: Type.Optional(Type.Number({ minimum: 0, maximum: 1_000_000 })),
  },
  { additionalProperties: false },
);

/** Versioned settings shared by every typed workflow node kind. */
export const NodeSpecV1Schema = Type.Object(
  {
    version: Type.Optional(Type.Literal(NODE_SPEC_V1_VERSION)),
    model: Type.Optional(ModelRequestSchema),
    reasoningEffort: Type.Optional(ReasoningLevelSchema),
    hyperparameters: Type.Optional(NodeHyperparametersSchema),
    conditions: Type.Optional(NodeConditionsSchema),
    harness: Type.Optional(HarnessSchema),
    databases: Type.Optional(Type.Array(ReferenceSchema, { maxItems: 64 })),
    skills: Type.Optional(NodeSkillsSchema),
    subagents: Type.Optional(NodeSubagentSchema),
    autonomy: Type.Optional(
      Type.Union([Type.Literal("strict"), Type.Literal("loose")]),
    ),
    deliberation: Type.Optional(NodeDeliberationSchema),
    billingMode: Type.Optional(
      Type.Union([
        Type.Literal("inherit"),
        Type.Literal("api"),
        Type.Literal("subscription"),
      ]),
    ),
    budget: Type.Optional(NodeBudgetHooksSchema),
  },
  { additionalProperties: false },
);

/** Workflow-wide defaults consumed by NodeSpec v1 resolution. */
export const WorkflowSettingsV1Schema = Type.Object(
  {
    version: Type.Optional(Type.Literal(NODE_SPEC_V1_VERSION)),
    defaultHarness: Type.Optional(HarnessSchema),
    databases: Type.Optional(Type.Array(ReferenceSchema, { maxItems: 64 })),
  },
  { additionalProperties: false },
);

export const RescuePolicySchema = Type.Object(
  {
    enabled: Type.Boolean(),
    maxAttempts: Type.Integer({ minimum: 0, maximum: 10 }),
    triggers: Type.Array(
      Type.Union([
        Type.Literal("failure"),
        Type.Literal("stalled"),
        Type.Literal("unsupported-output"),
        Type.Literal("pre-compaction"),
        Type.Literal("post-compaction"),
      ]),
      { maxItems: 5 },
    ),
  },
  { additionalProperties: false },
);

export const EvidencePolicySchema = Type.Object(
  {
    enabled: Type.Boolean(),
    minimumIndependentSources: Type.Integer({ minimum: 0, maximum: 20 }),
    requireArtifactReferences: Type.Boolean(),
    evaluator: Type.Optional(ModelRequestSchema),
    onUnsupportedOutput: Type.Union([
      Type.Literal("fail"),
      Type.Literal("rescue"),
      Type.Literal("route"),
    ]),
  },
  { additionalProperties: false },
);

export const NodeWorkspacePolicySchema = Type.Object(
  {
    isolation: Type.Union([
      Type.Literal("read-only"),
      Type.Literal("isolated-worktree"),
      Type.Literal("exclusive-project"),
    ]),
    writePaths: Type.Array(Type.String({ minLength: 1, maxLength: 1_024 }), {
      maxItems: 32,
    }),
  },
  { additionalProperties: false },
);

export const WorkflowNodePositionSchema = Type.Object(
  {
    x: Type.Number({ minimum: -1_000_000, maximum: 1_000_000 }),
    y: Type.Number({ minimum: -1_000_000, maximum: 1_000_000 }),
  },
  { additionalProperties: false },
);

/**
 * Where a node or a document came from.
 *
 * Additive, optional, and deliberately outside validation semantics: nothing
 * in validate.ts branches on it, and it exists so an imported or stitched-in
 * node can name its source without the executor ever consulting it.
 *
 * Module-local. This schema and the three below it are composed into
 * `WorkflowGraphDocumentSchema` and nothing else consumes them, so they stay
 * off the runtime's public export surface — `test/guards/typed-workflow-exports.test.ts`
 * pins that surface, and widening it is a reviewed decision this lane has no
 * reason to force.
 */
const WorkflowProvenanceSchema = Type.Object(
  {
    source: Type.String({ minLength: 1, maxLength: 64 }),
    id: Type.String({ minLength: 1, maxLength: 256 }),
    sha256: Type.Optional(Type.String({ minLength: 64, maxLength: 64, pattern: "^[0-9a-f]{64}$" })),
  },
  { additionalProperties: false },
);

/** Flatten provenance for a node that arrived as part of a stitched subgraph. */
const WorkflowNodeCompositeOriginSchema = Type.Object(
  {
    kind: Type.String({ minLength: 1, maxLength: 64 }),
    sourceId: Type.String({ minLength: 1, maxLength: 256 }),
    sourceGraphSha256: Type.Optional(
      Type.String({ minLength: 64, maxLength: 64, pattern: "^[0-9a-f]{64}$" }),
    ),
    label: Type.Optional(ShortTextSchema),
  },
  { additionalProperties: false },
);

const WorkflowNodeMetaSchema = Type.Object(
  { compositeOf: Type.Optional(WorkflowNodeCompositeOriginSchema) },
  { additionalProperties: false },
);

const CommonNodeProperties = {
  id: IdentifierSchema,
  name: ShortTextSchema,
  description: Type.Optional(DescriptionSchema),
  terminal: Type.Boolean(),
  workspace: NodeWorkspacePolicySchema,
  position: Type.Optional(WorkflowNodePositionSchema),
  limits: Type.Optional(NodeLimitsSchema),
  rescue: Type.Optional(RescuePolicySchema),
  evidence: Type.Optional(EvidencePolicySchema),
  settings: Type.Optional(NodeSpecV1Schema),
  meta: Type.Optional(WorkflowNodeMetaSchema),
  provenance: Type.Optional(WorkflowProvenanceSchema),
};

const ModelDrivenNodeProperties = {
  ...CommonNodeProperties,
  model: Type.Optional(ModelRequestSchema),
};

export const AgentNodeSchema = Type.Object(
  {
    ...ModelDrivenNodeProperties,
    kind: Type.Literal("agent"),
    prompt: InstructionSchema,
  },
  { additionalProperties: false },
);

export const ResearchUntilGoalNodeSchema = Type.Object(
  {
    ...ModelDrivenNodeProperties,
    kind: Type.Literal("research-until-goal"),
    goal: InstructionSchema,
    completionCriteria: Type.Array(ShortTextSchema, {
      minItems: 1,
      maxItems: 32,
    }),
  },
  { additionalProperties: false },
);

const CouncilMemberSchema = Type.Object(
  {
    id: IdentifierSchema,
    role: ShortTextSchema,
    model: ModelRequestSchema,
  },
  { additionalProperties: false },
);

export const CouncilNodeSchema = Type.Object(
  {
    ...CommonNodeProperties,
    kind: Type.Literal("council"),
    goal: InstructionSchema,
    members: Type.Array(CouncilMemberSchema, { minItems: 2, maxItems: 16 }),
    chair: ModelRequestSchema,
    rounds: Type.Integer({ minimum: 1, maximum: 20 }),
    preserveMinorityReports: Type.Boolean(),
  },
  { additionalProperties: false },
);

const FusionMemberSchema = Type.Object(
  {
    id: IdentifierSchema,
    role: ShortTextSchema,
    model: ModelRequestSchema,
  },
  { additionalProperties: false },
);

const OpenRouterFusionSchema = Type.Object(
  {
    mode: Type.Literal("openrouter-router"),
    router: ModelRequestSchema,
    // OpenRouter's hosted Fusion plugin currently accepts at most eight
    // analysis models. Kady-owned panels have a separate, wider bound below.
    members: Type.Array(FusionMemberSchema, { minItems: 2, maxItems: 8 }),
    judge: ModelRequestSchema,
  },
  { additionalProperties: false },
);

const KadyPanelFusionSchema = Type.Object(
  {
    mode: Type.Literal("kady-panel"),
    members: Type.Array(FusionMemberSchema, { minItems: 2, maxItems: 32 }),
    synthesizer: ModelRequestSchema,
    rounds: Type.Integer({ minimum: 1, maximum: 20 }),
  },
  { additionalProperties: false },
);

export const FusionNodeSchema = Type.Object(
  {
    ...CommonNodeProperties,
    kind: Type.Literal("fusion"),
    goal: InstructionSchema,
    fusion: Type.Union([OpenRouterFusionSchema, KadyPanelFusionSchema]),
    preserveMinorityReports: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const BestOfNNodeSchema = Type.Object(
  {
    ...ModelDrivenNodeProperties,
    kind: Type.Literal("best-of-n"),
    goal: InstructionSchema,
    candidateCount: Type.Optional(Type.Integer({ minimum: 2, maximum: 16 })),
    candidateModels: Type.Optional(
      Type.Array(ModelRequestSchema, { minItems: 2, maxItems: 16 }),
    ),
    evaluator: Type.Optional(ModelRequestSchema),
  },
  { additionalProperties: false },
);

const EvidenceCheckSchema = Type.Union([
  Type.Literal("citations"),
  Type.Literal("artifact-exists"),
  Type.Literal("claim-support"),
  Type.Literal("unsupported-output"),
]);

export const EvidenceGateNodeSchema = Type.Object(
  {
    ...CommonNodeProperties,
    kind: Type.Literal("evidence-gate"),
    checks: Type.Array(EvidenceCheckSchema, { minItems: 1, maxItems: 4 }),
    artifactIds: Type.Array(IdentifierSchema, { maxItems: 64 }),
    evaluator: Type.Optional(ModelRequestSchema),
    onUnsupportedOutput: Type.Union([
      Type.Literal("fail"),
      Type.Literal("rescue"),
      Type.Literal("route"),
    ]),
  },
  { additionalProperties: false },
);

export const Lean4NodeSchema = Type.Object(
  {
    ...CommonNodeProperties,
    kind: Type.Literal("lean4"),
    goal: InstructionSchema,
    theorem: InstructionSchema,
    mode: Type.Union([Type.Literal("verify"), Type.Literal("solve")]),
    solverModel: Type.Optional(ModelRequestSchema),
    mathlib: Type.Boolean(),
    skill: Type.Literal("byom-dag-fusion"),
  },
  { additionalProperties: false },
);

export const WorkflowNodeSchema = Type.Union([
  AgentNodeSchema,
  ResearchUntilGoalNodeSchema,
  CouncilNodeSchema,
  FusionNodeSchema,
  PromptOptimizationNodeSchema,
  BestOfNNodeSchema,
  EvidenceGateNodeSchema,
  Lean4NodeSchema,
]);

export const WorkflowEdgeSchema = Type.Object(
  {
    id: IdentifierSchema,
    from: IdentifierSchema,
    to: IdentifierSchema,
    condition: Type.Optional(
      Type.Union([
        Type.Literal("always"),
        Type.Literal("success"),
        Type.Literal("failure"),
        Type.Literal("evidence-supported"),
        Type.Literal("evidence-unsupported"),
      ]),
    ),
  },
  { additionalProperties: false },
);

export const WorkflowArtifactSchema = Type.Object(
  {
    id: IdentifierSchema,
    name: ShortTextSchema,
    kind: Type.Union([
      Type.Literal("file"),
      Type.Literal("directory"),
      Type.Literal("dataset"),
      Type.Literal("report"),
      Type.Literal("proof"),
      Type.Literal("log"),
    ]),
    writerNodeId: IdentifierSchema,
    path: Type.Optional(Type.String({ minLength: 1, maxLength: 1_024 })),
  },
  { additionalProperties: false },
);

const ScientificWorkflowRequiredInputSchema = Type.Object(
  {
    key: Type.String({ minLength: 1, maxLength: 64 }),
    label: Type.String({ minLength: 1, maxLength: 256 }),
  },
  { additionalProperties: false },
);

const ScientificWorkflowRequiredFileSchema = Type.Object(
  {
    key: Type.String({ minLength: 1, maxLength: 64 }),
    label: Type.String({ minLength: 1, maxLength: 256 }),
    minimumCount: Type.Integer({ minimum: 1, maximum: 10_000 }),
  },
  { additionalProperties: false },
);

export const ScientificWorkflowPreconditionsSchema = Type.Object(
  {
    requiredInputs: Type.Array(ScientificWorkflowRequiredInputSchema, {
      maxItems: 256,
      uniqueItems: true,
    }),
    requiredFiles: Type.Array(ScientificWorkflowRequiredFileSchema, {
      maxItems: 256,
      uniqueItems: true,
    }),
    requiredCapabilities: Type.Array(
      Type.Union([
        Type.Literal("prompt-analysis"),
        Type.Literal("read-uploaded-files"),
      ]),
      { maxItems: 2, uniqueItems: true },
    ),
  },
  { additionalProperties: false },
);

/*
 * There is deliberately NO document-level `ui` object.
 *
 * Round 1 carried `ui.viewport` here. It was persisted and round-tripped but
 * never read and never written: nothing emitted a viewport, and nothing applied
 * one to the canvas. A stored field with no behaviour is not free — every
 * optional field added under `additionalProperties: false` is a document an
 * older server can no longer read (it validates on read and raises CORRUPT), so
 * an inert field buys a rollback constraint and nothing else. It is dropped
 * rather than left declared.
 *
 * Node LAYOUT never belonged here anyway: `CommonNodeProperties.position`
 * already carries it per node, and a second `ui.positions` map would be a
 * second source of truth for the same coordinate. Layout therefore still
 * participates in `graphSha256` through `position`, so a layout-only save is a
 * real hash change and not the silent no-op the store skips
 * (store.ts saveDefinitionWithIntent).
 *
 * If pan/zoom is ever remembered, it needs an emitter and an applier landing in
 * the same change as the field.
 */

export const WorkflowGraphDocumentSchema = Type.Object(
  {
    schemaVersion: Type.Literal(WORKFLOW_GRAPH_SCHEMA_VERSION),
    id: IdentifierSchema,
    name: ShortTextSchema,
    description: Type.Optional(DescriptionSchema),
    entryNodeId: IdentifierSchema,
    defaultModel: Type.Optional(ModelRequestSchema),
    settings: Type.Optional(WorkflowSettingsV1Schema),
    limits: WorkflowLimitsSchema,
    rescue: Type.Optional(RescuePolicySchema),
    evidence: EvidencePolicySchema,
    artifacts: Type.Optional(
      Type.Array(WorkflowArtifactSchema, { maxItems: MAX_WORKFLOW_ARTIFACTS }),
    ),
    preconditions: Type.Optional(ScientificWorkflowPreconditionsSchema),
    nodes: Type.Array(WorkflowNodeSchema, {
      minItems: 1,
      maxItems: MAX_WORKFLOW_NODES,
    }),
    edges: Type.Array(WorkflowEdgeSchema, { maxItems: MAX_WORKFLOW_EDGES }),
    provenance: Type.Optional(WorkflowProvenanceSchema),
  },
  { additionalProperties: false },
);

export type WorkflowLimits = Static<typeof WorkflowLimitsSchema>;
export type WorkflowProvenance = Static<typeof WorkflowProvenanceSchema>;
export type WorkflowNodeMeta = Static<typeof WorkflowNodeMetaSchema>;
export type NodeLimits = Static<typeof NodeLimitsSchema>;
export type RequestedModel = Static<typeof RequestedModelSchema>;
export type ModelRequest = Static<typeof ModelRequestSchema>;
export type NodeSpecV1 = Static<typeof NodeSpecV1Schema>;
export type WorkflowSettingsV1 = Static<typeof WorkflowSettingsV1Schema>;
export type RescuePolicy = Static<typeof RescuePolicySchema>;
export type EvidencePolicy = Static<typeof EvidencePolicySchema>;
export type NodeWorkspacePolicy = Static<typeof NodeWorkspacePolicySchema>;
export type WorkflowNode = Static<typeof WorkflowNodeSchema>;
export type WorkflowEdge = Static<typeof WorkflowEdgeSchema>;
export type WorkflowArtifact = Static<typeof WorkflowArtifactSchema>;
export type ScientificWorkflowPreconditions = Static<
  typeof ScientificWorkflowPreconditionsSchema
>;
export type WorkflowGraphDocument = Static<typeof WorkflowGraphDocumentSchema>;
