// danbot-byok — web/src/lib/builder-bridge.ts
//
// The Kady half of the host ↔ vendored-builder postMessage bridge.
//
// The vendored builder runs on its own origin (the engine sidecar), so the two
// halves cannot share a module. The wire contract below is duplicated in
// server/vendor/pipeline-engine/packages/web/src/host/HostBridge.ts and the two
// copies MUST be edited together; `BUILDER_BRIDGE_VERSION` is the tripwire — an
// envelope with an unknown `v` is dropped rather than guessed at.
//
// Security posture:
//   * `targetOrigin` is explicit in both directions. Never `"*"`, never
//     `event.origin`-derived. A message from any other origin, or from a window
//     that is not the frame we mounted, is ignored without a reply.
//   * Payloads are capped at 1 MiB — the same number the validate route
//     enforces — so a document that survives the bridge cannot be rejected by
//     size at the route, and a hostile frame cannot wedge the host with a
//     multi-gigabyte string.
//   * Unknown message types are ignored. New types are additive by
//     construction.
//
// Liveness: if `builder.ready` does not arrive within 5 s the bridge reports
// `timeout`. The surface shows a banner and the legacy builder stays fully
// usable — a bridge failure must never take the existing builder down with it.

export const BUILDER_BRIDGE_VERSION = 1 as const;
export const BUILDER_BRIDGE_MAX_PAYLOAD_BYTES = 1024 * 1024;
export const BUILDER_BRIDGE_READY_TIMEOUT_MS = 5_000;

/** Query flag that puts the vendored builder into host mode. */
export const BUILDER_HOST_PARAM = "host";
export const BUILDER_HOST_VALUE = "kady";
/** Carries the host origin the iframe must post back to. */
export const BUILDER_HOST_ORIGIN_PARAM = "hostOrigin";

export const HOST_TO_FRAME_TYPES = [
  "builder.init",
  "builder.loadGraph",
  "builder.setSourceList",
  "builder.setIssues",
  "builder.applyPatch",
  "builder.setMode",
  // Additive: the Kady picker lists ENGINE pipelines too, and only the iframe
  // can load one — it owns the engine's own document model. The host therefore
  // asks rather than converts. Turning an engine pipeline into a typed document
  // is round 2's import work and deliberately not attempted here.
  "builder.loadEnginePipeline",
] as const;

export const FRAME_TO_HOST_TYPES = [
  "builder.ready",
  "builder.delta",
  "builder.selection",
  "builder.requestSave",
  "builder.requestRun",
  // Additive to the plan's five: a host-fed select is useless if choosing an
  // entry cannot reach the host, and the host — not the iframe — is the only
  // side that can read a typed workflow or a library template.
  "builder.requestSource",
  // RESERVED, WITH NO PRODUCER IN THIS TREE. The host implements the receiving
  // half (`applyDocumentReplacement` in dag-builder-surface.tsx: validate one
  // whole document server-side, apply it as one undoable change), but nothing
  // sends it and nothing can yet: the vendored builder's YAML/Split view is a
  // one-way serializer (`YamlCodeView.tsx` renders into a `<pre>`), so there is
  // no hand-edit for a producer to carry. A YAML or hand-edited document does
  // NOT reach the canvas today. Wiring a producer means an editable YAML
  // surface plus an engine-YAML → typed-document import, which is the import
  // work a later round owns.
  "builder.documentReplaced",
  // The canvas is no longer showing the view the host pushed (the author loaded
  // an engine pipeline into it). Without this the host would diff the engine
  // graph against its typed document and "apply" the difference — which is a
  // silent overwrite of a typed workflow with an unrelated one.
  "builder.canvasDetached",
] as const;

export type HostToFrameType = (typeof HOST_TO_FRAME_TYPES)[number];
export type FrameToHostType = (typeof FRAME_TO_HOST_TYPES)[number];

/** One selectable workflow source rendered by the in-iframe select and the Kady picker. */
export interface BuilderSourceEntry {
  /** Unique across all groups; echoed back verbatim in `builder.requestSource`. */
  id: string;
  label: string;
  description?: string;
  /** Short right-aligned marker, e.g. a node count or a category. */
  badge?: string;
}

export interface BuilderSourceGroup {
  id: "kady-workflows" | "workflows-library" | "engine-pipelines";
  label: string;
  entries: BuilderSourceEntry[];
}

export interface BuilderSourceListPayload {
  groups: BuilderSourceGroup[];
}

export interface BuilderRequestSourcePayload {
  groupId: BuilderSourceGroup["id"];
  entryId: string;
}

export interface BuilderIssue {
  code: string;
  severity: "error" | "warning";
  path: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface BuilderBridgeEnvelope<TPayload = unknown> {
  v: typeof BUILDER_BRIDGE_VERSION;
  id: string;
  type: string;
  payload: TPayload;
}

export type BuilderBridgeStatus = "connecting" | "connected" | "timeout" | "closed";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Shape check only. Whether the TYPE is one this side accepts is a separate
 * decision, so an unexpected-but-well-formed message can be dropped quietly
 * rather than treated as an attack.
 */
export function isBuilderBridgeEnvelope(value: unknown): value is BuilderBridgeEnvelope {
  return (
    isRecord(value)
    && value.v === BUILDER_BRIDGE_VERSION
    && typeof value.id === "string"
    && value.id.length > 0
    && value.id.length <= 128
    && typeof value.type === "string"
    && value.type.length > 0
    && value.type.length <= 64
    && "payload" in value
  );
}

export class BuilderBridgePayloadError extends Error {
  constructor(byteLength: number) {
    super(
      `Builder bridge payload is ${byteLength} bytes, over the ${BUILDER_BRIDGE_MAX_PAYLOAD_BYTES}-byte cap.`,
    );
    this.name = "BuilderBridgePayloadError";
  }
}

/**
 * Serialize an envelope, refusing anything over the cap.
 *
 * Messages cross as JSON STRINGS rather than structured-cloned objects: the cap
 * is only meaningful against a byte length, and a string is what both ends can
 * measure identically.
 */
export function encodeBridgeMessage(envelope: BuilderBridgeEnvelope): string {
  const serialized = JSON.stringify(envelope);
  const byteLength = new TextEncoder().encode(serialized).byteLength;
  if (byteLength > BUILDER_BRIDGE_MAX_PAYLOAD_BYTES) throw new BuilderBridgePayloadError(byteLength);
  return serialized;
}

/** Parse a received message. Returns null for anything that is not ours. */
export function decodeBridgeMessage(data: unknown): BuilderBridgeEnvelope | null {
  if (typeof data !== "string") return null;
  if (new TextEncoder().encode(data).byteLength > BUILDER_BRIDGE_MAX_PAYLOAD_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  return isBuilderBridgeEnvelope(parsed) ? parsed : null;
}

export interface BuilderHostBridgeOptions {
  /** The exact origin of the vendored builder. Compared with `===`. */
  targetOrigin: string;
  /** Resolves the mounted frame's window; null until the iframe mounts. */
  frameWindow: () => Window | null;
  /** Called for every accepted iframe→host envelope. */
  onMessage: (envelope: BuilderBridgeEnvelope) => void;
  onStatusChange?: (status: BuilderBridgeStatus) => void;
  readyTimeoutMs?: number;
  /** Injected for tests; defaults to the ambient window. */
  hostWindow?: Pick<Window, "addEventListener" | "removeEventListener">;
}

export interface BuilderHostBridge {
  post: (type: HostToFrameType, payload: unknown) => boolean;
  status: () => BuilderBridgeStatus;
  /** Restart the ready timer — used when the iframe navigates or reloads. */
  reset: () => void;
  dispose: () => void;
}

const ACCEPTED_FRAME_TYPES: ReadonlySet<string> = new Set<string>(FRAME_TO_HOST_TYPES);

/**
 * Create the host-side bridge.
 *
 * The listener is installed immediately so a fast iframe cannot announce
 * `builder.ready` into a window that is not listening yet.
 */
export function createBuilderHostBridge(options: BuilderHostBridgeOptions): BuilderHostBridge {
  const host = options.hostWindow ?? (typeof window === "undefined" ? null : window);
  const readyTimeoutMs = options.readyTimeoutMs ?? BUILDER_BRIDGE_READY_TIMEOUT_MS;
  let status: BuilderBridgeStatus = "connecting";
  let sequence = 0;
  let readyTimer: ReturnType<typeof setTimeout> | null = null;

  const setStatus = (next: BuilderBridgeStatus): void => {
    if (status === next || status === "closed") return;
    status = next;
    options.onStatusChange?.(next);
  };

  const clearReadyTimer = (): void => {
    if (readyTimer !== null) {
      clearTimeout(readyTimer);
      readyTimer = null;
    }
  };

  const armReadyTimer = (): void => {
    clearReadyTimer();
    readyTimer = setTimeout(() => {
      readyTimer = null;
      if (status === "connecting") setStatus("timeout");
    }, readyTimeoutMs);
  };

  const onWindowMessage = (event: MessageEvent): void => {
    if (event.origin !== options.targetOrigin) return;
    const frame = options.frameWindow();
    // `event.source` identifies the exact window that posted. Origin alone is
    // not enough: any document on the builder origin — including one opened by
    // something else — shares it.
    if (frame === null || event.source !== frame) return;
    const envelope = decodeBridgeMessage(event.data);
    if (envelope === null || !ACCEPTED_FRAME_TYPES.has(envelope.type)) return;
    if (envelope.type === "builder.ready") {
      clearReadyTimer();
      setStatus("connected");
    }
    options.onMessage(envelope);
  };

  host?.addEventListener("message", onWindowMessage as EventListener);
  armReadyTimer();

  return {
    post(type, payload) {
      const frame = options.frameWindow();
      if (frame === null || status === "closed") return false;
      let serialized: string;
      try {
        sequence += 1;
        serialized = encodeBridgeMessage({
          v: BUILDER_BRIDGE_VERSION,
          id: `host-${sequence}`,
          type,
          payload,
        });
      } catch {
        // Over the cap, or not serializable. The caller decides what to show;
        // the bridge does not throw into a React render or a message handler.
        return false;
      }
      frame.postMessage(serialized, options.targetOrigin);
      return true;
    },
    status: () => status,
    reset() {
      if (status === "closed") return;
      status = "connecting";
      options.onStatusChange?.("connecting");
      armReadyTimer();
    },
    dispose() {
      clearReadyTimer();
      host?.removeEventListener("message", onWindowMessage as EventListener);
      status = "closed";
      options.onStatusChange?.("closed");
    },
  };
}

/**
 * Append the host-mode flags to a builder URL without disturbing its other query.
 *
 * `hostOrigin` travels in the URL because the iframe has no other way to learn
 * the exact origin it must `postMessage` to — `document.referrer` is subject to
 * referrer policy and `"*"` is not acceptable. It is not a capability: a page
 * that embeds the builder with its own origin here receives only the view model
 * it itself supplied, because the builder in host mode fetches no Kady data.
 */
export function withHostModeParam(source: string, hostOrigin?: string): string {
  const origin = hostOrigin
    ?? (typeof window === "undefined" ? undefined : window.location.origin);
  const [base, fragment] = source.split("#", 2);
  const [path, query = ""] = base.split("?", 2);
  const params = new URLSearchParams(query);
  params.set(BUILDER_HOST_PARAM, BUILDER_HOST_VALUE);
  if (origin) params.set(BUILDER_HOST_ORIGIN_PARAM, origin);
  const rebuilt = `${path}?${params.toString()}`;
  return fragment === undefined ? rebuilt : `${rebuilt}#${fragment}`;
}

/** The origin a builder URL will load on, or null when it is not absolute. */
export function builderOrigin(source: string): string | null {
  try {
    return new URL(source, typeof window === "undefined" ? undefined : window.location.href).origin;
  } catch {
    return null;
  }
}
