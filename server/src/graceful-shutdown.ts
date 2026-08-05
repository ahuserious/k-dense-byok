export type GracefulShutdownReason = NodeJS.Signals | "launcher-ipc";

export interface GracefulShutdownRuntime {
  setKeepAlive(callback: () => void, intervalMs: number): ReturnType<typeof setInterval>;
  clearKeepAlive(handle: ReturnType<typeof setInterval>): void;
  exit(code: number): void;
}

export interface GracefulShutdownCoordinatorOptions {
  close(): Promise<void>;
  onStart(reason: GracefulShutdownReason): void;
  onComplete(reason: GracefulShutdownReason): void;
  onRefused(reason: GracefulShutdownReason, error: unknown): void;
  onRepeated(reason: GracefulShutdownReason): void;
  onForced(reason: GracefulShutdownReason): void;
  forceOnRepeated?: boolean;
  runtime?: GracefulShutdownRuntime;
}

export type GracefulShutdownState = "idle" | "closing" | "refused" | "complete";

export interface GracefulShutdownCoordinator {
  request(reason: GracefulShutdownReason): void;
  state(): GracefulShutdownState;
}

const productionRuntime: GracefulShutdownRuntime = {
  setKeepAlive: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearKeepAlive: (handle) => clearInterval(handle),
  exit: (code) => process.exit(code),
};

/**
 * The backend only performs graceful close. Duplicate signal/IPC deliveries
 * coalesce here because Windows can deliver the console signal as well as the
 * launcher's IPC request. The parent launcher owns the separate explicit
 * second-signal force action.
 */
export function createGracefulShutdownCoordinator(
  options: GracefulShutdownCoordinatorOptions,
): GracefulShutdownCoordinator {
  const runtime = options.runtime ?? productionRuntime;
  let currentState: GracefulShutdownState = "idle";
  let keepAlive: ReturnType<typeof setInterval> | undefined;

  const clearKeepAlive = () => {
    if (!keepAlive) return;
    runtime.clearKeepAlive(keepAlive);
    keepAlive = undefined;
  };

  return {
    request(reason) {
      if (currentState !== "idle") {
        if (options.forceOnRepeated) {
          options.onForced(reason);
          clearKeepAlive();
          runtime.exit(1);
          return;
        }
        options.onRepeated(reason);
        return;
      }

      currentState = "closing";
      // Awaiting a never-settling provider promise does not itself keep Node's
      // event loop alive. This referenced timer preserves the exact owner until
      // graceful close succeeds or the user explicitly signals a second time.
      keepAlive = runtime.setKeepAlive(() => undefined, 1_000);
      options.onStart(reason);
      void Promise.resolve()
        .then(() => options.close())
        .then(() => {
          currentState = "complete";
          clearKeepAlive();
          options.onComplete(reason);
          runtime.exit(0);
        })
        .catch((error: unknown) => {
          currentState = "refused";
          options.onRefused(reason, error);
          // Keep the process and retained provider/session owner alive. Only
          // the parent launcher may perform an explicit unsafe force-exit.
        });
    },
    state: () => currentState,
  };
}
