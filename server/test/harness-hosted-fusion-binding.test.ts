/**
 * Gap (B) of the harness binding: hosted-Fusion-only nodes.
 *
 * `kady-node-executor.ts` requests a delegation session only when
 * `requiresPiSubagent` — `callCeiling > 0 && !hostedFusionWithoutPolicyEvaluator`.
 * A hosted-Fusion node served entirely by the OpenRouter router therefore never
 * reached the dispatch decision, and `harness` was accepted and discarded for it
 * on every transport: exactly the shape of #55.
 *
 * NodeSpec v1 ("What BOUND will mean", condition 6) permits two closures. The
 * one taken here is the second: such a node starts no CLI process for any
 * harness to be, so a non-`pi` declaration is refused at validation with a
 * message naming the next action. These are the pins that it is refused, that
 * inheritance is refused the same way, and that `pi` and evaluator-bearing
 * hosted-Fusion nodes are untouched.
 */
import { describe, expect, it } from "vitest";
import {
  validateWorkflowGraphDocument,
  type ModelRequest,
  type WorkflowGraphDocument,
  type WorkflowNode,
  type WorkflowValidationResult,
} from "../src/workflows/index.ts";
import type { WorkflowHarness } from "../src/agent/workflow-delegation-session.ts";

function openRouterModel(model = "anthropic/claude-sonnet-4"): ModelRequest {
  return {
    requested: {
      source: "fixed",
      provider: "openrouter",
      model,
      auth: { kind: "api-key" },
      reasoning: "high",
    },
    resolution: { mode: "exact" },
  } as ModelRequest;
}

interface HostedFusionGraphOptions {
  harness?: WorkflowHarness;
  defaultHarness?: WorkflowHarness;
  /** Enabling evidence gives the node a policy-evaluator slot and a Pi child. */
  evidence?: boolean;
}

function hostedFusionGraph(options: HostedFusionGraphOptions): WorkflowGraphDocument {
  const node: WorkflowNode = {
    id: "fuse",
    name: "Fuse",
    kind: "fusion",
    terminal: true,
    workspace: { isolation: "read-only", writePaths: [] },
    goal: "Fuse the independent analyses.",
    preserveMinorityReports: false,
    fusion: {
      mode: "openrouter-router",
      router: openRouterModel("openrouter/fusion"),
      members: [
        { id: "analyst", role: "Analyst", model: openRouterModel() },
        { id: "critic", role: "Critic", model: openRouterModel("openai/gpt-5") },
      ],
      judge: openRouterModel("anthropic/claude-opus-4"),
    },
    ...(options.harness ? { settings: { harness: options.harness } } : {}),
  } as unknown as WorkflowNode;
  return {
    ...(options.defaultHarness
      ? { settings: { defaultHarness: options.defaultHarness } }
      : {}),
    schemaVersion: "1.0",
    id: "hosted-fusion-harness",
    name: "Hosted fusion harness graph",
    entryNodeId: node.id,
    defaultModel: openRouterModel(),
    limits: {
      maxIterations: 4,
      maxModelCalls: 32,
      maxParallelism: 4,
      maxSubagents: 4,
      timeoutMs: 30_000,
      maxTokens: 32_000,
      maxCostUsd: 8,
      maxRetries: 1,
    },
    evidence: {
      enabled: options.evidence ?? false,
      minimumIndependentSources: options.evidence ? 1 : 0,
      requireArtifactReferences: false,
      onUnsupportedOutput: "route",
    },
    nodes: [node],
    edges: [],
  } as unknown as WorkflowGraphDocument;
}

function issues(result: WorkflowValidationResult): Array<{ code: string; message: string }> {
  return result.ok ? [] : result.issues.map(({ code, message }) => ({ code, message }));
}

describe("harness on a hosted-Fusion-only node", () => {
  it("accepts the baseline graph with no harness declared", () => {
    expect(validateWorkflowGraphDocument(hostedFusionGraph({})).ok).toBe(true);
  });

  it("accepts an explicit pi harness, which is what such a node can honour", () => {
    expect(validateWorkflowGraphDocument(hostedFusionGraph({ harness: "pi" })).ok)
      .toBe(true);
  });

  it.each(["claude-code", "grok-cli", "deepseek", "oh-my-pi", "codex"] as const)(
    "refuses %s on the node, naming the next action",
    (harness: WorkflowHarness) => {
      const result = validateWorkflowGraphDocument(hostedFusionGraph({ harness }));
      expect(result.ok).toBe(false);
      const found = issues(result).find(
        (issue) => issue.code === "unreachable-node-harness",
      );
      expect(found).toBeDefined();
      expect(found?.message).toContain("Set this node's harness to pi");
      // The message names the harness by its label, not by its raw literal.
      expect(found?.message).not.toContain(`"${harness}"`);
    },
  );

  it("refuses an inherited defaultHarness the same way, on its own path", () => {
    const result = validateWorkflowGraphDocument(
      hostedFusionGraph({ defaultHarness: "grok-cli" }),
    );
    expect(result.ok).toBe(false);
    const found = issues(result).find(
      (issue) => issue.code === "unreachable-inherited-harness",
    );
    expect(found).toBeDefined();
    expect(found?.message).toContain("Grok CLI");
  });

  it("lets a node's own pi win over a non-pi workflow default", () => {
    const result = validateWorkflowGraphDocument(
      hostedFusionGraph({ harness: "pi", defaultHarness: "grok-cli" }),
    );
    expect(issues(result).map((issue) => issue.code))
      .not.toContain("unreachable-node-harness");
    expect(issues(result).map((issue) => issue.code))
      .not.toContain("unreachable-inherited-harness");
  });

  it("does not refuse a hosted-Fusion node that does have a Pi child", () => {
    // Evidence-policy evaluation gives the node a delegated evaluator, so it
    // reaches the executor's dispatch decision the ordinary way and the harness
    // is not inert for it.
    const result = validateWorkflowGraphDocument(
      hostedFusionGraph({ harness: "grok-cli", evidence: true }),
    );
    expect(issues(result).map((issue) => issue.code))
      .not.toContain("unreachable-node-harness");
  });
});
