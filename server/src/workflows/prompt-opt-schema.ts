import { Type, type Static } from "typebox";
import { InterviewParams } from "../agent/interview.ts";

export const PROMPT_OPTIMIZATION_ARTIFACT_VERSION = 1 as const;
export const MAX_PROMPT_OPTIMIZATION_ITERATIONS = 8;
export const MAX_PROMPT_OPTIMIZATION_PROMPT_LENGTH = 3_072;

const IdentifierSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-z][a-z0-9_-]*$",
});

const ShortTextSchema = Type.String({ minLength: 1, maxLength: 256 });
const DescriptionSchema = Type.String({ minLength: 1, maxLength: 4_096 });
const InstructionSchema = Type.String({ minLength: 1, maxLength: 32_768 });
const PromptSchema = Type.String({
  minLength: 1,
  maxLength: MAX_PROMPT_OPTIMIZATION_PROMPT_LENGTH,
});

const ReferenceSchema = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]*$",
});

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

const RequestedModelSchema = Type.Union([
  FixedRequestedModelSchema,
  KadyCurrentRequestedModelSchema,
]);

const ModelRequestSchema = Type.Object(
  {
    requested: RequestedModelSchema,
    resolution: Type.Union([
      Type.Object({ mode: Type.Literal("exact") }, { additionalProperties: false }),
      Type.Object(
        {
          mode: Type.Literal("explicit-fallback"),
          alternatives: Type.Array(RequestedModelSchema, { minItems: 1, maxItems: 8 }),
          reason: ShortTextSchema,
        },
        { additionalProperties: false },
      ),
    ]),
  },
  { additionalProperties: false },
);

const NodeLimitsSchema = Type.Object(
  {
    maxIterations: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
    maxModelCalls: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
    maxParallelism: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
    maxSubagents: Type.Optional(Type.Integer({ minimum: 0, maximum: 256 })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 86_400_000 })),
    maxTokens: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000_000 })),
    maxCostUsd: Type.Optional(Type.Number({ minimum: 0, maximum: 1_000_000 })),
    maxRetries: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })),
  },
  { additionalProperties: false },
);

const RescuePolicySchema = Type.Object(
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

const EvidencePolicySchema = Type.Object(
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

const NodeWorkspacePolicySchema = Type.Object(
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

const SamplingValueSchema = Type.Union([
  Type.Number(),
  Type.String({ maxLength: 256 }),
  Type.Boolean(),
]);

/** Frozen NodeSpec v1 shape, mirrored here so schema.ts can import this fragment without a cycle. */
export const PromptOptimizationNodeSpecV1Schema = Type.Object(
  {
    version: Type.Optional(Type.Literal(1)),
    model: Type.Optional(ModelRequestSchema),
    reasoningEffort: Type.Optional(ReasoningLevelSchema),
    hyperparameters: Type.Optional(
      Type.Object(
        {
          temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
          top_p: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
          sampling: Type.Optional(
            Type.Record(
              Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_.-]{0,63}$" }),
              SamplingValueSchema,
              { maxProperties: 16 },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    conditions: Type.Optional(
      Type.Object(
        {
          when: Type.Optional(InstructionSchema),
          exists: Type.Optional(
            Type.Array(Type.String({ minLength: 1, maxLength: 1_024 }), {
              maxItems: 64,
            }),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    harness: Type.Optional(
      Type.Union([
        Type.Literal("pi"),
        Type.Literal("claude-code"),
        Type.Literal("codex"),
        Type.Literal("opencode"),
        Type.Literal("copilot"),
      ]),
    ),
    databases: Type.Optional(Type.Array(ReferenceSchema, { maxItems: 64 })),
    skills: Type.Optional(
      Type.Object(
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
      ),
    ),
    subagents: Type.Optional(
      Type.Object(
        {
          mode: Type.Optional(
            Type.Union([Type.Literal("auto"), Type.Literal("auto-manual")]),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    autonomy: Type.Optional(
      Type.Union([Type.Literal("strict"), Type.Literal("loose")]),
    ),
    deliberation: Type.Optional(
      Type.Object(
        {
          personalityStoreRef: Type.Optional(ReferenceSchema),
          bestOfNPersonalityCount: Type.Optional(
            Type.Integer({ minimum: 1, maximum: 32 }),
          ),
          mimeographs: Type.Optional(
            Type.Object(
              {
                mode: Type.Optional(
                  Type.Union([Type.Literal("auto"), Type.Literal("manual")]),
                ),
                personalityRefs: Type.Optional(
                  Type.Array(ReferenceSchema, { maxItems: 32 }),
                ),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    billingMode: Type.Optional(
      Type.Union([
        Type.Literal("inherit"),
        Type.Literal("api"),
        Type.Literal("subscription"),
      ]),
    ),
    budget: Type.Optional(
      Type.Object(
        {
          maxTokens: Type.Optional(
            Type.Integer({ minimum: 1, maximum: 100_000_000 }),
          ),
          maxCostUsd: Type.Optional(
            Type.Number({ minimum: 0, maximum: 1_000_000 }),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const CouncilMemberSchema = Type.Object(
  { id: IdentifierSchema, role: ShortTextSchema, model: ModelRequestSchema },
  { additionalProperties: false },
);

const CouncilConfigurationSchema = Type.Object(
  {
    members: Type.Array(CouncilMemberSchema, { minItems: 2, maxItems: 16 }),
    chair: ModelRequestSchema,
    rounds: Type.Integer({ minimum: 1, maximum: 20 }),
    preserveMinorityReports: Type.Boolean(),
  },
  { additionalProperties: false },
);

const FusionMemberSchema = Type.Object(
  { id: IdentifierSchema, role: ShortTextSchema, model: ModelRequestSchema },
  { additionalProperties: false },
);

const FusionConfigurationSchema = Type.Union([
  Type.Object(
    {
      mode: Type.Literal("openrouter-router"),
      router: ModelRequestSchema,
      members: Type.Array(FusionMemberSchema, { minItems: 2, maxItems: 8 }),
      judge: ModelRequestSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      mode: Type.Literal("kady-panel"),
      members: Type.Array(FusionMemberSchema, { minItems: 2, maxItems: 32 }),
      synthesizer: ModelRequestSchema,
      rounds: Type.Integer({ minimum: 1, maximum: 20 }),
    },
    { additionalProperties: false },
  ),
]);

/** Complete S6 union fragment. It intentionally has no runtime import from schema.ts. */
export const PromptOptimizationNodeSchema = Type.Object(
  {
    id: IdentifierSchema,
    name: ShortTextSchema,
    description: Type.Optional(DescriptionSchema),
    terminal: Type.Boolean(),
    workspace: NodeWorkspacePolicySchema,
    position: Type.Optional(
      Type.Object(
        {
          x: Type.Number({ minimum: -1_000_000, maximum: 1_000_000 }),
          y: Type.Number({ minimum: -1_000_000, maximum: 1_000_000 }),
        },
        { additionalProperties: false },
      ),
    ),
    limits: Type.Optional(NodeLimitsSchema),
    rescue: Type.Optional(RescuePolicySchema),
    evidence: Type.Optional(EvidencePolicySchema),
    settings: Type.Optional(PromptOptimizationNodeSpecV1Schema),
    kind: Type.Literal("prompt-optimization"),
    originalPrompt: PromptSchema,
    objective: InstructionSchema,
    artifactId: IdentifierSchema,
    iterations: Type.Integer({
      minimum: 1,
      maximum: MAX_PROMPT_OPTIMIZATION_ITERATIONS,
    }),
    interviewUser: Type.Optional(InterviewParams),
    fusionDeliberation: Type.Object(
      {
        enabled: Type.Boolean(),
        council: CouncilConfigurationSchema,
        fusion: Type.Optional(FusionConfigurationSchema),
        preserveMinorityReports: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const InterviewResponseSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    value: Type.Union([
      Type.String(),
      Type.Array(Type.String()),
    ]),
  },
  { additionalProperties: false },
);

export const PromptOptimizationArtifactSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    artifactVersion: Type.Literal(PROMPT_OPTIMIZATION_ARTIFACT_VERSION),
    kind: Type.Literal("prompt-optimization"),
    runId: Type.String({ minLength: 1, maxLength: 128 }),
    executionId: Type.String({ minLength: 1, maxLength: 128 }),
    nodeId: IdentifierSchema,
    originalPrompt: PromptSchema,
    objective: InstructionSchema,
    interview: Type.Optional(
      Type.Object(
        {
          cancelled: Type.Boolean(),
          responses: Type.Array(InterviewResponseSchema, { maxItems: 128 }),
        },
        { additionalProperties: false },
      ),
    ),
    iterations: Type.Array(
      Type.Object(
        {
          iteration: Type.Integer({ minimum: 1, maximum: MAX_PROMPT_OPTIMIZATION_ITERATIONS }),
          mode: Type.Union([Type.Literal("council"), Type.Literal("fusion")]),
          inputPrompt: PromptSchema,
          candidatePrompt: PromptSchema,
          rationale: Type.String({ minLength: 1, maxLength: 4_096 }),
          usage: Type.Object(
            {
              tokens: Type.Integer({ minimum: 0, maximum: 100_000_000 }),
              costUsd: Type.Number({ minimum: 0, maximum: 1_000_000 }),
            },
            { additionalProperties: false },
          ),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: MAX_PROMPT_OPTIMIZATION_ITERATIONS },
    ),
    winningPrompt: PromptSchema,
    rationale: Type.String({ minLength: 1, maxLength: 4_096 }),
    envelope: Type.Object(
      {
        startedAt: Type.Integer({ minimum: 0 }),
        deadlineAt: Type.Integer({ minimum: 0 }),
        maxTokens: Type.Integer({ minimum: 1, maximum: 100_000_000 }),
        spentTokens: Type.Integer({ minimum: 0, maximum: 100_000_000 }),
        maxCostUsd: Type.Number({ minimum: 0, maximum: 1_000_000 }),
        spentCostUsd: Type.Number({ minimum: 0, maximum: 1_000_000 }),
      },
      { additionalProperties: false },
    ),
    createdAt: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type PromptOptimizationNode = Static<typeof PromptOptimizationNodeSchema>;
export type PromptOptimizationArtifact = Static<typeof PromptOptimizationArtifactSchema>;
export type PromptOptimizationIteration = PromptOptimizationArtifact["iterations"][number];
