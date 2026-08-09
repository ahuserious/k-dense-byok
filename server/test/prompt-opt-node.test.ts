import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import {
  pendingInterviewFor,
  resolveInterview,
} from "../src/agent/interview.ts";
import {
  PromptOptimizationArtifactSchema,
  PromptOptimizationNodeSchema,
  createTypedWorkflowPromptDeliberationPort,
  executePromptOptimizationNode,
  type PromptOptimizationArtifactWriter,
  type PromptOptimizationDeliberationPort,
  type PromptOptimizationNode,
  type PromptOptimizationNodeExecutorContext,
} from "../src/workflows/prompt-opt-node.ts";
import { NodeSpecV1Schema } from "../src/workflows/schema.ts";
import type { WorkflowNodeExecutor } from "../src/workflows/runner.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })
    ),
  );
});

function model(modelId: string) {
  return {
    requested: {
      source: "fixed" as const,
      provider: "openrouter",
      model: modelId,
      auth: { kind: "api-key" as const },
      reasoning: "high" as const,
    },
    resolution: { mode: "exact" as const },
  };
}

function node(overrides: Partial<PromptOptimizationNode> = {}): PromptOptimizationNode {
  return {
    id: "optimize-prompt",
    name: "Optimize target prompt",
    kind: "prompt-optimization",
    terminal: true,
    workspace: { isolation: "read-only", writePaths: [] },
    settings: { version: 1, budget: { maxTokens: 20_000, maxCostUsd: 10 } },
    originalPrompt: "Summarize the experiment.",
    objective: "Make the request precise, falsifiable, and explicit about evidence.",
    iterations: 2,
    fusionDeliberation: {
      enabled: false,
      council: {
        members: [
          { id: "methods", role: "Methods reviewer", model: model("model-a") },
          { id: "critic", role: "Adversarial reviewer", model: model("model-b") },
        ],
        chair: model("model-chair"),
        rounds: 1,
        preserveMinorityReports: true,
      },
      fusion: {
        mode: "kady-panel",
        members: [
          { id: "writer", role: "Prompt writer", model: model("model-a") },
          { id: "judge", role: "Prompt critic", model: model("model-b") },
        ],
        synthesizer: model("model-synthesizer"),
        rounds: 1,
      },
      preserveMinorityReports: true,
    },
    ...overrides,
  };
}

const graph = {
  limits: {
    maxIterations: 20,
    maxModelCalls: 100,
    maxParallelism: 8,
    maxSubagents: 8,
    timeoutMs: 60_000,
    maxTokens: 100_000,
    maxCostUsd: 100,
    maxRetries: 1,
  },
};

const memoryWriter: PromptOptimizationArtifactWriter = async (artifact) => ({
  path: `.kady/workflows/prompt-optimizations/${artifact.executionId}.json`,
  size: Buffer.byteLength(JSON.stringify(artifact)),
  sha256: "a".repeat(64),
  mediaType: "application/json",
});

function iterativeDeliberation(): PromptOptimizationDeliberationPort {
  return {
    async deliberate(input) {
      return {
        candidatePrompt: `${input.currentPrompt} Revision ${input.iteration}.`,
        rationale: `Iteration ${input.iteration} removed ambiguity.`,
      };
    },
  };
}

describe("prompt-optimization node", () => {
  it("round-trips its self-contained NodeSpec-v1-conformant schema fragment", () => {
    const original = node({
      settings: {
        version: 1,
        reasoningEffort: "high",
        hyperparameters: { temperature: 1, top_p: 1, sampling: {} },
        conditions: { exists: [] },
        harness: "pi",
        databases: [],
        skills: { mode: "auto", list: [] },
        subagents: { mode: "auto" },
        autonomy: "strict",
        deliberation: {
          bestOfNPersonalityCount: 2,
          mimeographs: { mode: "auto", personalityRefs: [] },
        },
        billingMode: "inherit",
        budget: { maxTokens: 20_000, maxCostUsd: 10 },
      },
    });
    const roundTripped = JSON.parse(JSON.stringify(original));

    expect(Value.Check(PromptOptimizationNodeSchema, roundTripped)).toBe(true);
    expect(Value.Check(NodeSpecV1Schema, roundTripped.settings)).toBe(true);
    expect(roundTripped).toEqual(original);
  });

  it("pauses for INTERVIEW-USER and makes zero provider calls until answers resume it", async () => {
    const deliberate = vi.fn(iterativeDeliberation().deliberate);
    const events: string[] = [];
    const optimization = executePromptOptimizationNode({
      projectId: "project-a",
      sessionId: "session-a",
      sandboxPath: "/unused",
      runId: "run-a",
      executionId: "execution-a",
      graph,
      node: node({
        iterations: 1,
        interviewUser: {
          title: "Optimization constraints",
          questions: [
            {
              id: "audience",
              type: "single",
              question: "Who is the audience?",
              options: ["domain experts", "general readers"],
              recommended: "domain experts",
              conviction: "strong",
            },
            { id: "must-keep", type: "text", question: "What must remain verbatim?" },
          ],
        },
      }),
      deliberation: { deliberate },
      writeArtifact: memoryWriter,
      onEvent: (event) => {
        events.push(event.type);
      },
      now: () => 100,
    });

    const pending = pendingInterviewFor("project-a", "session-a");
    expect(pending?.payload.description).toMatch(/^Prompt optimization · /);
    expect(deliberate).not.toHaveBeenCalled();
    expect(events).toEqual(["run_waiting"]);

    expect(
      resolveInterview("project-a", "session-a", pending!.toolCallId, {
        responses: [
          { id: "audience", value: "domain experts" },
          { id: "must-keep", value: "Keep the experiment name." },
        ],
      }),
    ).toBe(true);

    const result = await optimization;
    expect(deliberate).toHaveBeenCalledTimes(1);
    expect(deliberate.mock.calls[0][0].interview).toEqual({
      cancelled: false,
      responses: [
        { id: "audience", value: "domain experts" },
        { id: "must-keep", value: "Keep the experiment name." },
      ],
    });
    expect(result.artifact.interview).toEqual(
      deliberate.mock.calls[0][0].interview,
    );
    expect(events).toEqual(["run_waiting", "run_resumed"]);
  });

  it("routes the toggle to council or fusion deliberation with mock providers", async () => {
    const providerKinds: string[] = [];
    const typedExecutor: WorkflowNodeExecutor = async (context) => {
      providerKinds.push(context.node.kind);
      for (const slot of context.expectedModelCallSlots) {
        const requested = slot.request.requested;
        context.recordModelResolution(slot.id, {
          request: slot.request,
          resolved: {
            provider: requested.source === "fixed" ? requested.provider : "openrouter",
            model: requested.source === "fixed" ? requested.model : "current",
            auth: { kind: requested.auth.kind },
            reasoning: requested.reasoning,
            runtime: context.node.kind === "fusion" ? "kady-fusion" : "pi",
          },
          fallbackUsed: false,
        });
      }
      return context.node.kind === "council"
        ? {
            output: {
              decision: "council optimized prompt",
              rationale: "council scored and synthesized the candidates.",
            },
          }
        : {
            output: {
              answer: "fusion optimized prompt",
              rationale: "fusion scored and synthesized the candidates.",
            },
          };
    };
    const sourceContext: PromptOptimizationNodeExecutorContext = {
      projectId: "project-a",
      runId: "run-source",
      workflowId: "workflow-a",
      workflowRevision: 1,
      graph: {
        id: "workflow-a",
        limits: graph.limits,
        evidence: {
          enabled: false,
          minimumIndependentSources: 0,
          requireArtifactReferences: false,
          onUnsupportedOutput: "fail",
        },
      },
      node: node({ iterations: 1 }),
      runInput: {},
      attempt: 1,
      executionId: "execution-source",
      branchId: "entry",
      resumed: false,
      inbound: [],
      expectedModelCallSlots: [],
      declareModelCallSlot() {
        throw new Error("The outer prompt node has no direct slots.");
      },
      recordModelResolution() {
        throw new Error("The outer prompt node has no direct slots.");
      },
      recordCompactionCheck() {},
      signal: new AbortController().signal,
    };
    const deliberation = createTypedWorkflowPromptDeliberationPort(
      typedExecutor,
      sourceContext,
    );
    const common = {
      projectId: "project-a",
      sandboxPath: "/unused",
      graph,
      deliberation,
      writeArtifact: memoryWriter,
      now: () => 100,
    };

    await executePromptOptimizationNode({
      ...common,
      runId: "run-council",
      executionId: "execution-council",
      node: node({ iterations: 1 }),
    });
    await executePromptOptimizationNode({
      ...common,
      runId: "run-fusion",
      executionId: "execution-fusion",
      node: node({
        iterations: 1,
        fusionDeliberation: {
          ...node().fusionDeliberation,
          enabled: true,
        },
      }),
    });

    expect(providerKinds).toEqual(["council", "fusion"]);
  });

  it("writes the versioned artifact and surfaces its runtime-owned reference in a RunState event", async () => {
    const sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "prompt-opt-test-"));
    temporaryDirectories.push(sandboxPath);
    const result = await executePromptOptimizationNode({
      projectId: "project-a",
      sandboxPath,
      runId: "run-artifact",
      executionId: "execution-artifact",
      graph,
      node: node(),
      deliberation: iterativeDeliberation(),
      now: () => 123_456,
    });

    expect(Value.Check(PromptOptimizationArtifactSchema, result.artifact)).toBe(true);
    expect(result.artifact).toMatchObject({
      schemaVersion: 1,
      artifactVersion: 1,
      originalPrompt: "Summarize the experiment.",
      winningPrompt: "Summarize the experiment. Revision 1. Revision 2.",
      rationale: "Iteration 2 removed ambiguity.",
      createdAt: 123_456,
    });
    expect(result.artifact.iterations).toHaveLength(2);

    const stored = JSON.parse(
      await fs.readFile(
        path.join(sandboxPath, ...result.artifactReference.path.split("/")),
        "utf8",
      ),
    );
    expect(stored).toEqual(result.artifact);
    expect(result.completionEvent).toMatchObject({
      type: "node_succeeded",
      nodeId: "optimize-prompt",
      data: {
        routeCondition: "success",
        output: {
          kind: "prompt-optimization",
          schemaVersion: 1,
          artifactVersion: 1,
          artifact: result.artifactReference,
          winningPrompt: result.artifact.winningPrompt,
        },
      },
    });
  });
});
