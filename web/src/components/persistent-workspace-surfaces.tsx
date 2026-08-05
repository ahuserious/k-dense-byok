"use client";

import { useCallback, useState, type ReactNode } from "react";

import type { WorkspaceView } from "@/lib/workspace-persistence";

export type PersistentWorkspaceSurfaceView = Exclude<WorkspaceView, "chat">;

const PERSISTENT_WORKSPACE_SURFACE_VIEWS = [
  "workflows",
  "dag-workflows",
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
            ? "flex h-full min-h-0 w-full overflow-hidden"
            : "hidden"
        }
      >
        {surfaces[surfaceView]}
      </div>
    );
  });
}
