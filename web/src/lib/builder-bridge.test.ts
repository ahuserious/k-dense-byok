import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BUILDER_BRIDGE_MAX_PAYLOAD_BYTES,
  BUILDER_BRIDGE_VERSION,
  builderOrigin,
  createBuilderHostBridge,
  decodeBridgeMessage,
  encodeBridgeMessage,
  isBuilderBridgeEnvelope,
  withHostModeParam,
  type BuilderBridgeEnvelope,
  type BuilderBridgeStatus,
} from "@/lib/builder-bridge";

const FRAME_ORIGIN = "http://127.0.0.1:13391";

/** A minimal host window that records listeners so tests can post into them. */
function fakeHostWindow() {
  const listeners = new Set<(event: MessageEvent) => void>();
  return {
    listeners,
    addEventListener: (type: string, listener: EventListener) => {
      if (type === "message") listeners.add(listener as (event: MessageEvent) => void);
    },
    removeEventListener: (type: string, listener: EventListener) => {
      if (type === "message") listeners.delete(listener as (event: MessageEvent) => void);
    },
    deliver(event: Partial<MessageEvent>) {
      for (const listener of listeners) listener(event as MessageEvent);
    },
  };
}

function frameEnvelope(type: string, payload: unknown = {}): string {
  return JSON.stringify({ v: BUILDER_BRIDGE_VERSION, id: "frame-1", type, payload });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("envelope encoding", () => {
  it("accepts a well-formed envelope and rejects malformed ones", () => {
    expect(isBuilderBridgeEnvelope({ v: 1, id: "a", type: "builder.ready", payload: {} })).toBe(true);
    expect(isBuilderBridgeEnvelope({ v: 2, id: "a", type: "builder.ready", payload: {} })).toBe(false);
    expect(isBuilderBridgeEnvelope({ v: 1, id: "", type: "builder.ready", payload: {} })).toBe(false);
    expect(isBuilderBridgeEnvelope({ v: 1, id: "a", type: "builder.ready" })).toBe(false);
    expect(isBuilderBridgeEnvelope("builder.ready")).toBe(false);
    expect(isBuilderBridgeEnvelope(null)).toBe(false);
  });

  it("refuses to serialize a payload over the 1 MiB cap", () => {
    const envelope: BuilderBridgeEnvelope = {
      v: BUILDER_BRIDGE_VERSION,
      id: "host-1",
      type: "builder.loadGraph",
      payload: { blob: "x".repeat(BUILDER_BRIDGE_MAX_PAYLOAD_BYTES) },
    };

    expect(() => encodeBridgeMessage(envelope)).toThrow(/over the 1048576-byte cap/);
  });

  it("drops an oversized, non-string, or unparseable inbound message", () => {
    expect(decodeBridgeMessage("x".repeat(BUILDER_BRIDGE_MAX_PAYLOAD_BYTES + 1))).toBeNull();
    expect(decodeBridgeMessage({ v: 1, id: "a", type: "builder.ready", payload: {} })).toBeNull();
    expect(decodeBridgeMessage("{ not json")).toBeNull();
    expect(decodeBridgeMessage(frameEnvelope("builder.ready"))).toMatchObject({
      type: "builder.ready",
    });
  });
});

describe("createBuilderHostBridge", () => {
  function setup(options: { readyTimeoutMs?: number } = {}) {
    const host = fakeHostWindow();
    const frame = { postMessage: vi.fn() };
    const received: BuilderBridgeEnvelope[] = [];
    const statuses: BuilderBridgeStatus[] = [];
    const bridge = createBuilderHostBridge({
      targetOrigin: FRAME_ORIGIN,
      frameWindow: () => frame as unknown as Window,
      onMessage: (envelope) => received.push(envelope),
      onStatusChange: (status) => statuses.push(status),
      hostWindow: host,
      ...options,
    });
    return { host, frame, received, statuses, bridge };
  }

  it("posts to the exact frame origin, never a wildcard", () => {
    const { frame, bridge } = setup();

    expect(bridge.post("builder.init", { mode: "typed" })).toBe(true);

    expect(frame.postMessage).toHaveBeenCalledTimes(1);
    const [message, origin] = frame.postMessage.mock.calls[0];
    expect(origin).toBe(FRAME_ORIGIN);
    expect(JSON.parse(message as string)).toMatchObject({
      v: BUILDER_BRIDGE_VERSION,
      type: "builder.init",
      payload: { mode: "typed" },
    });
  });

  it("returns false instead of throwing when a payload is over the cap", () => {
    const { frame, bridge } = setup();

    expect(
      bridge.post("builder.loadGraph", { blob: "x".repeat(BUILDER_BRIDGE_MAX_PAYLOAD_BYTES) }),
    ).toBe(false);
    expect(frame.postMessage).not.toHaveBeenCalled();
  });

  it("accepts a ready message from the mounted frame and reports connected", () => {
    const { host, frame, received, statuses, bridge } = setup();

    host.deliver({ origin: FRAME_ORIGIN, source: frame as unknown as Window, data: frameEnvelope("builder.ready") });

    expect(bridge.status()).toBe("connected");
    expect(statuses).toEqual(["connected"]);
    expect(received.map((envelope) => envelope.type)).toEqual(["builder.ready"]);
  });

  it("ignores messages from another origin, another window, and unknown types", () => {
    const { host, frame, received, bridge } = setup();
    const otherWindow = { postMessage: vi.fn() } as unknown as Window;

    host.deliver({ origin: "http://evil.example", source: frame as unknown as Window, data: frameEnvelope("builder.ready") });
    host.deliver({ origin: FRAME_ORIGIN, source: otherWindow, data: frameEnvelope("builder.ready") });
    host.deliver({ origin: FRAME_ORIGIN, source: frame as unknown as Window, data: frameEnvelope("builder.init") });
    host.deliver({ origin: FRAME_ORIGIN, source: frame as unknown as Window, data: frameEnvelope("builder.somethingNew") });

    expect(received).toEqual([]);
    expect(bridge.status()).toBe("connecting");
  });

  it("carries the engine-pipeline request out and the detach notice back", () => {
    const { host, frame, received, bridge } = setup();

    expect(bridge.post("builder.loadEnginePipeline", { workflowId: "legacy-yaml" })).toBe(true);
    expect(JSON.parse(frame.postMessage.mock.calls[0][0] as string)).toMatchObject({
      type: "builder.loadEnginePipeline",
      payload: { workflowId: "legacy-yaml" },
    });

    // The detach notice is what stops the host diffing an engine graph against
    // its typed document, so it has to survive the accepted-type filter.
    host.deliver({
      origin: FRAME_ORIGIN,
      source: frame as unknown as Window,
      data: frameEnvelope("builder.canvasDetached"),
    });

    expect(received.map((envelope) => envelope.type)).toEqual(["builder.canvasDetached"]);
  });

  it("reports a timeout when ready never arrives, and stops reporting once connected", () => {
    const first = setup({ readyTimeoutMs: 5_000 });
    vi.advanceTimersByTime(5_000);
    expect(first.bridge.status()).toBe("timeout");
    expect(first.statuses).toEqual(["timeout"]);

    const second = setup({ readyTimeoutMs: 5_000 });
    second.host.deliver({
      origin: FRAME_ORIGIN,
      source: second.frame as unknown as Window,
      data: frameEnvelope("builder.ready"),
    });
    vi.advanceTimersByTime(10_000);
    expect(second.bridge.status()).toBe("connected");
    expect(second.statuses).toEqual(["connected"]);
  });

  it("re-arms the ready timer on reset, for an iframe that navigates", () => {
    const { host, frame, bridge, statuses } = setup({ readyTimeoutMs: 5_000 });
    host.deliver({ origin: FRAME_ORIGIN, source: frame as unknown as Window, data: frameEnvelope("builder.ready") });
    expect(bridge.status()).toBe("connected");

    bridge.reset();
    expect(bridge.status()).toBe("connecting");
    vi.advanceTimersByTime(5_000);

    expect(bridge.status()).toBe("timeout");
    expect(statuses).toEqual(["connected", "connecting", "timeout"]);
  });

  it("stops listening and refuses to post after dispose", () => {
    const { host, frame, received, bridge } = setup();

    bridge.dispose();
    host.deliver({ origin: FRAME_ORIGIN, source: frame as unknown as Window, data: frameEnvelope("builder.ready") });

    expect(received).toEqual([]);
    expect(bridge.post("builder.init", {})).toBe(false);
    expect(bridge.status()).toBe("closed");
    expect(host.listeners.size).toBe(0);
  });

  it("does not fire a timeout after dispose", () => {
    const { bridge, statuses } = setup({ readyTimeoutMs: 5_000 });

    bridge.dispose();
    vi.advanceTimersByTime(10_000);

    expect(statuses).toEqual(["closed"]);
  });
});

describe("builder URL helpers", () => {
  it("adds host mode and the host origin without disturbing an existing query or fragment", () => {
    expect(withHostModeParam("http://x/legacy/workflows/builder", "http://kady.test")).toBe(
      "http://x/legacy/workflows/builder?host=kady&hostOrigin=http%3A%2F%2Fkady.test",
    );
    expect(withHostModeParam("http://x/builder?edit=a&codebaseId=b", "http://kady.test")).toBe(
      "http://x/builder?edit=a&codebaseId=b&host=kady&hostOrigin=http%3A%2F%2Fkady.test",
    );
    expect(withHostModeParam("http://x/builder?host=other#frag", "http://kady.test")).toBe(
      "http://x/builder?host=kady&hostOrigin=http%3A%2F%2Fkady.test#frag",
    );
  });

  it("falls back to the page origin when no host origin is given", () => {
    expect(withHostModeParam("http://x/builder")).toContain(
      `hostOrigin=${encodeURIComponent(window.location.origin)}`,
    );
  });

  it("reads the origin a builder URL will load on", () => {
    expect(builderOrigin("http://127.0.0.1:13391/legacy/workflows/builder")).toBe(FRAME_ORIGIN);
    // A relative builder URL resolves against the page, which is what the
    // same-origin dev setup produces.
    expect(builderOrigin("/legacy/workflows/builder")).toBe(window.location.origin);
  });
});
