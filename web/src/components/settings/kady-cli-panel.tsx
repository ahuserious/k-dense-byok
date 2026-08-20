"use client";

/**
 * Settings ▸ Kady CLI (master-brief row 15).
 *
 * Built against `W/interfaces/F2-harness-and-nodecontrol.md`. Three rules from
 * that document are load-bearing and are implemented literally:
 *
 *  1. `label` is rendered, never `id`.
 *  2. `availability === "ready"` is the WHOLE selectability rule.
 *  3. A non-`ready` harness is rendered DISABLED WITH ITS `detail` VISIBLE —
 *     never hidden and never live. Hiding it makes "why can't I pick DeepSeek?"
 *     unanswerable; rendering it live makes the run fail after the user has
 *     committed to it.
 *
 * WHAT THIS PANEL DELIBERATELY DOES NOT DO — and why the harness rows are
 * announced as disabled even when a harness IS ready:
 *
 *   There is no endpoint in this tree that persists a default harness. F2's
 *   published interface exposes discovery plus the two `claude-code`
 *   mutations, but no mutation for `workflow.defaultHarness` or a session
 *   harness. `server/src/api/harness.ts` is not in this clone at all, so even
 *   discovery 404s today. A picker that cannot persist a value cannot change
 *   the backend dispatch decision.
 *
 *   §6.7 is unambiguous about what to do with that: a control that cannot act is
 *   rendered disabled with a visible reason, never rendered live. So the rows
 *   are readable, focusable and announced as disabled, with the reason on
 *   screen. They are `aria-disabled` rather than `disabled` on purpose: a
 *   `disabled` button drops out of the tab order, and a user who cannot reach
 *   the control also cannot reach the explanation of why it is off.
 *
 * The `claude-code` binary-path and system-prompt editors DO write — those
 * endpoints exist in F2's contract — so they are live whenever the list loads,
 * and inert with an honest reason while it does not.
 */

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangleIcon,
  CheckIcon,
  InfoIcon,
  RefreshCwIcon,
  TerminalIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useProjectScopeId } from "@/lib/projects";
import {
  binaryPathSourceLabel,
  clearClaudeBinaryPath,
  clearClaudeSystemPrompt,
  fetchHarnesses,
  isSelectable,
  saveClaudeBinaryPath,
  saveClaudeSystemPrompt,
  unselectableReason,
  utf8ByteLength,
  UNREACHABLE_INHERITED_HARNESS,
  UNREACHABLE_NODE_HARNESS,
  WORKFLOW_HARNESS_NOT_BOUND,
  type HarnessBinaryPathState,
  type HarnessFetchOutcome,
  type HarnessListEntry,
} from "@/lib/kady-cli";

/**
 * The reason every harness row is inert. Shown once at the top of the list and
 * repeated in each row's accessible name, so it is never more than one focus
 * stop away from the control it explains.
 */
const SELECTION_NOT_BOUND_REASON =
  "Choosing a default harness is not connected to anything that runs yet. The published harness service can discover commands and configure Claude Code, but it has no endpoint that stores a default selection. Until that endpoint changes the tested backend dispatch decision, every selector row remains disabled.";

/** See the note on the harness row's ring: `--ring` fails 3:1 in light theme. */
const FOCUS_RING =
  "focus-visible:border-foreground focus-visible:ring-foreground focus-visible:ring-[3px] focus-visible:outline-none";

const AVAILABILITY_LABEL: Record<HarnessListEntry["availability"], string> = {
  ready: "Ready",
  "not-found": "Not installed",
  "no-adapter": "No adapter",
  rejected: "Rejected",
};

type PanelStatus = "loading" | "ready" | "unavailable";

export function KadyCliPanel() {
  const projectId = useProjectScopeId();
  const [status, setStatus] = useState<PanelStatus>("loading");
  const [harnesses, setHarnesses] = useState<HarnessListEntry[]>([]);
  const [detail, setDetail] = useState<string | null>(null);

  const applyOutcome = useCallback((outcome: HarnessFetchOutcome) => {
    if (outcome.kind === "ok") {
      // Replace state from the mutation's own full response — never issue a
      // follow-up GET, so a concurrent change cannot be lost.
      setHarnesses(outcome.response.harnesses);
      setStatus("ready");
      setDetail(null);
      return;
    }
    if (outcome.kind === "unavailable") {
      setStatus("unavailable");
      setDetail(outcome.detail);
    }
  }, []);

  const load = useCallback(async () => {
    setStatus("loading");
    setDetail(null);
    applyOutcome(await fetchHarnesses(projectId));
  }, [applyOutcome, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const claudeCode = harnesses.find((entry) => entry.id === "claude-code") ?? null;

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      <header>
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <TerminalIcon className="size-4" aria-hidden />
          Kady CLI
        </h2>
        <p className="text-muted-foreground mt-1 text-xs">
          Which command-line harness a workflow node runs on. Only harnesses that
          actually resolve on this machine can ever be selected.
        </p>
      </header>

      {status === "loading" && (
        <p className="text-muted-foreground text-xs" role="status">
          Reading the harness list…
        </p>
      )}

      {status === "unavailable" && (
        <div className="border-border rounded-md border p-3" role="status">
          <p className="text-foreground flex gap-1.5 text-xs">
            <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              <span className="font-medium">Harness settings are unavailable.</span>{" "}
              {detail}
            </span>
          </p>
          <Button
            variant="outline"
            size="sm"
            className={cn("mt-2 h-7 text-xs", FOCUS_RING)}
            onClick={() => void load()}
          >
            <RefreshCwIcon className="size-3" aria-hidden />
            Retry
          </Button>
        </div>
      )}

      {status === "ready" && (
        <>
          <div className="border-border rounded-md border p-3">
            <p className="text-foreground flex gap-1.5 text-xs">
              <InfoIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>
                <span className="font-medium">Selection is not bound yet.</span>{" "}
                {SELECTION_NOT_BOUND_REASON}
              </span>
            </p>
          </div>

          <section aria-labelledby="kady-cli-harnesses">
            <h3
              id="kady-cli-harnesses"
              className="text-muted-foreground text-xs uppercase tracking-wide"
            >
              Harnesses
            </h3>
            <ul
              className="mt-2 space-y-1.5"
              role="radiogroup"
              aria-labelledby="kady-cli-harnesses"
              aria-disabled="true"
              aria-describedby="kady-cli-not-bound"
            >
              {harnesses.map((entry) => (
                <HarnessRow key={entry.id} entry={entry} />
              ))}
            </ul>
            <p id="kady-cli-not-bound" className="sr-only">
              {SELECTION_NOT_BOUND_REASON}
            </p>
          </section>

          {claudeCode?.supportsBinaryPathOverride && claudeCode.binaryPath && (
            <ClaudeCodeSettings
              binaryPath={claudeCode.binaryPath}
              projectId={projectId}
              onOutcome={applyOutcome}
            />
          )}

          <section aria-labelledby="kady-cli-limits">
            <h3
              id="kady-cli-limits"
              className="text-muted-foreground text-xs uppercase tracking-wide"
            >
              When a harness is refused
            </h3>
            <ul className="text-muted-foreground mt-2 space-y-1 text-xs">
              <li>
                A hosted-Fusion node whose whole call ceiling is served by the OpenRouter
                router starts no CLI process, so any harness other than Pi is refused at
                validation with{" "}
                <code className="font-mono">{UNREACHABLE_NODE_HARNESS}</code> — or{" "}
                <code className="font-mono">{UNREACHABLE_INHERITED_HARNESS}</code> when it
                was inherited from the default.
              </li>
              <li>
                The Claude Code CLI has no sampling flags, so a node that sets temperature
                or top-p on that harness is refused with{" "}
                <code className="font-mono">{WORKFLOW_HARNESS_NOT_BOUND}</code> rather than
                having those values silently dropped.
              </li>
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

function HarnessRow({ entry }: { entry: HarnessListEntry }) {
  const selectable = isSelectable(entry);
  const reason = unselectableReason(entry);
  // Even a `ready` harness is inert, because nothing persists the choice. Both
  // reasons are surfaced; neither is inferred from the other.
  const rowReason = selectable ? SELECTION_NOT_BOUND_REASON : reason;

  return (
    <li>
      <button
        type="button"
        role="radio"
        aria-checked={false}
        aria-disabled="true"
        aria-label={`${entry.label}. ${AVAILABILITY_LABEL[entry.availability]}. ${rowReason ?? ""}`}
        onClick={(event) => {
          // aria-disabled keeps the control in the tab order so its reason is
          // reachable; it must still not act.
          event.preventDefault();
        }}
        className={cn(
          "border-border w-full cursor-not-allowed rounded-md border px-3 py-2 text-left",
          // `--ring` measures 2.59:1 against a light background — below the 3:1
          // §6.6 requires of a focus indicator. `--foreground` measures 19.79:1
          // light and 18.96:1 dark. Never dimmed by opacity.
          "focus-visible:border-foreground focus-visible:ring-foreground focus-visible:ring-[3px] focus-visible:outline-none",
        )}
      >
        <span className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-medium">{entry.label}</span>
          <span
            className={cn(
              "shrink-0 rounded-sm border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide",
              selectable ? "border-border text-foreground" : "border-border text-muted-foreground",
            )}
          >
            {selectable && <CheckIcon className="mr-0.5 inline size-2.5" aria-hidden />}
            {AVAILABILITY_LABEL[entry.availability]}
          </span>
        </span>
        {entry.summary ? (
          <span className="text-muted-foreground mt-0.5 block text-xs">
            {entry.summary}
          </span>
        ) : null}
        {!selectable && reason ? (
          <span className="text-foreground mt-1 flex gap-1.5 text-xs">
            <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" aria-hidden />
            <span>{reason}</span>
          </span>
        ) : null}
        {entry.resolvedExecutable ? (
          <span className="text-muted-foreground mt-1 block font-mono text-[11px]">
            Resolved command: {entry.resolvedExecutable}
          </span>
        ) : null}
        {entry.unboundControls.length > 0 ? (
          <span className="text-muted-foreground mt-1 block text-xs">
            Adapter limits:{" "}
            {entry.unboundControls
              .map(({ control, reason }) => `${control} — ${reason}`)
              .join("; ")}
          </span>
        ) : null}
      </button>
    </li>
  );
}

function ClaudeCodeSettings({
  binaryPath,
  projectId,
  onOutcome,
}: {
  binaryPath: HarnessBinaryPathState;
  projectId: string;
  onOutcome: (outcome: HarnessFetchOutcome) => void;
}) {
  // `override` pre-fills the editor when the user set it or when it was
  // rejected, so a bad value can be fixed in place; otherwise the field is empty
  // with `resolvedPath` as placeholder text (F2 §3).
  const [pathDraft, setPathDraft] = useState(binaryPath.override ?? "");
  const [pathError, setPathError] = useState<string | null>(
    binaryPath.state === "rejected" ? binaryPath.detail : null,
  );
  const [promptDraft, setPromptDraft] = useState(binaryPath.systemPrompt ?? "");
  const [promptError, setPromptError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const promptBytes = utf8ByteLength(promptDraft);
  const promptOverBudget = promptBytes > binaryPath.systemPromptMaxBytes;
  const sourceLabel = binaryPathSourceLabel(binaryPath.source);

  const run = async (
    action: () => Promise<HarnessFetchOutcome>,
    setError: (message: string | null) => void,
  ) => {
    setBusy(true);
    setError(null);
    const outcome = await action();
    setBusy(false);
    if (outcome.kind === "ok") {
      onOutcome(outcome);
      return;
    }
    // A 400 means nothing was persisted: keep the field dirty and show `detail`.
    // Never optimistically apply.
    setError(outcome.detail);
    if (outcome.kind === "unavailable") onOutcome(outcome);
  };

  return (
    <section aria-labelledby="kady-cli-claude" className="border-border rounded-md border p-3">
      <h3 id="kady-cli-claude" className="text-sm font-medium">
        Claude Code CLI
      </h3>

      {binaryPath.state === "resolved" && binaryPath.resolvedPath ? (
        <p className="text-muted-foreground mt-1 text-xs">
          Using <span className="text-foreground font-mono">{binaryPath.resolvedPath}</span>
          {sourceLabel ? ` — ${sourceLabel}` : ""}
        </p>
      ) : null}
      {binaryPath.state !== "resolved" && binaryPath.detail ? (
        <p className="text-foreground mt-1 flex gap-1.5 text-xs">
          <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" aria-hidden />
          <span>{binaryPath.detail}</span>
        </p>
      ) : null}

      <label className="mt-3 block text-xs font-medium" htmlFor="kady-cli-binary-path">
        Binary path
      </label>
      <Input
        id="kady-cli-binary-path"
        className="mt-1 font-mono text-xs"
        value={pathDraft}
        placeholder={binaryPath.resolvedPath ?? "/path/to/claude"}
        aria-invalid={pathError !== null}
        aria-describedby={pathError ? "kady-cli-binary-path-error" : undefined}
        onChange={(event) => {
          setPathDraft(event.target.value);
        }}
      />
      {pathError ? (
        <p id="kady-cli-binary-path-error" className="text-destructive mt-1 text-xs">
          {pathError}
        </p>
      ) : null}
      <div className="mt-2 flex gap-2">
        <Button
          size="sm"
          className="h-7 text-xs"
          disabled={busy || pathDraft.trim().length === 0}
          onClick={() => void run(() => saveClaudeBinaryPath(pathDraft.trim(), projectId), setPathError)}
        >
          Save path
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          disabled={busy || binaryPath.override === null}
          onClick={() =>
            void run(async () => {
              const outcome = await clearClaudeBinaryPath(projectId);
              if (outcome.kind === "ok") setPathDraft("");
              return outcome;
            }, setPathError)
          }
        >
          Clear override
        </Button>
      </div>

      <label className="mt-4 block text-xs font-medium" htmlFor="kady-cli-system-prompt">
        System prompt override
      </label>
      <p className="text-muted-foreground mt-0.5 text-xs">
        {binaryPath.systemPrompt === null
          ? "Unset — Claude Code uses its own default prompt for relayed workflow nodes."
          : "Replaces Claude Code's preset prompt for relayed workflow nodes."}
      </p>
      <Textarea
        id="kady-cli-system-prompt"
        className="mt-1 min-h-24 font-mono text-xs"
        value={promptDraft}
        aria-invalid={promptOverBudget || promptError !== null}
        aria-describedby="kady-cli-system-prompt-bytes"
        onChange={(event) => {
          setPromptDraft(event.target.value);
        }}
      />
      <p
        id="kady-cli-system-prompt-bytes"
        className={cn(
          "mt-1 font-mono text-xs tabular-nums",
          promptOverBudget ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {promptBytes} / {binaryPath.systemPromptMaxBytes} bytes
        {promptOverBudget ? " — over the limit, this will be refused" : ""}
      </p>
      {promptError ? <p className="text-destructive mt-1 text-xs">{promptError}</p> : null}
      <div className="mt-2 flex gap-2">
        <Button
          size="sm"
          className="h-7 text-xs"
          disabled={busy || promptDraft.trim().length === 0 || promptOverBudget}
          onClick={() =>
            void run(() => saveClaudeSystemPrompt(promptDraft, projectId), setPromptError)
          }
        >
          Save prompt
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          disabled={busy || binaryPath.systemPrompt === null}
          onClick={() =>
            void run(async () => {
              const outcome = await clearClaudeSystemPrompt(projectId);
              if (outcome.kind === "ok") setPromptDraft("");
              return outcome;
            }, setPromptError)
          }
        >
          Restore default
        </Button>
      </div>
    </section>
  );
}
