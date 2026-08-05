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
  hostedFusionQuarantineSnapshot,
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
  });
  await registerSessionRoutes(app);
  await registerSandboxRoutes(app);
  await registerSkillRoutes(app);
  await registerSystemRoutes(app);
  await registerMcpRoutes(app);
  await registerCredentialRoutes(app);
  await registerAgentRoutes(app);
  await registerSpeechRoutes(app);
  await registerModalRoutes(app);
  await registerModelProviderRoutes(app);
  await registerDagWorkflowRoutes(app, {
    controller: workflowController ?? undefined,
  });

  // Budget reconciliation is fail-closed: an expired hold with no observable
  // terminal usage is charged at its reserved maximum before graph/run state is
  // recovered. This is accounting protection, not proof that a process-local
  // pi-subagents child stopped; abnormal child reattachment remains a P0 gate.
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
    // A late acknowledgement may arrive after the bounded caller has already
    // failed closed. Graceful shutdown retains the process and exact owner
    // until that quarantine releases or its release attempt visibly fails.
    await waitForHostedFusionQuarantines();
    assertNoHostedFusionQuarantine();
    await disposeAllWorkflowDelegationSessions();
  });

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
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => queueOrRequestShutdown(signal));
  }
  process.on("message", (message: unknown) => {
    if (
      typeof message === "object" &&
      message !== null &&
      (message as { type?: unknown }).type === "kady-shutdown"
    ) {
      queueOrRequestShutdown("launcher-ipc");
    }
  });

  // Before anything makes an outbound request: Node's fetch ignores
  // HTTP_PROXY/HTTPS_PROXY on its own, so a proxied network would otherwise
  // only be used by the child `pi` processes that run subagents.
  const proxy = configureHttpProxy();
  syncHelperVenv(); // best-effort; previews degrade gracefully if it fails
  const app = await buildApp();
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
          quarantines: hostedFusionQuarantineSnapshot(),
          ...workflowControllerErrorLogFields(error),
        },
        "graceful shutdown refused to discard process-owned work; Kady remains alive. Send a second signal only to force an unsafe exit",
      );
    },
    onRepeated: (reason) => {
      app.log.warn(
        { reason, quarantines: hostedFusionQuarantineSnapshot() },
        "graceful Kady shutdown is already pending or refused; duplicate backend shutdown delivery was ignored",
      );
    },
    onForced: (reason) => {
      app.log.error(
        { reason, quarantines: hostedFusionQuarantineSnapshot() },
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
        app.log.error(error);
        process.exit(1);
      }
    }
  }
}
