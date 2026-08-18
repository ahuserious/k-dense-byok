"use client";

import { LoaderCircleIcon, SendIcon, SquareIcon } from "lucide-react";
import { FormEvent, KeyboardEvent, useEffect, useId, useState } from "react";

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import { AssistantMessageBody } from "@/components/chat-tab";
import { apiFetch } from "@/lib/projects";
import { useAgent } from "@/lib/use-agent";

export type HelperAgentProfile = "dag-builder" | "raindrop" | "workflow-rescue";
export type HelperAgentContextReference =
  | { kind: "workflow"; id: string }
  | { kind: "run"; id: string }
  | { kind: "session"; id: string };

function referenceKey(reference: HelperAgentContextReference | undefined): string {
  return reference ? `${reference.kind}:${reference.id}` : "no-selection";
}

function helperLabel(profile: HelperAgentProfile): string {
  if (profile === "dag-builder") return "DAG Builder agent";
  if (profile === "workflow-rescue") return "Workflow Rescue helper";
  return "Raindrop analyst";
}

/**
 * Which of the three context states the caller is in. The empty state and the
 * blocked hint have to differ across all three: the copy that describes what
 * the helper does is a lie in the state where it can do nothing, and "pick one
 * above" is a lie when the picker has nothing to offer.
 */
type HelperContextState =
  /** A context reference is bound; the helper can actually answer. */
  | "selected"
  /** Selectable contexts exist, the user has not chosen one. */
  | "unselected"
  /** The picker is empty — nothing in this project can be selected yet. */
  | "unavailable";

function helperEmptyState(
  profile: HelperAgentProfile,
  contextState: HelperContextState,
): {
  title: string;
  description: string;
  placeholder: string;
  /**
   * Why the composer cannot send yet when nothing is selected. The transcript
   * already carries `description`, but that text is unassociated chrome: this
   * one is what `aria-describedby` points the Send button at, so it has to name
   * the thing the user must pick for THIS profile.
   */
  missingContext: string;
} {
  if (profile === "dag-builder") {
    // The DAG-BUILDING chat the owner asked for, and the only one. Two hard
    // limits shape every string here, and the round-1 review failed on the
    // first: (1) the composer is HARD BLOCKED until a SAVED revision is
    // selected, so on a project with no saved workflow the old copy invited the
    // user to "describe the pipeline you want" into a box that could never
    // send; (2) there is no bridge from this rail into the canvas
    // (dag-builder-surface.tsx header), so "I draft the VISUAL DAG" promised an
    // apply path that does not exist. The copy below says only what is true in
    // each state: explain, draft YAML the user copies in, propose fixes.
    if (contextState === "unavailable") {
      return {
        title: "No saved workflow to work on yet",
        description:
          "This assistant works on SAVED workflow revisions, so it needs one to exist first. Save a workflow in the canvas on the left, or create one in Scientific Pipelines, then pick its revision above.",
        placeholder: "Save a workflow first, then ask about it…",
        missingContext:
          "Save a workflow first, or create one in Scientific Pipelines, then pick its revision above.",
      };
    }
    if (contextState === "unselected") {
      return {
        title: "Pick a saved workflow revision to start",
        description:
          "Choose a saved revision above. I then explain its nodes and edges, draft YAML you can copy into the canvas, and propose fixes for validation errors.",
        placeholder: "Pick a saved revision above, then ask…",
        missingContext: "Pick a saved workflow revision above to ask the DAG Builder agent.",
      };
    }
    return {
      title: "Build on this saved workflow revision",
      description:
        "I explain the nodes and edges of the revision above, draft YAML you can copy into the canvas, and propose fixes for validation errors. I cannot edit the canvas myself.",
      placeholder: "Ask about this workflow…",
      missingContext: "Pick a saved workflow revision above to ask the DAG Builder agent.",
    };
  }
  if (profile === "workflow-rescue") {
    return {
      title: "Diagnose this stopped run",
      description: "Ask for a repair proposal. This helper cannot control, retry, or modify the run.",
      placeholder: "Ask what failed and what to change…",
      missingContext: "Select a stopped run to ask the Workflow Rescue helper.",
    };
  }
  // A LOG ANALYST, never a DAG-building chat. The previous copy led with "DAG
  // run", which read as the builder assistant and sent the owner looking for
  // the pipeline chat here. Nothing in this profile's user-facing text now
  // describes building a graph.
  return {
    title: "Analyze a saved log",
    description:
      "Pick a saved run or chat log on the left, then ask for a causal timeline of what happened.",
    placeholder: "Ask what failed and why…",
    missingContext: "Pick a saved run or chat log on the left to ask the Raindrop analyst.",
  };
}

function ScopedHelperAgentChat({
  projectId,
  profile,
  contextReference,
  hasSelectableContext = true,
  providerBlocked = false,
}: {
  projectId: string;
  profile: HelperAgentProfile;
  contextReference?: HelperAgentContextReference;
  hasSelectableContext?: boolean;
  providerBlocked?: boolean;
}) {
  const agent = useAgent(projectId);
  const contextKind = contextReference?.kind;
  const contextId = contextReference?.id;
  const [draft, setDraft] = useState("");
  const [connection, setConnection] = useState<"waiting" | "connecting" | "ready" | "error">(
    contextReference ? "connecting" : "waiting",
  );
  const [connectionError, setConnectionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    if (!contextKind || !contextId) {
      setConnection("waiting");
      setConnectionError(null);
      return () => controller.abort();
    }
    setConnection("connecting");
    setConnectionError(null);
    void apiFetch(
      `/helper-sessions/${encodeURIComponent(profile)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: contextKind, id: contextId }),
        signal: controller.signal,
      },
      projectId,
    )
      .then(async (response) => {
        if (!response.ok) {
          const data = await response.json().catch(() => ({})) as { detail?: string };
          throw new Error(data.detail ?? `Helper session failed (${response.status})`);
        }
        const data = await response.json() as {
          id?: unknown;
          source?: { kind?: unknown; id?: unknown };
        };
        if (
          typeof data.id !== "string" ||
          data.source?.kind !== contextKind ||
          data.source?.id !== contextId
        ) {
          throw new Error("Helper session response did not match the selected context.");
        }
        const restored = await agent.loadSession(data.id);
        if (cancelled) return;
        if (restored !== "restored") {
          throw new Error("The helper session could not be restored.");
        }
        setConnection("ready");
      })
      .catch((error) => {
        if (cancelled || controller.signal.aborted) return;
        setConnection("error");
        setConnectionError(error instanceof Error ? error.message : "Helper session failed.");
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
    // One ScopedHelperAgentChat is scoped to one project/profile/source tuple.
    // loadSession is intentionally omitted: useAgent returns a fresh callback
    // whenever its transcript changes, which would reconnect on every token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextId, contextKind, profile, projectId]);

  const running = agent.status === "submitted" || agent.status === "streaming";
  const contextReady = Boolean(contextKind && contextId);
  // `hasSelectableContext` defaults to true, so a call site that does not know
  // whether its picker is empty keeps the previous two-state behaviour.
  const emptyState = helperEmptyState(
    profile,
    contextReady ? "selected" : hasSelectableContext ? "unselected" : "unavailable",
  );

  // The composer used to be a bare native `disabled` on both the textarea and
  // Send: unfocusable, so a keyboard or screen-reader user could neither land
  // on it nor hear why, and the only explanation was unassociated transcript
  // text. Same treatment as the chat Submit — the controls stay focusable with
  // `aria-disabled` (submit() refuses either way) and point at one visible
  // hint. The connection error keeps its own alert; describedby aims there
  // instead of restating it.
  const instanceId = useId();
  const blockedHintId = `${instanceId}-helper-blocked`;
  const connectionErrorId = `${instanceId}-helper-error`;
  // Precedence mirrors the chat composer's Submit hint (F5): a missing provider
  // is the reason nothing at all can be sent, so it outranks the per-profile
  // "pick a context" hint, and the caller is expected to pass it only once the
  // provider check has SETTLED — an unsettled check would flash the amber block
  // and shove the composer down on every Builder visit.
  const blockedHint = providerBlocked
    ? "Connect a provider in Settings to send"
    : !contextReady
      ? emptyState.missingContext
      : connection === "connecting"
        ? `${helperLabel(profile)} is connecting…`
        : null;
  const blocked = providerBlocked || connection !== "ready" || !contextReady;
  const blockedDescribedBy = connectionError
    ? connectionErrorId
    : blockedHint
      ? blockedHintId
      : undefined;

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const question = draft.trim();
    if (!question || blocked || running) return;
    setDraft("");
    // The browser sends only the question. The server reconstructs the bounded
    // projection from this helper session's authoritative typed binding.
    await agent.send(question);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    void submit();
  };

  return (
    <section className="flex h-full min-h-0 flex-col bg-background" aria-label={helperLabel(profile)}>
      <div className="shrink-0 border-b bg-muted/10 px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold">{helperLabel(profile)}</span>
          <span className="text-[10px] text-muted-foreground">
            {connection === "connecting"
              ? "Connecting…"
              : connection === "ready"
                ? "Pi (Kady) · bounded context · no tools"
                : connection === "waiting"
                  ? "Select saved context"
                  : "Unavailable"}
          </span>
        </div>
        {connectionError ? (
          <p id={connectionErrorId} role="alert" className="mt-1 text-[10px] text-destructive">
            {connectionError}
          </p>
        ) : null}
      </div>

      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="px-3 py-3">
          {agent.messages.length === 0 ? (
            <ConversationEmptyState
              title={emptyState.title}
              description={emptyState.description}
            />
          ) : agent.messages.map((message, index) => (
            <Message from={message.role} key={message.id}>
              <MessageContent>
                {message.role === "assistant" ? (
                  <AssistantMessageBody
                    message={message}
                    isStreaming={running}
                    isLast={index === agent.messages.length - 1}
                    sessionId={agent.sessionId}
                    projectId={projectId}
                  />
                ) : (
                  <MessageResponse>{message.content}</MessageResponse>
                )}
              </MessageContent>
            </Message>
          ))}
          {connection === "connecting" && agent.messages.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-4 text-[11px] text-muted-foreground">
              <LoaderCircleIcon className="size-3.5 animate-spin" /> Restoring helper session…
            </div>
          ) : null}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <form className="shrink-0 border-t p-2" onSubmit={(event) => void submit(event)}>
        {blockedHint ? (
          <p
            id={blockedHintId}
            data-testid="helper-agent-blocked-hint"
            className="mb-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[10px] text-amber-700 dark:text-amber-300"
          >
            {blockedHint}
          </p>
        ) : null}
        <textarea
          aria-label={`Message ${helperLabel(profile)}`}
          // A 1px `ring-ring` rendered 1.56:1 against the surround, and
          // `aria-disabled:opacity-50` then halved even that — on the one
          // control M4 deliberately kept in the tab order. The ring is now 2px
          // of foreground/60 (the colour the picker and chat composer already
          // use) and the blocked state is drawn in muted colours so the ring
          // keeps its full opacity while the field is refusing input.
          className="min-h-16 w-full resize-none rounded-md border bg-background px-2.5 py-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-foreground/60 aria-disabled:bg-muted aria-disabled:text-muted-foreground aria-disabled:cursor-not-allowed"
          value={draft}
          // readOnly rather than disabled: the field keeps its place in the tab
          // order (so the reason is reachable) and still refuses input.
          readOnly={blocked}
          aria-disabled={blocked || undefined}
          aria-describedby={blocked ? blockedDescribedBy : undefined}
          placeholder={emptyState.placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <span className="text-[10px] text-muted-foreground">Shift+Enter for a new line</span>
          {running ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-medium hover:bg-muted"
              onClick={() => void agent.stop()}
            >
              <SquareIcon className="size-3" /> Stop
            </button>
          ) : (
            <button
              type="submit"
              // No `outline-none` base: in Tailwind v4 it sets
              // --tw-outline-style unconditionally, which would leave the
              // focus-visible outline below styleless. The explicit 2px
              // foreground outline replaces the browser default, which at
              // `opacity-40` had rendered 2.68:1; the blocked look is colour,
              // not opacity, so the outline stays at full strength.
              className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-[10px] font-medium text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground aria-disabled:cursor-not-allowed aria-disabled:bg-muted aria-disabled:text-muted-foreground"
              aria-disabled={blocked || !draft.trim() || undefined}
              aria-describedby={blockedDescribedBy}
            >
              <SendIcon className="size-3" /> Send
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

export function HelperAgentChat(props: {
  projectId: string;
  profile: HelperAgentProfile;
  contextReference?: HelperAgentContextReference;
  /**
   * False when the caller's picker has nothing to offer at all — a project with
   * no saved workflow, say. The empty state and the blocked hint then name the
   * way out instead of telling the user to pick from an empty list. Optional
   * and defaulted true: call sites that cannot tell keep the previous copy.
   */
  hasSelectableContext?: boolean;
  /**
   * True when no model provider is connected, so no helper turn can be served.
   * Optional and defaulted off: call sites that do not run the provider check
   * behave exactly as before.
   */
  providerBlocked?: boolean;
}) {
  // A source change must create a fresh useAgent instance. Otherwise the old
  // session id/transcript remains bound and untrusted source A can persist into
  // source B even when the server correctly returns a different helper session.
  return <ScopedHelperAgentChat key={`${props.profile}:${referenceKey(props.contextReference)}`} {...props} />;
}
