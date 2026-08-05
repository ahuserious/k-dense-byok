"use client";

import { PlusIcon, Trash2Icon } from "lucide-react";
import { createContext, useContext, useMemo, useState } from "react";

import type { Model } from "@/components/model-selector";
import {
  DEFAULT_WORKFLOW_EVIDENCE,
  DEFAULT_WORKFLOW_RESCUE,
  allowedConditionsForSource,
  createKadyPanelFusionConfiguration,
  createOpenRouterFusionConfiguration,
  exactKadyCurrentModel,
  fallbackAlternativeFor,
  nodeKindLabel,
  nodeRemovalBlocker,
} from "@/lib/dag-workflow-builder";
import type {
  BestOfNWorkflowNode,
  CouncilWorkflowNode,
  EvidenceGateWorkflowNode,
  FixedRequestedModel,
  FusionWorkflowNode,
  Lean4WorkflowNode,
  WorkflowEdgeCondition,
  WorkflowEvidenceCheck,
  WorkflowEvidencePolicy,
  WorkflowGraphDocument,
  WorkflowGraphNode,
  WorkflowLimits,
  WorkflowModelRequest,
  WorkflowNodeLimits,
  WorkflowPanelMember,
  WorkflowReasoningLevel,
  WorkflowRequestedModel,
  WorkflowRescuePolicy,
  WorkflowRescueTrigger,
} from "@/lib/dag-workflows";

const INPUT_CLASS = "w-full rounded-md border bg-background px-2 py-1.5 text-xs";
const TEXTAREA_CLASS = `${INPUT_CLASS} min-h-20 resize-y`;
const SECTION_CLASS = "space-y-3 border-b px-4 py-4 last:border-b-0";

const REASONING_LEVELS: WorkflowReasoningLevel[] = [
  "off", "minimal", "low", "medium", "high", "xhigh", "max",
];
const RESCUE_TRIGGERS: WorkflowRescueTrigger[] = [
  "failure", "stalled", "unsupported-output", "pre-compaction", "post-compaction",
];
const EVIDENCE_CHECKS: WorkflowEvidenceCheck[] = [
  "citations", "artifact-exists", "claim-support", "unsupported-output",
];
const PANEL_MEMBER_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const MIN_PANEL_MEMBERS = 2;

const ModelInventoryContext = createContext<readonly Model[]>([]);

const WORKFLOW_LIMIT_FIELDS: ReadonlyArray<{
  key: keyof WorkflowLimits;
  label: string;
  min: number;
  max: number;
  step?: number;
}> = [
  { key: "maxIterations", label: "Iterations", min: 1, max: 1_000 },
  { key: "maxModelCalls", label: "Model calls", min: 1, max: 10_000 },
  { key: "maxParallelism", label: "Parallelism", min: 1, max: 16 },
  { key: "maxSubagents", label: "Subagents", min: 0, max: 256 },
  { key: "timeoutMs", label: "Timeout (ms)", min: 1_000, max: 86_400_000 },
  { key: "maxTokens", label: "Tokens", min: 1, max: 100_000_000 },
  { key: "maxCostUsd", label: "Cost (USD)", min: 0, max: 1_000_000, step: 0.01 },
  { key: "maxRetries", label: "Retry ceiling", min: 0, max: 3 },
];

function cloneModelRequest(value: WorkflowModelRequest): WorkflowModelRequest {
  return {
    requested: value.requested.source === "kady-current"
      ? {
          ...value.requested,
          auth: { ...value.requested.auth },
        }
      : {
          ...value.requested,
          auth: { ...value.requested.auth },
        },
    resolution: value.resolution.mode === "exact"
      ? { mode: "exact" }
      : {
          mode: "explicit-fallback",
          reason: value.resolution.reason,
          alternatives: value.resolution.alternatives.map((alternative) => (
            alternative.source === "kady-current"
              ? { ...alternative, auth: { ...alternative.auth } }
              : { ...alternative, auth: { ...alternative.auth } }
          )),
        },
  };
}

function inventoryModelIdentity(modelId: string): {
  provider: string;
  model: string;
} | null {
  const separator = modelId.indexOf("/");
  if (separator < 1 || separator === modelId.length - 1) return null;
  return {
    provider: modelId.slice(0, separator),
    model: modelId.slice(separator + 1),
  };
}

function nextPanelMemberId(
  members: readonly WorkflowPanelMember[],
  stem: string,
): string {
  const existing = new Set(members.map((member) => member.id));
  for (let suffix = members.length + 1; suffix <= 10_000; suffix += 1) {
    const candidate = `${stem}-${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error(`Unable to allocate another ${stem} member id.`);
}

function panelMemberIdError(
  members: readonly WorkflowPanelMember[],
  index: number,
): string | null {
  const memberId = members[index]?.id ?? "";
  if (!PANEL_MEMBER_ID.test(memberId)) {
    return "Use 1-64 lowercase letters, numbers, underscores, or hyphens; start with a letter.";
  }
  if (members.some((member, candidateIndex) => candidateIndex !== index && member.id === memberId)) {
    return "Member IDs must be unique within this panel.";
  }
  return null;
}

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="block space-y-1">
      <span className="block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
      {hint ? <span className="block text-[10px] leading-relaxed text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

function RequestedModelFields({
  value,
  onChange,
}: {
  value: WorkflowRequestedModel;
  onChange: (value: WorkflowRequestedModel) => void;
}) {
  const modelInventory = useContext(ModelInventoryContext);
  const [forceCustomReference, setForceCustomReference] = useState(false);
  const selectableModels = useMemo(() => {
    const seen = new Set<string>();
    return modelInventory.filter((model) => {
      if (model.isFusion || model.id.startsWith("fusion/")) return false;
      if (!inventoryModelIdentity(model.id) || seen.has(model.id)) return false;
      seen.add(model.id);
      return true;
    });
  }, [modelInventory]);
  const currentModelId = value.source === "fixed"
    ? `${value.provider}/${value.model}`
    : "";
  const inventorySelection = selectableModels.find((model) => model.id === currentModelId);
  const customReference = value.source === "fixed" && (
    forceCustomReference || !inventorySelection
  );

  return (
    <div className="grid gap-2 rounded-md border bg-muted/10 p-2">
      <Field label="Source">
        <select
          className={INPUT_CLASS}
          value={value.source}
          onChange={(event) => {
            if (event.target.value === "kady-current") {
              onChange({
                source: "kady-current",
                auth: { kind: "kady-current" },
                reasoning: value.reasoning,
              });
            } else {
              onChange({
                source: "fixed",
                provider: "openrouter",
                model: "anthropic/claude-sonnet-4",
                auth: { kind: "api-key" },
                reasoning: value.reasoning,
              });
            }
          }}
        >
          <option value="kady-current">Pi (Kady) current</option>
          <option value="fixed">Fixed provider/model</option>
        </select>
      </Field>

      {value.source === "fixed" ? (
        <>
          <Field
            label="Discovered model"
            hint="Selecting an inventory entry changes only provider/model. Auth, reasoning, and fallback policy stay explicit below."
          >
            <select
              className={INPUT_CLASS}
              aria-label="Discovered model"
              value={customReference ? "__custom__" : currentModelId}
              onChange={(event) => {
                if (event.target.value === "__custom__") {
                  setForceCustomReference(true);
                  return;
                }
                const selected = selectableModels.find(
                  (model) => model.id === event.target.value && model.available !== false,
                );
                const identity = selected ? inventoryModelIdentity(selected.id) : null;
                if (!identity) return;
                setForceCustomReference(false);
                onChange({ ...value, ...identity });
              }}
            >
              <option value="__custom__">Known Kady provider/model reference</option>
              {selectableModels.map((model) => (
                <option key={model.id} value={model.id} disabled={model.available === false}>
                  {model.label} · {model.sourceLabel ?? model.provider}
                  {model.available === false ? " · disconnected" : ""}
                </option>
              ))}
            </select>
          </Field>
          {customReference ? (
            <div className="grid grid-cols-2 gap-2">
              <Field label="Provider">
                <input
                  className={INPUT_CLASS}
                  value={value.provider}
                  onChange={(event) => onChange({ ...value, provider: event.target.value })}
                />
              </Field>
              <Field label="Model">
                <input
                  className={INPUT_CLASS}
                  value={value.model}
                  onChange={(event) => onChange({ ...value, model: event.target.value })}
                />
              </Field>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2 rounded border bg-background px-2 py-1.5 text-[10px]">
              <span className="min-w-0 truncate font-mono">{currentModelId}</span>
              <button
                type="button"
                className="shrink-0 underline"
                onClick={() => setForceCustomReference(true)}
              >
                Edit model ref
              </button>
            </div>
          )}
          <div className="grid gap-2">
            <Field
              label="Auth owner"
              hint="Fixed DAG requests do not support auth profiles. Configured OpenAI-compatible models use custom auth."
            >
              <select
                className={INPUT_CLASS}
                value={value.auth.kind}
                onChange={(event) => onChange({
                  ...value,
                  auth: { kind: event.target.value as FixedRequestedModel["auth"]["kind"] },
                })}
              >
                <option value="api-key">API key</option>
                <option value="oauth">OAuth</option>
                <option value="local">Local</option>
                <option value="custom">Configured OpenAI-compatible</option>
              </select>
            </Field>
            {value.auth.profile ? (
              <div className="rounded border border-amber-500/40 bg-amber-500/5 p-2 text-[10px] text-amber-800 dark:text-amber-200">
                This saved request contains unsupported auth profile <code>{value.auth.profile}</code>. Remove it before saving.
                <button
                  type="button"
                  className="ml-2 underline"
                  onClick={() => onChange({ ...value, auth: { kind: value.auth.kind } })}
                >
                  Remove profile
                </button>
              </div>
            ) : null}
          </div>
        </>
      ) : (
        <p className="rounded border bg-background px-2 py-1.5 text-[10px] text-muted-foreground">
          Provider, model, and auth are resolved from the main Kady agent at run admission.
        </p>
      )}

      <Field label="Reasoning">
        <select
          className={INPUT_CLASS}
          value={value.reasoning}
          onChange={(event) => onChange({
            ...value,
            reasoning: event.target.value as WorkflowReasoningLevel,
          })}
        >
          {REASONING_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
        </select>
      </Field>
    </div>
  );
}

export function ModelRequestEditor({
  label,
  value,
  onChange,
}: {
  label: string;
  value: WorkflowModelRequest;
  onChange: (value: WorkflowModelRequest) => void;
}) {
  const fallbackResolution = value.resolution.mode === "explicit-fallback"
    ? value.resolution
    : null;
  return (
    <details className="rounded-md border bg-muted/5 p-2">
      <summary className="cursor-pointer text-xs font-medium">{label}</summary>
      <div className="mt-3 space-y-3">
        <RequestedModelFields
          value={value.requested}
          onChange={(requested) => onChange({ ...value, requested })}
        />
        <Field
          label="Resolution policy"
          hint="Exact requests fail visibly. Fallback models run only when explicitly listed here."
        >
          <select
            className={INPUT_CLASS}
            value={value.resolution.mode}
            onChange={(event) => {
              if (event.target.value === "exact") {
                onChange({ ...value, resolution: { mode: "exact" } });
              } else {
                onChange({
                  ...value,
                  resolution: {
                    mode: "explicit-fallback",
                    alternatives: [fallbackAlternativeFor(value.requested)],
                    reason: "Use only these explicitly approved alternatives.",
                  },
                });
              }
            }}
          >
            <option value="exact">Exact — fail if unsupported</option>
            <option value="explicit-fallback">Explicit fallback list</option>
          </select>
        </Field>

        {fallbackResolution ? (
          <div className="space-y-2">
            <Field label="Fallback reason">
              <input
                className={INPUT_CLASS}
                value={fallbackResolution.reason}
                onChange={(event) => onChange({
                  ...value,
                  resolution: {
                    mode: "explicit-fallback",
                    alternatives: fallbackResolution.alternatives,
                    reason: event.target.value,
                  },
                })}
              />
            </Field>
            {fallbackResolution.alternatives.map((alternative, index) => (
              <div key={index} className="space-y-1 rounded-md border p-2">
                <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Alternative {index + 1}
                  <button
                    type="button"
                    className="rounded p-1 hover:bg-muted disabled:opacity-40"
                    aria-label={`Remove fallback alternative ${index + 1}`}
                    disabled={fallbackResolution.alternatives.length === 1}
                    onClick={() => onChange({
                      ...value,
                      resolution: {
                        mode: "explicit-fallback",
                        reason: fallbackResolution.reason,
                        alternatives: fallbackResolution.alternatives.filter((_, candidateIndex) => candidateIndex !== index),
                      },
                    })}
                  >
                    <Trash2Icon className="size-3" />
                  </button>
                </div>
                <RequestedModelFields
                  value={alternative}
                  onChange={(nextAlternative) => onChange({
                    ...value,
                    resolution: {
                      mode: "explicit-fallback",
                      reason: fallbackResolution.reason,
                      alternatives: fallbackResolution.alternatives.map((candidate, candidateIndex) => (
                        candidateIndex === index ? nextAlternative : candidate
                      )),
                    },
                  })}
                />
              </div>
            ))}
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-medium hover:bg-muted disabled:opacity-40"
              disabled={fallbackResolution.alternatives.length >= 8}
              onClick={() => onChange({
                ...value,
                resolution: {
                  mode: "explicit-fallback",
                  reason: fallbackResolution.reason,
                  alternatives: [
                    ...fallbackResolution.alternatives,
                    fallbackAlternativeFor(value.requested, fallbackResolution.alternatives.length),
                  ],
                },
              })}
            >
              <PlusIcon className="size-3" /> Add explicit alternative
            </button>
          </div>
        ) : null}
      </div>
    </details>
  );
}

function RescuePolicyEditor({
  value,
  onChange,
}: {
  value: WorkflowRescuePolicy;
  onChange: (value: WorkflowRescuePolicy) => void;
}) {
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(event) => onChange(event.target.checked
            ? { ...DEFAULT_WORKFLOW_RESCUE, triggers: [...DEFAULT_WORKFLOW_RESCUE.triggers] }
            : { enabled: false, maxAttempts: 0, triggers: [] })}
        />
        Auto-rescue enabled
      </label>
      <Field
        label="Maximum rescue attempts"
        hint="Automatic rescue is also capped by the workflow or node Retry ceiling; the lower value wins."
      >
        <input
          className={INPUT_CLASS}
          type="number"
          min={value.enabled ? 1 : 0}
          max={10}
          disabled={!value.enabled}
          value={value.maxAttempts}
          onChange={(event) => {
            if (!event.target.value) return;
            onChange({ ...value, maxAttempts: Number(event.target.value) });
          }}
        />
      </Field>
      <div className="grid grid-cols-1 gap-1">
        {RESCUE_TRIGGERS.map((trigger) => (
          <label key={trigger} className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <input
              type="checkbox"
              disabled={!value.enabled}
              checked={value.triggers.includes(trigger)}
              onChange={(event) => onChange({
                ...value,
                triggers: event.target.checked
                  ? [...value.triggers, trigger]
                  : value.triggers.filter((candidate) => candidate !== trigger),
              })}
            />
            {trigger}
          </label>
        ))}
      </div>
    </div>
  );
}

function EvidencePolicyEditor({
  value,
  onChange,
  scope,
  evaluatorApplies = true,
}: {
  value: WorkflowEvidencePolicy;
  onChange: (value: WorkflowEvidencePolicy) => void;
  scope: "workflow" | "node";
  evaluatorApplies?: boolean;
}) {
  const evaluatorLabel = scope === "workflow"
    ? "Workflow evidence evaluator"
    : "Node evidence evaluator";
  const evaluatorPrecedence = scope === "workflow"
    ? "Evaluator precedence: workflow evidence evaluator, then graph default model. If neither is configured, enabled model-assisted checks fail validation."
    : "Evaluator precedence: node evidence evaluator, workflow evidence evaluator, then graph default model. If none is configured, enabled model-assisted checks fail validation.";

  return (
    <div className="space-y-2">
      <p className="text-[10px] leading-relaxed text-muted-foreground">
        Enabled non-gate nodes run model-assisted support checking; this is not proof of truth.
        Explicit evidence gates keep their authored checks.
      </p>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(event) => onChange({ ...value, enabled: event.target.checked })}
        />
        Evidence checks enabled
      </label>
      <Field label="Minimum independent sources">
        <input
          className={INPUT_CLASS}
          type="number"
          min={0}
          max={20}
          value={value.minimumIndependentSources}
          onChange={(event) => {
            if (!event.target.value) return;
            onChange({ ...value, minimumIndependentSources: Number(event.target.value) });
          }}
        />
      </Field>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={value.requireArtifactReferences}
          onChange={(event) => onChange({ ...value, requireArtifactReferences: event.target.checked })}
        />
        Require artifact references
      </label>
      <Field label="Unsupported output">
        <select
          className={INPUT_CLASS}
          value={value.onUnsupportedOutput}
          onChange={(event) => onChange({
            ...value,
            onUnsupportedOutput: event.target.value as WorkflowEvidencePolicy["onUnsupportedOutput"],
          })}
        >
          <option value="fail">Fail visibly</option>
          <option value="rescue">Request bounded rescue</option>
          <option value="route">Follow explicit route</option>
        </select>
      </Field>
      <div className="space-y-1">
        {!evaluatorApplies ? (
          <>
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              Explicit evidence gates use the gate evaluator configured above. They do not run
              or consume an extra model call for the common policy evaluator.
            </p>
            {value.evaluator ? (
              <button
                type="button"
                className="text-[10px] text-muted-foreground underline"
                onClick={() => {
                  const policyWithoutEvaluator = { ...value };
                  delete policyWithoutEvaluator.evaluator;
                  onChange(policyWithoutEvaluator);
                }}
              >
                Remove ignored node policy evaluator
              </button>
            ) : null}
          </>
        ) : value.evaluator ? (
          <>
            <ModelRequestEditor
              label={evaluatorLabel}
              value={value.evaluator}
              onChange={(evaluator) => onChange({ ...value, evaluator })}
            />
            <button
              type="button"
              className="text-[10px] text-muted-foreground underline"
              onClick={() => {
                const policyWithoutEvaluator = { ...value };
                delete policyWithoutEvaluator.evaluator;
                onChange(policyWithoutEvaluator);
              }}
            >
              Remove {scope} evidence evaluator
            </button>
          </>
        ) : (
          <button
            type="button"
            className="rounded-md border px-2 py-1.5 text-xs hover:bg-muted"
            onClick={() => onChange({ ...value, evaluator: exactKadyCurrentModel() })}
          >
            Add {scope} evidence evaluator
          </button>
        )}
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          {evaluatorPrecedence}
        </p>
      </div>
    </div>
  );
}

export function DagGraphInspector({
  graph,
  onChange,
  modelInventory = [],
}: {
  graph: WorkflowGraphDocument;
  onChange: (graph: WorkflowGraphDocument) => void;
  modelInventory?: readonly Model[];
}) {
  const rootCandidates = useMemo(() => {
    const targets = new Set(graph.edges.map((edge) => edge.to));
    return graph.nodes.filter((node) => !targets.has(node.id) || node.id === graph.entryNodeId);
  }, [graph.edges, graph.entryNodeId, graph.nodes]);
  return (
    <ModelInventoryContext.Provider value={modelInventory}>
      <div className={SECTION_CLASS}>
      <h2 className="text-xs font-semibold">Graph settings</h2>
      <Field label="Name">
        <input className={INPUT_CLASS} value={graph.name} onChange={(event) => onChange({ ...graph, name: event.target.value })} />
      </Field>
      <Field label="Description">
        <textarea
          className={TEXTAREA_CLASS}
          value={graph.description ?? ""}
          onChange={(event) => {
            if (event.target.value) {
              onChange({ ...graph, description: event.target.value });
              return;
            }
            const graphWithoutDescription = { ...graph };
            delete graphWithoutDescription.description;
            onChange(graphWithoutDescription);
          }}
        />
      </Field>
      <Field label="Entry node" hint="Only nodes without incoming edges can be selected as the entry.">
        <select className={INPUT_CLASS} value={graph.entryNodeId} onChange={(event) => onChange({ ...graph, entryNodeId: event.target.value })}>
          {rootCandidates.map((node) => <option key={node.id} value={node.id}>{node.name} ({node.id})</option>)}
        </select>
      </Field>

      <details>
        <summary className="cursor-pointer text-xs font-medium">Workflow limits</summary>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {WORKFLOW_LIMIT_FIELDS.map((field) => (
            <Field key={field.key} label={field.label}>
              <input
                className={INPUT_CLASS}
                type="number"
                min={field.min}
                max={field.max}
                step={field.step}
                value={graph.limits[field.key]}
                onChange={(event) => {
                  if (!event.target.value) return;
                  onChange({
                    ...graph,
                    limits: { ...graph.limits, [field.key]: Number(event.target.value) },
                  });
                }}
              />
            </Field>
          ))}
        </div>
      </details>

      <details>
        <summary className="cursor-pointer text-xs font-medium">Workflow rescue</summary>
        <div className="mt-2">
          <RescuePolicyEditor
            value={graph.rescue ?? DEFAULT_WORKFLOW_RESCUE}
            onChange={(rescue) => onChange({ ...graph, rescue })}
          />
        </div>
      </details>

      <details>
        <summary className="cursor-pointer text-xs font-medium">Workflow evidence</summary>
        <div className="mt-2">
          <EvidencePolicyEditor
            value={graph.evidence}
            scope="workflow"
            onChange={(evidence) => onChange({ ...graph, evidence })}
          />
        </div>
      </details>

      {graph.defaultModel ? (
        <ModelRequestEditor
          label="Graph default model"
          value={graph.defaultModel}
          onChange={(defaultModel) => onChange({ ...graph, defaultModel })}
        />
      ) : (
        <button type="button" className="rounded-md border px-2 py-1.5 text-xs hover:bg-muted" onClick={() => onChange({ ...graph, defaultModel: exactKadyCurrentModel() })}>
          Add Pi (Kady) default model
        </button>
      )}
      </div>
    </ModelInventoryContext.Provider>
  );
}

function ModelOverrideEditor({
  label,
  value,
  onChange,
  addLabel = "Override graph model",
}: {
  label: string;
  value: WorkflowModelRequest | undefined;
  onChange: (value: WorkflowModelRequest | undefined) => void;
  addLabel?: string;
}) {
  return value ? (
    <div className="space-y-1">
      <ModelRequestEditor label={label} value={value} onChange={onChange} />
      <button type="button" className="text-[10px] text-muted-foreground underline" onClick={() => onChange(undefined)}>
        Inherit graph default instead
      </button>
    </div>
  ) : (
    <button type="button" className="rounded-md border px-2 py-1.5 text-xs hover:bg-muted" onClick={() => onChange(exactKadyCurrentModel())}>
      {addLabel}
    </button>
  );
}

function NodeLimitsEditor({
  value,
  workflowLimits,
  onChange,
}: {
  value: WorkflowNodeLimits | undefined;
  workflowLimits: WorkflowLimits;
  onChange: (value: WorkflowNodeLimits | undefined) => void;
}) {
  return (
    <div className="space-y-2">
      <p className="text-[10px] leading-relaxed text-muted-foreground">
        Checked values override this node only. Unchecked values inherit the workflow limit,
        and no node override may exceed that workflow ceiling.
      </p>
      {WORKFLOW_LIMIT_FIELDS.map((field) => {
        const override = value?.[field.key];
        const enabled = override !== undefined;
        const workflowMaximum = workflowLimits[field.key];
        return (
          <div key={field.key} className="grid grid-cols-[1fr_8rem] items-center gap-2">
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                aria-label={`Override ${field.label}`}
                checked={enabled}
                onChange={(event) => {
                  if (event.target.checked) {
                    onChange({
                      ...(value ?? {}),
                      [field.key]: workflowMaximum,
                    });
                    return;
                  }
                  const nextLimits = { ...(value ?? {}) };
                  delete nextLimits[field.key];
                  onChange(Object.keys(nextLimits).length > 0 ? nextLimits : undefined);
                }}
              />
              <span>{field.label}</span>
            </label>
            <input
              className={INPUT_CLASS}
              aria-label={`Node ${field.label}`}
              type="number"
              min={field.min}
              max={Math.min(field.max, workflowMaximum)}
              step={field.step}
              disabled={!enabled}
              value={override ?? workflowMaximum}
              onChange={(event) => {
                if (!event.target.value) return;
                const nextValue = Number(event.target.value);
                const maximum = Math.min(field.max, workflowMaximum);
                if (
                  !Number.isFinite(nextValue) ||
                  nextValue < field.min ||
                  nextValue > maximum ||
                  (field.key !== "maxCostUsd" && !Number.isSafeInteger(nextValue))
                ) return;
                onChange({ ...(value ?? {}), [field.key]: nextValue });
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

function PanelMembersEditor({
  members,
  onChange,
  maximumMembers,
  memberLabel,
  idStem,
}: {
  members: WorkflowPanelMember[];
  onChange: (members: WorkflowPanelMember[]) => void;
  maximumMembers: number;
  memberLabel: string;
  idStem: string;
}) {
  const sourceMember = members.at(-1);
  return (
    <div className="space-y-2">
      {members.map((member, index) => {
        const idError = panelMemberIdError(members, index);
        return (
          <div key={index} className="space-y-2 rounded-md border p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {memberLabel} {index + 1}
              </span>
              <button
                type="button"
                className="rounded p-1 text-destructive hover:bg-destructive/5 disabled:cursor-not-allowed disabled:opacity-40"
                aria-label={`Remove ${memberLabel} ${member.id}`}
                disabled={members.length <= MIN_PANEL_MEMBERS}
                onClick={() => onChange(
                  members.filter((_, candidateIndex) => candidateIndex !== index),
                )}
              >
                <Trash2Icon className="size-3" />
              </button>
            </div>
            <Field
              label={`Member ${index + 1} ID`}
              hint="Stable workflow identity; role edits do not rename it."
            >
              <input
                className={INPUT_CLASS}
                aria-label={`Member ${index + 1} ID`}
                value={member.id}
                maxLength={64}
                pattern="[a-z][a-z0-9_-]*"
                aria-invalid={Boolean(idError)}
                onChange={(event) => onChange(members.map((candidate, candidateIndex) => (
                  candidateIndex === index ? { ...candidate, id: event.target.value } : candidate
                )))}
              />
            </Field>
            {idError ? <p role="alert" className="text-[10px] text-destructive">{idError}</p> : null}
            <Field label={`Member ${index + 1} role`}>
              <input className={INPUT_CLASS} value={member.role} onChange={(event) => onChange(members.map((candidate, candidateIndex) => (
                candidateIndex === index ? { ...candidate, role: event.target.value } : candidate
              )))} />
            </Field>
            <ModelRequestEditor
              label={`${member.role || member.id} model`}
              value={member.model}
              onChange={(model) => onChange(members.map((candidate, candidateIndex) => (
                candidateIndex === index ? { ...candidate, model } : candidate
              )))}
            />
          </div>
        );
      })}
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded-md border px-2 py-1.5 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
        disabled={members.length >= maximumMembers || !sourceMember}
        title={members.length >= maximumMembers
          ? `${memberLabel} is limited to ${maximumMembers} members.`
          : "Copies the last visible member model for explicit editing."}
        onClick={() => {
          if (!sourceMember || members.length >= maximumMembers) return;
          onChange([
            ...members,
            {
              id: nextPanelMemberId(members, idStem),
              role: `${memberLabel} ${members.length + 1}`,
              model: cloneModelRequest(sourceMember.model),
            },
          ]);
        }}
      >
        <PlusIcon className="size-3" /> Add {memberLabel}
      </button>
      <p className="text-[10px] text-muted-foreground">
        {members.length} of {maximumMembers} members. New members copy the last visible model;
        no fallback is added implicitly.
      </p>
    </div>
  );
}

function CouncilFields({ node, onChange }: { node: CouncilWorkflowNode; onChange: (node: WorkflowGraphNode) => void }) {
  return (
    <>
      <Field label="Council goal"><textarea className={TEXTAREA_CLASS} value={node.goal} onChange={(event) => onChange({ ...node, goal: event.target.value })} /></Field>
      <Field label="Rounds"><input className={INPUT_CLASS} type="number" min={1} max={20} value={node.rounds} onChange={(event) => event.target.value && onChange({ ...node, rounds: Number(event.target.value) })} /></Field>
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={node.preserveMinorityReports} onChange={(event) => onChange({ ...node, preserveMinorityReports: event.target.checked })} /> Preserve minority reports</label>
      <ModelRequestEditor label="Council chair model" value={node.chair} onChange={(chair) => onChange({ ...node, chair })} />
      <details><summary className="cursor-pointer text-xs font-medium">Council members ({node.members.length})</summary><div className="mt-2"><PanelMembersEditor members={node.members} maximumMembers={16} memberLabel="Council member" idStem="perspective" onChange={(members) => onChange({ ...node, members })} /></div></details>
    </>
  );
}

function FusionFields({ node, onChange }: { node: FusionWorkflowNode; onChange: (node: WorkflowGraphNode) => void }) {
  const fusion = node.fusion;
  return (
    <>
      <Field label="Fusion goal"><textarea className={TEXTAREA_CLASS} value={node.goal} onChange={(event) => onChange({ ...node, goal: event.target.value })} /></Field>
      <Field label="Fusion executor" hint="Changing executor replaces its participant configuration with valid visible defaults.">
        <select className={INPUT_CLASS} value={fusion.mode} onChange={(event) => onChange({
          ...node,
          fusion: event.target.value === "openrouter-router"
            ? createOpenRouterFusionConfiguration()
            : createKadyPanelFusionConfiguration(),
        })}>
          <option value="kady-panel">Kady-owned panel (local/OpenAI-compatible/OpenRouter/OAuth)</option>
          <option value="openrouter-router">OpenRouter hosted Fusion router</option>
        </select>
      </Field>
      <p className="rounded-md border bg-muted/10 p-2 text-[10px] leading-relaxed text-muted-foreground">
        {fusion.mode === "openrouter-router"
          ? "Hosted mode requires the exact openrouter/openrouter/fusion router, exact fixed OpenRouter panel models, API-key auth, and one shared reasoning level."
          : "Kady resolves and receipts each member separately, so local, configured OpenAI-compatible, OAuth, and OpenRouter requests remain distinct."}
      </p>
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={node.preserveMinorityReports} onChange={(event) => onChange({ ...node, preserveMinorityReports: event.target.checked })} /> Preserve minority reports</label>
      {fusion.mode === "openrouter-router" ? <ModelRequestEditor label="Hosted router" value={fusion.router} onChange={(router) => onChange({ ...node, fusion: { ...fusion, router } })} /> : (
        <Field label="Panel rounds"><input className={INPUT_CLASS} type="number" min={1} max={20} value={fusion.rounds} onChange={(event) => event.target.value && onChange({ ...node, fusion: { ...fusion, rounds: Number(event.target.value) } })} /></Field>
      )}
      <details><summary className="cursor-pointer text-xs font-medium">Fusion members ({fusion.members.length})</summary><div className="mt-2"><PanelMembersEditor members={fusion.members} maximumMembers={fusion.mode === "openrouter-router" ? 8 : 32} memberLabel={fusion.mode === "openrouter-router" ? "Hosted Fusion member" : "Kady Fusion member"} idStem={fusion.mode === "openrouter-router" ? "panel" : "analyst"} onChange={(members) => onChange({ ...node, fusion: { ...fusion, members } })} /></div></details>
      {fusion.mode === "openrouter-router" ? <ModelRequestEditor label="Final judge model" value={fusion.judge} onChange={(judge) => onChange({ ...node, fusion: { ...fusion, judge } })} /> : <ModelRequestEditor label="Synthesizer model" value={fusion.synthesizer} onChange={(synthesizer) => onChange({ ...node, fusion: { ...fusion, synthesizer } })} />}
    </>
  );
}

function BestOfNFields({
  node,
  onChange,
  graphDefaultModel,
}: {
  node: BestOfNWorkflowNode;
  onChange: (node: WorkflowGraphNode) => void;
  graphDefaultModel: WorkflowModelRequest | undefined;
}) {
  const explicitCandidates = node.candidateModels;
  const usesExplicitCandidates = explicitCandidates !== undefined;
  const repeatedCandidateCount = node.candidateCount ?? 2;
  const explicitSeed = node.model ?? graphDefaultModel;
  const updateExplicitCandidates = (candidateModels: WorkflowModelRequest[]) => {
    const nextNode: BestOfNWorkflowNode = {
      ...node,
      candidateCount: candidateModels.length,
      candidateModels,
    };
    delete nextNode.model;
    onChange(nextNode);
  };

  return (
    <>
      <Field label="Best-of-N goal">
        <textarea
          className={TEXTAREA_CLASS}
          value={node.goal}
          onChange={(event) => onChange({ ...node, goal: event.target.value })}
        />
      </Field>
      <Field
        label="Candidate model mode"
        hint={usesExplicitCandidates
          ? "Switching to repeated mode uses Candidate 1 as the repeated request."
          : "Explicit mode copies the visible node override or graph default into each initial candidate for editing."}
      >
        <select
          className={INPUT_CLASS}
          aria-label="Candidate model mode"
          value={usesExplicitCandidates ? "explicit" : "repeated"}
          onChange={(event) => {
            if (event.target.value === "explicit") {
              if (!explicitSeed) return;
              const count = Number.isSafeInteger(repeatedCandidateCount) &&
                  repeatedCandidateCount >= 2 && repeatedCandidateCount <= 16
                ? repeatedCandidateCount
                : 2;
              updateExplicitCandidates(
                Array.from({ length: count }, () => cloneModelRequest(explicitSeed)),
              );
              return;
            }
            const repeatedNode: BestOfNWorkflowNode = {
              ...node,
              candidateCount: explicitCandidates?.length ?? repeatedCandidateCount,
              ...(explicitCandidates?.[0]
                ? { model: cloneModelRequest(explicitCandidates[0]) }
                : {}),
            };
            delete repeatedNode.candidateModels;
            onChange(repeatedNode);
          }}
        >
          <option value="repeated">Repeat one model request</option>
          <option value="explicit" disabled={!usesExplicitCandidates && !explicitSeed}>
            Edit each candidate model
          </option>
        </select>
      </Field>
      {!usesExplicitCandidates && !explicitSeed ? (
        <p role="alert" className="text-[10px] text-destructive">
          Add a graph default or repeated node model before creating explicit candidates.
        </p>
      ) : null}
      {usesExplicitCandidates && node.model ? (
        <div role="alert" className="space-y-1 rounded border border-destructive/30 bg-destructive/5 p-2 text-[10px] text-destructive">
          <p>This saved node has both repeated and explicit candidate models, which is ambiguous.</p>
          <button type="button" className="underline" onClick={() => updateExplicitCandidates(explicitCandidates)}>
            Remove conflicting repeated model
          </button>
        </div>
      ) : null}
      {usesExplicitCandidates ? (
        <div className="space-y-2">
          {node.candidateCount !== explicitCandidates.length ? (
            <div role="alert" className="space-y-1 rounded border border-destructive/30 bg-destructive/5 p-2 text-[10px] text-destructive">
              <p>Candidate count must equal the explicit model list length.</p>
              <button type="button" className="underline" onClick={() => updateExplicitCandidates(explicitCandidates)}>
                Repair candidate count to {explicitCandidates.length}
              </button>
            </div>
          ) : null}
          {explicitCandidates.map((candidate, index) => (
            <div key={index} className="space-y-1 rounded-md border p-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Candidate {index + 1}
                </span>
                <button
                  type="button"
                  className="rounded p-1 text-destructive hover:bg-destructive/5 disabled:cursor-not-allowed disabled:opacity-40"
                  aria-label={`Remove candidate model ${index + 1}`}
                  disabled={explicitCandidates.length <= 2}
                  onClick={() => updateExplicitCandidates(
                    explicitCandidates.filter((_, candidateIndex) => candidateIndex !== index),
                  )}
                >
                  <Trash2Icon className="size-3" />
                </button>
              </div>
              <ModelRequestEditor
                label={`Candidate ${index + 1} model`}
                value={candidate}
                onChange={(model) => updateExplicitCandidates(
                  explicitCandidates.map((existing, candidateIndex) => (
                    candidateIndex === index ? model : existing
                  )),
                )}
              />
            </div>
          ))}
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md border px-2 py-1.5 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
            disabled={explicitCandidates.length >= 16 || explicitCandidates.length === 0}
            onClick={() => {
              const source = explicitCandidates.at(-1);
              if (!source || explicitCandidates.length >= 16) return;
              updateExplicitCandidates([...explicitCandidates, cloneModelRequest(source)]);
            }}
          >
            <PlusIcon className="size-3" /> Add candidate model
          </button>
          <p className="text-[10px] text-muted-foreground">
            {explicitCandidates.length} of 16 candidates. Candidate count follows this list exactly;
            new entries copy the last visible request without adding fallback.
          </p>
        </div>
      ) : (
        <>
          <Field label="Candidate count" hint="Defaults to 2 and is bounded from 2 to 16.">
            <input
              className={INPUT_CLASS}
              type="number"
              min={2}
              max={16}
              value={repeatedCandidateCount}
              onChange={(event) => {
                if (event.target.value) {
                  const candidateCount = Number(event.target.value);
                  if (!Number.isSafeInteger(candidateCount) || candidateCount < 2 || candidateCount > 16) {
                    return;
                  }
                  onChange({ ...node, candidateCount });
                }
              }}
            />
          </Field>
          <ModelOverrideEditor
            label="Repeated candidate model"
            value={node.model}
            addLabel="Add repeated candidate model override"
            onChange={(model) => {
              const nextNode: BestOfNWorkflowNode = { ...node };
              if (model) nextNode.model = model;
              else delete nextNode.model;
              delete nextNode.candidateModels;
              onChange(nextNode);
            }}
          />
        </>
      )}
      <ModelOverrideEditor
        label="Evaluator model"
        value={node.evaluator}
        addLabel="Add evaluator model override"
        onChange={(evaluator) => {
          if (evaluator) {
            onChange({ ...node, evaluator });
            return;
          }
          const nodeWithoutEvaluator = { ...node };
          delete nodeWithoutEvaluator.evaluator;
          onChange(nodeWithoutEvaluator);
        }}
      />
    </>
  );
}

function EvidenceGateFields({
  node,
  onChange,
}: {
  node: EvidenceGateWorkflowNode;
  onChange: (node: WorkflowGraphNode) => void;
}) {
  return (
    <>
      <div className="space-y-1">
        <span className="block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Checks
        </span>
        {EVIDENCE_CHECKS.map((check) => (
          <label key={check} className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={node.checks.includes(check)}
              onChange={(event) => onChange({
                ...node,
                checks: event.target.checked
                  ? [...node.checks, check]
                  : node.checks.filter((candidate) => candidate !== check),
              })}
            />
            {check}
          </label>
        ))}
      </div>
      <Field label="Artifact IDs" hint="Comma-separated existing artifact ids.">
        <input
          className={INPUT_CLASS}
          value={node.artifactIds.join(", ")}
          onChange={(event) => onChange({
            ...node,
            artifactIds: event.target.value
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean),
          })}
        />
      </Field>
      <Field label="Unsupported output">
        <select
          className={INPUT_CLASS}
          value={node.onUnsupportedOutput}
          onChange={(event) => onChange({
            ...node,
            onUnsupportedOutput: event.target.value as EvidenceGateWorkflowNode["onUnsupportedOutput"],
          })}
        >
          <option value="fail">Fail</option>
          <option value="rescue">Rescue</option>
          <option value="route">Route</option>
        </select>
      </Field>
      <ModelOverrideEditor
        label="Evidence evaluator"
        value={node.evaluator}
        onChange={(evaluator) => {
          if (evaluator) {
            onChange({ ...node, evaluator });
            return;
          }
          const nodeWithoutEvaluator = { ...node };
          delete nodeWithoutEvaluator.evaluator;
          onChange(nodeWithoutEvaluator);
        }}
      />
    </>
  );
}

function LeanFields({
  node,
  onChange,
}: {
  node: Lean4WorkflowNode;
  onChange: (node: WorkflowGraphNode) => void;
}) {
  return (
    <>
      <Field label="Lean goal">
        <textarea className={TEXTAREA_CLASS} value={node.goal} onChange={(event) => onChange({ ...node, goal: event.target.value })} />
      </Field>
      <Field
        label={node.mode === "solve" ? "Exact proposition to prove" : "Reviewed Lean source"}
        hint={node.mode === "solve"
          ? "Enter only the exact Lean proposition. The model may propose a proof body but cannot rewrite this statement or theorem name."
          : "Enter the complete Lean source you reviewed; Kady verifies its first named theorem or lemma."}
      >
        <textarea className={`${TEXTAREA_CLASS} font-mono`} value={node.theorem} onChange={(event) => onChange({ ...node, theorem: event.target.value })} />
      </Field>
      <Field label="Mode">
        <select
          className={INPUT_CLASS}
          value={node.mode}
          onChange={(event) => {
            if (event.target.value === "verify") {
              const verifiedNode = { ...node, mode: "verify" as const };
              delete verifiedNode.solverModel;
              onChange(verifiedNode);
              return;
            }
            onChange({ ...node, mode: "solve" });
          }}
        >
          <option value="verify">Verify supplied proof</option>
          <option value="solve">Ask a model, then verify</option>
        </select>
      </Field>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={node.mathlib}
          onChange={(event) => onChange({ ...node, mathlib: event.target.checked })}
        />
        Use Mathlib
      </label>
      <p className="text-[10px] text-muted-foreground">
        Skill: <span className="font-mono">byom-dag-fusion</span>
      </p>
      <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-[10px] text-amber-800 dark:text-amber-200">
        Lean execution is disabled by default. A server owner must explicitly enable the
        unsandboxed policy. That opt-in runs Lean with Kady&apos;s OS-user filesystem and
        network authority; it is not a security sandbox.
      </p>
      {node.mode === "solve" ? (
        <ModelOverrideEditor
          label="Lean solver model"
          value={node.solverModel}
          onChange={(solverModel) => {
            if (solverModel) {
              onChange({ ...node, solverModel });
              return;
            }
            const nodeWithoutSolver = { ...node };
            delete nodeWithoutSolver.solverModel;
            onChange(nodeWithoutSolver);
          }}
        />
      ) : null}
    </>
  );
}

export function DagNodeInspector({
  graph,
  node,
  onChange,
  onRemove,
  modelInventory = [],
}: {
  graph: WorkflowGraphDocument;
  node: WorkflowGraphNode;
  onChange: (node: WorkflowGraphNode) => void;
  onRemove: () => void;
  modelInventory?: readonly Model[];
}) {
  const outgoingCount = graph.edges.filter((edge) => edge.from === node.id).length;
  const removalBlocker = nodeRemovalBlocker(graph, node.id);
  const modelDriven = node.kind === "agent" || node.kind === "research-until-goal";
  return (
    <ModelInventoryContext.Provider value={modelInventory}>
      <div className={SECTION_CLASS}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold">Selected node</h2>
        <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold text-primary">
          {nodeKindLabel(node.kind)}
        </span>
      </div>
      <Field label="Name">
        <input
          className={INPUT_CLASS}
          value={node.name}
          onChange={(event) => onChange({ ...node, name: event.target.value })}
        />
      </Field>
      <Field label="Description">
        <textarea
          className={TEXTAREA_CLASS}
          value={node.description ?? ""}
          onChange={(event) => {
            if (event.target.value) {
              onChange({ ...node, description: event.target.value });
              return;
            }
            const nodeWithoutDescription = { ...node };
            delete nodeWithoutDescription.description;
            onChange(nodeWithoutDescription);
          }}
        />
      </Field>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={node.terminal}
          disabled={
            (node.kind === "evidence-gate" && !node.terminal) ||
            (!node.terminal && outgoingCount > 0)
          }
          onChange={(event) => {
            if (node.kind === "evidence-gate" && event.target.checked) return;
            onChange({ ...node, terminal: event.target.checked });
          }}
        />
        Terminal node
      </label>
      {node.kind === "evidence-gate" && !node.terminal ? (
        <p className="text-[10px] text-muted-foreground">
          Evidence gates require an evidence-supported outgoing route and cannot be terminal.
        </p>
      ) : null}
      {node.kind !== "evidence-gate" && !node.terminal && outgoingCount > 0 ? (
        <p className="text-[10px] text-muted-foreground">
          Remove outgoing edges before marking this node terminal.
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-2"><Field label="Position X"><input className={INPUT_CLASS} type="number" value={node.position?.x ?? 0} onChange={(event) => event.target.value && onChange({ ...node, position: { x: Number(event.target.value), y: node.position?.y ?? 0 } })} /></Field><Field label="Position Y"><input className={INPUT_CLASS} type="number" value={node.position?.y ?? 0} onChange={(event) => event.target.value && onChange({ ...node, position: { x: node.position?.x ?? 0, y: Number(event.target.value) } })} /></Field></div>

      {modelDriven ? (
        <ModelOverrideEditor
          label="Node model override"
          value={node.model}
          onChange={(model) => {
            if (model) {
              onChange({ ...node, model });
              return;
            }
            const nodeWithoutModel = { ...node };
            delete nodeWithoutModel.model;
            onChange(nodeWithoutModel);
          }}
        />
      ) : null}

      {node.kind === "agent" ? <Field label="Agent prompt"><textarea className={TEXTAREA_CLASS} value={node.prompt} onChange={(event) => onChange({ ...node, prompt: event.target.value })} /></Field> : null}
      {node.kind === "research-until-goal" ? <><Field label="Research goal"><textarea className={TEXTAREA_CLASS} value={node.goal} onChange={(event) => onChange({ ...node, goal: event.target.value })} /></Field><Field label="Completion criteria" hint="One criterion per line."><textarea className={TEXTAREA_CLASS} value={node.completionCriteria.join("\n")} onChange={(event) => onChange({ ...node, completionCriteria: event.target.value.split("\n").map((line) => line.trim()).filter(Boolean) })} /></Field></> : null}
      {node.kind === "council" ? <CouncilFields node={node} onChange={onChange} /> : null}
      {node.kind === "fusion" ? <FusionFields node={node} onChange={onChange} /> : null}
      {node.kind === "best-of-n" ? <BestOfNFields node={node} graphDefaultModel={graph.defaultModel} onChange={onChange} /> : null}
      {node.kind === "evidence-gate" ? <EvidenceGateFields node={node} onChange={onChange} /> : null}
      {node.kind === "lean4" ? <LeanFields node={node} onChange={onChange} /> : null}

      <details>
        <summary className="cursor-pointer text-xs font-medium">Node limits override</summary>
        <div className="mt-2">
          <NodeLimitsEditor
            value={node.limits}
            workflowLimits={graph.limits}
            onChange={(limits) => {
              const nextNode = { ...node };
              if (limits) nextNode.limits = limits;
              else delete nextNode.limits;
              onChange(nextNode);
            }}
          />
        </div>
      </details>
      <details>
        <summary className="cursor-pointer text-xs font-medium">Node rescue override</summary>
        <div className="mt-2">
          {node.rescue ? (
            <>
              <RescuePolicyEditor
                value={node.rescue}
                onChange={(rescue) => onChange({ ...node, rescue })}
              />
              <button
                type="button"
                className="mt-2 text-[10px] underline"
                onClick={() => {
                  const nodeWithoutRescue = { ...node };
                  delete nodeWithoutRescue.rescue;
                  onChange(nodeWithoutRescue);
                }}
              >
                Inherit workflow rescue
              </button>
            </>
          ) : (
            <button
              type="button"
              className="rounded-md border px-2 py-1.5 text-xs hover:bg-muted"
              onClick={() => onChange({
                ...node,
                rescue: {
                  ...DEFAULT_WORKFLOW_RESCUE,
                  triggers: [...DEFAULT_WORKFLOW_RESCUE.triggers],
                },
              })}
            >
              Add node rescue override
            </button>
          )}
        </div>
      </details>
      <details>
        <summary className="cursor-pointer text-xs font-medium">Node evidence override</summary>
        <div className="mt-2">
          {node.evidence ? (
            <>
              <EvidencePolicyEditor
                value={node.evidence}
                scope="node"
                evaluatorApplies={node.kind !== "evidence-gate"}
                onChange={(evidence) => onChange({ ...node, evidence })}
              />
              <button
                type="button"
                className="mt-2 text-[10px] underline"
                onClick={() => {
                  const nodeWithoutEvidence = { ...node };
                  delete nodeWithoutEvidence.evidence;
                  onChange(nodeWithoutEvidence);
                }}
              >
                Inherit workflow evidence
              </button>
            </>
          ) : (
            <button
              type="button"
              className="rounded-md border px-2 py-1.5 text-xs hover:bg-muted"
              onClick={() => onChange({
                ...node,
                evidence: { ...DEFAULT_WORKFLOW_EVIDENCE },
              })}
            >
              Add node evidence override
            </button>
          )}
        </div>
      </details>

      <button type="button" className="inline-flex items-center gap-1 rounded-md border border-destructive/30 px-2 py-1.5 text-xs text-destructive hover:bg-destructive/5 disabled:cursor-not-allowed disabled:opacity-40" disabled={Boolean(removalBlocker)} title={removalBlocker ?? undefined} onClick={onRemove}><Trash2Icon className="size-3" /> Remove node</button>
      {removalBlocker ? <p className="text-[10px] leading-relaxed text-muted-foreground">{removalBlocker}</p> : null}
      </div>
    </ModelInventoryContext.Provider>
  );
}

export function DagEdgeInspector({
  graph,
  selectedNodeId,
  onAdd,
  onRemove,
}: {
  graph: WorkflowGraphDocument;
  selectedNodeId: string | null;
  onAdd: (edge: { from: string; to: string; condition: WorkflowEdgeCondition }) => string | null;
  onRemove: (edgeId: string) => void;
}) {
  const [from, setFrom] = useState(selectedNodeId ?? graph.nodes[0]?.id ?? "");
  const [to, setTo] = useState(graph.nodes.find((node) => node.id !== from)?.id ?? "");
  const effectiveFrom = graph.nodes.some((node) => node.id === from)
    ? from
    : graph.nodes[0]?.id ?? "";
  const source = graph.nodes.find((node) => node.id === effectiveFrom);
  const allowedConditions = source
    ? allowedConditionsForSource(source, graph.evidence)
    : ["always" as const];
  const [condition, setCondition] = useState<WorkflowEdgeCondition>(allowedConditions[0]);
  const [error, setError] = useState<string | null>(null);
  const effectiveCondition = allowedConditions.includes(condition)
    ? condition
    : allowedConditions[0];
  const effectiveTo = to !== effectiveFrom && graph.nodes.some((node) => node.id === to)
    ? to
    : graph.nodes.find((node) => node.id !== effectiveFrom)?.id ?? "";

  return (
    <div className={SECTION_CLASS}>
      <h2 className="text-xs font-semibold">Edges</h2>
      <div className="grid gap-2">
        <Field label="From">
          <select
            className={INPUT_CLASS}
            value={effectiveFrom}
            onChange={(event) => {
              const nextFrom = event.target.value;
              const nextSource = graph.nodes.find((node) => node.id === nextFrom);
              const nextAllowed = nextSource
                ? allowedConditionsForSource(nextSource, graph.evidence)
                : ["always" as const];
              setFrom(nextFrom);
              if (effectiveTo === nextFrom) {
                setTo(graph.nodes.find((node) => node.id !== nextFrom)?.id ?? "");
              }
              if (!nextAllowed.includes(effectiveCondition)) {
                setCondition(nextAllowed[0]);
              }
              setError(null);
            }}
          >
            {graph.nodes.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}
          </select>
        </Field>
        <Field label="To">
          <select
            className={INPUT_CLASS}
            value={effectiveTo}
            onChange={(event) => {
              setTo(event.target.value);
              setError(null);
            }}
          >
            {graph.nodes
              .filter((node) => node.id !== effectiveFrom)
              .map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}
          </select>
        </Field>
        <Field label="Condition">
          <select
            className={INPUT_CLASS}
            value={effectiveCondition}
            onChange={(event) => setCondition(event.target.value as WorkflowEdgeCondition)}
          >
            {allowedConditions.map((candidate) => <option key={candidate} value={candidate}>{candidate}</option>)}
          </select>
        </Field>
        <button type="button" className="inline-flex items-center justify-center gap-1 rounded-md border px-2 py-1.5 text-xs font-medium hover:bg-muted" onClick={() => {
          const nextError = onAdd({
            from: effectiveFrom,
            to: effectiveTo,
            condition: effectiveCondition,
          });
          setError(nextError);
        }}><PlusIcon className="size-3" /> Add explicit edge</button>
        {error ? <p role="alert" className="text-[10px] text-destructive">{error}</p> : null}
      </div>
      <div className="space-y-1">
        {graph.edges.length === 0 ? <p className="text-[10px] text-muted-foreground">No edges. Nonterminal nodes need valid outgoing routes before save.</p> : graph.edges.map((edge) => (
          <div key={edge.id} className="flex items-center justify-between gap-2 rounded border px-2 py-1.5 text-[10px]">
            <span className="min-w-0 truncate"><span className="font-medium">{edge.from}</span> → <span className="font-medium">{edge.to}</span> · {edge.condition ?? "always"}</span>
            <button type="button" className="shrink-0 rounded p-1 text-destructive hover:bg-destructive/5" aria-label={`Remove edge ${edge.id}`} onClick={() => onRemove(edge.id)}><Trash2Icon className="size-3" /></button>
          </div>
        ))}
      </div>
    </div>
  );
}
