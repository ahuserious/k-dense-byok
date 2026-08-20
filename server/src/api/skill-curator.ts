import type { FastifyInstance, FastifyReply } from "fastify";
import { activePaths } from "../projects.ts";
import {
  WorkflowDefinitionConflictError,
  WorkflowStoreError,
} from "../workflows/store.ts";
import {
  applySkillCuration,
  readSkillCuratorSnapshot,
  SkillCuratorError,
  type CuratorMimeographMode,
  type CuratorSkillMode,
  type CuratorWriteMode,
  type SkillCurationInput,
} from "../agent/skill-curator.ts";
import {
  evaluateAutoresearchRun,
  type AutoresearchMonitorMode,
} from "../agent/skill-curator-autoresearch.ts";
import {
  destHarnessAdapterStatus,
  promptElevationAdapterStatus,
} from "../agent/skill-curator-prompt-elevation.ts";
import { SkillOperationFailure } from "../agent/skills-install.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : null;
}

function safeError(
  reply: FastifyReply,
  error: unknown,
): { code: string; detail: string; currentRevision?: number | null } {
  if (error instanceof SkillCuratorError) {
    reply.code(error.status);
    return { code: error.code, detail: error.message };
  }
  if (error instanceof SkillOperationFailure) {
    reply.code(error.status);
    return {
      code: "SKILL_INSTALL_FAILED",
      detail:
        error.status === 502
          ? "Skill installation failed before curation. Review the source in Settings ▸ Skills and try again."
          : error.detail,
    };
  }
  if (error instanceof WorkflowDefinitionConflictError) {
    reply.code(409);
    return {
      code: "WORKFLOW_REVISION_CONFLICT",
      detail: "The workflow changed after the curator loaded it. Reload and try again.",
      currentRevision: error.currentRevision,
    };
  }
  if (error instanceof WorkflowStoreError) {
    const status =
      error.code === "NOT_FOUND"
        ? 404
        : error.code === "CONFLICT"
          ? 409
          : error.code === "INVALID_DEFINITION" || error.code === "INVALID_ID"
            ? 400
            : 422;
    reply.code(status);
    return {
      code: `WORKFLOW_${error.code}`,
      detail:
        error.code === "CORRUPT"
          ? "The saved workflow could not be read safely."
          : error.message,
    };
  }
  reply.code(500);
  return {
    code: "SKILL_CURATOR_FAILED",
    detail: "The skill curator could not complete the request.",
  };
}

function parseInstall(value: unknown): SkillCurationInput["install"] {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new SkillCuratorError(400, "INVALID_INSTALL", "install must be an object.");
  }
  const names = stringArray(value.names);
  if (
    typeof value.source !== "string" ||
    !names ||
    (value.ref !== undefined && typeof value.ref !== "string") ||
    (value.scope !== undefined && typeof value.scope !== "string") ||
    (value.stagingToken !== undefined && typeof value.stagingToken !== "string") ||
    (value.replace !== undefined && typeof value.replace !== "boolean") ||
    value.acknowledged !== true
  ) {
    throw new SkillCuratorError(
      400,
      "INVALID_INSTALL",
      "install must carry source, string names, and acknowledged=true; optional fields must use their declared types.",
    );
  }
  return {
    source: value.source,
    names,
    acknowledged: true,
    ...(typeof value.ref === "string" ? { ref: value.ref } : {}),
    ...(typeof value.scope === "string" ? { scope: value.scope } : {}),
    ...(typeof value.stagingToken === "string"
      ? { stagingToken: value.stagingToken }
      : {}),
    ...(typeof value.replace === "boolean" ? { replace: value.replace } : {}),
  };
}

function parseCurationBody(body: unknown): SkillCurationInput {
  if (!isRecord(body)) {
    throw new SkillCuratorError(400, "INVALID_BODY", "A JSON object is required.");
  }
  const nodeIds = stringArray(body.nodeIds);
  const skillRefs = stringArray(body.skillRefs);
  if (!nodeIds || !skillRefs) {
    throw new SkillCuratorError(
      400,
      "INVALID_BODY",
      "nodeIds and skillRefs must be arrays of strings.",
    );
  }
  let mimeographs: SkillCurationInput["mimeographs"];
  if (body.mimeographs !== undefined) {
    if (!isRecord(body.mimeographs)) {
      throw new SkillCuratorError(
        400,
        "INVALID_MIMEOGRAPHS",
        "mimeographs must be an object.",
      );
    }
    const personalityRefs = stringArray(body.mimeographs.personalityRefs);
    if (
      !personalityRefs ||
      (body.mimeographs.mode !== "auto" && body.mimeographs.mode !== "manual")
    ) {
      throw new SkillCuratorError(
        400,
        "INVALID_MIMEOGRAPHS",
        "mimeographs requires mode auto|manual and a string personalityRefs array.",
      );
    }
    mimeographs = {
      mode: body.mimeographs.mode as CuratorMimeographMode,
      personalityRefs,
    };
  }
  return {
    expectedRevision: body.expectedRevision as number,
    nodeIds,
    skillRefs,
    skillsMode: body.skillsMode as CuratorSkillMode,
    ...(body.writeMode !== undefined
      ? { writeMode: body.writeMode as CuratorWriteMode }
      : {}),
    ...(mimeographs ? { mimeographs } : {}),
    ...(body.install !== undefined ? { install: parseInstall(body.install) } : {}),
  };
}

export async function registerSkillCuratorRoutes(app: FastifyInstance): Promise<void> {
  app.get("/skills/curator/capabilities", async () => ({
    promptElevation: promptElevationAdapterStatus(app),
    harness: destHarnessAdapterStatus(app),
    runStateCritiques: {
      readsLiveRunState: true,
      persistedToRunState: false,
      reason:
        "RunState v1 has no critique/evaluation event channel on this build. F11 does not change the frozen contract.",
    },
    durability: {
      available: app.hasRoute({ method: "GET", url: "/durability/settings" }),
      settingsEndpoint: "/durability/settings",
      signalsEndpoint: "/durability/signals",
      ownsStore: false,
      reason: app.hasRoute({ method: "GET", url: "/durability/settings" })
        ? null
        : "Durability settings endpoint not available on this build.",
    },
    modelPresets: {
      available: app.hasRoute({ method: "GET", url: "/model-presets" }),
      endpoint: "/model-presets",
    },
  }));

  app.get<{ Params: { workflowId: string } }>(
    "/skills/curator/workflows/:workflowId",
    async (request, reply) => {
      try {
        const paths = activePaths();
        return readSkillCuratorSnapshot(
          paths.id,
          paths,
          request.params.workflowId,
        );
      } catch (error) {
        return safeError(reply, error);
      }
    },
  );

  app.post<{ Params: { workflowId: string }; Body: unknown }>(
    "/skills/curator/workflows/:workflowId/apply",
    async (request, reply) => {
      try {
        const paths = activePaths();
        return await applySkillCuration(
          paths.id,
          paths,
          request.params.workflowId,
          parseCurationBody(request.body),
        );
      } catch (error) {
        return safeError(reply, error);
      }
    },
  );

  app.post<{ Params: { runId: string }; Body: unknown }>(
    "/skills/curator/autoresearch/runs/:runId/evaluate",
    async (request, reply) => {
      try {
        if (!isRecord(request.body)) {
          throw new SkillCuratorError(400, "INVALID_BODY", "A JSON object is required.");
        }
        const paths = activePaths();
        return evaluateAutoresearchRun(paths.id, request.params.runId, {
          mode: request.body.mode as AutoresearchMonitorMode,
          cycle: request.body.cycle as number,
          maxEvaluations: request.body.maxEvaluations as number,
          ...(request.body.afterSeq !== undefined
            ? { afterSeq: request.body.afterSeq as number }
            : {}),
          ...(request.body.userInput !== undefined
            ? { userInput: request.body.userInput as string }
            : {}),
        });
      } catch (error) {
        return safeError(reply, error);
      }
    },
  );
}
