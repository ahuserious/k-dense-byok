"use client";

import { useCallback, useState, type ReactNode } from "react";

import type { WorkspaceView } from "@/lib/workspace-persistence";

export type PersistentWorkspaceSurfaceView = Exclude<WorkspaceView, "chat">;

const PERSISTENT_WORKSPACE_SURFACE_VIEWS = [
  "workflows",
  "scientific-pipelines",
  "dag-builder",
  "console",
  "raindrop",
] as const satisfies ReadonlyArray<PersistentWorkspaceSurfaceView>;

interface PersistentWorkspaceViewState {
  activeView: WorkspaceView;
  mountedViews: ReadonlySet<PersistentWorkspaceSurfaceView>;
}

export function usePersistentWorkspaceView(initialView: WorkspaceView) {
  const [state, setState] = useState<PersistentWorkspaceViewState>(() => ({
    activeView: initialView,
    mountedViews:
      initialView === "chat"
        ? new Set()
        : new Set<PersistentWorkspaceSurfaceView>([initialView]),
  }));

  const setActiveView = useCallback((nextView: WorkspaceView) => {
    setState((current) => {
      if (current.activeView === nextView) return current;
      if (nextView === "chat" || current.mountedViews.has(nextView)) {
        return { ...current, activeView: nextView };
      }
      const mountedViews = new Set(current.mountedViews);
      mountedViews.add(nextView);
      return { activeView: nextView, mountedViews };
    });
  }, []);

  return {
    activeView: state.activeView,
    mountedViews: state.mountedViews,
    setActiveView,
  };
}

export function PersistentWorkspaceSurfaces({
  activeView,
  mountedViews,
  surfaces,
}: {
  activeView: WorkspaceView;
  mountedViews: ReadonlySet<PersistentWorkspaceSurfaceView>;
  surfaces: Record<PersistentWorkspaceSurfaceView, ReactNode>;
}) {
  return PERSISTENT_WORKSPACE_SURFACE_VIEWS.map((surfaceView) => {
    const isVisible = activeView === surfaceView;
    if (!isVisible && !mountedViews.has(surfaceView)) return null;

    return (
      <div
        key={surfaceView}
        data-workspace-surface={surfaceView}
        aria-hidden={!isVisible}
        className={
          isVisible
            // `min-w-0`/`max-w-full` on the wrapper AND on its direct child are
            // both required: a flex item keeps `min-width: auto`, so without
            // them a wide descendant (a long `<pre>` line, a category chip
            // strip) sizes the pane to its content instead of to the viewport,
            // and the `overflow-hidden` here then clips every right-aligned
            // control with no scroller to reach it. The child rule is applied
            // from here because `surfaces` is arbitrary caller-owned JSX.
            ? "flex h-full min-h-0 w-full min-w-0 max-w-full overflow-hidden [&>*]:min-w-0 [&>*]:max-w-full"
            : "hidden"
        }
      >
        {surfaces[surfaceView]}
      </div>
    );
  });
}
