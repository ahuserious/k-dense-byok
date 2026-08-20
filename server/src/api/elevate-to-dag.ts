import type { FastifyInstance, FastifyReply } from "fastify";

import { currentProjectId } from "../scope.ts";
import {
  ElevateToDagError,
  elevatePromptToDag,
} from "../workflows/elevate-to-dag.ts";
import type { ModelRequest } from "../workflows/schema.ts";

const MAX_NAME_CHARS = 256;

class ElevateToDagRouteError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ElevateToDagRouteError";
  }
}

function sendError(reply: FastifyReply, error: ElevateToDagRouteError): void {
  void reply.code(error.statusCode).send({
    code: error.code,
    error: error.message,
    next: "Correct the prompt or model and retry elevate-to-dag.",
  });
}

function readPrompt(body: unknown): { prompt: string; name?: string; workflowId?: string; defaultModel: ModelRequest } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ElevateToDagRouteError(400, "ELEVATE_INVALID_REQUEST", "A JSON body is required.");
  }
  const record = body as Record<string, unknown>;
  if (typeof record.prompt !== "string" || record.prompt.trim().length === 0) {
    throw new ElevateToDagRouteError(400, "ELEVATE_INVALID_REQUEST", "A prompt is required.");
  }
  if (!record.defaultModel || typeof record.defaultModel !== "object") {
    throw new ElevateToDagRouteError(
      400,
      "ELEVATE_INVALID_REQUEST",
      "A defaultModel is required so the saved graph can execute.",
    );
  }
  return {
    prompt: record.prompt,
    ...(typeof record.name === "string" && record.name.trim().length > 0 &&
      record.name.trim().length <= MAX_NAME_CHARS
      ? { name: record.name.trim() }
      : {}),
    ...(typeof record.workflowId === "string" ? { workflowId: record.workflowId } : {}),
    defaultModel: record.defaultModel as ModelRequest,
  };
}

/**
 * `POST /elevate-to-dag` — one engine, three entry points (rows 26 / 17 / 43).
 * Route registration is in INTEGRATION.md; this lane does not write index.ts.
 */
export function registerElevateToDagRoutes(app: FastifyInstance): void {
  app.post("/elevate-to-dag", async (request, reply) => {
    try {
      const projectId = currentProjectId();
      const body = readPrompt(request.body);
      const result = elevatePromptToDag({
        projectId,
        prompt: body.prompt,
        name: body.name,
        workflowId: body.workflowId,
        defaultModel: body.defaultModel,
        save: true,
      });
      return reply.code(201).send({
        workflowId: result.workflowId,
        revision: result.revision,
        saved: result.saved,
        nodeCount: result.graph.nodes.length,
        entryNodeId: result.graph.entryNodeId,
      });
    } catch (error) {
      if (error instanceof ElevateToDagRouteError) {
        sendError(reply, error);
        return;
      }
      if (error instanceof ElevateToDagError) {
        sendError(
          reply,
          new ElevateToDagRouteError(
            error.code === "SAVE_FAILED" ? 409 : 400,
            `ELEVATE_${error.code}`,
            error.message,
          ),
        );
        return;
      }
      throw error;
    }
  });
}
