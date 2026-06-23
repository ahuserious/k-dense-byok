// danbot-byok — web/src/components/top-nav-bar.tsx
//
// The primary top navigation row: one tab per top-level surface. "Chat" is first;
// the rest are the agent surfaces. This row replaces the old right-cluster pills that
// lived inside the chat-tabs bar — the chat-tabs strip now lives below (chat view only),
// freeing horizontal room for many chat tabs.
//
// Styled as an "agent surface": monospace, Raindrop-ish. The active tab gets a subtle
// filled treatment.

"use client";

import {
  DropletIcon,
  GaugeIcon,
  LayersIcon,
  MessageSquareTextIcon,
  NetworkIcon,
  WorkflowIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type AppView =
  | "chat"
  | "workflows"
  | "pipelines"
  | "dag-builder"
  | "console"
  | "raindrop";

const TABS: { id: AppView; label: string; icon: typeof WorkflowIcon }[] = [
  { id: "chat", label: "Chat", icon: MessageSquareTextIcon },
  { id: "workflows", label: "Workflows", icon: WorkflowIcon },
  { id: "pipelines", label: "DAG Pipelines", icon: LayersIcon },
  { id: "dag-builder", label: "DAG Builder", icon: NetworkIcon },
  { id: "console", label: "Console", icon: GaugeIcon },
  { id: "raindrop", label: "Raindrop", icon: DropletIcon },
];

export function TopNavBar({
  view,
  onSelect,
}: {
  view: AppView;
  onSelect: (view: AppView) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 border-b px-3 py-1.5 font-mono">
      {TABS.map((tab) => {
        const Icon = tab.icon;
        const active = view === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onSelect(tab.id)}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              active
                ? "bg-foreground/10 text-foreground"
                : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" />
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
