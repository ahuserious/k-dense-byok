import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import {
  PromptOptimizationArtifactSchema,
  PromptOptimizationEnvelopeError,
  PromptOptimizationNodeSchema,
  createTypedWorkflowPromptDeliberationPort,
  executePromptOptimizationNode,
  validatePromptOptimizationNode,
  type PromptOptimizationArtifactWriter,
  type PromptOptimizationDeliberationPort,
  type PromptOptimizationNode,
  type PromptOptimizationNodeExecutorContext,
} from "../src/workflows/prompt-opt-node.ts";
import { createPromptOptimizationInterviewContract } from "../src/workflows/prompt-opt-interview-contract.ts";
import { handlePromptOptimizationInterviewAnswer } from "../src/workflows/prompt-opt-interview-api.ts";
import {
  promptOptimizationModelCallSlots,
} from "../src/workflows/prompt-opt-model-slots.ts";
import { NodeSpecV1Schema, type WorkflowGraphDocument } from "../src/workflows/schema.ts";
import type { WorkflowModelResolutionReceipt } from "../src/workflows/run-state.ts";
import type { WorkflowNodeExecutor } from "../src/workflows/runner.ts";
import type { WorkflowValidationIssue } from "../src/workflows/validate.ts";

const temporaryDirectories: string[] = [];
const artifactPath = ".kady/workflows/prompt-optimizations/result.json";
const discardDurableEvent = async () => {};

type PromptRunStateEvent = {
  type: "model_call_declared" | "model_resolved";
  slotId: string;
  receipt?: WorkflowModelResolutionReceipt;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })
  ));
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
    workspace: {
      isolation: "isolated-worktree",
      writePaths: [".kady/workflows/prompt-optimizations"],
    },
    settings: { version: 1, budget: { maxTokens: 20_000, maxCostUsd: 10 } },
    originalPrompt: "Summarize the experiment.",
    objective: "Make the request precise, falsifiable, and explicit about evidence.",
    artifactId: "prompt-artifact",
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

function graph(overrides: Record<string, unknown> = {}) {
  return {
    id: "workflow-a",
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
    evidence: {
      enabled: false,
      minimumIndependentSources: 0,
      requireArtifactReferences: false,
      onUnsupportedOutput: "fail" as const,
    },
    artifacts: [{
      id: "prompt-artifact",
      kind: "report" as const,
      writerNodeId: "optimize-prompt",
      path: artifactPath,
    }],
    ...overrides,
  };
}

function sourceContextFor(
  promptNode: PromptOptimizationNode,
  events: PromptRunStateEvent[] = [],
): PromptOptimizationNodeExecutorContext {
  const expectedModelCallSlots = promptOptimizationModelCallSlots(promptNode);
  return {
    projectId: "project-a",
    runId: "run-source",
    workflowId: "workflow-a",
    workflowRevision: 1,
    graph: graph(),
    node: promptNode,
    runInput: {},
    attempt: 1,
    executionId: "execution-source",
    writeDurableEvent: discardDurableEvent,
    branchId: "entry",
    resumed: false,
    inbound: [],
    expectedModelCallSlots,
    declareModelCallSlot(slotId) {
      const slot = expectedModelCallSlots.find((candidate) => candidate.id === slotId);
      if (!slot) throw new Error(`Unknown outer prompt slot ${slotId}.`);
      events.push({ type: "model_call_declared", slotId });
      return structuredClone(slot);
    },
    recordModelResolution(slotId, receipt) {
      if (!expectedModelCallSlots.some((slot) => slot.id === slotId)) {
        throw new Error(`Unknown outer prompt receipt ${slotId}.`);
      }
      events.push({ type: "model_resolved", slotId, receipt: structuredClone(receipt) });
    },
    recordCompactionCheck() {},
    signal: new AbortController().signal,
  } as unknown as PromptOptimizationNodeExecutorContext;
}

const memoryWriter: PromptOptimizationArtifactWriter = async (artifact, context) => ({
  path: context.artifactPath,
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
        usage: { tokens: 1, costUsd: 0.01 },
      };
    },
  };
}

async function temporarySandbox(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "prompt-opt-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function waitForPersistedInterview(
  contract: ReturnType<typeof createPromptOptimizationInterviewContract>,
  runId: string,
  nodeId: string,
) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const state = await contract.read(runId, nodeId);
    if (state) return state;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Interview was not persisted.");
}

describe("prompt-optimization node", () => {
  it("round-trips its self-contained NodeSpec-v1 schema fragment", () => {
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
    expect(roundTripped.artifactId).toBe("prompt-artifact");
  });

  it("rejects enabled or overridden evidence before any provider call", async () => {
    const deliberate = vi.fn(iterativeDeliberation().deliberate);
    const evidenceGraph = graph({ evidence: { ...graph().evidence, enabled: true } });
    const issues: WorkflowValidationIssue[] = [];
    validatePromptOptimizationNode(node(), "/nodes/0", evidenceGraph, issues);
    expect(issues).toContainEqual(expect.objectContaining({
      code: "prompt-optimization-evidence-policy-unsupported",
    }));
    const overrideIssues: WorkflowValidationIssue[] = [];
    validatePromptOptimizationNode(node({ evidence: graph().evidence }), "/nodes/0", graph(), overrideIssues);
    expect(overrideIssues).toContainEqual(expect.objectContaining({
      code: "prompt-optimization-evidence-policy-unsupported",
      path: "/nodes/0/evidence",
    }));
    await expect(executePromptOptimizationNode({
      projectId: "project-a",
      sandboxPath: "/unused",
      runId: "run-evidence",
      executionId: "execution-evidence",
      attempt: 1,
      graph: evidenceGraph,
      node: node(),
      deliberation: { deliberate },
      writeDurableEvent: discardDurableEvent,
      writeArtifact: memoryWriter,
    })).rejects.toThrow(/evidence-policy-unsupported/);
    expect(deliberate).not.toHaveBeenCalled();
  });

  it("rejects interview placement on a parallel path while accepting a linear path", () => {
    const interviewNode = node({
      iterations: 1,
      interviewUser: {
        title: "Constraints",
        questions: [{ id: "scope", type: "text", question: "Scope?" }],
      },
    });
    const root = {
      id: "root",
      name: "Root",
      kind: "agent",
      terminal: false,
      workspace: { isolation: "read-only", writePaths: [] },
      prompt: "Start.",
    } as const;
    const sibling = {
      id: "sibling",
      name: "Sibling",
      kind: "agent",
      terminal: true,
      workspace: { isolation: "read-only", writePaths: [] },
      prompt: "Concurrent work.",
    } as const;
    const linearDocument = {
      ...graph(),
      nodes: [root, interviewNode],
      edges: [{ id: "root-to-opt", from: "root", to: interviewNode.id }],
    } as unknown as WorkflowGraphDocument;
    const linearIssues: WorkflowValidationIssue[] = [];
    validatePromptOptimizationNode(interviewNode, "/nodes/1", linearDocument, linearIssues);
    expect(linearIssues).not.toContainEqual(expect.objectContaining({
      code: "prompt-optimization-interview-parallel-path-unsupported",
    }));

    const forkedDocument = {
      ...graph(),
      nodes: [root, interviewNode, sibling],
      edges: [
        { id: "root-to-opt", from: "root", to: interviewNode.id },
        { id: "root-to-sibling", from: "root", to: sibling.id },
      ],
    } as unknown as WorkflowGraphDocument;
    const forkedIssues: WorkflowValidationIssue[] = [];
    validatePromptOptimizationNode(interviewNode, "/nodes/1", forkedDocument, forkedIssues);
    expect(forkedIssues).toContainEqual(expect.objectContaining({
      code: "prompt-optimization-interview-parallel-path-unsupported",
      path: "/nodes/1/interviewUser",
      message: expect.stringContaining("run-level waiting"),
    }));
  });

  it("fails at node start when the runner did not supply a durable event writer", async () => {
    const deliberate = vi.fn(iterativeDeliberation().deliberate);
    await expect(executePromptOptimizationNode({
      projectId: "project-a",
      sandboxPath: "/unused",
      runId: "run-no-writer",
      executionId: "execution-no-writer",
      attempt: 1,
      graph: graph(),
      node: node({ iterations: 1 }),
      deliberation: { deliberate },
      writeDurableEvent: undefined as never,
      writeArtifact: memoryWriter,
    })).rejects.toThrow("PROMPT_OPTIMIZATION_DURABLE_EVENT_WRITER_REQUIRED");
    expect(deliberate).not.toHaveBeenCalled();
  });

  it("enforces one cumulative token/cost cap across iterations", async () => {
    const writeArtifact = vi.fn(memoryWriter);
    const deliberate = vi.fn(async (input: Parameters<PromptOptimizationDeliberationPort["deliberate"]>[0]) => ({
      candidatePrompt: `${input.currentPrompt} bounded`,
      rationale: "bounded",
      usage: {
        tokens: input.iteration === 1 ? input.limits.maxTokens : input.limits.maxTokens + 1,
        costUsd: input.limits.maxCostUsd,
      },
    }));
    await expect(executePromptOptimizationNode({
      projectId: "project-a",
      sandboxPath: "/unused",
      runId: "run-cap",
      executionId: "execution-cap",
      attempt: 1,
      graph: graph(),
      node: node({
        iterations: 3,
        settings: { version: 1, budget: { maxTokens: 6, maxCostUsd: 3 } },
      }),
      deliberation: { deliberate },
      writeDurableEvent: discardDurableEvent,
      writeArtifact,
      now: () => 1_000,
    })).rejects.toMatchObject({
      name: "PromptOptimizationEnvelopeError",
      code: "PROMPT_OPTIMIZATION_ENVELOPE_EXHAUSTED",
      completedIterations: 1,
    } satisfies Partial<PromptOptimizationEnvelopeError>);
    expect(deliberate).toHaveBeenCalledTimes(2);
    expect(deliberate.mock.calls[0][0].remaining.maxTokens).toBe(6);
    expect(deliberate.mock.calls[1][0].remaining.maxTokens).toBe(4);
    expect(writeArtifact).not.toHaveBeenCalled();
  });

  it("pauses durably, makes zero provider calls, and counts interview time", async () => {
    const sandboxPath = await temporarySandbox();
    let clock = 1_000;
    const contract = createPromptOptimizationInterviewContract({
      sandboxPath,
      now: () => clock,
      pollIntervalMs: 5,
    });
    const deliberate = vi.fn(iterativeDeliberation().deliberate);
    const execution = executePromptOptimizationNode({
      projectId: "project-a",
      sandboxPath,
      runId: "run-interview",
      executionId: "execution-interview",
      attempt: 1,
      graph: graph({ limits: { ...graph().limits, timeoutMs: 10_000 } }),
      node: node({
        iterations: 1,
        interviewUser: {
          title: "Optimization constraints",
          questions: [{ id: "audience", type: "text", question: "Audience?" }],
        },
      }),
      deliberation: { deliberate },
      writeDurableEvent: discardDurableEvent,
      interviewContract: contract,
      writeArtifact: memoryWriter,
      now: () => clock,
    });
    await waitForPersistedInterview(contract, "run-interview", "optimize-prompt");
    expect(deliberate).not.toHaveBeenCalled();
    clock = 5_000;
    await handlePromptOptimizationInterviewAnswer({
      contract,
      runId: "run-interview",
      nodeId: "optimize-prompt",
      answer: { responses: [{ id: "audience", value: "domain experts" }] },
    });
    await execution;
    expect(deliberate).toHaveBeenCalledTimes(1);
    expect(deliberate.mock.calls[0][0].remaining.timeoutMs).toBe(6_000);
    expect(deliberate.mock.calls[0][0].interview?.responses[0].value).toBe("domain experts");
  });

  it("feeds durable interview timeout into the cumulative envelope with zero provider calls", async () => {
    const sandboxPath = await temporarySandbox();
    let clock = 1_000;
    const contract = createPromptOptimizationInterviewContract({
      sandboxPath,
      now: () => clock,
      pollIntervalMs: 5,
    });
    const deliberate = vi.fn(iterativeDeliberation().deliberate);
    const execution = executePromptOptimizationNode({
      projectId: "project-a",
      sandboxPath,
      runId: "run-interview-timeout",
      executionId: "execution-interview-timeout",
      attempt: 1,
      graph: graph({ limits: { ...graph().limits, timeoutMs: 10_000 } }),
      node: node({
        iterations: 1,
        interviewUser: {
          title: "Optimization constraints",
          questions: [{ id: "audience", type: "text", question: "Audience?" }],
        },
      }),
      deliberation: { deliberate },
      writeDurableEvent: discardDurableEvent,
      interviewContract: contract,
      writeArtifact: memoryWriter,
      now: () => clock,
    });
    await waitForPersistedInterview(contract, "run-interview-timeout", "optimize-prompt");
    clock = 11_000;
    await expect(execution).rejects.toMatchObject({
      name: "PromptOptimizationEnvelopeError",
      completedIterations: 0,
    });
    expect(deliberate).not.toHaveBeenCalled();
  });

  it("reuses answered interview state after a retryable post-answer failure", async () => {
    const sandboxPath = await temporarySandbox();
    const contract = createPromptOptimizationInterviewContract({
      sandboxPath,
      now: () => 1_000,
      pollIntervalMs: 5,
    });
    const questions = {
      title: "Optimization constraints",
      questions: [{ id: "audience", type: "text" as const, question: "Audience?" }],
    };
    const writeDurableEvent = vi.fn(discardDurableEvent);
    const firstDeliberation = vi.fn(async () => {
      throw new Error("retryable failure after interview");
    });
    const firstAttempt = executePromptOptimizationNode({
      projectId: "project-a",
      sandboxPath,
      runId: "run-answer-retry",
      executionId: "execution-attempt-1",
      attempt: 1,
      graph: graph(),
      node: node({ iterations: 1, interviewUser: questions }),
      deliberation: { deliberate: firstDeliberation },
      writeDurableEvent,
      interviewContract: contract,
      writeArtifact: memoryWriter,
      now: () => 1_000,
    });
    await waitForPersistedInterview(contract, "run-answer-retry", "optimize-prompt");
    await handlePromptOptimizationInterviewAnswer({
      contract,
      runId: "run-answer-retry",
      nodeId: "optimize-prompt",
      answer: { responses: [{ id: "audience", value: "domain experts" }] },
    });
    await expect(firstAttempt).rejects.toThrow("retryable failure after interview");

    const secondDeliberation = vi.fn(iterativeDeliberation().deliberate);
    const secondAttempt = await executePromptOptimizationNode({
      projectId: "project-a",
      sandboxPath,
      runId: "run-answer-retry",
      executionId: "execution-attempt-2",
      attempt: 2,
      graph: graph(),
      node: node({ iterations: 1, interviewUser: structuredClone(questions) }),
      deliberation: { deliberate: secondDeliberation },
      writeDurableEvent,
      interviewContract: contract,
      writeArtifact: memoryWriter,
      now: () => 1_000,
    });
    expect(secondDeliberation).toHaveBeenCalledTimes(1);
    expect(secondDeliberation.mock.calls[0][0].interview?.responses).toEqual([
      { id: "audience", value: "domain experts" },
    ]);
    expect(secondAttempt.artifact.interview?.responses[0].value).toBe("domain experts");
    // The retry reused answers and therefore did not create a second pause/resume pair.
    expect(writeDurableEvent).toHaveBeenCalledTimes(2);
  });

  it("routes the toggle through typed council/fusion and propagates policies", async () => {
    const seen: Array<PromptOptimizationNodeExecutorContext["node"]> = [];
    const typedExecutor: WorkflowNodeExecutor = async (context) => {
      seen.push(context.node as unknown as PromptOptimizationNode);
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
        ? { output: { decision: "council prompt", rationale: "council rationale" } }
        : { output: { answer: "fusion prompt", rationale: "fusion rationale" } };
    };
    const parent = node({
      iterations: 1,
      rescue: { enabled: true, maxAttempts: 1, triggers: ["failure"] },
      settings: {
        version: 1,
        reasoningEffort: "high",
        skills: { mode: "auto", list: [] },
        budget: { maxTokens: 2_000, maxCostUsd: 2 },
      },
    });
    for (const enabled of [false, true]) {
      const executionNode = node({
        ...parent,
        fusionDeliberation: { ...parent.fusionDeliberation, enabled },
      });
      const sourceContext = sourceContextFor(executionNode);
      const deliberation = createTypedWorkflowPromptDeliberationPort(typedExecutor, sourceContext);
      await executePromptOptimizationNode({
        projectId: "project-a",
        sandboxPath: "/unused",
        runId: enabled ? "run-fusion" : "run-council",
        executionId: enabled ? "execution-fusion" : "execution-council",
        attempt: 1,
        graph: graph(),
        node: executionNode,
        deliberation,
        writeDurableEvent: discardDurableEvent,
        writeArtifact: memoryWriter,
        now: () => 1_000,
      });
    }
    expect(seen.map((synthetic) => synthetic.kind)).toEqual(["council", "fusion"]);
    for (const synthetic of seen) {
      expect(synthetic.workspace).toEqual({ isolation: "read-only", writePaths: [] });
      expect(synthetic.rescue).toEqual(parent.rescue);
      expect(synthetic.evidence).toEqual(graph().evidence);
      expect(synthetic.settings?.skills).toEqual(parent.settings?.skills);
      expect(synthetic.settings?.budget?.maxTokens).toBeLessThanOrEqual(2_000);
    }
  });

  it("executes configured council and Kady-panel child rounds while the outer cap stays separate", async () => {
    const seen: Array<{ kind: string; nodeRounds: number; graphRounds: number; slots: number }> = [];
    const typedExecutor: WorkflowNodeExecutor = async (context) => {
      const nodeRounds = context.node.kind === "council"
        ? context.node.rounds
        : context.node.kind === "fusion" && context.node.fusion.mode === "kady-panel"
          ? context.node.fusion.rounds
          : 1;
      seen.push({
        kind: context.node.kind,
        nodeRounds,
        graphRounds: context.graph.limits.maxIterations,
        slots: context.expectedModelCallSlots.length,
      });
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
        ? { output: { decision: "council rounds prompt", rationale: "two rounds" } }
        : { output: { answer: "fusion rounds prompt", rationale: "three rounds" } };
    };

    const councilNode = node({
      iterations: 1,
      fusionDeliberation: {
        ...node().fusionDeliberation,
        enabled: false,
        council: { ...node().fusionDeliberation.council, rounds: 2 },
      },
    });
    const fusionNode = node({
      iterations: 1,
      fusionDeliberation: {
        ...node().fusionDeliberation,
        enabled: true,
        fusion: { ...node().fusionDeliberation.fusion!, rounds: 3 },
      },
    });
    for (const executionNode of [councilNode, fusionNode]) {
      const sourceContext = sourceContextFor(executionNode);
      await executePromptOptimizationNode({
        projectId: "project-a",
        sandboxPath: "/unused",
        runId: `run-rounds-${executionNode.fusionDeliberation.enabled ? "fusion" : "council"}`,
        executionId: `execution-rounds-${executionNode.fusionDeliberation.enabled ? "fusion" : "council"}`,
        attempt: 1,
        graph: graph(),
        node: executionNode,
        deliberation: createTypedWorkflowPromptDeliberationPort(typedExecutor, sourceContext),
        writeDurableEvent: discardDurableEvent,
        writeArtifact: memoryWriter,
        now: () => 1_000,
      });
    }
    expect(seen).toEqual([
      { kind: "council", nodeRounds: 2, graphRounds: 2, slots: 6 },
      { kind: "fusion", nodeRounds: 3, graphRounds: 3, slots: 7 },
    ]);

    const capIssues: WorkflowValidationIssue[] = [];
    validatePromptOptimizationNode(
      node({
        iterations: 2,
        fusionDeliberation: councilNode.fusionDeliberation,
      }),
      "/nodes/0",
      graph({ limits: { ...graph().limits, maxIterations: 1 } }),
      capIssues,
    );
    expect(capIssues).toContainEqual(expect.objectContaining({
      code: "prompt-optimization-iteration-demand-exceeds-limit",
    }));
  });

  it("maps every synthetic call to one declared and resolved outer RunState receipt", async () => {
    const runStateEvents: PromptRunStateEvent[] = [];
    const receiptNode = node({
      iterations: 2,
      fusionDeliberation: {
        ...node().fusionDeliberation,
        council: { ...node().fusionDeliberation.council, rounds: 2 },
      },
    });
    const sourceContext = sourceContextFor(receiptNode, runStateEvents);
    const typedExecutor: WorkflowNodeExecutor = async (context) => {
      for (const slot of context.expectedModelCallSlots) {
        const requested = slot.request.requested;
        context.recordModelResolution(slot.id, {
          request: slot.request,
          resolved: {
            provider: requested.source === "fixed" ? requested.provider : "openrouter",
            model: requested.source === "fixed" ? requested.model : "current",
            auth: { kind: requested.auth.kind },
            reasoning: requested.reasoning,
            runtime: "pi",
          },
          fallbackUsed: false,
        });
      }
      return { output: { decision: "receipt-backed prompt", rationale: "auditable" } };
    };
    const result = await executePromptOptimizationNode({
      projectId: "project-a",
      sandboxPath: "/unused",
      runId: "run-receipts",
      executionId: "execution-receipts",
      attempt: 1,
      graph: graph(),
      node: receiptNode,
      deliberation: createTypedWorkflowPromptDeliberationPort(typedExecutor, sourceContext),
      writeDurableEvent: discardDurableEvent,
      writeArtifact: memoryWriter,
      now: () => 1_000,
    });
    expect(result.artifact.iterations).toHaveLength(2);
    const expectedSlotIds = promptOptimizationModelCallSlots(receiptNode).map((slot) => slot.id);
    expect(runStateEvents.filter((event) => event.type === "model_call_declared").map((event) => event.slotId))
      .toEqual(expectedSlotIds);
    expect(runStateEvents.filter((event) => event.type === "model_resolved").map((event) => event.slotId))
      .toEqual(expectedSlotIds);
    expect(runStateEvents.filter((event) => event.type === "model_resolved").map((event) => event.receipt))
      .toEqual(expectedSlotIds.map(() => expect.objectContaining({
        fallbackUsed: false,
        request: expect.objectContaining({ requested: expect.objectContaining({ provider: "openrouter" }) }),
        resolved: expect.objectContaining({ provider: "openrouter", runtime: "pi" }),
      })));
  });

  it("writes the declared artifact with a normalized receipt and RunState event", async () => {
    const sandboxPath = await temporarySandbox();
    const result = await executePromptOptimizationNode({
      projectId: "project-a",
      sandboxPath,
      runId: "run-artifact",
      executionId: "execution-artifact",
      attempt: 1,
      graph: graph(),
      node: node(),
      deliberation: iterativeDeliberation(),
      writeDurableEvent: discardDurableEvent,
      now: () => 123_456,
    });
    expect(Value.Check(PromptOptimizationArtifactSchema, result.artifact)).toBe(true);
    expect(result.artifact).toMatchObject({
      schemaVersion: 1,
      artifactVersion: 1,
      originalPrompt: "Summarize the experiment.",
      winningPrompt: "Summarize the experiment. Revision 1. Revision 2.",
      envelope: { spentTokens: 2, spentCostUsd: 0.02 },
    });
    expect(result.artifactReference).toMatchObject({
      path: artifactPath,
      size: expect.any(Number),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(result.artifacts).toEqual([result.artifactReference]);
    expect(JSON.parse(await fs.readFile(path.join(sandboxPath, artifactPath), "utf8")))
      .toEqual(result.artifact);
    expect(result.completionEvent.data?.artifacts).toEqual([result.artifactReference]);
  });

  it("leaves no orphaned declared artifact when deliberation fails mid-run", async () => {
    const sandboxPath = await temporarySandbox();
    let calls = 0;
    await expect(executePromptOptimizationNode({
      projectId: "project-a",
      sandboxPath,
      runId: "run-failure",
      executionId: "execution-failure",
      attempt: 1,
      graph: graph(),
      node: node(),
      deliberation: {
        async deliberate(input) {
          calls += 1;
          if (calls === 2) throw new Error("provider failed");
          return {
            candidatePrompt: `${input.currentPrompt} first`,
            rationale: "first",
            usage: { tokens: 1, costUsd: 0 },
          };
        },
      },
      writeDurableEvent: discardDurableEvent,
      now: () => 1_000,
    })).rejects.toThrow("provider failed");
    await expect(fs.stat(path.join(sandboxPath, artifactPath))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
