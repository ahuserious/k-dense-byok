"use client";

import {
  BracesIcon,
  LayersIcon,
  ListTreeIcon,
  MessageSquareTextIcon,
  NetworkIcon,
  TerminalSquareIcon,
  WorkflowIcon,
} from "lucide-react";

import type { WorkspaceView } from "@/lib/workspace-persistence";
import { cn } from "@/lib/utils";

// Naming: "DAG Workflows" is the native typed engine (list + typed builder);
// "DAG Pipelines" is the ported Archon-engine list; "DAG Builder" hosts both
// builders behind an engine toggle (typed default, Pipelines-engine iframe).
const NAVIGATION_ITEMS: ReadonlyArray<{
  view: WorkspaceView;
  label: string;
  icon: typeof MessageSquareTextIcon;
}> = [
  { view: "chat", label: "Chat", icon: MessageSquareTextIcon },
  { view: "workflows", label: "Workflows", icon: WorkflowIcon },
  { view: "dag-workflows", label: "DAG Workflows", icon: ListTreeIcon },
  { view: "dag-pipelines", label: "DAG Pipelines", icon: LayersIcon },
  { view: "dag-builder", label: "DAG Builder", icon: NetworkIcon },
  { view: "console", label: "Console", icon: TerminalSquareIcon },
  { view: "raindrop", label: "Raindrop", icon: BracesIcon },
];

export function WorkspaceNavigation({
  view,
  onChange,
}: {
  view: WorkspaceView;
  onChange: (view: WorkspaceView) => void;
}) {
  return (
    <nav
      aria-label="Project workspace"
      className="flex shrink-0 items-center gap-1 overflow-x-auto border-b bg-muted/20 px-3 py-1.5 font-mono"
    >
      {NAVIGATION_ITEMS.map((item) => {
        const Icon = item.icon;
        const selected = view === item.view;
        return (
          <button
            key={item.view}
            type="button"
            onClick={() => onChange(item.view)}
            aria-current={selected ? "page" : undefined}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
              selected
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" />
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}
