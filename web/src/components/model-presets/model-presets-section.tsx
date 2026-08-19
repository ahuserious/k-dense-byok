"use client";

/**
 * Settings ▸ Model providers ▸ Model presets.
 *
 * Mounted inside the Model providers tab rather than as its own Settings tab:
 * the tab list lives in `settings-dialog.tsx`, which another lane owns this
 * wave, and rows 1–2 already name this tab. The user path is one click deeper
 * and requires no cross-lane change, which is what makes this section reachable
 * at all rather than reachable-in-principle.
 *
 * "raindrop slim" (§6.4): slim rows, secondary text in `--muted-foreground`, no
 * chrome that carries no information. Every colour is a semantic token; there
 * is no raw hex, rgb or hsl anywhere in this directory.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  LoaderCircleIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PresetEditor } from "@/components/model-presets/preset-editor";
import {
  createModelPreset,
  deleteModelPreset,
  groupPresetsByProvider,
  testModelPreset,
  updateModelPreset,
  useModelPresets,
  type ModelPreset,
  type ModelPresetInput,
  type PresetBinding,
  type PresetBindingSurface,
  type PresetTestResult,
} from "@/lib/model-presets";

/**
 * Focus ring, matching the preset editor. See the note there: the primitives'
 * `ring-ring/50` measures under the 3:1 §6.6 requires, so every control in this
 * section restyles the ring through `--primary` rather than forking a
 * primitive or redefining a token.
 */
const FOCUS_RING_CLASS =
  "focus-visible:ring-[3px] focus-visible:ring-primary focus-visible:border-primary";

/** A one-line, human summary of what a preset will send. */
function parameterSummary(preset: ModelPreset): string {
  const parts: string[] = [];
  const hyperparameters = preset.hyperparameters ?? {};
  if (hyperparameters.temperature !== undefined) {
    parts.push(`temp ${hyperparameters.temperature}`);
  }
  if (hyperparameters.topP !== undefined) parts.push(`top_p ${hyperparameters.topP}`);
  if (hyperparameters.maxTokens !== undefined) {
    parts.push(`${hyperparameters.maxTokens} max tokens`);
  }
  if (hyperparameters.reasoningEffort) {
    parts.push(`${hyperparameters.reasoningEffort} reasoning`);
  }
  if (hyperparameters.seed !== undefined) parts.push(`seed ${hyperparameters.seed}`);
  if (preset.systemPromptOverride) parts.push("system prompt override");
  if (preset.modal) {
    parts.push(`${preset.modal.gpuCount} GPU${preset.modal.gpuCount === 1 ? "" : "s"}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "provider defaults";
}

export function ModelPresetsSection() {
  const { presets, groups, bindings, loading, error, refresh } = useModelPresets();
  const [editing, setEditing] = useState<{ preset: ModelPreset | null } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<PresetTestResult | null>(null);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);

  const grouped = useMemo(
    () => groupPresetsByProvider(presets, groups),
    [presets, groups],
  );
  const configuredById = useMemo(
    () => new Map(groups.map((group) => [group.id, group] as const)),
    [groups],
  );

  // Closing the editor puts focus back where it came from, so a keyboard user
  // is not dropped at the top of the document (§6.6).
  const closeEditor = useCallback(() => {
    setEditing(null);
    addButtonRef.current?.focus();
  }, []);

  const save = useCallback(
    async (input: ModelPresetInput) => {
      if (editing?.preset) {
        await updateModelPreset(editing.preset.id, input);
      } else {
        await createModelPreset(input);
      }
      closeEditor();
      refresh();
    },
    [closeEditor, editing, refresh],
  );

  const remove = useCallback(
    async (preset: ModelPreset) => {
      if (
        !window.confirm(
          `Delete the preset "${preset.name}"? Anything that selected it will stop resolving until you pick another model.`,
        )
      ) {
        return;
      }
      setBusyId(preset.id);
      setActionError(null);
      try {
        await deleteModelPreset(preset.id);
        refresh();
      } catch (cause) {
        setActionError(
          cause instanceof Error ? cause.message : "Could not delete the preset.",
        );
      } finally {
        setBusyId(null);
      }
    },
    [refresh],
  );

  const test = useCallback(async (preset: ModelPreset) => {
    setBusyId(preset.id);
    setActionError(null);
    setTestResult(null);
    try {
      setTestResult(await testModelPreset(preset.id));
    } catch (cause) {
      setActionError(
        cause instanceof Error ? cause.message : "The provider call did not complete.",
      );
    } finally {
      setBusyId(null);
    }
  }, []);

  return (
    <section aria-labelledby="model-presets-heading" className="mt-6 border-t pt-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id="model-presets-heading" className="text-sm font-medium">
            Model presets
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            A preset is a saved provider, model and set of call parameters. Selecting one
            anywhere a model is chosen resolves to exactly that provider and model.
          </p>
        </div>
        <Button
          ref={addButtonRef}
          type="button"
          size="sm"
          className={`shrink-0 ${FOCUS_RING_CLASS}`}
          onClick={() => {
            setActionError(null);
            setTestResult(null);
            setEditing({ preset: null });
          }}
        >
          <PlusIcon className="size-3.5" aria-hidden />
          Model preset
        </Button>
      </div>

      {error ? (
        <div
          role="alert"
          className="mt-3 flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive"
        >
          <AlertCircleIcon className="size-4 shrink-0" aria-hidden />
          <span>{error}</span>
        </div>
      ) : null}
      {actionError ? (
        <div
          role="alert"
          className="mt-3 flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive"
        >
          <AlertCircleIcon className="size-4 shrink-0" aria-hidden />
          <span>{actionError}</span>
        </div>
      ) : null}

      {editing ? (
        <div className="mt-3">
          <PresetEditor
            preset={editing.preset}
            groups={groups}
            onSave={save}
            onCancel={closeEditor}
          />
        </div>
      ) : null}

      {testResult ? (
        <div
          role="status"
          className="mt-3 rounded-md border bg-muted/40 p-3 text-[11px] leading-relaxed"
        >
          <div className="flex items-center gap-1.5 font-medium">
            <CheckCircle2Icon className="size-3.5" aria-hidden />
            <span>
              {testResult.ref} answered with HTTP {testResult.status}
            </span>
          </div>
          <p className="mt-1 text-muted-foreground">
            Sent to {testResult.request.url} as{" "}
            <code>{String(testResult.request.body.model)}</code>
            {testResult.request.body.temperature !== undefined
              ? `, temperature ${String(testResult.request.body.temperature)}`
              : ""}
            {testResult.request.body.max_tokens !== undefined
              ? `, max_tokens ${String(testResult.request.body.max_tokens)}`
              : ""}
            .
          </p>
          {testResult.text ? (
            <p className="mt-1 line-clamp-3 text-muted-foreground">{testResult.text}</p>
          ) : null}
        </div>
      ) : null}

      {loading && presets.length === 0 ? (
        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <LoaderCircleIcon className="size-4 animate-spin" aria-hidden />
          Loading presets…
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          {grouped.map(({ group, presets: groupPresets }) => (
            <div key={group.id} className="rounded-lg border">
              <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
                <h4 className="text-xs font-semibold">{group.label}</h4>
                <Badge variant={group.configured ? "secondary" : "outline"}>
                  {group.configured ? "Configured" : "Not configured"}
                </Badge>
                <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
                  {groupPresets.length} preset{groupPresets.length === 1 ? "" : "s"}
                </span>
              </div>
              {!group.configured ? (
                <p className="px-3 pt-2 text-[11px] leading-relaxed text-muted-foreground">
                  {group.notConfiguredReason}
                </p>
              ) : null}
              {groupPresets.length === 0 ? (
                <p className="px-3 py-2 text-[11px] text-muted-foreground">
                  No presets yet.
                </p>
              ) : (
                <ul className="divide-y">
                  {groupPresets.map((preset) => {
                    const status = configuredById.get(preset.providerId);
                    const testable =
                      Boolean(status?.configured) &&
                      Boolean(status?.dispatchableAsChatModel);
                    const testReason = !status?.configured
                      ? status?.notConfiguredReason
                      : !status?.dispatchableAsChatModel
                        ? `${status?.label} presets describe a compute job rather than a chat model, so there is no completion to send.`
                        : undefined;
                    return (
                      <li
                        key={preset.id}
                        className="flex items-center gap-2 px-3 py-2 text-xs"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium">{preset.name}</p>
                          <p className="truncate text-[11px] text-muted-foreground">
                            {preset.ref} · {parameterSummary(preset)}
                          </p>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className={`h-7 shrink-0 px-2 ${FOCUS_RING_CLASS}`}
                          disabled={!testable || busyId === preset.id}
                          title={testReason}
                          aria-label={`Test preset ${preset.name}`}
                          onClick={() => void test(preset)}
                        >
                          {busyId === preset.id ? (
                            <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden />
                          ) : (
                            <PlayIcon className="size-3.5" aria-hidden />
                          )}
                          Test
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className={`h-7 shrink-0 px-2 ${FOCUS_RING_CLASS}`}
                          aria-label={`Edit preset ${preset.name}`}
                          onClick={() => {
                            setActionError(null);
                            setTestResult(null);
                            setEditing({ preset });
                          }}
                        >
                          <PencilIcon className="size-3.5" aria-hidden />
                          Edit
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className={`h-7 shrink-0 px-2 ${FOCUS_RING_CLASS}`}
                          disabled={busyId === preset.id}
                          aria-label={`Delete preset ${preset.name}`}
                          onClick={() => void remove(preset)}
                        >
                          <Trash2Icon className="size-3.5" aria-hidden />
                          Delete
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}

      <PresetBindingNotice bindings={bindings} />
    </section>
  );
}

/**
 * Where a preset's parameters actually land.
 *
 * Rendered from the server's own binding block rather than from prose in this
 * file, so a surface that starts carrying a preset's parameters updates here
 * without a UI change — and, more to the point, a surface that stops carrying
 * them cannot keep claiming it does. Bound and dropped are distinguished by the
 * word, not by colour or opacity alone (§6.6).
 */
function PresetBindingNotice({
  bindings,
}: {
  bindings: Record<PresetBindingSurface, PresetBinding>;
}) {
  const rows: Array<{ surface: PresetBindingSurface; label: string }> = [
    { surface: "direct", label: "Test preset" },
    { surface: "chat-session", label: "Chat and runs" },
    { surface: "workflow-node", label: "Workflow nodes" },
    { surface: "hosted-fusion-supervised", label: "Hosted Fusion nodes" },
  ];
  return (
    <div className="mt-4 rounded-lg border p-3">
      <h4 className="text-xs font-semibold">Where these parameters apply</h4>
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
        Every surface uses the preset&apos;s provider and model. This is whether it also
        carries the hyperparameters and the system-prompt override.
      </p>
      <dl className="mt-2 space-y-1.5 text-[11px] leading-relaxed">
        {rows.map(({ surface, label }) => {
          const binding = bindings[surface];
          const carried =
            binding.hyperparameters === "bound" &&
            binding.systemPromptOverride === "bound";
          return (
            <div key={surface} className="flex gap-2">
              <dt className="w-36 shrink-0 font-medium">{label}</dt>
              <dd className="text-muted-foreground">
                <span className="font-medium text-foreground">
                  {carried ? "Carried" : "Not carried"}
                </span>
                {binding.reason ? ` — ${binding.reason}` : ""}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}
