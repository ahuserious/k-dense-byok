// danbot-byok — web/src/components/chat-rail.tsx
//
// A collapsible chat docked as a vertical rail on the FAR RIGHT of the page,
// available across all views (Workflows / DAG Pipelines / DAG Builder / Console)
// so you can talk to KADY without leaving the visual builder or the console. It
// replaces the old chat popout that lived INSIDE the Archon builder iframe (which
// couldn't host Kady's model selector or load Kady skills).
//
// It is "wired the same way as the rest of the agents": it renders a real
// <ChatTab> (same Pi session, same ModelSelector, same tools/cost), just in a
// narrow drawer. The one extra is `preloadSkills` — the rail's session always
// reaches for `archon` + `scientific-pipeline-builder` (see ChatTab.preloadSkills).
//
// Collapsed → a thin vertical strip you click to slide the panel open; open/closed
// is persisted in localStorage. The ChatTab stays mounted while collapsed (just
// display:none via isActive) so an in-flight turn keeps streaming.

"use client";

import { useEffect, useState } from "react";
import { ChevronRightIcon, MessageSquareTextIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { ChatTab, type ChatTabMeta } from "@/components/chat-tab";
import type { Skill } from "@/components/skills-selector";

// A dedicated, stable tab id for the rail's session (kept out of the main tab strip).
const RAIL_TAB_ID = "rail-chat";
const RAIL_SKILLS = ["archon", "scientific-pipeline-builder"];
const STORAGE_KEY = "kady.chatRail.open";

export interface ChatRailProps {
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
  onStitchPipeline: () => void;
  onCreateGoalWorkflow: (goal: string) => void;
}

export function ChatRail({
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
  onStitchPipeline,
  onCreateGoalWorkflow,
}: ChatRailProps) {
  // Hydrate persisted open/closed once on mount (localStorage is client-only).
  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "1" && !open) onToggle(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, open ? "1" : "0");
  }, [open]);

  return (
    <div
      className={cn(
        "flex h-full shrink-0 flex-col border-l bg-background transition-[width] duration-200 ease-out",
        open ? "w-[400px]" : "w-9",
      )}
    >
      {open ? (
        <>
          <div className="flex shrink-0 items-center justify-between border-b px-3 py-1.5">
            <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
              <MessageSquareTextIcon className="size-3.5" />
              Chat
            </span>
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
          {/* The real KADY chat — preloadSkills makes this session reach for the
              archon + scientific-pipeline-builder skills. */}
          <ChatTab
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
            onStitchPipeline={onStitchPipeline}
            onCreateGoalWorkflow={onCreateGoalWorkflow}
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
