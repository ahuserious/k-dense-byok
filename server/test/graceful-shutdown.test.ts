import { describe, expect, it, vi } from "vitest";
import {
  createGracefulShutdownCoordinator,
  type GracefulShutdownRuntime,
} from "../src/graceful-shutdown.ts";

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
} {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: Error) => void;
  return {
    promise: new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    }),
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

function fakeRuntime() {
  const exit = vi.fn();
  const clearKeepAlive = vi.fn();
  const keepAliveHandle = {} as ReturnType<typeof setInterval>;
  const setKeepAlive = vi.fn(() => keepAliveHandle);
  const runtime: GracefulShutdownRuntime = {
    setKeepAlive,
    clearKeepAlive,
    exit,
  };
  return { runtime, exit, setKeepAlive, clearKeepAlive, keepAliveHandle };
}

describe("production graceful shutdown coordinator", () => {
  it("keeps ownership alive and never exits before app.close resolves", async () => {
    const closing = deferred();
    const runtime = fakeRuntime();
    const events: string[] = [];
    const coordinator = createGracefulShutdownCoordinator({
      close: vi.fn(() => closing.promise),
      onStart: () => events.push("start"),
      onComplete: () => events.push("complete"),
      onRefused: () => events.push("refused"),
      onRepeated: () => events.push("repeated"),
      onForced: () => events.push("forced"),
      runtime: runtime.runtime,
    });

    coordinator.request("SIGTERM");
    await Promise.resolve();
    expect(coordinator.state()).toBe("closing");
    expect(runtime.setKeepAlive).toHaveBeenCalledOnce();
    expect(runtime.exit).not.toHaveBeenCalled();

    closing.resolve();
    await vi.waitFor(() => expect(runtime.exit).toHaveBeenCalledWith(0));
    expect(events).toEqual(["start", "complete"]);
    expect(runtime.clearKeepAlive).toHaveBeenCalledWith(runtime.keepAliveHandle);
  });

  it("visibly refuses a failed close and coalesces duplicate signal or IPC delivery", async () => {
    const runtime = fakeRuntime();
    const refused = new Error("hosted Fusion provider is still quarantined");
    const onRefused = vi.fn();
    const onRepeated = vi.fn();
    const coordinator = createGracefulShutdownCoordinator({
      close: vi.fn(async () => { throw refused; }),
      onStart: vi.fn(),
      onComplete: vi.fn(),
      onRefused,
      onRepeated,
      onForced: vi.fn(),
      runtime: runtime.runtime,
    });

    coordinator.request("launcher-ipc");
    await vi.waitFor(() => expect(coordinator.state()).toBe("refused"));
    expect(onRefused).toHaveBeenCalledWith("launcher-ipc", refused);
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(runtime.clearKeepAlive).not.toHaveBeenCalled();

    coordinator.request("SIGINT");
    expect(onRepeated).toHaveBeenCalledWith("SIGINT");
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(runtime.clearKeepAlive).not.toHaveBeenCalled();
  });

  it("uses a second standalone signal as the explicit unsafe escape hatch", async () => {
    const closing = deferred();
    const runtime = fakeRuntime();
    const onForced = vi.fn();
    const coordinator = createGracefulShutdownCoordinator({
      close: () => closing.promise,
      onStart: vi.fn(),
      onComplete: vi.fn(),
      onRefused: vi.fn(),
      onRepeated: vi.fn(),
      onForced,
      forceOnRepeated: true,
      runtime: runtime.runtime,
    });

    coordinator.request("SIGTERM");
    await Promise.resolve();
    coordinator.request("SIGINT");

    expect(onForced).toHaveBeenCalledWith("SIGINT");
    expect(runtime.clearKeepAlive).toHaveBeenCalledOnce();
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
