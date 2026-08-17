"use client";

import {
  BracesIcon,
  LayersIcon,
  MessageSquareTextIcon,
  NetworkIcon,
  TerminalSquareIcon,
  WorkflowIcon,
} from "lucide-react";
import { forwardRef, useImperativeHandle, useRef } from "react";

import type { WorkspaceView } from "@/lib/workspace-persistence";
import { cn } from "@/lib/utils";

const NAVIGATION_ITEMS: ReadonlyArray<{
  view: WorkspaceView;
  label: string;
  icon: typeof MessageSquareTextIcon;
}> = [
  { view: "chat", label: "Chat", icon: MessageSquareTextIcon },
  { view: "workflows", label: "Workflows", icon: WorkflowIcon },
  { view: "scientific-pipelines", label: "Scientific Pipelines", icon: LayersIcon },
  { view: "dag-builder", label: "Builder", icon: NetworkIcon },
  { view: "console", label: "Console", icon: TerminalSquareIcon },
  { view: "raindrop", label: "Raindrop", icon: BracesIcon },
];

/**
 * Imperative handle so the shell can hand the keyboard over to this nav.
 * Entering a project from the picker otherwise leaves `document.activeElement`
 * on `<body>` — the activated card unmounts and nothing claims the caret — and
 * a keyboard user has to Tab from the top of the document again.
 */
export type WorkspaceNavigationHandle = {
  focusFirst: () => void;
};

export const WorkspaceNavigation = forwardRef<
  WorkspaceNavigationHandle,
  {
    view: WorkspaceView;
    onChange: (view: WorkspaceView) => void;
  }
>(function WorkspaceNavigation({ view, onChange }, ref) {
  const firstControlRef = useRef<HTMLButtonElement | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      focusFirst() {
        // preventScroll: the caller moves focus during a screen change, and a
        // scroll-into-view there would jump a layout the user has not seen yet.
        firstControlRef.current?.focus({ preventScroll: true });
      },
    }),
    [],
  );

  return (
    <nav
      aria-label="Project workspace"
      className="flex shrink-0 items-center gap-1 overflow-x-auto border-b bg-muted/20 px-3 py-1.5 font-mono"
    >
      {NAVIGATION_ITEMS.map((item, index) => {
        const Icon = item.icon;
        const selected = view === item.view;
        return (
          <button
            key={item.view}
            ref={index === 0 ? firstControlRef : undefined}
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
});
