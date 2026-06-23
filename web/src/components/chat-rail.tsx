// danbot-byok — web/src/components/chat-rail.tsx
//
// A collapsible chat docked as a vertical rail on the FAR RIGHT of the DAG Builder
// (scoped to that view in page.tsx). It's where you compose a pipeline by talking to
// KADY — and where the "Add to pipeline" popover (workflows / skills / databases /
// suggestions) sends its compose instructions. It replaces the old chat popout that
// lived INSIDE the Archon builder iframe (which couldn't host Kady's model selector
// or load Kady skills).
//
// It is "wired the same way as the rest of the agents": it renders a real <ChatTab>
// (same Pi session, model selector, tools, cost), with `preloadSkills` so the session
// always reaches for `archon` + `scientific-pipeline-builder`.
//
// Collapsed → a thin vertical strip you click to slide the panel open; open/closed is
// persisted in localStorage. The ChatTab stays mounted while collapsed so an in-flight
// turn keeps streaming.

"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { ChevronRightIcon, MessageSquareTextIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { ChatTab, type ChatTabHandle, type ChatTabMeta } from "@/components/chat-tab";
import type { Skill } from "@/components/skills-selector";
import { DagComposePopover } from "@/components/dag-compose-popover";

// A dedicated, stable tab id for the rail's session (kept out of the main tab strip).
const RAIL_TAB_ID = "rail-chat";
const RAIL_SKILLS = ["archon", "scientific-pipeline-builder"];
const STORAGE_KEY = "kady.chatRail.open";

export interface ChatRailProps {
  /** Whether the rail's view (DAG Builder) is active. When false the rail is hidden
   *  (display:none) but stays mounted so its chat session/stream persists. */
  visible: boolean;
  open: boolean;
  onToggle: (open: boolean) => void;
  // ChatTab passthrough — the same shared sandbox/state the main tabs receive.
  allFiles: string[];
  uploadFiles: (files: FileList | File[], paths?: string[]) => Promise<string[]>;
  onSandboxRefresh: () => void;
  onTurnComplete: () => void;
  allSkills: Skill[];
  budgetState: "ok" | "warn" | "exceeded";
  budgetTotalUsd: number;
  budgetLimitUsd: number | null;
  onMetaChange: (tabId: string, meta: ChatTabMeta) => void;
  /** A compose instruction parked by "Add to DAG builder"; flushed to the chat on bump. */
  composeMessageRef?: RefObject<string | null>;
  /** Bumped by the parent each time a new composeMessageRef is parked. */
  composeNonce?: number;
}

export function ChatRail({
  visible,
  open,
  onToggle,
  allFiles,
  uploadFiles,
  onSandboxRefresh,
  onTurnComplete,
  allSkills,
  budgetState,
  budgetTotalUsd,
  budgetLimitUsd,
  onMetaChange,
  composeMessageRef,
  composeNonce,
}: ChatRailProps) {
  const chatTabRef = useRef<ChatTabHandle>(null);

  // Append (stack) a line into the rail's chat input — NOT send — retrying briefly until
  // the ChatTab's imperative handle has registered (it mounts a tick after the rail opens).
  // The user reviews the stacked stages, then sends once to build the pipeline YAML.
  const appendToRail = useCallback((line: string) => {
    let tries = 0;
    const attempt = () => {
      const handle = chatTabRef.current;
      if (handle) {
        handle.appendToInput(line);
        return;
      }
      if (tries++ < 15) setTimeout(attempt, 100);
    };
    attempt();
  }, []);

  // Hydrate persisted open/closed once on mount (localStorage is client-only).
  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "1" && !open) onToggle(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, open ? "1" : "0");
  }, [open]);

  // Flush a parked compose instruction (from a workflow card's "Add to DAG builder").
  // Keyed on composeNonce so it fires even when the rail was already open.
  useEffect(() => {
    if (!composeNonce) return;
    const msg = composeMessageRef?.current;
    if (msg) {
      composeMessageRef.current = null;
      appendToRail(msg);
    }
  }, [composeNonce, composeMessageRef, appendToRail]);

  return (
    <div
      className={cn(
        "h-full shrink-0 flex-col border-l bg-background transition-[width] duration-200 ease-out",
        // Hidden (but mounted) when away from the DAG Builder so the chat persists.
        visible ? "flex" : "hidden",
        open ? "w-[400px]" : "w-9",
      )}
    >
      {open ? (
        <>
          <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-1.5">
            <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
              <MessageSquareTextIcon className="size-3.5" />
              Chat
            </span>
            <div className="flex items-center gap-1">
              <DagComposePopover allSkills={allSkills} onStack={appendToRail} />
              <button
                type="button"
                onClick={() => onToggle(false)}
                aria-label="Collapse chat rail"
                title="Collapse chat"
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <XIcon className="size-3.5" />
              </button>
            </div>
          </div>
          {/* The real KADY chat — preloadSkills makes this session reach for the
              archon + scientific-pipeline-builder skills. */}
          <ChatTab
            ref={chatTabRef}
            tabId={RAIL_TAB_ID}
            isActive={open}
            allFiles={allFiles}
            uploadFiles={uploadFiles}
            onSandboxRefresh={onSandboxRefresh}
            onTurnComplete={onTurnComplete}
            allSkills={allSkills}
            budgetState={budgetState}
            budgetTotalUsd={budgetTotalUsd}
            budgetLimitUsd={budgetLimitUsd}
            onMetaChange={onMetaChange}
            preloadSkills={RAIL_SKILLS}
          />
        </>
      ) : (
        // Collapsed strip — click anywhere to slide the panel open.
        <button
          type="button"
          onClick={() => onToggle(true)}
          aria-label="Open chat rail"
          title="Open chat"
          className="flex h-full w-full flex-col items-center gap-2 py-3 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
        >
          <ChevronRightIcon className="size-4 shrink-0 rotate-180" />
          <MessageSquareTextIcon className="size-4 shrink-0" />
          <span className="text-[11px] font-medium [writing-mode:vertical-rl]">Chat</span>
        </button>
      )}
    </div>
  );
}
