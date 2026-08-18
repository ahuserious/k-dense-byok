// danbot-byok — web/src/components/builder/builder-host-context.tsx
//
// How the Kady host reaches the iframe it does not render.
//
// `DagBuilderSurface` owns the typed document and the bridge, but the <iframe>
// itself is mounted several levels down by `EngineIframePanel` (via
// `PipelineBuilderPanel`, which is another lane's file and stays untouched).
// Passing the bridge down as props would mean editing every component in
// between; a context lets exactly two files know about it and leaves the
// Raindrop embed — which mounts the same panel with no provider — behaving
// precisely as before.

"use client";

import { createContext, useContext } from "react";

export interface BuilderHostAttachment {
  /** Rewrite the iframe URL for host mode (adds `?host=kady`). */
  decorateSrc: (source: string) => string;
  /** Callback ref for the mounted iframe. Must be stable across renders. */
  attachFrame: (frame: HTMLIFrameElement | null) => void;
  /** The iframe fired `load`: a fresh document is about to announce itself. */
  onFrameLoad: () => void;
}

const BuilderHostContext = createContext<BuilderHostAttachment | null>(null);

export const BuilderHostProvider = BuilderHostContext.Provider;

/** Null everywhere except inside the DAG Builder surface. */
export function useBuilderHostAttachment(): BuilderHostAttachment | null {
  return useContext(BuilderHostContext);
}
