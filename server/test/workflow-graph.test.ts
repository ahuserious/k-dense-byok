import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKFLOW_RESCUE_POLICY,
  MAX_WORKFLOW_DOCUMENT_BYTES,
  MAX_WORKFLOW_NODES,
  WORKFLOW_GRAPH_SCHEMA_VERSION,
  deriveWorkflowNodeDemand,
  normalizeWorkflowProjectPath,
  resolveWorkflowProjectPath,
  validateWorkflowGraphDocument,
  type ModelRequest,
  type RequestedModel,
  type WorkflowGraphDocument,
  type WorkflowNode,
  type WorkflowValidationResult,
} from "../src/workflows/index.ts";

type FixedRequestedModel = Extract<RequestedModel, { source: "fixed" }>;
type AuthKind = FixedRequestedModel["auth"]["kind"];

function exactModel(
  provider = "openrouter",
  model = "anthropic/claude-sonnet-4",
  authKind: AuthKind = "api-key",
): ModelRequest {
  return {
    requested: {
      source: "fixed",
      provider,
      model,
      auth: { kind: authKind },
      reasoning: "high",
    },
    resolution: { mode: "exact" },
  };
}

function validWorkflow(): WorkflowGraphDocument {
  return {
    schemaVersion: WORKFLOW_GRAPH_SCHEMA_VERSION,
    id: "private-research",
    name: "Private research with checked synthesis",
    entryNodeId: "research",
    defaultModel: exactModel(),
    limits: {
      maxIterations: 20,
      maxModelCalls: 80,
      maxParallelism: 8,
      maxSubagents: 16,
      timeoutMs: 600_000,
      maxTokens: 1_000_000,
      maxCostUsd: 50,
      maxRetries: 3,
    },
    evidence: {
      enabled: true,
      minimumIndependentSources: 2,
      requireArtifactReferences: true,
      onUnsupportedOutput: "rescue",
    },
    artifacts: [
      {
        id: "research-report",
        name: "Research report",
        kind: "report",
        writerNodeId: "research",
        path: "results/research.md",
      },
    ],
    nodes: [
      {
        id: "research",
        name: "Research until supported",
        kind: "research-until-goal",
        terminal: false,
        workspace: {
          isolation: "isolated-worktree",
          writePaths: ["results/research.md"],
        },
        position: { x: 0, y: 0 },
        goal: "Find independently supported results.",
        completionCriteria: ["At least two independent sources agree."],
        limits: { maxIterations: 8, maxSubagents: 8 },
      },
      {
        id: "council",
        name: "Scientific council",
        kind: "council",
        terminal: false,
        workspace: { isolation: "read-only", writePaths: [] },
        goal: "Challenge the strongest interpretation.",
        members: [
          { id: "theorist", role: "Theorist", model: exactModel() },
          {
            id: "experimentalist",
            role: "Experimentalist",
            model: exactModel("openai-codex", "gpt-5", "oauth"),
          },
        ],
        chair: exactModel(),
        rounds: 2,
        preserveMinorityReports: true,
      },
      {
        id: "fusion",
        name: "Local Kady fusion",
        kind: "fusion",
        terminal: false,
        workspace: { isolation: "read-only", writePaths: [] },
        goal: "Synthesize the panel without hiding disagreement.",
        fusion: {
          mode: "kady-panel",
          members: [
            {
              id: "local-a",
              role: "Local analyst",
              model: exactModel("ollama", "qwen3:32b", "local"),
            },
            {
              id: "custom-b",
              role: "Custom verifier",
              model: exactModel("openai-compatible", "lab-model", "custom"),
            },
          ],
          synthesizer: exactModel(),
          rounds: 1,
        },
        preserveMinorityReports: true,
      },
      {
        id: "best",
        name: "Best pathway",
        kind: "best-of-n",
        terminal: false,
        workspace: { isolation: "read-only", writePaths: [] },
        goal: "Create alternative ways to reach the next goal.",
      },
      {
        id: "gate",
        name: "Evidence gate",
        kind: "evidence-gate",
        terminal: false,
        workspace: { isolation: "read-only", writePaths: [] },
        checks: ["citations", "artifact-exists", "unsupported-output"],
        artifactIds: ["research-report"],
        onUnsupportedOutput: "rescue",
      },
      {
        id: "lean",
        name: "Lean proof",
        kind: "lean4",
        terminal: false,
        workspace: { isolation: "read-only", writePaths: [] },
        goal: "Machine-check the mathematical claim.",
        theorem: "theorem kady_example : 1 + 1 = 2 := by norm_num",
        mode: "verify",
        mathlib: true,
        skill: "byom-dag-fusion",
      },
      {
        id: "final",
        name: "Final report",
        kind: "agent",
        terminal: true,
        workspace: { isolation: "read-only", writePaths: [] },
        prompt: "Write the supported result and retained minority report.",
      },
    ],
    edges: [
      { id: "research-to-council", from: "research", to: "council" },
      { id: "council-to-fusion", from: "council", to: "fusion" },
      { id: "fusion-to-best", from: "fusion", to: "best" },
      { id: "best-to-gate", from: "best", to: "gate" },
      {
        id: "gate-to-lean",
        from: "gate",
        to: "lean",
        condition: "evidence-supported",
      },
      { id: "lean-to-final", from: "lean", to: "final" },
    ],
  };
}

function issueCodes(result: WorkflowValidationResult): string[] {
  if (result.ok) return [];
  return result.issues.map((issue) => issue.code);
}

function nodeOfKind<K extends WorkflowNode["kind"]>(
  document: WorkflowGraphDocument,
  kind: K,
): Extract<WorkflowNode, { kind: K }> {
  const node = document.nodes.find((candidate) => candidate.kind === kind);
  if (!node) throw new Error(`Missing ${kind} fixture node.`);
  return node as Extract<WorkflowNode, { kind: K }>;
}

describe("workflow graph contract", () => {
  it("accepts every foundation node and applies explicit defaults without mutation", () => {
    const input = validWorkflow();
    const result = validateWorkflowGraphDocument(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.rescue).toEqual(DEFAULT_WORKFLOW_RESCUE_POLICY);
    expect(nodeOfKind(result.document, "best-of-n").candidateCount).toBe(2);
    expect(result.document.edges[0].condition).toBe("always");
    expect(input.rescue).toBeUndefined();
    expect(nodeOfKind(input, "best-of-n").candidateCount).toBeUndefined();
    expect(input.edges[0].condition).toBeUndefined();

    nodeOfKind(result.document, "council").members[0].role = "Changed after validation";
    nodeOfKind(result.document, "council").members[0].model.requested.reasoning = "off";
    nodeOfKind(result.document, "research-until-goal").workspace.writePaths[0] =
      "changed.md";
    result.document.rescue!.triggers.push("failure");
    expect(nodeOfKind(input, "council").members[0].role).toBe("Theorist");
    expect(nodeOfKind(input, "council").members[0].model.requested.reasoning).toBe(
      "high",
    );
    expect(nodeOfKind(input, "research-until-goal").workspace.writePaths[0]).toBe(
      "results/research.md",
    );
    expect(DEFAULT_WORKFLOW_RESCUE_POLICY.triggers).toHaveLength(5);
  });

  it("represents OpenRouter routing separately from a Kady-owned panel", () => {
    const document = validWorkflow();
    const fusion = nodeOfKind(document, "fusion");
    fusion.fusion = {
      mode: "openrouter-router",
      router: exactModel("openrouter", "openrouter/fusion"),
      members: [
        { id: "panel-a", role: "Panel A", model: exactModel() },
        {
          id: "panel-b",
          role: "Panel B",
          model: exactModel("openrouter", "openai/gpt-5"),
        },
      ],
      judge: exactModel("openrouter", "anthropic/claude-opus-4"),
    };
    expect(validateWorkflowGraphDocument(document).ok).toBe(true);

    fusion.fusion.router = exactModel("openrouter", "google/gemini-2.5-pro");
    expect(issueCodes(validateWorkflowGraphDocument(document))).toContain(
      "invalid-openrouter-router",
    );

    fusion.fusion.router = exactModel("openrouter", "openrouter/fusion", "local");
    expect(issueCodes(validateWorkflowGraphDocument(document))).toContain(
      "invalid-openrouter-router",
    );

    fusion.fusion.router = exactModel("ollama", "qwen3:32b", "local");
    expect(issueCodes(validateWorkflowGraphDocument(document))).toContain(
      "invalid-openrouter-router",
    );

    fusion.fusion.router = exactModel("openrouter", "openrouter/fusion");
    fusion.fusion.members[0].model = exactModel("ollama", "qwen3:32b", "local");
    expect(issueCodes(validateWorkflowGraphDocument(document))).toContain(
      "invalid-openrouter-panel-model",
    );

    fusion.fusion.members[0].model = {
      requested: exactModel("openrouter", "anthropic/claude-sonnet-4").requested,
      resolution: {
        mode: "explicit-fallback",
        alternatives: [
          exactModel("openrouter", "google/gemini-2.5-pro").requested,
        ],
        reason: "Try another hosted model.",
      },
    };
    expect(issueCodes(validateWorkflowGraphDocument(document))).toContain(
      "invalid-openrouter-panel-model",
    );

    fusion.fusion.members[0].model = exactModel();
    fusion.fusion.judge.requested.reasoning = "medium";
    expect(issueCodes(validateWorkflowGraphDocument(document))).toContain(
      "openrouter-reasoning-mismatch",
    );

    fusion.fusion.judge = exactModel("openrouter", "anthropic/claude-opus-4");
    fusion.fusion.members = Array.from({ length: 9 }, (_, index) => ({
      id: `panel-${index}`,
      role: `Panel ${index}`,
      model: exactModel("openrouter", `provider/model-${index}`),
    }));
    expect(issueCodes(validateWorkflowGraphDocument(document))).toContain("schema");
  });

  it("represents the current Kady main-agent selection without inventing a model id", () => {
    const document = validWorkflow();
    document.defaultModel = {
      requested: {
        source: "kady-current",
        auth: { kind: "kady-current" },
        reasoning: "max",
      },
      resolution: { mode: "exact" },
    };
    expect(validateWorkflowGraphDocument(document).ok).toBe(true);
  });

  it("supports explicit best-of-N candidate models and derives their count", () => {
    const document = validWorkflow();
    const bestOfN = nodeOfKind(document, "best-of-n");
    bestOfN.candidateModels = [
      exactModel("ollama", "qwen3:32b", "local"),
      exactModel("openai-compatible", "lab-model", "custom"),
      exactModel("openrouter", "google/gemini-2.5-pro"),
    ];
    delete bestOfN.candidateCount;
    const result = validateWorkflowGraphDocument(document);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(nodeOfKind(result.document, "best-of-n").candidateCount).toBe(3);
    }

    bestOfN.candidateCount = 2;
    expect(issueCodes(validateWorkflowGraphDocument(document))).toContain(
      "candidate-count-mismatch",
    );
  });

  it("does not mix a repeated Best-of-N model with explicit candidate models", () => {
    const document = validWorkflow();
    const bestOfN = nodeOfKind(document, "best-of-n");
    bestOfN.model = exactModel("ollama", "qwen3:32b", "local");
    bestOfN.candidateModels = [exactModel(), exactModel("openrouter", "openai/gpt-5")];
    expect(issueCodes(validateWorkflowGraphDocument(document))).toContain(
      "ambiguous-candidate-models",
    );
  });

  it("rejects the retired debate name and a renamed Lean skill", () => {
    const debateDocument = validWorkflow() as unknown as {
      nodes: Array<Record<string, unknown>>;
    };
    debateDocument.nodes[1].kind = "debate";
    expect(issueCodes(validateWorkflowGraphDocument(debateDocument))).toContain("schema");

    const leanDocument = validWorkflow();
    nodeOfKind(leanDocument, "lean4").skill = "some-other-skill" as "byom-dag-fusion";
    expect(issueCodes(validateWorkflowGraphDocument(leanDocument))).toContain("schema");
  });

  it("requires a visible model selection for Lean solve but not verify", () => {
    const document = validWorkflow();
    const lean = nodeOfKind(document, "lean4");
    lean.solverModel = exactModel("ollama", "deepseek-prover", "local");
    expect(issueCodes(validateWorkflowGraphDocument(document))).toContain(
      "unexpected-lean-solver-model",
    );

    delete lean.solverModel;
    delete document.defaultModel;
    lean.mode = "solve";
    expect(issueCodes(validateWorkflowGraphDocument(document))).toContain(
      "missing-lean-solver-model",
    );

    lean.solverModel = exactModel("ollama", "deepseek-prover", "local");
    expect(issueCodes(validateWorkflowGraphDocument(document))).not.toContain(
      "missing-lean-solver-model",
    );
  });

  it("allows trusted Lean failure receipts without a model policy and keeps enabled policies strict", () => {
    const document = validWorkflow();
    const lean = nodeOfKind(document, "lean4");
    lean.evidence = {
      enabled: false,
      minimumIndependentSources: 0,
      requireArtifactReferences: false,
      onUnsupportedOutput: "route",
    };

    expect(issueCodes(validateWorkflowGraphDocument(document))).not.toEqual(
      expect.arrayContaining(["unsafe-lean-evidence-policy", "unsafe-lean-evidence-routing"]),
    );

    lean.evidence.enabled = true;
    expect(issueCodes(validateWorkflowGraphDocument(document))).toEqual(
      expect.arrayContaining(["unsafe-lean-evidence-policy", "unsafe-lean-evidence-routing"]),
    );
  });

  it("requires an exact request or a fully explicit, unique fallback list", () => {
    const noModel = validWorkflow();
    delete noModel.defaultModel;
    expect(issueCodes(validateWorkflowGraphDocument(noModel))).toContain(
      "missing-model-request",
    );

    const repeatedFallback = validWorkflow();
    const requested = exactModel().requested;
    repeatedFallback.defaultModel = {
      requested,
      resolution: {
        mode: "explicit-fallback",
        alternatives: [requested, requested],
        reason: "Only these models are approved for this workflow.",
      },
    };
    const codes = issueCodes(validateWorkflowGraphDocument(repeatedFallback));
    expect(codes).toContain("fallback-repeats-request");
    expect(codes).toContain("duplicate-model-fallback");

    const ambiguousCurrent = validWorkflow();
    ambiguousCurrent.defaultModel = {
      requested: exactModel().requested,
      resolution: {
        mode: "explicit-fallback",
        alternatives: [
          {
            source: "kady-current",
            auth: { kind: "kady-current" },
            reasoning: "high",
          },
        ],
        reason: "Do not silently reinterpret the active Kady model.",
      },
    };
    expect(issueCodes(validateWorkflowGraphDocument(ambiguousCurrent))).toContain(
      "ambiguous-kady-current-fallback",
    );
  });

  it("derives compound-node demand and rejects graphs that cannot admit it", () => {
    const document = validWorkflow();
    document.limits.maxModelCalls = 40;
    const council = nodeOfKind(document, "council");
    council.rounds = 20;
    council.limits = {
      maxIterations: 20,
      maxModelCalls: 1,
      maxSubagents: 0,
      maxTokens: 12_345,
      maxCostUsd: 7,
    };
    const demand = deriveWorkflowNodeDemand(council, document);
    expect(demand).toMatchObject({
      minimumModelCalls: 61,
      maximumModelCalls: 61,
      maximumIterations: 20,
      minimumConcurrentSubagents: 1,
      preferredParallelism: 2,
      maxTokens: 12_345,
      maxCostUsd: 7,
    });
    const codes = issueCodes(validateWorkflowGraphDocument(document));
    expect(codes).toContain("node-model-call-demand-exceeds-limit");
    expect(codes).toContain("node-subagent-demand-exceeds-limit");
    expect(codes).toContain("workflow-model-call-demand-exceeds-limit");
  });

  it("rejects duplicate, dangling, and self-referential edge endpoints", () => {
    const document = validWorkflow();
    document.edges.push(
      { id: "duplicate-route", from: "research", to: "council" },
      { id: "unknown-route", from: "missing", to: "final" },
      { id: "self-route", from: "best", to: "best" },
    );
    const codes = issueCodes(validateWorkflowGraphDocument(document));
    expect(codes).toContain("duplicate-edge-endpoints");
    expect(codes).toContain("unknown-edge-source");
    expect(codes).toContain("self-edge");
  });

  it("requires complete outcome routes and permits explicit fan-out", () => {
    const document = validWorkflow();
    document.edges[0].condition = "failure";
    expect(issueCodes(validateWorkflowGraphDocument(document))).toContain(
      "missing-success-route",
    );

    document.edges.push({
      id: "research-success-to-council",
      from: "research",
      to: "council",
      condition: "success",
    });
    document.edges.push({
      id: "research-success-to-fusion",
      from: "research",
      to: "fusion",
      condition: "success",
    });
    expect(validateWorkflowGraphDocument(document).ok).toBe(true);
  });

  it("rejects mixing unconditional and outcome-specific routes", () => {
    const document = validWorkflow();
    document.edges.push({
      id: "research-success-to-final",
      from: "research",
      to: "final",
      condition: "success",
    });
    expect(issueCodes(validateWorkflowGraphDocument(document))).toContain(
      "mixed-always-and-outcome-routes",
    );
  });

  it("requires unique document, member, and edge ids", () => {
    const document = validWorkflow();
    document.nodes[1].id = "research";
    document.artifacts!.push({ ...document.artifacts![0] });
    document.edges[1].id = document.edges[0].id;
    const council = nodeOfKind(document, "council");
    council.members[1].id = council.members[0].id;
    const codes = issueCodes(validateWorkflowGraphDocument(document));
    expect(codes).toContain("duplicate-node-id");
    expect(codes).toContain("duplicate-artifact-id");
    expect(codes).toContain("duplicate-edge-id");
    expect(codes).toContain("duplicate-member-id");
  });

  it("requires an existing root entry with no incoming edge", () => {
    const unknownEntry = validWorkflow();
    unknownEntry.entryNodeId = "missing-entry";
    expect(issueCodes(validateWorkflowGraphDocument(unknownEntry))).toContain(
      "unknown-entry-node",
    );

    const incomingEntry = validWorkflow();
    incomingEntry.edges.push({ id: "back-to-entry", from: "final", to: "research" });
    expect(issueCodes(validateWorkflowGraphDocument(incomingEntry))).toContain(
      "entry-has-incoming-edge",
    );
  });

  it("rejects outer cycles while keeping bounded loops inside compound nodes", () => {
    const document = validWorkflow();
    nodeOfKind(document, "agent").terminal = false;
    document.edges.push({ id: "cycle-back", from: "final", to: "research" });
    expect(issueCodes(validateWorkflowGraphDocument(document))).toContain("cycle");
  });

  it("rejects unreachable nodes and inconsistent terminal declarations", () => {
    const unreachable = validWorkflow();
    unreachable.edges = unreachable.edges.filter((edge) => edge.from !== "fusion");
    const unreachableCodes = issueCodes(validateWorkflowGraphDocument(unreachable));
    expect(unreachableCodes).toContain("unreachable-node");
    expect(unreachableCodes).toContain("unterminated-sink");

    const falseTerminal = validWorkflow();
    nodeOfKind(falseTerminal, "fusion").terminal = true;
    expect(issueCodes(validateWorkflowGraphDocument(falseTerminal))).toContain(
      "terminal-has-outgoing-edge",
    );
  });

  it("validates artifact writer ownership and evidence references", () => {
    const document = validWorkflow();
    document.artifacts![0].writerNodeId = "missing-writer";
    nodeOfKind(document, "evidence-gate").artifactIds.push("missing-artifact");
    const codes = issueCodes(validateWorkflowGraphDocument(document));
    expect(codes).toContain("unknown-artifact-writer");
    expect(codes).toContain("unknown-artifact");

    const directoryOwner = validWorkflow();
    nodeOfKind(directoryOwner, "research-until-goal").workspace.writePaths = ["results"];
    expect(validateWorkflowGraphDocument(directoryOwner).ok).toBe(true);
  });

  it("makes writer isolation and write ownership explicit", () => {
    const readOnlyWriter = validWorkflow();
    nodeOfKind(readOnlyWriter, "research-until-goal").workspace = {
      isolation: "read-only",
      writePaths: [],
    };
    expect(issueCodes(validateWorkflowGraphDocument(readOnlyWriter))).toContain(
      "read-only-artifact-writer",
    );

    const unsafeWriter = validWorkflow();
    nodeOfKind(unsafeWriter, "research-until-goal").workspace.writePaths = [
      "../outside.md",
    ];
    const codes = issueCodes(validateWorkflowGraphDocument(unsafeWriter));
    expect(codes).toContain("unsafe-write-path");
    expect(codes).toContain("artifact-outside-write-paths");

    const overlappingWriters = validWorkflow();
    nodeOfKind(overlappingWriters, "best-of-n").workspace = {
      isolation: "exclusive-project",
      writePaths: ["RESULTS"],
    };
    expect(issueCodes(validateWorkflowGraphDocument(overlappingWriters))).toContain(
      "overlapping-write-ownership",
    );
  });

  it("normalizes only portable project paths and resolves them inside the project", () => {
    expect(normalizeWorkflowProjectPath("results/report.md")).toBe("results/report.md");
    for (const unsafePath of [
      "C:outside.txt",
      "C:/outside.txt",
      "\\\\server\\share",
      "results\\report.md",
      "results//report.md",
      "results/./report.md",
      "results/../report.md",
      "results/NUL.txt",
      "results/bad\0name",
    ]) {
      expect(normalizeWorkflowProjectPath(unsafePath)).toBeUndefined();
    }

    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-workflow-path-"));
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-workflow-outside-"));
    try {
      expect(resolveWorkflowProjectPath(projectRoot, "results/report.md")).toBe(
        path.join(projectRoot, "results", "report.md"),
      );
      expect(() => resolveWorkflowProjectPath(projectRoot, "C:outside.txt")).toThrow(
        "Unsafe workflow project path",
      );
      if (process.platform !== "win32") {
        fs.symlinkSync(outsideRoot, path.join(projectRoot, "escape"), "dir");
        expect(() => resolveWorkflowProjectPath(projectRoot, "escape/report.md")).toThrow(
          "resolves through a symlink outside",
        );
      }
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it("enforces workflow ceilings and bounded rescue policies", () => {
    const document = validWorkflow();
    nodeOfKind(document, "research-until-goal").limits = { maxSubagents: 17 };
    nodeOfKind(document, "best-of-n").rescue = {
      enabled: true,
      maxAttempts: 0,
      triggers: ["failure", "failure"],
    };
    const codes = issueCodes(validateWorkflowGraphDocument(document));
    expect(codes).toContain("node-limit-exceeds-workflow");
    expect(codes).toContain("unbounded-rescue-disabled");
    expect(codes).toContain("duplicate-rescue-trigger");

    const adapterOverflow = validWorkflow();
    adapterOverflow.limits.maxParallelism = 17;
    adapterOverflow.limits.maxRetries = 4;
    expect(issueCodes(validateWorkflowGraphDocument(adapterOverflow))).toContain("schema");
  });

  it("rejects rescue actions when the effective rescue policy is disabled", () => {
    const document = validWorkflow();
    document.rescue = { enabled: false, maxAttempts: 0, triggers: [] };
    document.evidence.onUnsupportedOutput = "fail";
    expect(issueCodes(validateWorkflowGraphDocument(document))).toContain(
      "rescue-unavailable",
    );

    nodeOfKind(document, "evidence-gate").rescue = {
      enabled: true,
      maxAttempts: 1,
      triggers: ["unsupported-output"],
    };
    expect(issueCodes(validateWorkflowGraphDocument(document))).not.toContain(
      "rescue-unavailable",
    );
  });

  it("requires a visible model for model-based evidence checks", () => {
    const document = validWorkflow();
    delete document.defaultModel;
    expect(issueCodes(validateWorkflowGraphDocument(document))).toContain(
      "missing-evidence-evaluator",
    );

    nodeOfKind(document, "evidence-gate").evaluator = exactModel();
    expect(issueCodes(validateWorkflowGraphDocument(document))).not.toContain(
      "missing-evidence-evaluator",
    );
  });

  it("requires explicit supported and routed-unsupported gate paths", () => {
    const document = validWorkflow();
    const gate = nodeOfKind(document, "evidence-gate");
    gate.onUnsupportedOutput = "route";
    expect(issueCodes(validateWorkflowGraphDocument(document))).toContain(
      "missing-unsupported-route",
    );

    document.edges.push({
      id: "unsupported-to-final",
      from: "gate",
      to: "final",
      condition: "evidence-unsupported",
    });
    expect(validateWorkflowGraphDocument(document).ok).toBe(true);
  });

  it("requires both evidence routes for a routed common policy on a non-gate node", () => {
    const document = validWorkflow();
    document.evidence.enabled = false;
    nodeOfKind(document, "lean4").evidence = {
      enabled: true,
      minimumIndependentSources: 0,
      requireArtifactReferences: true,
      onUnsupportedOutput: "fail",
    };
    const research = nodeOfKind(document, "research-until-goal");
    research.evidence = {
      enabled: true,
      minimumIndependentSources: 1,
      requireArtifactReferences: false,
      onUnsupportedOutput: "route",
      evaluator: exactModel(),
    };
    const supportedEdge = document.edges.find((edge) => edge.from === research.id);
    if (!supportedEdge) throw new Error("Missing research route fixture.");
    supportedEdge.condition = "evidence-supported";

    expect(issueCodes(validateWorkflowGraphDocument(document))).toContain(
      "missing-unsupported-route",
    );

    document.edges.push({
      id: "research-unsupported-to-final",
      from: research.id,
      to: "final",
      condition: "evidence-unsupported",
    });
    expect(validateWorkflowGraphDocument(document).ok).toBe(true);
  });

  it("validates the maximum write-path shape through the sorted ownership check", () => {
    const document = validWorkflow();
    document.evidence.enabled = false;
    document.limits.maxModelCalls = MAX_WORKFLOW_NODES;
    document.limits.maxIterations = MAX_WORKFLOW_NODES;
    document.entryNodeId = "node-0";
    document.artifacts = [];
    document.nodes = Array.from({ length: MAX_WORKFLOW_NODES }, (_, nodeIndex) => {
      const node: WorkflowNode = {
        id: `node-${nodeIndex}`,
        name: `Node ${nodeIndex}`,
        kind: "agent",
        terminal: nodeIndex === MAX_WORKFLOW_NODES - 1,
        workspace: {
          isolation: "exclusive-project",
          writePaths: Array.from(
            { length: 32 },
            (_, pathIndex) => `owned/node-${nodeIndex}/path-${pathIndex}`,
          ),
        },
        prompt: "Perform the bounded step.",
      };
      return node;
    });
    document.edges = Array.from({ length: MAX_WORKFLOW_NODES - 1 }, (_, index) => ({
      id: `edge-${index}`,
      from: `node-${index}`,
      to: `node-${index + 1}`,
    }));

    expect(validateWorkflowGraphDocument(document).ok).toBe(true);
  });

  it("rejects structurally unbounded or open-ended documents", () => {
    const tooManyNodes = validWorkflow() as unknown as Record<string, unknown>;
    const template = validWorkflow().nodes[0];
    tooManyNodes.nodes = Array.from({ length: MAX_WORKFLOW_NODES + 1 }, (_, index) => ({
      ...template,
      id: `node-${index}`,
      terminal: true,
    }));
    expect(issueCodes(validateWorkflowGraphDocument(tooManyNodes))).toContain("schema");

    const extraProperty = { ...validWorkflow(), runtimeCommand: "do anything" };
    expect(issueCodes(validateWorkflowGraphDocument(extraProperty))).toContain("schema");

    const oversizedDocument = validWorkflow() as unknown as Record<string, unknown>;
    oversizedDocument.nodes = Array.from({ length: 130 }, (_, index) => ({
      ...template,
      id: `large-node-${index}`,
      prompt: "x".repeat(32_768),
      terminal: true,
    }));
    expect(JSON.stringify(oversizedDocument).length).toBeGreaterThan(
      MAX_WORKFLOW_DOCUMENT_BYTES,
    );
    expect(issueCodes(validateWorkflowGraphDocument(oversizedDocument))).toContain(
      "document-too-large",
    );
  });
});
