/**
 * K-Dense BYOK backend (TypeScript, Pi SDK).
 *
 * Replaces the Python FastAPI + Google ADK server. Boots Fastify, applies the
 * same project-scoping contract the frontend expects (X-Project-Id header /
 * ?project query / kady-project cookie), and registers the route plugins.
 */
import "./env.ts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyCors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyRequest } from "fastify";
import { DEFAULT_PROJECT_ID, HOST, PORT, modalConfigured } from "./config.ts";
import { isCorsOriginAllowed } from "./cors.ts";
import { ensureProjectExists, getProject, listProjects } from "./projects.ts";
import { withActiveProject } from "./scope.ts";
import { registerProjectRoutes } from "./api/projects.ts";
import { registerSessionRoutes } from "./api/sessions.ts";
import { registerSandboxRoutes } from "./api/sandbox.ts";
import { registerSkillRoutes } from "./api/skills.ts";
import { registerSystemRoutes } from "./api/system.ts";
import { registerMcpRoutes } from "./api/mcp.ts";
import { registerCredentialRoutes } from "./api/credentials.ts";
import { registerAgentRoutes } from "./api/agents.ts";
import { registerSpeechRoutes } from "./api/speech.ts";
import { registerModalRoutes } from "./api/modal.ts";
import { registerModelProviderRoutes } from "./api/model-providers.ts";
import { registerDagWorkflowRoutes } from "./api/dag-workflows.ts";
import { registerPipelineRoutes } from "./api/pipelines.ts";
import { registerConsoleRoutes } from "./api/console.ts";
import { disposeAllWorkflowDelegationSessions } from "./agent/workflow-delegation-session.ts";
import type { WorkflowRunController } from "./workflows/controller.ts";
import { reconcileStaleWorkflowBudgetReservations } from "./workflows/budget.ts";
import {
  createProductionWorkflowController,
  workflowControllerErrorLogFields,
} from "./workflows/service.ts";
import { workflowStore } from "./workflows/store.ts";
import {
  assertNoHostedFusionQuarantine,
  DEFAULT_HOSTED_FUSION_CANCELLATION_ACK_TIMEOUT_MS,
  waitForHostedFusionQuarantines,
} from "./workflows/hosted-fusion.ts";
import {
  createGracefulShutdownCoordinator,
  type GracefulShutdownReason,
} from "./graceful-shutdown.ts";
import { startAutomaticSkillSync } from "./agent/skills-sync.ts";
import { modalJobManager } from "./modal/manager.ts";
import { syncHelperVenv } from "./helpers-env.ts";
import { configureHttpProxy } from "./http-proxy.ts";
import {
  ensureWorkflowSupervisor,
  type WorkflowSupervisorClient,
} from "./workflows/supervisor/client.ts";
import type { WorkflowSupervisorSnapshot } from "./workflows/supervisor/protocol.ts";

function readCookie(req: FastifyRequest, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return undefined;
}

function resolveProjectId(req: FastifyRequest): string {
  const header = req.headers["x-project-id"];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  const q = (req.query as Record<string, unknown> | undefined)?.project;
  const candidates: (string | undefined)[] = [
    fromHeader != null ? String(fromHeader) : undefined,
    q != null ? String(q) : undefined,
    readCookie(req, "kady-project"),
  ];
  for (const c of candidates) {
    if (c && c.trim()) return c.trim();
  }
  return DEFAULT_PROJECT_ID;
}

export interface BuildAppOptions {
  /** Omit for production execution; pass null only for queued-storage tests. */
  workflowController?: WorkflowRunController | null;
  /** Production passes the already-attached detached workflow owner. */
  workflowSupervisor?: Pick<
    WorkflowSupervisorClient,
    | "nodeExecutorDependencies"
    | "quiesceProject"
    | "reloadCredentials"
    | "shutdown"
    | "snapshot"
  > | null;
  /** Records remote ownership state for safe shutdown diagnostics. */
  onWorkflowSupervisorSnapshot?(snapshot: WorkflowSupervisorSnapshot): void;
}

export async function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    // Inline image attachments ride the JSON run body as base64 (up to 12 ×
    // 5MB, see agent/prompt-images.ts); Fastify's default 1MB limit would
    // reject them.
    bodyLimit: 96 * 1024 * 1024,
  });
  const workflowController = options.workflowController === undefined
    ? createProductionWorkflowController({
      ...(options.workflowSupervisor
        ? { nodeExecutorDependencies: options.workflowSupervisor.nodeExecutorDependencies() }
        : {}),
      onError: ({ projectId, runId, error }) => {
        app.log.error(
          { projectId, runId, ...workflowControllerErrorLogFields(error) },
          "workflow DAG run controller failed",
        );
      },
    })
    : options.workflowController;

  await app.register(fastifyCors, {
    origin: (origin, cb) => {
      cb(null, isCorsOriginAllowed(origin));
    },
    credentials: true,
    exposedHeaders: ["ETag", "X-Project-Fallback"],
  });

  await app.register(multipart, { limits: { fileSize: 1024 * 1024 * 1024 } });

  // Binary/unknown request bodies (e.g. PUT /sandbox/file) → raw Buffer.
  // JSON and text/plain keep their built-in parsers; multipart is handled above.
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  // Project scope: resolve the active project and run the rest of the request
  // lifecycle inside its AsyncLocalStorage context. Calling `done` inside
  // withActiveProject keeps the store active for downstream hooks + handler.
  app.addHook("onRequest", (req, reply, done) => {
    let projectId = resolveProjectId(req);
    try {
      // Only the default project is created on demand. An unknown id here is
      // a stale header (e.g. an in-flight poll for a just-deleted project) —
      // creating it would silently resurrect the deleted project.
      if (projectId !== DEFAULT_PROJECT_ID && !getProject(projectId)) {
        // Reads degrade to the default project (with a header so the client
        // can notice and re-sync), but a write must never land in a project
        // the caller did not ask for: that silently moves a chat, an upload or
        // a spend record into someone else's workspace.
        if (req.method !== "GET" && req.method !== "HEAD") {
          reply.code(404).send({
            detail: `Unknown project: ${projectId}`,
            reason: "unknown_project",
          });
          return;
        }
        reply.header("X-Project-Fallback", projectId);
        projectId = DEFAULT_PROJECT_ID;
      }
      ensureProjectExists(projectId);
    } catch {
      projectId = DEFAULT_PROJECT_ID;
      ensureProjectExists(projectId);
    }
    withActiveProject(projectId, () => done());
  });

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/config", async () => ({ modal_configured: modalConfigured() }));

  await registerProjectRoutes(app, {
    workflowController: workflowController ?? undefined,
    workflowSupervisor: options.workflowSupervisor ?? undefined,
  });
  await registerSessionRoutes(app);
  await registerSandboxRoutes(app);
  await registerSkillRoutes(app);
  await registerSystemRoutes(app);
  await registerMcpRoutes(app);
  await registerCredentialRoutes(
    app,
    options.workflowSupervisor
      ? { reloadCredentials: (keys) => options.workflowSupervisor!.reloadCredentials(keys) }
      : {},
  );
  await registerAgentRoutes(app);
  await registerSpeechRoutes(app);
  await registerModalRoutes(app);
  await registerModelProviderRoutes(app);
  await registerDagWorkflowRoutes(app, {
    controller: workflowController ?? undefined,
  });
  await registerPipelineRoutes(app);
  await registerConsoleRoutes(app);

  // Production attaches to and drains any inherited detached owner before
  // buildApp runs. Budget reconciliation can therefore charge only reservations
  // whose supervisor-side settlement really is absent before graph recovery.
  for (const project of listProjects()) {
    try {
      const staleReservations = await reconcileStaleWorkflowBudgetReservations(
        project.id,
      );
      if (staleReservations.length > 0) {
        app.log.warn(
          {
            projectId: project.id,
            reservationIds: staleReservations.map((reservation) => reservation.id),
          },
          "charged stale workflow budget reservations at their unobserved maximum",
        );
      }
    } catch (error) {
      app.log.error(
        { projectId: project.id, ...workflowControllerErrorLogFields(error) },
        "workflow budget restart reconciliation failed closed",
      );
    }
  }

  const logRecovery = (recovery: ReturnType<WorkflowRunController["recoverProjects"]>[number]) => {
    if (recovery.interrupted.length > 0) {
      app.log.info(
        { projectId: recovery.projectId, runIds: recovery.interrupted },
        "marked workflow runs interrupted after server restart",
      );
    }
    if (recovery.enqueued.length > 0) {
      app.log.info(
        { projectId: recovery.projectId, runIds: recovery.enqueued },
        "re-enqueued durable workflow runs",
      );
    }
    for (const error of recovery.errors) {
      app.log.warn(
        { projectId: recovery.projectId, runId: error.runId },
        "workflow restart reconciliation could not inspect a run",
      );
    }
  };

  if (workflowController) {
    for (const recovery of workflowController.startRecoveryLoop(
      () => listProjects().map((project) => project.id),
    )) {
      logRecovery(recovery);
    }
  } else {
    // Explicit storage-only mode never launches queued work, but still makes
    // abandoned in-flight state visibly resumable for API tests and tools.
    for (const project of listProjects()) {
      const recovery = workflowStore.reconcileInterruptedRuns(project.id);
      logRecovery({ projectId: project.id, enqueued: [], ...recovery });
    }
  }

  // Reattach durable jobs after routes are available. Recovery schedules
  // active jobs in the background and immediately reconciles any terminal job
  // whose accounting write was interrupted by a prior shutdown.
  await modalJobManager.recoverAllProjects();

  app.addHook("onClose", async () => {
    await workflowController?.close({
      // Give every hosted leaf its complete acknowledgement window plus a
      // scheduling margin before deciding whether shutdown owns quarantine.
      graceMs: DEFAULT_HOSTED_FUSION_CANCELLATION_ACK_TIMEOUT_MS + 1_000,
    });
    // close() is deliberately bounded for embedded/test callers. Production
    // graceful shutdown has a separate explicit force escape, so it must wait
    // for actual controller idleness before concluding no hosted owner can
    // still enter quarantine after the check below.
    await workflowController?.waitForIdle();
    if (options.workflowSupervisor) return;
    // A late acknowledgement may arrive after the bounded caller has already
    // failed closed. Graceful shutdown retains the process and exact owner
    // until that quarantine releases or its release attempt visibly fails.
    await waitForHostedFusionQuarantines();
    assertNoHostedFusionQuarantine();
    await disposeAllWorkflowDelegationSessions();
  });

  if (options.workflowSupervisor) {
    // Fastify's close hooks run only after close() has marked the app closing;
    // onClose runs after the HTTP listener is gone. Guard the close boundary
    // itself so a detached owner can refuse without taking the API down or
    // irreversibly closing the local workflow controller.
    const closeFastify = app.close.bind(app);
    let closePromise: Promise<undefined> | undefined;
    let supervisorShutdownComplete = false;
    app.close = ((closeListener?: (error?: Error) => void) => {
      if (!closePromise) {
        const currentClose = (async (): Promise<undefined> => {
          if (!supervisorShutdownComplete) {
            try {
              options.onWorkflowSupervisorSnapshot?.(
                await options.workflowSupervisor!.snapshot(),
              );
              await options.workflowSupervisor!.shutdown("backend-shutdown");
              supervisorShutdownComplete = true;
            } catch (error) {
              // Retain the control lease and refresh diagnostics while Fastify
              // is still listening. A later explicit close may retry the guard.
              try {
                options.onWorkflowSupervisorSnapshot?.(
                  await options.workflowSupervisor!.snapshot(),
                );
              } catch {
                // The original shutdown failure remains authoritative.
              }
              throw error;
            }
          }
          return closeFastify();
        })();
        closePromise = currentClose;
        void currentClose.catch(() => {
          if (closePromise === currentClose) closePromise = undefined;
        });
      }
      if (!closeListener) return closePromise;
      void closePromise.then(
        () => closeListener(),
        (error: unknown) => closeListener(
          error instanceof Error ? error : new Error(String(error)),
        ),
      );
      return undefined;
    }) as typeof app.close;
  }

  return app;
}

// Boot when run directly (tsx src/index.ts), not when imported by tests.
// Compare real paths, not URL strings: import.meta.url percent-encodes (and on
// macOS resolves /tmp → /private/tmp), so a naive compare fails for repo paths
// with spaces or symlinks and the server would silently never listen.
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
  let requestShutdown: ((reason: GracefulShutdownReason) => void) | undefined;
  let pendingShutdownReason: GracefulShutdownReason | undefined;
  const queueOrRequestShutdown = (reason: GracefulShutdownReason) => {
    if (requestShutdown) {
      requestShutdown(reason);
      return;
    }
    if (pendingShutdownReason) {
      // Windows can deliver both the console signal and the launcher's IPC
      // request. Coalesce both before the coordinator exists; only the parent
      // launcher owns explicit force termination.
      return;
    }
    pendingShutdownReason = reason;
  };
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const handler = () => queueOrRequestShutdown(signal);
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
  const onLauncherMessage = (message: unknown) => {
    if (
      typeof message === "object" &&
      message !== null &&
      (message as { type?: unknown }).type === "kady-shutdown"
    ) {
      queueOrRequestShutdown("launcher-ipc");
    }
  };
  process.on("message", onLauncherMessage);

  let initializingSupervisor: WorkflowSupervisorClient | undefined;
  const initialized = await (async () => {
    try {
      // Before anything makes an outbound request: Node's fetch ignores
      // HTTP_PROXY/HTTPS_PROXY on its own, so a proxied network would otherwise
      // only be used by the child `pi` processes that run subagents.
      const proxy = configureHttpProxy();
      initializingSupervisor = await ensureWorkflowSupervisor();
      let lastSupervisorSnapshot = await initializingSupervisor.snapshot();
      syncHelperVenv(); // best-effort; previews degrade gracefully if it fails
      const app = await buildApp({
        workflowSupervisor: initializingSupervisor,
        onWorkflowSupervisorSnapshot: (snapshot) => {
          lastSupervisorSnapshot = snapshot;
        },
      });
      return {
        app,
        proxy,
        supervisorDiagnostics: () => ({
          workflowSupervisor: lastSupervisorSnapshot,
        }),
      };
    } catch (error) {
      if (initializingSupervisor) {
        try {
          await initializingSupervisor.shutdown("backend-shutdown");
        } catch {
          // A retained owner must stay detached and attachable for the next
          // backend; release this failed bootstrap's control lease.
          await initializingSupervisor.close();
        }
      }
      process.stderr.write(
        `Kady backend initialization failed: ${JSON.stringify(
          workflowControllerErrorLogFields(error),
        )}\n`,
      );
      process.exitCode = 1;
      return undefined;
    }
  })();

  if (initialized) {
    const { app, proxy, supervisorDiagnostics } = initialized;
    const shutdown = createGracefulShutdownCoordinator({
      close: () => app.close(),
      onStart: (reason) => {
        app.log.info({ reason }, "graceful Kady shutdown requested");
      },
      onComplete: (reason) => {
        app.log.info({ reason }, "graceful Kady shutdown completed");
      },
      onRefused: (reason, error) => {
        app.log.error(
          {
            reason,
            ...supervisorDiagnostics(),
            ...workflowControllerErrorLogFields(error),
          },
          "graceful shutdown refused to discard supervised work; Kady remains alive. Send a second signal only to force an unsafe exit",
        );
      },
      onRepeated: (reason) => {
        app.log.warn(
          { reason, ...supervisorDiagnostics() },
          "graceful Kady shutdown is already pending or refused; duplicate backend shutdown delivery was ignored",
        );
      },
      onForced: (reason) => {
        app.log.error(
          { reason, ...supervisorDiagnostics() },
          "forcing unsafe standalone Kady shutdown after a second explicit signal",
        );
      },
      forceOnRepeated: typeof process.send !== "function",
    });
    requestShutdown = shutdown.request;

    if (proxy.enabled) {
      app.log.info(
        { httpProxy: proxy.httpProxy, httpsProxy: proxy.httpsProxy, noProxy: proxy.noProxy },
        "routing outbound HTTP through the configured proxy",
      );
    }
    if (pendingShutdownReason) {
      shutdown.request(pendingShutdownReason);
    } else {
      try {
        const addr = await app.listen({ port: PORT, host: HOST });
        if (shutdown.state() === "idle") {
          app.log.info(`kady-server listening on ${addr}`);
          process.send?.({ type: "kady-ready", address: addr });
          startAutomaticSkillSync(app.log);
        }
      } catch (error) {
        if (shutdown.state() === "idle") {
          app.log.error(
            { ...supervisorDiagnostics(), ...workflowControllerErrorLogFields(error) },
            "Kady backend failed to listen",
          );
          try {
            await app.close();
          } catch (closeError) {
            app.log.error(
              {
                ...supervisorDiagnostics(),
                ...workflowControllerErrorLogFields(closeError),
              },
              "Kady startup cleanup retained supervised work",
            );
          }
          process.exitCode = 1;
        }
      }
    }
  } else {
    // The failed bootstrap above already released any supervisor control lease,
    // so nothing is owned. Both the installed signal handlers and the launcher's
    // IPC channel keep libuv referenced, so without releasing them this process
    // would sit forever on an empty event loop and its caller would read the
    // startup failure as a hang instead of an exit code.
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
    process.off("message", onLauncherMessage);
    if (process.connected) process.disconnect();
  }
}
