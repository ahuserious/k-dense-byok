/**
 * Gap (B) of the harness binding: every node that reaches no dispatch decision.
 *
 * `kady-node-executor.ts` requests a delegation session only when
 * `requiresPiSubagent` — `callCeiling > 0 && !hostedFusionWithoutPolicyEvaluator`.
 * When that is false, `harness` is accepted and discarded on every transport:
 * exactly the shape of #55.
 *
 * Round 1 closed only the second conjunct, so a `lean4` node with
 * `mode: "verify"` and an `evidence-gate` with no evaluator and only
 * `artifact-exists` checks still accepted `harness: "grok-cli"` with zero
 * issues and then dropped it. Both conjuncts are closed now, and both the
 * validator and the executor compute the predicate from
 * `workflowHarnessDispatchReachability`, so they cannot drift.
 *
 * NodeSpec v1 ("What BOUND will mean", condition 6) permits two closures. The
 * one taken here is the second: such a node starts no CLI process for any
 * harness to be, so a non-`pi` declaration is refused at validation with a
 * message naming the next action. These are the pins that it is refused, that
 * inheritance is refused the same way, and that `pi`, evaluator-bearing
 * hosted-Fusion nodes, `lean4` *solve* nodes and evaluating evidence gates are
 * untouched.
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

/**
 * The other half of the predicate: `callCeiling === 0`.
 *
 * These are the branches the round-1 validator missed. `maximumModelCalls`
 * returns 0 for `lean4` with `mode: "verify"` and for an `evidence-gate` with no
 * evaluator and only `artifact-exists` checks, so `requiresPiSubagent` is false
 * and the executor never asks for a delegation session — `harness` reached no
 * decision and was discarded, with the graph validating clean.
 */
function singleNodeGraph(node: WorkflowNode, defaultHarness?: WorkflowHarness) {
  return {
    ...(defaultHarness ? { settings: { defaultHarness } } : {}),
    schemaVersion: "1.0",
    id: "zero-call-harness",
    name: "Zero model-call harness graph",
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
      enabled: false,
      minimumIndependentSources: 0,
      requireArtifactReferences: false,
      onUnsupportedOutput: "route",
    },
    nodes: [node],
    edges: [],
  } as unknown as WorkflowGraphDocument;
}

function lean4Node(
  mode: "verify" | "solve",
  harness?: WorkflowHarness,
): WorkflowNode {
  return {
    id: "prove",
    name: "Prove",
    kind: "lean4",
    terminal: true,
    workspace: { isolation: "read-only", writePaths: [] },
    goal: "Discharge the stated lemma.",
    theorem: "theorem trivial : True := by trivial",
    mode,
    mathlib: false,
    skill: "byom-dag-fusion",
    ...(mode === "solve" ? { solverModel: openRouterModel() } : {}),
    ...(harness ? { settings: { harness } } : {}),
  } as unknown as WorkflowNode;
}

function evidenceGateNode(
  options: { evaluator?: boolean; reasonedCheck?: boolean; harness?: WorkflowHarness },
): WorkflowNode {
  return {
    id: "gate",
    name: "Gate",
    kind: "evidence-gate",
    terminal: true,
    workspace: { isolation: "read-only", writePaths: [] },
    checks: options.reasonedCheck
      ? ["artifact-exists", "claim-supported"]
      : ["artifact-exists"],
    artifactIds: ["report"],
    onUnsupportedOutput: "fail",
    ...(options.evaluator ? { evaluator: openRouterModel() } : {}),
    ...(options.harness ? { settings: { harness: options.harness } } : {}),
  } as unknown as WorkflowNode;
}

describe("harness on a node that makes no model calls at all", () => {
  it("accepts a lean4 verify node with no harness declared", () => {
    expect(validateWorkflowGraphDocument(singleNodeGraph(lean4Node("verify"))).ok)
      .toBe(true);
  });

  it.each(["grok-cli", "claude-code", "deepseek", "oh-my-pi", "codex"] as const)(
    "refuses %s on a lean4 verify node, which reaches no dispatch decision",
    (harness: WorkflowHarness) => {
      const result = validateWorkflowGraphDocument(
        singleNodeGraph(lean4Node("verify", harness)),
      );
      expect(result.ok).toBe(false);
      const found = issues(result).find(
        (issue) => issue.code === "unreachable-node-harness",
      );
      expect(found).toBeDefined();
      expect(found?.message).toContain("makes no model calls");
      expect(found?.message).toContain("Set this node's harness to pi");
      expect(found?.message).not.toContain(`"${harness}"`);
    },
  );

  it("refuses an inherited defaultHarness on a lean4 verify node", () => {
    const result = validateWorkflowGraphDocument(
      singleNodeGraph(lean4Node("verify"), "grok-cli"),
    );
    expect(result.ok).toBe(false);
    expect(issues(result).map((issue) => issue.code))
      .toContain("unreachable-inherited-harness");
  });

  it("leaves a lean4 solve node alone — it does reach the decision", () => {
    // `maximumModelCalls` returns 1 for `mode: "solve"`, and the lean4 branch
    // delegates on exactly that mode (`kady-node-executor.ts:3077`).
    const result = validateWorkflowGraphDocument(
      singleNodeGraph(lean4Node("solve", "grok-cli")),
    );
    expect(issues(result).map((issue) => issue.code))
      .not.toContain("unreachable-node-harness");
  });

  it("refuses a harness on an evidence gate with no evaluator and only artifact checks", () => {
    const result = validateWorkflowGraphDocument(
      singleNodeGraph(evidenceGateNode({ harness: "grok-cli" })),
    );
    expect(result.ok).toBe(false);
    const found = issues(result).find(
      (issue) => issue.code === "unreachable-node-harness",
    );
    expect(found).toBeDefined();
    expect(found?.message).toContain("makes no model calls");
  });

  it("leaves an evaluating evidence gate alone", () => {
    for (const node of [
      evidenceGateNode({ harness: "grok-cli", evaluator: true }),
      evidenceGateNode({ harness: "grok-cli", reasonedCheck: true }),
    ]) {
      const result = validateWorkflowGraphDocument(singleNodeGraph(node));
      expect(issues(result).map((issue) => issue.code))
        .not.toContain("unreachable-node-harness");
    }
  });

  it("leaves an ordinary agent node alone", () => {
    const agent = {
      id: "step",
      name: "Step",
      kind: "agent",
      terminal: true,
      workspace: { isolation: "read-only", writePaths: [] },
      prompt: "Answer from the supplied evidence only.",
      settings: { harness: "claude-code" },
    } as unknown as WorkflowNode;
    const result = validateWorkflowGraphDocument(singleNodeGraph(agent));
    expect(issues(result).map((issue) => issue.code))
      .not.toContain("unreachable-node-harness");
  });
});
