import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_DELEGATION_RESPONSE_EVENT } from "pi-subagents/delegation";
import {
  createDagFusionWorkflowSessionBridge,
  installDagFusionCompactionEventSink,
} from "../src/agent/dag-fusion-bridge.ts";

describe("DAG Fusion production compaction feed hook", () => {
  it("forwards the exact terminal child identity to the registered server sink", async () => {
    const eventHandlers = new Map<string, Set<(value: unknown) => void>>();
    const lifecycleHandlers = new Map<string, () => void | Promise<void>>();
    const events = {
      on(channel: string, handler: (value: unknown) => void) {
        const handlers = eventHandlers.get(channel) ?? new Set();
        handlers.add(handler);
        eventHandlers.set(channel, handlers);
        return () => handlers.delete(handler);
      },
      emit(channel: string, value: unknown) {
        for (const handler of eventHandlers.get(channel) ?? []) handler(value);
      },
    };
    const pi = {
      events,
      on(event: string, handler: () => void | Promise<void>) {
        lifecycleHandlers.set(event, handler);
      },
    } as unknown as ExtensionAPI;
    const sink = vi.fn().mockResolvedValue(undefined);
    const removeSink = installDagFusionCompactionEventSink(sink);
    const bridge = createDagFusionWorkflowSessionBridge();
    try {
      await bridge.extension.factory(pi);
      events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        requestId: "request-feed",
        ownerRunId: "wrun_11111111111111111111111111111111",
        nodeId: "analysis",
        runId: "child-feed-run",
        status: "completed",
      });
      await vi.waitFor(() => expect(sink).toHaveBeenCalledWith({
        ownerRunId: "wrun_11111111111111111111111111111111",
        nodeId: "analysis",
        childRunId: "child-feed-run",
      }));
    } finally {
      removeSink();
      await lifecycleHandlers.get("session_shutdown")?.();
      await bridge.dispose();
    }
  });
});
