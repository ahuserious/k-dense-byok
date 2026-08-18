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
  | "unavailable"
  /**
   * The picker's list could not be fetched, so the helper does not KNOW what
   * this project has. Distinct from "unavailable" on purpose (r3 review F8): an
   * errored list left the rail asserting "No saved workflow to work on yet" and
   * then telling the user to go create a workflow they may already own.
   */
  | "unlistable";

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
    // The DAG-BUILDING chat the owner asked for, and the only one. EVERY
    // sentence below names a route a user can walk end to end; rounds 1 and 3
    // both failed here, and both failures were the same shape — copy describing
    // a capability the product does not have:
    //
    //   * r1: "I draft the VISUAL DAG" promised an apply path into the canvas.
    //   * r3 F1: "Save a workflow in the canvas on the left" named a route that
    //     cannot produce a revision THIS picker lists. The canvas saves to the
    //     vendored pipeline engine's own store (PUT /api/workflows/<name> on the
    //     iframe's origin); the picker lists Kady's typed store (GET
    //     /dag-workflows). Nothing bridges them, and in the very state this copy
    //     is written for the canvas's Save is disabled outright
    //     ("Open a workflow from the registry before saving"). The only route
    //     that produces a listed revision is Scientific Pipelines → "New typed
    //     workflow", so that is the only route named.
    //   * r3 F2: "draft YAML you can copy into the canvas" named a paste target
    //     that does not exist. The engine's YAML surface is a read-only <pre>
    //     headed "Read-only YAML preview" in both YAML and Split modes, there is
    //     no YAML import anywhere in the vendored app or in Kady's web app, and
    //     /dag-workflow-imports/* has no caller in web/src. The draft is text in
    //     THIS chat and nothing more, so that is what the copy says.
    //   * r3 F3: "then pick its revision above" was false at the moment the user
    //     followed it — PersistentWorkspaceSurfaces keeps this rail mounted, so
    //     returning to the Builder does not refetch. The Reload control is the
    //     trigger the rail actually owns, so the copy names it.
    //
    // A word ban cannot police this (neither r3 sentence used a banned word);
    // the assertion in helper-agent-chat.test.tsx pins the ban across every
    // string in every state, and the walk-throughs in the lane report are what
    // pin the routes.
    if (contextState === "unlistable") {
      return {
        title: "Saved workflows could not be listed",
        description:
          "The list above did not load, so I do not know which revisions this project has. Press Reload above to try again.",
        placeholder: "Reload the list above, then ask…",
        missingContext: "Saved workflows could not be listed. Press Reload above to try again.",
      };
    }
    if (contextState === "unavailable") {
      return {
        title: "No saved workflow to work on yet",
        description:
          "I work on typed workflow revisions, and this project has none yet. Create one in Scientific Pipelines with New typed workflow, then press Reload above and pick its revision. The canvas on the left saves into the pipeline engine's own store, which this picker cannot list.",
        placeholder: "Create a typed workflow first, then ask about it…",
        missingContext:
          "Create a typed workflow in Scientific Pipelines, then press Reload above and pick its revision.",
      };
    }
    if (contextState === "unselected") {
      return {
        title: "Pick a saved workflow revision to start",
        description:
          "Choose a saved revision above. I then explain its nodes and edges, draft YAML here in the chat, and propose fixes for validation errors. Nothing I write reaches the canvas: it has no YAML import, and I cannot edit it.",
        placeholder: "Pick a saved revision above, then ask…",
        missingContext: "Pick a saved workflow revision above to ask the DAG Builder agent.",
      };
    }
    return {
      title: "Build on this saved workflow revision",
      description:
        "I explain the nodes and edges of the revision above, draft YAML here in the chat, and propose fixes for validation errors. Nothing I write reaches the canvas: it has no YAML import, and I cannot edit it.",
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
  contextListFailed = false,
  providerBlocked = false,
}: {
  projectId: string;
  profile: HelperAgentProfile;
  contextReference?: HelperAgentContextReference;
  hasSelectableContext?: boolean;
  contextListFailed?: boolean;
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
  // "unlistable" ranks BELOW "unselected": a caller whose list failed but whose
  // previous snapshot still holds options can still pick one, and the picker's
  // own role=alert already reports the failure. It ranks ABOVE "unavailable"
  // because a failed fetch is not evidence that the project is empty.
  const emptyState = helperEmptyState(
    profile,
    contextReady
      ? "selected"
      : hasSelectableContext
        ? "unselected"
        : contextListFailed
          ? "unlistable"
          : "unavailable",
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
   * True when the caller's picker could not FETCH its list, which is a different
   * thing from fetching an empty one. Without this the rail told a user whose
   * list request failed that no saved workflow exists, and then sent them off to
   * create one they may already have (r3 review F8). Optional and defaulted off.
   */
  contextListFailed?: boolean;
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
