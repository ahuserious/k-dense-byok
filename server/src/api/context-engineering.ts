import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import { activePaths } from "../projects.ts";
import { currentProjectId } from "../scope.ts";
import { getSession, readSessionProfileBinding } from "../agent/session-registry.ts";
import { toHistory } from "../agent/session-history.ts";
import type { LateralPassMessage } from "../context/lateral-pass.ts";
import type { ContextEngineeringProduction } from
  "../workflows/context-watcher-production.ts";

interface LateralPassBody {
  userPrompt?: unknown;
  goal?: unknown;
  openTodos?: unknown;
}

function transcriptForSession(
  sessionFile: string | null | undefined,
  sandboxRoot: string,
  fallback: string,
): LateralPassMessage[] {
  if (!sessionFile || !fs.existsSync(sessionFile)) {
    return [{ role: "user", content: fallback }];
  }
  const messages: LateralPassMessage[] = [];
  for (const message of toHistory(sessionFile, sandboxRoot)) {
    if (message.role === "user" && message.content) {
      messages.push({ role: "user", content: message.content });
      continue;
    }
    if (message.role !== "assistant" || !message.frames) continue;
    const text = message.frames
      .flatMap((frame) => frame.type === "text_delta" ? [frame.delta] : [])
      .join("")
      .trim();
    if (text) messages.push({ role: "assistant", content: text });
    const toolFrames = message.frames.filter((frame) =>
      frame.type === "tool_start" || frame.type === "tool_end"
    );
    if (toolFrames.length > 0) {
      messages.push({ role: "tool", content: JSON.stringify(toolFrames) });
    }
  }
  return messages.length > 0 ? messages : [{ role: "user", content: fallback }];
}

export async function registerContextEngineeringRoutes(
  app: FastifyInstance,
  contextEngineering: ContextEngineeringProduction,
): Promise<void> {
  app.post<{
    Params: { id: string };
    Body: LateralPassBody | null;
  }>("/sessions/:id/lateral-pass", async (request, reply) => {
    const body = request.body;
    if (
      !body || typeof body !== "object" ||
      typeof body.userPrompt !== "string" || !body.userPrompt.trim() ||
      typeof body.goal !== "string" || !body.goal.trim() ||
      !Array.isArray(body.openTodos) ||
      !body.openTodos.every((todo) => typeof todo === "string" && todo.length > 0)
    ) {
      reply.code(400);
      return { detail: "Lateral pass requires a prompt, goal, and string todo list." };
    }
    const projectId = currentProjectId();
    const paths = activePaths();
    const session = await getSession(projectId, paths, request.params.id);
    if (!session) {
      reply.code(404);
      return { detail: "Session not found." };
    }
    const binding = readSessionProfileBinding(paths, request.params.id);
    if (binding.profile !== "main") {
      reply.code(409);
      return { detail: "Lateral pass is available only for ordinary chat sessions." };
    }
    try {
      return await contextEngineering.dispatchLateralPass(projectId, {
        sourceSessionId: request.params.id,
        userPrompt: body.userPrompt,
        goal: body.goal,
        openTodos: [...body.openTodos] as string[],
        transcript: transcriptForSession(
          session.sessionFile,
          paths.sandbox,
          body.userPrompt,
        ),
      });
    } catch (error) {
      reply.code(422);
      return { detail: error instanceof Error ? error.message : "Lateral pass failed." };
    }
  });
}
