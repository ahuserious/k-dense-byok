import type { FastifyInstance, FastifyReply } from "fastify";
import type { InterviewAnswer } from "../agent/interview.ts";
import { resolvePaths } from "../projects.ts";
import { currentProjectId } from "../scope.ts";
import { workflowStore } from "./store.ts";
import {
  PromptOptimizationInterviewContract,
  createPromptOptimizationInterviewContract,
  type PromptOptimizationInterviewTransition,
} from "./prompt-opt-interview-contract.ts";

export interface PromptOptimizationInterviewRouteOptions {
  contractForProject?: (projectId: string) => PromptOptimizationInterviewContract;
}

function requirePromptOptimizationNode(
  projectId: string,
  runId: string,
  nodeId: string,
): void {
  const run = workflowStore.readRun(projectId, runId);
  if (!run) throw new Error(`No such workflow run: ${runId}`);
  const node = run.manifest.graph.nodes.find((candidate) => candidate.id === nodeId);
  if (!node || (node as { kind: string }).kind !== "prompt-optimization") {
    throw new Error(`Run ${runId} has no prompt-optimization node ${nodeId}.`);
  }
}

/** In-process endpoint core used by the Fastify route and socket-free tests. */
export async function handlePromptOptimizationInterviewAnswer(input: {
  contract: PromptOptimizationInterviewContract;
  runId: string;
  nodeId: string;
  answer: InterviewAnswer;
}): Promise<PromptOptimizationInterviewTransition> {
  return input.contract.answer(input.runId, input.nodeId, input.answer);
}

function routeError(reply: FastifyReply, error: unknown) {
  const message = error instanceof Error ? error.message : "Prompt optimization interview failed.";
  const status = message.startsWith("No such") || message.includes("no prompt-optimization")
    ? 404
    : message.includes("already")
      ? 409
      : 400;
  reply.code(status).header("Cache-Control", "no-store");
  return { detail: message };
}

/** Run-scoped durable answer routes; index.ts registers this module with one call. */
export async function registerPromptOptimizationInterviewRoutes(
  app: FastifyInstance,
  options: PromptOptimizationInterviewRouteOptions = {},
): Promise<void> {
  const contractForProject = options.contractForProject ?? ((projectId: string) =>
    createPromptOptimizationInterviewContract({
      sandboxPath: resolvePaths(projectId).sandbox,
    }));

  app.get<{ Params: { runId: string; nodeId: string } }>(
    "/dag-workflow-runs/:runId/nodes/:nodeId/prompt-opt-interview",
    async (request, reply) => {
      try {
        const projectId = currentProjectId();
        requirePromptOptimizationNode(projectId, request.params.runId, request.params.nodeId);
        reply.header("Cache-Control", "no-store");
        return {
          state: await contractForProject(projectId).read(
            request.params.runId,
            request.params.nodeId,
          ),
        };
      } catch (error) {
        return routeError(reply, error);
      }
    },
  );

  app.post<{
    Params: { runId: string; nodeId: string };
    Body: InterviewAnswer;
  }>(
    "/dag-workflow-runs/:runId/nodes/:nodeId/prompt-opt-interview/answer",
    async (request, reply) => {
      try {
        const projectId = currentProjectId();
        requirePromptOptimizationNode(projectId, request.params.runId, request.params.nodeId);
        const transition = await handlePromptOptimizationInterviewAnswer({
          contract: contractForProject(projectId),
          runId: request.params.runId,
          nodeId: request.params.nodeId,
          answer: request.body,
        });
        reply.header("Cache-Control", "no-store");
        return transition;
      } catch (error) {
        return routeError(reply, error);
      }
    },
  );
}
