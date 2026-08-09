import { describe, expect, it, vi } from "vitest";
import {
  bindDeliberationStaffing,
  withDeliberationBindings,
} from "../src/workflows/deliberation-runtime.ts";
import { DEFAULT_PERSONALITY_STORE_REF } from "../src/personality-store/store.ts";
import type {
  WorkflowNodeExecutorContext,
  WorkflowNodeExecutorResult,
} from "../src/workflows/runner.ts";
import type { ModelRequest, WorkflowNode } from "../src/workflows/schema.ts";

const model = (name: string): ModelRequest => ({
  requested: {
    source: "fixed",
    provider: "openrouter",
    model: name,
    auth: { kind: "api-key" },
    reasoning: "high",
  },
  resolution: { mode: "exact" },
});

const snapshot = {
  schemaVersion: 1 as const,
  storeRef: DEFAULT_PERSONALITY_STORE_REF,
  source: "ahuserious/scientific-agents",
  revision: "fixture",
  digest: "0".repeat(64),
  personalities: [
    { ref: "genomics", title: "Genomics Scientist", instructions: "Inspect genome variants and alignments." },
    { ref: "statistician", title: "Statistician", instructions: "Audit estimands and uncertainty." },
    { ref: "chemist", title: "Chemist", instructions: "Check molecules and assays." },
  ],
};

function commonNode(id: string) {
  return {
    id,
    name: id,
    description: id,
    terminal: true,
    workspace: { isolation: "read-only" as const, writePaths: [] },
  };
}

describe("deliberation personality binding", () => {
  it("materializes an auto-selected roster into best-of-n execution without changing model candidates", () => {
    const candidateModels = [model("candidate-a"), model("candidate-b")];
    const node: Extract<WorkflowNode, { kind: "best-of-n" }> = {
      ...commonNode("best"),
      kind: "best-of-n",
      goal: "Audit genome variant alignment uncertainty",
      candidateModels,
      candidateCount: 2,
      evaluator: model("evaluator"),
      settings: {
        deliberation: {
          personalityStoreRef: DEFAULT_PERSONALITY_STORE_REF,
          bestOfNPersonalityCount: 1,
          mimeographs: { mode: "auto", personalityRefs: [] },
        },
      },
    };

    const bound = bindDeliberationStaffing(node, snapshot);
    expect(bound.personalities.map((personality) => personality.ref)).toEqual(["genomics"]);
    expect(bound.node.goal).toContain("Candidate path k must adopt roster entry");
    expect(bound.node.goal).toContain("mimeograph-genomics");
    expect(bound.node.candidateModels).toEqual(candidateModels);
    expect(bound.node.settings?.deliberation).toBeUndefined();
  });

  it("uses the exact manual mimeograph roster and injects identities into fusion roles", () => {
    const node: Extract<WorkflowNode, { kind: "fusion" }> = {
      ...commonNode("fusion"),
      kind: "fusion",
      goal: "Assess an assay with uncertainty",
      fusion: {
        mode: "kady-panel",
        members: [
          { id: "a", role: "Primary", model: model("a") },
          { id: "b", role: "Reviewer", model: model("b") },
        ],
        synthesizer: model("judge"),
        rounds: 1,
      },
      preserveMinorityReports: true,
      settings: {
        deliberation: {
          bestOfNPersonalityCount: 2,
          mimeographs: {
            mode: "manual",
            personalityRefs: ["chemist", "statistician"],
          },
        },
      },
    };

    const bound = bindDeliberationStaffing(node, snapshot);
    expect(new Set(bound.personalities.map((personality) => personality.ref))).toEqual(
      new Set(["chemist", "statistician"]),
    );
    expect(bound.node.kind).toBe("fusion");
    if (bound.node.kind !== "fusion") return;
    expect(bound.node.fusion.members.map((member) => member.role)).toEqual([
      "Primary [mimeograph:chemist]",
      "Reviewer [mimeograph:statistician]",
    ]);
  });

  it("binds hosted reasoning and personalities before the production executor boundary", async () => {
    const node: Extract<WorkflowNode, { kind: "fusion" }> = {
      ...commonNode("hosted"),
      kind: "fusion",
      goal: "Audit genome evidence",
      settings: {
        reasoningEffort: "xhigh",
        deliberation: {
          bestOfNPersonalityCount: 1,
          mimeographs: { mode: "auto", personalityRefs: [] },
        },
      },
      fusion: {
        mode: "openrouter-router",
        router: model("openrouter/fusion"),
        members: [
          { id: "a", role: "Primary", model: model("a") },
          { id: "b", role: "Reviewer", model: model("b") },
        ],
        judge: model("judge"),
      },
      preserveMinorityReports: true,
    };
    const downstream = vi.fn(async (): Promise<WorkflowNodeExecutorResult> => ({ output: null }));
    const execute = withDeliberationBindings(downstream, {
      loadStore: vi.fn(async () => snapshot),
    });
    await execute({ node } as WorkflowNodeExecutorContext);

    const received = downstream.mock.calls[0][0].node;
    expect(received.settings?.reasoningEffort).toBeUndefined();
    expect(received.settings?.deliberation).toBeUndefined();
    expect(received.kind).toBe("fusion");
    if (received.kind !== "fusion" || received.fusion.mode !== "openrouter-router") return;
    expect(received.fusion.router.requested.reasoning).toBe("xhigh");
    expect(received.fusion.members.every((member) =>
      member.model.requested.reasoning === "xhigh"
    )).toBe(true);
    expect(received.fusion.judge.requested.reasoning).toBe("xhigh");
    expect(received.goal).toContain("mimeograph-genomics");
  });
});
