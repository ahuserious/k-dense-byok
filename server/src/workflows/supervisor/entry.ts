/** Detached owner for workflow Pi and hosted-Fusion attempts. */
import "../../env.ts";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configureHttpProxy } from "../../http-proxy.ts";
import { WORKFLOW_SUPERVISOR_PROTOCOL_VERSION } from "./protocol.ts";
import {
  WORKFLOW_SUPERVISOR_RUNTIME_VERSION,
  assertPrivateWorkflowSupervisorSocketDirectory,
  assertPrivateWorkflowSupervisorStateDirectory,
  removeWorkflowSupervisorRuntimeStateIfOwned,
  workflowSupervisorRepositoryDigest,
  workflowSupervisorRuntimePaths,
  writeWorkflowSupervisorRuntimeState,
  type WorkflowSupervisorRuntimeStateV1,
} from "./runtime.ts";

function workflowSupervisorLaunchToken(): string {
  const supplied = process.env.KADY_WORKFLOW_SUPERVISOR_TOKEN;
  if (supplied === undefined) return crypto.randomBytes(32).toString("hex");
  if (!/^[a-f0-9]{64}$/.test(supplied)) {
    throw new Error("Workflow supervisor launch token is malformed.");
  }
  return supplied;
}

function internalShutdownEpoch(): number {
  // Wall-clock milliseconds are positive safe integers for centuries. A
  // detached supervisor with no live control socket may attach this private
  // epoch solely to drain the prior owner before handling an OS signal.
  return Math.max(1, Date.now());
}

export async function runWorkflowSupervisorEntrypoint(): Promise<void> {
  process.title = "kady-workflow-supervisor";
  const launchToken = workflowSupervisorLaunchToken();
  configureHttpProxy();
  // Coordinator evaluation reaches Pi's model/session runtime. Load it only
  // after installing the proxy dispatcher so no provider-capable module can
  // capture or use the unconfigured global fetch path during ESM evaluation.
  const [
    { WorkflowSupervisorCoordinator },
    { WorkflowSupervisorJournal },
    { createWorkflowSupervisorSocketServer },
  ] = await Promise.all([
    import("./coordinator.ts"),
    import("./journal.ts"),
    import("./server.ts"),
  ]);

  const paths = workflowSupervisorRuntimePaths();
  assertPrivateWorkflowSupervisorStateDirectory(paths, { create: true });
  assertPrivateWorkflowSupervisorSocketDirectory(paths, { create: true });

  const journal = new WorkflowSupervisorJournal({
    stateDirectory: path.join(paths.stateDir, "operations"),
  });
  const coordinator = new WorkflowSupervisorCoordinator({ journal });
  const runtimeState: WorkflowSupervisorRuntimeStateV1 = {
    version: WORKFLOW_SUPERVISOR_RUNTIME_VERSION,
    protocolVersion: WORKFLOW_SUPERVISOR_PROTOCOL_VERSION,
    repositoryDigest: workflowSupervisorRepositoryDigest(),
    pid: process.pid,
    token: launchToken,
    socketPath: paths.socketPath,
    startedAt: Date.now(),
  };
  const socketServer = createWorkflowSupervisorSocketServer({
    socketPath: paths.socketPath,
    token: runtimeState.token,
    coordinator,
  });

  let signalShutdown: Promise<void> | undefined;
  let readyForSignalShutdown = false;
  let pendingSignalShutdown = false;
  const requestSignalShutdown = () => {
    if (!readyForSignalShutdown) {
      pendingSignalShutdown = true;
      return;
    }
    if (signalShutdown) return;
    signalShutdown = (async () => {
      try {
        let epoch = coordinator.snapshot().attachedEpoch;
        if (epoch === null) {
          epoch = internalShutdownEpoch();
          await coordinator.attach(epoch);
        }
        await coordinator.shutdown(epoch);
        await socketServer.close();
      } catch {
        // Fail closed: keep this process, journal, and socket alive if an exact
        // provider/process terminal state cannot be proven. The local logs are
        // intentionally the only diagnostic surface; protocol errors remain
        // fixed and non-sensitive.
        console.error("Workflow supervisor refused graceful signal shutdown.");
      }
    })();
  };
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const handler = () => requestSignalShutdown();
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  try {
    await socketServer.listen();
    writeWorkflowSupervisorRuntimeState(runtimeState, paths);
    readyForSignalShutdown = true;
    if (pendingSignalShutdown) requestSignalShutdown();
    process.send?.({ type: "kady-workflow-supervisor-ready" });
    await socketServer.closed;
  } finally {
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
    try {
      await socketServer.close();
    } finally {
      removeWorkflowSupervisorRuntimeStateIfOwned(paths, runtimeState);
    }
  }
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return (
      fs.realpathSync(fileURLToPath(import.meta.url)) ===
      fs.realpathSync(path.resolve(process.argv[1]))
    );
  } catch {
    return false;
  }
})();

if (isMain) {
  try {
    await runWorkflowSupervisorEntrypoint();
  } catch {
    console.error("Workflow supervisor failed to start.");
    process.exitCode = 1;
  }
}
