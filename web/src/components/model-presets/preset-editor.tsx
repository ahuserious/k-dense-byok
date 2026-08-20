"use client";

/**
 * The preset editor.
 *
 * Deliberately an inline panel rather than a nested dialog. Settings is already
 * a `Dialog`; a second overlay inside it would need its own focus trap, its own
 * Escape handling, and its own focus restoration, and getting any of the three
 * wrong is precisely the accessibility failure §6.6 records this build failing
 * three times. An inline panel is in the natural tab order, needs no trap, and
 * Escape keeps its existing meaning (close Settings) — with Cancel providing
 * the local escape and returning focus to the trigger explicitly.
 *
 * Honest state (§6.7) is the organising rule here:
 *   - A parameter the selected provider does not accept renders DISABLED with
 *     the reason beside it, from `parameterSupport` on the server. Nothing is
 *     hardcoded per provider in this file.
 *   - An unconfigured provider can still be authored against, but says so and
 *     names the variable to set. It is never silently treated as working.
 *   - The "Where these apply" table states, per dispatch surface, whether the
 *     hyperparameters and the override are carried or dropped. It is rendered
 *     from the server's binding block, so a surface that starts carrying them
 *     updates here without a UI change.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { AlertCircleIcon, MinusIcon, PlusIcon, SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  REASONING_EFFORTS,
  fetchModalInstances,
  unsupportedParameterReasons,
  type ModalInstanceOption,
  type ModelPreset,
  type ModelPresetInput,
  type ProviderGroupStatus,
  type ReasoningEffort,
} from "@/lib/model-presets";
import {
  searchHuggingFaceModels,
  type HuggingFaceModelSummary,
} from "@/lib/model-presets-huggingface";

/**
 * The shadcn primitives draw their focus ring as `ring-ring/50`. Measured on
 * this palette that lands at 2.6:1 in light and 2.0:1 in dark against the field
 * surface — under the 3:1 §6.6 requires for a focus indicator, and it is the
 * exact "a dimmed ring is an invisible ring" failure recorded there.
 *
 * The primitives are not forked and `--ring` is not redefined: the ring colour
 * is restyled through another semantic token on the composed control, which is
 * the sanctioned route. `--primary` measures 12.9:1 (light) and 12.2:1 (dark)
 * against the field surface. Every control in this editor carries it.
 */
const FOCUS_RING_CLASS =
  "focus-visible:ring-[3px] focus-visible:ring-primary focus-visible:border-primary";
const FIELD_CLASS = `h-8 text-xs ${FOCUS_RING_CLASS}`;
const LABEL_CLASS = "text-[11px] font-medium text-muted-foreground";
const HINT_CLASS = "mt-1 text-[11px] leading-relaxed text-muted-foreground";
const SELECT_CLASS =
  `h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none ${FOCUS_RING_CLASS} disabled:cursor-not-allowed disabled:opacity-50`;

interface PresetFormState {
  name: string;
  providerId: string;
  modelId: string;
  temperature: string;
  topP: string;
  maxTokens: string;
  reasoningEffort: string;
  seed: string;
  systemPromptOverride: string;
  huggingFaceModelId: string;
  gpuCount: string;
  instanceId: string;
}

/** What the Hugging Face chooser knows. Every branch is a designed state. */
type HuggingFaceChooserState =
  | { kind: "idle" }
  | { kind: "searching" }
  | { kind: "results"; models: HuggingFaceModelSummary[] }
  | { kind: "unconfigured"; envVar: string; detail: string }
  | { kind: "unavailable"; detail: string };

function formStateFor(preset: ModelPreset | null, fallbackProviderId: string): PresetFormState {
  return {
    name: preset?.name ?? "",
    providerId: preset?.providerId ?? fallbackProviderId,
    modelId: preset?.modelId ?? "",
    temperature: preset?.hyperparameters?.temperature?.toString() ?? "",
    topP: preset?.hyperparameters?.topP?.toString() ?? "",
    maxTokens: preset?.hyperparameters?.maxTokens?.toString() ?? "",
    reasoningEffort: preset?.hyperparameters?.reasoningEffort ?? "",
    seed: preset?.hyperparameters?.seed?.toString() ?? "",
    systemPromptOverride: preset?.systemPromptOverride ?? "",
    huggingFaceModelId: preset?.modal?.huggingFaceModelId ?? "",
    gpuCount: preset?.modal?.gpuCount?.toString() ?? "1",
    instanceId: preset?.modal?.instanceId ?? "",
  };
}

function optionalNumber(raw: string): number | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

export interface PresetEditorProps {
  preset: ModelPreset | null;
  groups: ProviderGroupStatus[];
  onSave: (input: ModelPresetInput) => Promise<void>;
  onCancel: () => void;
}

export function PresetEditor({ preset, groups, onSave, onCancel }: PresetEditorProps) {
  const fieldId = useId();
  const nameRef = useRef<HTMLInputElement | null>(null);
  const [form, setForm] = useState<PresetFormState>(() =>
    formStateFor(preset, groups[0]?.id ?? "openrouter"),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [instances, setInstances] = useState<ModalInstanceOption[] | null>(null);
  const [huggingFaceQuery, setHuggingFaceQuery] = useState("");
  const [huggingFace, setHuggingFace] = useState<HuggingFaceChooserState>({ kind: "idle" });

  // Opening the editor moves focus to its first field so a keyboard user is not
  // left behind on the trigger with new content below them.
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const group = useMemo(
    () => groups.find((candidate) => candidate.id === form.providerId) ?? groups[0],
    [groups, form.providerId],
  );
  const unsupported = useMemo(
    () =>
      group
        ? unsupportedParameterReasons(group)
        : {
            temperature: null,
            topP: null,
            maxTokens: null,
            reasoningEffort: null,
            seed: null,
          },
    [group],
  );
  const isModal = form.providerId === "modal";

  /**
   * The Modal instance catalogue, from the already-registered
   * `GET /modal/instances`. The stepper's ceiling and its CPU rule come from
   * here rather than from constants in this file — F12's interface is explicit
   * that `maxGpuCount` is per instance (a10g is 4, not 8) and that a CPU
   * instance renders the stepper disabled at 1.
   *
   * Fetched only when the Modal group is selected: nothing else in this editor
   * needs it, and an unconditional fetch would make every preset edit hit the
   * Modal route for no reason.
   */
  useEffect(() => {
    if (!isModal || instances !== null) return;
    let cancelled = false;
    void fetchModalInstances().then((catalogue) => {
      if (!cancelled) setInstances(catalogue.instances);
    });
    return () => {
      cancelled = true;
    };
  }, [isModal, instances]);

  const selectedInstance = useMemo(
    () => (instances ?? []).find((candidate) => candidate.id === form.instanceId) ?? null,
    [instances, form.instanceId],
  );
  // No instance chosen means Modal's own default, which is the "cpu" instance —
  // and a CPU instance allows exactly one GPU. So the stepper is disabled at 1
  // until a GPU instance is picked, rather than live and then rejected at save.
  const gpuStepperMax = selectedInstance
    ? selectedInstance.maxGpuCount
    : 1;
  const gpuStepperDisabledReason = !selectedInstance
    ? "Pick a Modal instance to choose a GPU count. Without one the job runs on a CPU instance, which allows only 1."
    : selectedInstance.kind === "cpu"
      ? `The ${selectedInstance.id} instance has no GPUs, so its GPU count is fixed at 1.`
      : null;

  const runHuggingFaceSearch = useCallback(async () => {
    const query = huggingFaceQuery.trim();
    if (!query) return;
    setHuggingFace({ kind: "searching" });
    const result = await searchHuggingFaceModels(query, 20);
    if (result.ok) {
      setHuggingFace({ kind: "results", models: result.models });
      return;
    }
    setHuggingFace(
      result.kind === "unconfigured"
        ? { kind: "unconfigured", envVar: result.envVar, detail: result.detail }
        : { kind: "unavailable", detail: result.detail },
    );
  }, [huggingFaceQuery]);

  /**
   * Probe once when the Modal group is selected, so the chooser can render
   * DISABLED with the honest reason before the user types anything — rather
   * than accepting a query and only then admitting it cannot search. The probe
   * is a real search for a common term; a 503 or a 404 answers the question.
   */
  useEffect(() => {
    if (!isModal || huggingFace.kind !== "idle") return;
    let cancelled = false;
    void searchHuggingFaceModels("llama", 1).then((result) => {
      if (cancelled || result.ok) return;
      setHuggingFace(
        result.kind === "unconfigured"
          ? { kind: "unconfigured", envVar: result.envVar, detail: result.detail }
          : { kind: "unavailable", detail: result.detail },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [isModal, huggingFace.kind]);

  const huggingFaceDisabledReason =
    huggingFace.kind === "unconfigured"
      ? `Set ${huggingFace.envVar} to search Hugging Face models`
      : huggingFace.kind === "unavailable"
        ? huggingFace.detail
        : null;

  const set = <K extends keyof PresetFormState>(key: K, value: PresetFormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const adjustGpuCount = (delta: number) => {
    const current = Number(form.gpuCount) || 1;
    const next = Math.min(gpuStepperMax, Math.max(1, current + delta));
    set("gpuCount", String(next));
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const hyperparameters = {
        temperature: unsupported.temperature ? undefined : optionalNumber(form.temperature),
        topP: unsupported.topP ? undefined : optionalNumber(form.topP),
        maxTokens: unsupported.maxTokens ? undefined : optionalNumber(form.maxTokens),
        reasoningEffort:
          unsupported.reasoningEffort || !form.reasoningEffort
            ? undefined
            : (form.reasoningEffort as ReasoningEffort),
        seed: unsupported.seed ? undefined : optionalNumber(form.seed),
      };
      const hasHyperparameters = Object.values(hyperparameters).some(
        (value) => value !== undefined,
      );
      // All three optional fields are ALWAYS sent, with an explicit `null` when
      // they are empty. The PATCH route reads an absent key as "leave it as it
      // is": omitting them made an emptied system-prompt override silently come
      // back on the next save, and made a Modal preset impossible to re-target
      // at a chat provider (the merge re-attached the old `modal` block and the
      // server then refused it with an error naming nothing the user could act
      // on). `null` means clear, and the server treats it that way.
      await onSave({
        name: form.name.trim(),
        providerId: form.providerId as ModelPresetInput["providerId"],
        // A Modal preset's "model" is the Hugging Face id, so the two stay in
        // lockstep rather than asking the user to type it twice.
        modelId: isModal ? form.huggingFaceModelId.trim() : form.modelId.trim(),
        hyperparameters: hasHyperparameters ? hyperparameters : null,
        systemPromptOverride: form.systemPromptOverride.trim()
          ? form.systemPromptOverride
          : null,
        modal: isModal
          ? {
              huggingFaceModelId: form.huggingFaceModelId.trim(),
              gpuCount: Math.max(1, Math.floor(Number(form.gpuCount) || 1)),
              ...(form.instanceId ? { instanceId: form.instanceId } : {}),
            }
          : null,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the preset.");
    } finally {
      setSaving(false);
    }
  };

  const numberField = (
    key: keyof PresetFormState,
    label: string,
    placeholder: string,
    disabledReason: string | null,
    extra: { min?: string; max?: string; step?: string } = {},
  ) => (
    <div>
      <label className={LABEL_CLASS} htmlFor={`${fieldId}-${key}`}>
        {label}
      </label>
      <Input
        id={`${fieldId}-${key}`}
        type="number"
        inputMode="decimal"
        className={FIELD_CLASS}
        placeholder={disabledReason ? "not accepted" : placeholder}
        value={form[key]}
        disabled={Boolean(disabledReason)}
        aria-describedby={disabledReason ? `${fieldId}-${key}-reason` : undefined}
        onChange={(event) => set(key, event.target.value as PresetFormState[typeof key])}
        {...extra}
      />
      {disabledReason ? (
        <p id={`${fieldId}-${key}-reason`} className={HINT_CLASS}>
          {disabledReason}
        </p>
      ) : null}
    </div>
  );

  return (
    <form
      onSubmit={submit}
      aria-label={preset ? `Edit preset ${preset.name}` : "New model preset"}
      className="rounded-lg border bg-card p-3"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={LABEL_CLASS} htmlFor={`${fieldId}-name`}>
            Preset name
          </label>
          <Input
            id={`${fieldId}-name`}
            ref={nameRef}
            className={FIELD_CLASS}
            value={form.name}
            required
            maxLength={80}
            placeholder="Fast summariser"
            onChange={(event) => set("name", event.target.value)}
          />
        </div>
        <div>
          <label className={LABEL_CLASS} htmlFor={`${fieldId}-provider`}>
            Provider
          </label>
          <select
            id={`${fieldId}-provider`}
            className={SELECT_CLASS}
            value={form.providerId}
            onChange={(event) => set("providerId", event.target.value)}
          >
            {groups.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.label}
                {candidate.configured ? "" : " — not configured"}
              </option>
            ))}
          </select>
          {group && !group.configured ? (
            <p className={HINT_CLASS}>{group.notConfiguredReason}</p>
          ) : null}
        </div>
      </div>

      {isModal ? (
        <div className="mt-3 space-y-3">
          <div>
            <label className={LABEL_CLASS} htmlFor={`${fieldId}-hf-search`}>
              Hugging Face model
            </label>
            {/*
              A search-backed chooser over GET /integrations/huggingface/models,
              per lane F12's FINAL interface — deliberately NOT a free-text
              field. When Hugging Face is not configured (503 NOT_CONFIGURED) or
              the route is absent, the control renders DISABLED with the reason
              rather than falling back to free text, which is the
              accepted-then-discarded pattern this wave exists to stop (§6.7).
            */}
            <div className="flex items-center gap-1">
              <Input
                id={`${fieldId}-hf-search`}
                className={FIELD_CLASS}
                value={huggingFaceQuery}
                disabled={Boolean(huggingFaceDisabledReason)}
                placeholder={
                  huggingFaceDisabledReason ? "search unavailable" : "Search Hugging Face…"
                }
                aria-describedby={`${fieldId}-hf-state`}
                onChange={(event) => setHuggingFaceQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  // The editor is a form; Enter in a search box must search,
                  // not submit a preset that has no model chosen yet.
                  event.preventDefault();
                  void runHuggingFaceSearch();
                }}
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                className={`h-8 shrink-0 ${FOCUS_RING_CLASS}`}
                disabled={Boolean(huggingFaceDisabledReason) || !huggingFaceQuery.trim()}
                onClick={() => void runHuggingFaceSearch()}
              >
                <SearchIcon className="size-3.5" aria-hidden />
                Search
              </Button>
            </div>
            <p id={`${fieldId}-hf-state`} className={HINT_CLASS}>
              {huggingFaceDisabledReason ??
                (huggingFace.kind === "searching"
                  ? "Searching Hugging Face…"
                  : huggingFace.kind === "results"
                    ? `${huggingFace.models.length} model${huggingFace.models.length === 1 ? "" : "s"} found. Pick one below.`
                    : "Search the Hugging Face hub and pick the model this preset loads.")}
            </p>
            {huggingFace.kind === "results" && huggingFace.models.length > 0 ? (
              <select
                id={`${fieldId}-hf`}
                className={`mt-1 ${SELECT_CLASS}`}
                aria-label="Hugging Face model"
                value={form.huggingFaceModelId}
                onChange={(event) => set("huggingFaceModelId", event.target.value)}
              >
                <option value="">Select a model…</option>
                {huggingFace.models.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.id}
                    {candidate.pipelineTag ? ` · ${candidate.pipelineTag}` : ""}
                    {candidate.gated ? " · gated" : ""}
                  </option>
                ))}
              </select>
            ) : null}
            <p className={HINT_CLASS}>
              Selected:{" "}
              <code data-testid="hf-selected-model">
                {form.huggingFaceModelId || "none yet"}
              </code>
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={LABEL_CLASS} htmlFor={`${fieldId}-instance`}>
                Modal instance
              </label>
              <select
                id={`${fieldId}-instance`}
                className={SELECT_CLASS}
                value={form.instanceId}
                disabled={instances !== null && instances.length === 0}
                aria-describedby={`${fieldId}-instance-hint`}
                onChange={(event) => {
                  const nextId = event.target.value;
                  const next = (instances ?? []).find(
                    (candidate) => candidate.id === nextId,
                  );
                  // Clamp in the same action that changes the ceiling, so the
                  // form can never hold a pair the server would reject.
                  const ceiling = next ? next.maxGpuCount : 1;
                  setForm((current) => ({
                    ...current,
                    instanceId: nextId,
                    gpuCount: String(
                      Math.min(ceiling, Math.max(1, Number(current.gpuCount) || 1)),
                    ),
                  }));
                }}
              >
                <option value="">Modal default (CPU)</option>
                {(instances ?? []).map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.label}
                    {candidate.kind === "gpu" ? ` · up to ${candidate.maxGpuCount} GPUs` : ""}
                  </option>
                ))}
              </select>
              <p id={`${fieldId}-instance-hint`} className={HINT_CLASS}>
                {instances === null
                  ? "Reading the Modal instance catalogue…"
                  : instances.length === 0
                    ? "Kady could not read the Modal instance catalogue, so only the default CPU instance is available."
                    : "From Kady's Modal catalogue. Each instance sets its own GPU ceiling."}
              </p>
            </div>
            <div>
              <label className={LABEL_CLASS} htmlFor={`${fieldId}-gpu`}>
                GPU count
              </label>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className={`size-8 shrink-0 ${FOCUS_RING_CLASS}`}
                  aria-label="Decrease GPU count"
                  disabled={Boolean(gpuStepperDisabledReason)}
                  onClick={() => adjustGpuCount(-1)}
                >
                  <MinusIcon className="size-3.5" aria-hidden />
                </Button>
                <Input
                  id={`${fieldId}-gpu`}
                  type="number"
                  min="1"
                  max={String(gpuStepperMax)}
                  step="1"
                  className={`${FIELD_CLASS} text-center tabular-nums`}
                  value={form.gpuCount}
                  disabled={Boolean(gpuStepperDisabledReason)}
                  aria-describedby={`${fieldId}-gpu-hint`}
                  onChange={(event) => set("gpuCount", event.target.value)}
                />
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className={`size-8 shrink-0 ${FOCUS_RING_CLASS}`}
                  aria-label="Increase GPU count"
                  disabled={Boolean(gpuStepperDisabledReason)}
                  onClick={() => adjustGpuCount(1)}
                >
                  <PlusIcon className="size-3.5" aria-hidden />
                </Button>
              </div>
              <p id={`${fieldId}-gpu-hint`} className={HINT_CLASS}>
                {gpuStepperDisabledReason ??
                  `Sent to the Modal job as gpuCount. Up to ${gpuStepperMax} on this instance.`}
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-3">
          <label className={LABEL_CLASS} htmlFor={`${fieldId}-model`}>
            Model id
          </label>
          <Input
            id={`${fieldId}-model`}
            className={FIELD_CLASS}
            value={form.modelId}
            required
            placeholder={
              form.providerId === "local"
                ? "ollama/llama3"
                : form.providerId === "openrouter"
                  ? "anthropic/claude-opus-4.8"
                  : "llama-3.3-70b-versatile"
            }
            onChange={(event) => set("modelId", event.target.value)}
            aria-describedby={`${fieldId}-model-hint`}
          />
          <p id={`${fieldId}-model-hint`} className={HINT_CLASS}>
            The provider&apos;s own model id.
            {form.providerId === "local"
              ? " Local ids name their server, for example ollama/llama3."
              : null}
          </p>
        </div>
      )}

      <fieldset className="mt-4 border-t pt-3">
        <legend className="sr-only">Hyperparameters</legend>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Hyperparameters
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          {numberField("temperature", "Temperature", "0 – 2", unsupported.temperature, {
            min: "0",
            max: "2",
            step: "0.1",
          })}
          {numberField("topP", "Top p", "0 – 1", unsupported.topP, {
            min: "0",
            max: "1",
            step: "0.05",
          })}
          {numberField("maxTokens", "Max tokens", "e.g. 2048", unsupported.maxTokens, {
            min: "1",
            step: "1",
          })}
          <div>
            <label className={LABEL_CLASS} htmlFor={`${fieldId}-reasoning`}>
              Reasoning level
            </label>
            <select
              id={`${fieldId}-reasoning`}
              className={SELECT_CLASS}
              value={form.reasoningEffort}
              disabled={Boolean(unsupported.reasoningEffort)}
              aria-describedby={
                unsupported.reasoningEffort ? `${fieldId}-reasoning-reason` : undefined
              }
              onChange={(event) => set("reasoningEffort", event.target.value)}
            >
              <option value="">provider default</option>
              {REASONING_EFFORTS.map((effort) => (
                <option key={effort} value={effort}>
                  {effort}
                </option>
              ))}
            </select>
            {unsupported.reasoningEffort ? (
              <p id={`${fieldId}-reasoning-reason`} className={HINT_CLASS}>
                {unsupported.reasoningEffort}
              </p>
            ) : null}
          </div>
          {numberField("seed", "Seed", "integer", unsupported.seed, { step: "1" })}
        </div>
      </fieldset>

      <div className="mt-4 border-t pt-3">
        <label className={LABEL_CLASS} htmlFor={`${fieldId}-system`}>
          System-prompt override
        </label>
        <Textarea
          id={`${fieldId}-system`}
          className={`min-h-20 text-xs ${FOCUS_RING_CLASS}`}
          value={form.systemPromptOverride}
          placeholder="Leave empty to use the model's default system prompt."
          maxLength={32000}
          onChange={(event) => set("systemPromptOverride", event.target.value)}
          aria-describedby={`${fieldId}-system-hint`}
        />
        <p id={`${fieldId}-system-hint`} className={HINT_CLASS}>
          Replaces the system prompt entirely — it is sent as the only system message,
          not appended to a default one.
        </p>
      </div>

      {error ? (
        <div
          role="alert"
          className="mt-3 flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive"
        >
          <AlertCircleIcon className="size-3.5 shrink-0" aria-hidden />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="mt-4 flex items-center gap-2">
        <Button type="submit" size="sm" className={FOCUS_RING_CLASS} disabled={saving}>
          {saving ? "Saving…" : preset ? "Save preset" : "Create preset"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className={FOCUS_RING_CLASS}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
