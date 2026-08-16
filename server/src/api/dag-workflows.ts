import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { currentProjectId } from "../scope.ts";
import {
  WorkflowBudgetError,
  workflowRunBudgetSummary,
} from "../workflows/budget.ts";
import {
  LegacyPipelineImportError,
  MAX_WORKFLOW_EVENT_PAGE_SIZE,
  MAX_WORKFLOW_RUN_LIST_SIZE,
  WorkflowDefinitionConflictError,
  WorkflowPreconditionError,
  WorkflowStoreError,
  WorkflowRunControllerError,
  previewLegacyPipelineWorkflow,
  workflowStore,
  type SaveWorkflowDefinitionIntent,
  type WorkflowRunController,
  type StoredWorkflowDefinitionV1,
  type WorkflowRunRecord,
} from "../workflows/index.ts";

const IMPORT_REASONING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function workflowDefinitionSummary(definition: StoredWorkflowDefinitionV1) {
  return {
    id: definition.id,
    revision: definition.revision,
    createdAt: definition.createdAt,
    updatedAt: definition.updatedAt,
    graphSha256: definition.graphSha256,
    schemaVersion: definition.graph.schemaVersion,
    name: definition.graph.name,
    description: definition.graph.description ?? null,
    nodeCount: definition.graph.nodes.length,
    edgeCount: definition.graph.edges.length,
  };
}

function workflowRunSummary(run: WorkflowRunRecord) {
  return {
    id: run.manifest.id,
    workflowId: run.manifest.workflowId,
    workflowRevision: run.manifest.workflowRevision,
    graphSha256: run.manifest.graphSha256,
    sessionId: run.manifest.sessionId ?? null,
    createdAt: run.manifest.createdAt,
    requestedBy: run.manifest.requestedBy,
    status: run.state.status,
    lastSeq: run.state.lastSeq,
    startedAt: run.state.startedAt ?? null,
    finishedAt: run.state.finishedAt ?? null,
    interruptedAt: run.state.interruptedAt ?? null,
    recoverable: run.state.recoverable,
    lastError: run.state.lastError ?? null,
    diagnostics: run.state.diagnostics,
  };
}

/**
 * A conditional-header failure that must not be reported as a store conflict.
 * `WorkflowStoreError` has no code that maps to 400-for-malformed-precondition
 * or to 428, so the definition PUT raises this instead.
 */
class DefinitionConditionalHeaderError extends Error {
  readonly status: 400 | 428;
  readonly code: "INVALID_CONDITIONAL_HEADER" | "CONDITIONAL_HEADER_REQUIRED";

  constructor(
    status: 400 | 428,
    code: "INVALID_CONDITIONAL_HEADER" | "CONDITIONAL_HEADER_REQUIRED",
    message: string,
  ) {
    super(message);
    this.name = "DefinitionConditionalHeaderError";
    this.status = status;
    this.code = code;
  }
}

function errorResponse(reply: FastifyReply, error: unknown) {
  if (error instanceof DefinitionConditionalHeaderError) {
    reply.code(error.status);
    return { detail: error.message, code: error.code };
  }
  if (error instanceof WorkflowPreconditionError) {
    reply.code(422);
    return {
      code: "WORKFLOW_PRECONDITION_FAILED",
      detail: error.message,
      issues: error.issues.slice(0, 256),
    };
  }
  if (error instanceof WorkflowRunControllerError) {
    const status = {
      RUN_NOT_FOUND: 404,
      RUN_NOT_STARTABLE: 409,
      RUN_NOT_RESUMABLE: 409,
      RUN_NOT_CANCELLABLE: 409,
      PROJECT_QUIESCING: 409,
      CONTROLLER_CLOSED: 503,
      INVALID_LIMIT: 500,
    }[error.code];
    reply.code(status);
    return { detail: error.message, code: error.code };
  }
  if (error instanceof WorkflowBudgetError) {
    const status = {
      INVALID_ARGUMENT: 400,
      NOT_FOUND: 404,
      CONFLICT: 409,
      LIMIT_EXCEEDED: 422,
      LOCK_TIMEOUT: 503,
      CORRUPT: 500,
    }[error.code];
    reply.code(status);
    return { detail: error.message, code: error.code };
  }
  if (!(error instanceof WorkflowStoreError)) {
    reply.code(500);
    return { detail: "Workflow operation failed." };
  }
  const status = {
    INVALID_ID: 400,
    INVALID_DEFINITION: 400,
    NOT_FOUND: 404,
    CONFLICT: 409,
    TOO_LARGE: 413,
    LIMIT_REACHED: 422,
    CANCEL_REQUESTED: 409,
    CORRUPT: 500,
    UNSUPPORTED_VERSION: 500,
    PRECONDITION_FAILED: 422,
  }[error.code];
  reply.code(status);
  return { detail: error.message, code: error.code };
}

/**
 * Exactly one header value, or a 400. An array (a repeated header, or a
 * pre-split list) is never acceptable on a definition precondition: taking the
 * first member would silently apply a precondition the client did not intend.
 */
function singleConditionalHeader(
  value: string | string[] | undefined,
  name: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    throw new DefinitionConditionalHeaderError(
      400,
      "INVALID_CONDITIONAL_HEADER",
      `${name} must be sent exactly once as a single value.`,
    );
  }
  return value;
}

/** Strict `If-None-Match: *`. Any other form, including a list, is a 400. */
function parseCreatePrecondition(value: string | string[] | undefined): boolean {
  const raw = singleConditionalHeader(value, "If-None-Match");
  if (raw === undefined) return false;
  if (raw.trim() !== "*") {
    throw new DefinitionConditionalHeaderError(
      400,
      "INVALID_CONDITIONAL_HEADER",
      "If-None-Match must be exactly `*` on a workflow definition create.",
    );
  }
  return true;
}

/**
 * Strict strong quoted `If-Match: "<non-negative safe integer>"`. Bare, weak
 * (`W/"1"`), wildcard, and list forms are all 400.
 *
 * The digits must be the canonical decimal form (`0`, or no leading zero).
 * RFC 7232 §2.3.2 strong comparison is octet-by-octet, and this route only ever
 * mints an unpadded `"<revision>"`, so `"01"` names an entity-tag no response
 * can have issued: accepting it as revision 1 would satisfy a precondition the
 * client never received.
 */
function parseUpdatePrecondition(value: string | string[] | undefined): number | undefined {
  const raw = singleConditionalHeader(value, "If-Match");
  if (raw === undefined) return undefined;
  const match = /^"(0|[1-9]\d*)"$/.exec(raw.trim());
  const revision = match ? Number(match[1]) : Number.NaN;
  if (!match || !Number.isSafeInteger(revision) || revision < 0) {
    throw new DefinitionConditionalHeaderError(
      400,
      "INVALID_CONDITIONAL_HEADER",
      'If-Match must be exactly one strong quoted unpadded non-negative workflow revision, for example If-Match: "1".',
    );
  }
  return revision;
}

/**
 * The HTTP route may express only `create` or `update`; the trusted `upsert`
 * facade is never reachable from a request.
 */
function parseDefinitionIntent(
  ifMatch: string | string[] | undefined,
  ifNoneMatch: string | string[] | undefined,
): SaveWorkflowDefinitionIntent {
  const create = parseCreatePrecondition(ifNoneMatch);
  const expectedRevision = parseUpdatePrecondition(ifMatch);
  if (create && expectedRevision !== undefined) {
    throw new DefinitionConditionalHeaderError(
      400,
      "INVALID_CONDITIONAL_HEADER",
      "If-Match and If-None-Match are mutually exclusive on a workflow definition write.",
    );
  }
  if (create) return { kind: "create" };
  if (expectedRevision !== undefined) return { kind: "update", expectedRevision };
  throw new DefinitionConditionalHeaderError(
    428,
    "CONDITIONAL_HEADER_REQUIRED",
    'A workflow definition write requires either If-None-Match: * (create) or If-Match: "<revision>" (update).',
  );
}

function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) {
    throw new WorkflowStoreError("CONFLICT", `${label} must be an integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new WorkflowStoreError(
      "LIMIT_REACHED",
      `${label} must be ${minimum}-${maximum}.`,
    );
  }
  return parsed;
}

/**
 * Project-scoped typed DAG definition and durable run-read API.
 *
 * Execution events have no public append route: only the in-process runner may
 * advance the authoritative event log. Likewise, definitions and run records
 * are deliberately not deletable through this initial audit-preserving API.
 */
export interface RegisterDagWorkflowRoutesOptions {
  controller?: WorkflowRunController;
}

interface LegacyWorkflowPreviewRoute {
  Body: {
    source?: unknown;
    workflowId?: unknown;
    reasoning?: unknown;
  } | null;
}

export async function registerDagWorkflowRoutes(
  app: FastifyInstance,
  options: RegisterDagWorkflowRoutesOptions = {},
): Promise<void> {
  /**
   * Clean-room, preview-only bridge for the portable subset of the former
   * Pipeline engine YAML format. It never scans legacy engine storage, writes a definition, or
   * claims that a legacy sidecar run can resume in Kady. The caller must review
   * the returned typed graph and save it through the normal revisioned PUT.
   */
  const previewLegacyWorkflow = async (
    request: FastifyRequest<LegacyWorkflowPreviewRoute>,
    reply: FastifyReply,
    sourceFormat:
      | "pipeline-workflow-yaml/v1"
      | "archon-workflow-yaml/v1",
  ) => {
    try {
      const body = isRecord(request.body) ? request.body : {};
      if (typeof body.source !== "string") {
        throw new LegacyPipelineImportError(
          "INVALID_IMPORT_REQUEST",
          "source must be a YAML string.",
        );
      }
      if (typeof body.workflowId !== "string") {
        throw new LegacyPipelineImportError(
          "INVALID_IMPORT_REQUEST",
          "workflowId is required.",
        );
      }
      if (
        typeof body.reasoning !== "string" ||
        !IMPORT_REASONING_LEVELS.has(body.reasoning)
      ) {
        throw new LegacyPipelineImportError(
          "INVALID_IMPORT_REQUEST",
          "reasoning must be one of off, minimal, low, medium, high, xhigh, or max.",
        );
      }
      const preview = previewLegacyPipelineWorkflow({
        source: body.source,
        workflowId: body.workflowId,
        reasoning: body.reasoning as
          | "off"
          | "minimal"
          | "low"
          | "medium"
          | "high"
          | "xhigh"
          | "max",
      });
      reply.header("Cache-Control", "no-store");
      return { ...preview, sourceFormat };
    } catch (error) {
      if (!(error instanceof LegacyPipelineImportError)) {
        reply.code(500);
        return { detail: "Legacy workflow preview failed." };
      }
      reply.code(error.code === "LEGACY_SOURCE_TOO_LARGE" ? 413 : 400);
      return { detail: error.message, code: error.code };
    }
  };

  app.post<LegacyWorkflowPreviewRoute>(
    "/dag-workflow-imports/legacy-pipeline/preview",
    (request, reply) =>
      previewLegacyWorkflow(request, reply, "pipeline-workflow-yaml/v1"),
  );
  // deprecated-compat: retain the former migration URL for existing scripts.
  app.post<LegacyWorkflowPreviewRoute>(
    "/dag-workflow-imports/legacy-archon/preview",
    async (request, reply) => {
      request.log.warn(
        {
          deprecatedPath: request.url,
          replacementPath: "/dag-workflow-imports/legacy-pipeline/preview",
        },
        "dag_workflows.legacy_preview_path_deprecated",
      );
      return previewLegacyWorkflow(
        request,
        reply,
        "archon-workflow-yaml/v1",
      );
    },
  );

  app.get("/dag-workflows", async (_request, reply) => {
    try {
      reply.header("Cache-Control", "no-store");
      return {
        workflows: workflowStore
          .listDefinitions(currentProjectId())
          .map(workflowDefinitionSummary),
      };
    } catch (error) {
      return errorResponse(reply, error);
    }
  });

  app.get<{ Params: { workflowId: string } }>(
    "/dag-workflows/:workflowId",
    async (request, reply) => {
      try {
        const definition = workflowStore.readDefinition(
          currentProjectId(),
          request.params.workflowId,
        );
        if (!definition) {
          throw new WorkflowStoreError(
            "NOT_FOUND",
            `No such workflow: ${request.params.workflowId}`,
          );
        }
        reply.header("Cache-Control", "no-store");
        reply.header("ETag", `"${definition.revision}"`);
        return definition;
      } catch (error) {
        return errorResponse(reply, error);
      }
    },
  );

  app.put<{ Params: { workflowId: string }; Body: unknown }>(
    "/dag-workflows/:workflowId",
    async (request, reply) => {
      try {
        const intent = parseDefinitionIntent(
          request.headers["if-match"],
          request.headers["if-none-match"],
        );
        const result = workflowStore.saveDefinitionWithIntent(
          currentProjectId(),
          request.params.workflowId,
          request.body,
          intent,
        );
        reply.code(result.outcome === "created" ? 201 : 200);
        reply.header("Cache-Control", "no-store");
        reply.header("ETag", `"${result.definition.revision}"`);
        reply.header(
          "Location",
          `/dag-workflows/${encodeURIComponent(result.definition.id)}`,
        );
        return { outcome: result.outcome, definition: result.definition };
      } catch (error) {
        // The 409 ETag comes only from the revision the store captured inside
        // the mutation lock. Rereading here could race a later writer and
        // publish an ETag that never described the compared state.
        if (
          error instanceof WorkflowDefinitionConflictError &&
          error.currentRevision !== null
        ) {
          reply.header("ETag", `"${error.currentRevision}"`);
        }
        return errorResponse(reply, error);
      }
    },
  );

  app.post<{
    Params: { workflowId: string };
    Body: {
      requestId?: unknown;
      expectedWorkflowRevision?: unknown;
      sessionId?: unknown;
      input?: unknown;
    } | null;
  }>("/dag-workflows/:workflowId/runs", async (request, reply) => {
    try {
      const body = isRecord(request.body) ? request.body : {};
      if (typeof body.requestId !== "string") {
        throw new WorkflowStoreError("INVALID_ID", "requestId is required.");
      }
      if (
        body.expectedWorkflowRevision !== undefined &&
        (!Number.isSafeInteger(body.expectedWorkflowRevision) ||
          (body.expectedWorkflowRevision as number) < 1)
      ) {
        throw new WorkflowStoreError(
          "CONFLICT",
          "expectedWorkflowRevision must be a positive integer.",
        );
      }
      if (body.sessionId !== undefined && typeof body.sessionId !== "string") {
        throw new WorkflowStoreError("INVALID_ID", "sessionId must be a string.");
      }
      if (body.input !== undefined && !isRecord(body.input)) {
        throw new WorkflowStoreError("INVALID_DEFINITION", "input must be an object.");
      }
      const projectId = currentProjectId();
      const manifest = workflowStore.createRun(projectId, {
        workflowId: request.params.workflowId,
        requestId: body.requestId,
        requestedBy: "user",
        ...(body.expectedWorkflowRevision !== undefined
          ? { expectedWorkflowRevision: body.expectedWorkflowRevision as number }
          : {}),
        ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}),
        ...(body.input !== undefined
          ? {
              input: body.input as {
                goal?: string;
                variables?: Record<string, unknown>;
                files?: Record<string, string[]>;
              },
            }
          : {}),
      });
      const run = workflowStore.readRun(projectId, manifest.id);
      if (!run) throw new WorkflowStoreError("CORRUPT", "Created run is unreadable.");
      options.controller?.start(projectId, manifest.id);
      const scheduled = workflowStore.readRun(projectId, manifest.id) ?? run;
      reply.code(202);
      reply.header("Cache-Control", "no-store");
      reply.header("Location", `/dag-workflow-runs/${encodeURIComponent(manifest.id)}`);
      return { manifest, state: scheduled.state };
    } catch (error) {
      return errorResponse(reply, error);
    }
  });

  app.get<{ Querystring: { limit?: string } }>(
    "/dag-workflow-runs",
    async (request, reply) => {
      try {
        const limit = parseBoundedInteger(
          request.query.limit,
          100,
          1,
          MAX_WORKFLOW_RUN_LIST_SIZE,
          "Run list limit",
        );
        reply.header("Cache-Control", "no-store");
        return {
          runs: workflowStore.listRuns(currentProjectId(), limit).map(workflowRunSummary),
        };
      } catch (error) {
        return errorResponse(reply, error);
      }
    },
  );

  app.get<{ Params: { runId: string } }>(
    "/dag-workflow-runs/:runId",
    async (request, reply) => {
      try {
        const run = workflowStore.readRun(currentProjectId(), request.params.runId);
        if (!run) {
          throw new WorkflowStoreError(
            "NOT_FOUND",
            `No such workflow run: ${request.params.runId}`,
          );
        }
        reply.header("Cache-Control", "no-store");
        return run;
      } catch (error) {
        return errorResponse(reply, error);
      }
    },
  );

  app.get<{ Params: { runId: string } }>(
    "/dag-workflow-runs/:runId/budget",
    async (request, reply) => {
      try {
        const projectId = currentProjectId();
        const run = workflowStore.readRun(projectId, request.params.runId);
        if (!run) {
          throw new WorkflowStoreError(
            "NOT_FOUND",
            `No such workflow run: ${request.params.runId}`,
          );
        }
        const summary = workflowRunBudgetSummary(projectId, run.manifest.id);
        reply.header("Cache-Control", "no-store");
        return summary;
      } catch (error) {
        return errorResponse(reply, error);
      }
    },
  );

  app.get<{
    Params: { runId: string };
    Querystring: { after?: string; limit?: string };
  }>("/dag-workflow-runs/:runId/events", async (request, reply) => {
    try {
      const after = parseBoundedInteger(
        request.query.after,
        0,
        0,
        Number.MAX_SAFE_INTEGER,
        "Event cursor",
      );
      const limit = parseBoundedInteger(
        request.query.limit,
        200,
        1,
        MAX_WORKFLOW_EVENT_PAGE_SIZE,
        "Event page limit",
      );
      reply.header("Cache-Control", "no-store");
      return workflowStore.readRunEvents(currentProjectId(), request.params.runId, {
        after,
        limit,
      });
    } catch (error) {
      return errorResponse(reply, error);
    }
  });

  app.post<{ Params: { runId: string } }>(
    "/dag-workflow-runs/:runId/cancel",
    async (request, reply) => {
      try {
        if (!options.controller) {
          throw new WorkflowRunControllerError(
            "CONTROLLER_CLOSED",
            "Workflow execution is not enabled in this server process.",
          );
        }
        const run = options.controller.cancel(
          currentProjectId(),
          request.params.runId,
        );
        reply.code(run.state.status === "cancelled" ? 200 : 202);
        reply.header("Cache-Control", "no-store");
        return run;
      } catch (error) {
        return errorResponse(reply, error);
      }
    },
  );

  app.post<{ Params: { runId: string } }>(
    "/dag-workflow-runs/:runId/resume",
    async (request, reply) => {
      try {
        if (!options.controller) {
          throw new WorkflowRunControllerError(
            "CONTROLLER_CLOSED",
            "Workflow execution is not enabled in this server process.",
          );
        }
        options.controller.resume(currentProjectId(), request.params.runId);
        const run = workflowStore.readRun(currentProjectId(), request.params.runId);
        if (!run) {
          throw new WorkflowStoreError(
            "NOT_FOUND",
            `No such workflow run: ${request.params.runId}`,
          );
        }
        reply.code(202);
        reply.header("Cache-Control", "no-store");
        return run;
      } catch (error) {
        return errorResponse(reply, error);
      }
    },
  );

  app.post<{
    Params: { runId: string };
    Body: { requestId?: unknown } | null;
  }>("/dag-workflow-runs/:runId/rescue", async (request, reply) => {
    try {
      if (!options.controller) {
        throw new WorkflowRunControllerError(
          "CONTROLLER_CLOSED",
          "Workflow execution is not enabled in this server process.",
        );
      }
      const body = isRecord(request.body) ? request.body : {};
      if (typeof body.requestId !== "string") {
        throw new WorkflowStoreError("INVALID_ID", "requestId is required.");
      }
      const projectId = currentProjectId();
      const source = workflowStore.readRun(projectId, request.params.runId);
      if (!source) {
        throw new WorkflowStoreError(
          "NOT_FOUND",
          `No such workflow run: ${request.params.runId}`,
        );
      }
      if (source.state.status !== "failed") {
        throw new WorkflowStoreError(
          "CONFLICT",
          `Workflow run ${source.manifest.id} must be failed before a manual rescue run is created.`,
        );
      }
      const manifest = workflowStore.createRun(projectId, {
        workflowId: source.manifest.workflowId,
        requestId: body.requestId,
        requestedBy: "user",
        ...(source.manifest.sessionId
          ? { sessionId: source.manifest.sessionId }
          : {}),
        input: {
          ...(source.manifest.input.goal
            ? { goal: source.manifest.input.goal }
            : {}),
          variables: {
            ...(source.manifest.input.variables ?? {}),
            _kadyRescue: {
              sourceRunId: source.manifest.id,
              sourceWorkflowRevision: source.manifest.workflowRevision,
              error: source.state.lastError ?? null,
            },
          },
          ...(source.manifest.input.files
            ? { files: source.manifest.input.files }
            : {}),
        },
      });
      options.controller.start(projectId, manifest.id);
      const rescued = workflowStore.readRun(projectId, manifest.id);
      if (!rescued) {
        throw new WorkflowStoreError("CORRUPT", "Created rescue run is unreadable.");
      }
      reply.code(202);
      reply.header("Cache-Control", "no-store");
      reply.header(
        "Location",
        `/dag-workflow-runs/${encodeURIComponent(manifest.id)}`,
      );
      return rescued;
    } catch (error) {
      return errorResponse(reply, error);
    }
  });
}
