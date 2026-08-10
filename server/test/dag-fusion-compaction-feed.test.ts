import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_DELEGATION_RESPONSE_EVENT } from "pi-subagents/delegation";
import {
  createDagFusionWorkflowSessionBridge,
  installDagFusionCompactionEventSink,
} from "../src/agent/dag-fusion-bridge.ts";

const queueRoots: string[] = [];

afterEach(() => {
  for (const root of queueRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function queueRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "compaction-feed-"));
  queueRoots.push(root);
  return root;
}

function compactionResponse() {
  return {
    requestId: "request-feed",
    ownerRunId: "wrun_11111111111111111111111111111111",
    nodeId: "analysis",
    runId: "child-feed-run",
    status: "completed",
  };
}

function queueEventInChild(root: string): Promise<void> {
  const moduleUrl = pathToFileURL(
    path.join(process.cwd(), "src", "agent", "dag-fusion-bridge.ts"),
  ).href;
  const script = `
    import fs from "node:fs";
    import {
      createDagFusionWorkflowSessionBridge,
      installDagFusionCompactionEventSink,
    } from ${JSON.stringify(moduleUrl)};
    const handlers = new Map();
    const lifecycle = new Map();
    const events = {
      on(channel, handler) {
        const values = handlers.get(channel) ?? new Set();
        values.add(handler);
        handlers.set(channel, values);
        return () => values.delete(handler);
      },
      emit(channel, value) {
        for (const handler of handlers.get(channel) ?? []) handler(value);
      },
    };
    const remove = installDagFusionCompactionEventSink(
      async () => { throw new Error("child process stopped"); },
      {
        queueRoot: ${JSON.stringify(root)},
        retryBaseMs: 30_000,
        retryMaxMs: 30_000,
      },
    );
    const bridge = createDagFusionWorkflowSessionBridge();
    await bridge.extension.factory({
      events,
      on(event, handler) { lifecycle.set(event, handler); },
    });
    events.emit("prompt-template:subagent:response", ${JSON.stringify(compactionResponse())});
    const deadline = Date.now() + 10_000;
    let queued = false;
    while (Date.now() < deadline) {
      const file = fs.readdirSync(${JSON.stringify(root)}).find((name) => name.endsWith(".json"));
      if (file) {
        const record = JSON.parse(fs.readFileSync(${JSON.stringify(root)} + "/" + file, "utf8"));
        if (record.attempts === 1) {
          queued = true;
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (!queued) throw new Error("child did not persist the failed delivery");
    remove();
    await lifecycle.get("session_shutdown")?.();
    await bridge.dispose();
    process.stdout.write("QUEUED\\n");
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0 && stdout.includes("QUEUED")) resolve();
      else reject(new Error(`Queue child exited ${String(code)}: ${stderr}`));
    });
  });
}

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
    const removeSink = installDagFusionCompactionEventSink(sink, {
      queueRoot: queueRoot(),
    });
    const bridge = createDagFusionWorkflowSessionBridge();
    try {
      await bridge.extension.factory(pi);
      events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, compactionResponse());
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

  it("retries a transient sink failure with the queued event intact", async () => {
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
    const root = queueRoot();
    const sink = vi.fn()
      .mockRejectedValueOnce(new Error("transient watcher failure"))
      .mockResolvedValue(undefined);
    const removeSink = installDagFusionCompactionEventSink(sink, {
      queueRoot: root,
      retryBaseMs: 5,
      retryMaxMs: 10,
    });
    const bridge = createDagFusionWorkflowSessionBridge();
    try {
      await bridge.extension.factory(pi);
      events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, compactionResponse());
      await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(2));
      expect(fs.readdirSync(root).filter((name) => name.endsWith(".json"))).toEqual([]);
    } finally {
      removeSink();
      await lifecycleHandlers.get("session_shutdown")?.();
      await bridge.dispose();
    }
  });

  it("drains a previously queued event when a new process registration boots", async () => {
    const root = queueRoot();
    await queueEventInChild(root);
    expect(fs.readdirSync(root).filter((name) => name.endsWith(".json"))).toHaveLength(1);

    const restartedSink = vi.fn().mockResolvedValue(undefined);
    const removeRestartedSink = installDagFusionCompactionEventSink(restartedSink, {
      queueRoot: root,
    });
    try {
      await vi.waitFor(() => expect(restartedSink).toHaveBeenCalledWith({
        ownerRunId: "wrun_11111111111111111111111111111111",
        nodeId: "analysis",
        childRunId: "child-feed-run",
      }));
      expect(fs.readdirSync(root).filter((name) => name.endsWith(".json"))).toEqual([]);
    } finally {
      removeRestartedSink();
    }
  });
});
