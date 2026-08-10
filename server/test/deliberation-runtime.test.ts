import { describe, expect, it, vi } from "vitest";
import {
  bindDeliberationStaffing,
  withDeliberationBindings,
} from "../src/workflows/deliberation-runtime.ts";
import {
  DEFAULT_PERSONALITY_STORE_REF,
  personalityContentManifestDigest,
} from "../src/personality-store/store.ts";
import type {
  WorkflowNodeExecutorContext,
  WorkflowNodeExecutorResult,
} from "../src/workflows/runner.ts";
import type { WorkflowDeliberationStaffingReceipt } from "../src/workflows/run-state.ts";
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

const snapshotPersonalities = [
  { ref: "genomics", title: "Genomics Scientist", instructions: "Inspect genome variants and alignments." },
  { ref: "statistician", title: "Statistician", instructions: "Audit estimands and uncertainty." },
  { ref: "chemist", title: "Chemist", instructions: "Check molecules and assays." },
];

const snapshot = {
  schemaVersion: 1 as const,
  storeRef: DEFAULT_PERSONALITY_STORE_REF,
  source: "ahuserious/scientific-agents",
  revision: "a".repeat(40),
  digest: personalityContentManifestDigest(snapshotPersonalities),
  personalities: snapshotPersonalities,
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
    const bindingOrder: string[] = [];
    const downstream = vi.fn(async (): Promise<WorkflowNodeExecutorResult> => {
      bindingOrder.push("provider-dispatch");
      return { output: null };
    });
    const execute = withDeliberationBindings(downstream, {
      loadStore: vi.fn(async () => snapshot),
    });
    let receipt: WorkflowDeliberationStaffingReceipt | undefined;
    await execute({
      node,
      runId: "wfrun-hosted",
      recordDeliberationStaffingReceipt(value) {
        bindingOrder.push("receipt-persisted");
        receipt = structuredClone(value);
      },
    } as WorkflowNodeExecutorContext);

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
    expect(receipt).toMatchObject({
      revision: snapshot.revision,
      storeDigest: snapshot.digest,
      selectedPersonalityRefs: ["genomics"],
    });
    expect(bindingOrder).toEqual(["receipt-persisted", "provider-dispatch"]);
  });

  it("retries from the receipted snapshot after the current store is replaced", async () => {
    const node: Extract<WorkflowNode, { kind: "best-of-n" }> = {
      ...commonNode("durable"),
      kind: "best-of-n",
      goal: "Audit genome variant evidence",
      candidateModels: [model("candidate")],
      candidateCount: 1,
      evaluator: model("evaluator"),
      settings: {
        deliberation: {
          bestOfNPersonalityCount: 1,
          mimeographs: { mode: "auto", personalityRefs: [] },
        },
      },
    };
    const replacementPersonalities = [
      { ref: "chemist", title: "Chemist", instructions: "Audit molecules and assays." },
    ];
    const replacement = {
      ...snapshot,
      revision: "b".repeat(40),
      digest: personalityContentManifestDigest(replacementPersonalities),
      personalities: replacementPersonalities,
    };
    let currentStore = snapshot;
    let receipt: WorkflowDeliberationStaffingReceipt | undefined;
    const downstream = vi.fn(async (): Promise<WorkflowNodeExecutorResult> => ({ output: null }));
    const loadStore = vi.fn(async () => currentStore);
    const loadStoreSnapshot = vi.fn(async (_storeRef: string, digest: string) => {
      if (digest !== snapshot.digest) throw new Error("missing snapshot");
      return snapshot;
    });
    const execute = withDeliberationBindings(downstream, { loadStore, loadStoreSnapshot });

    await execute({
      node,
      runId: "wfrun-durable",
      recordDeliberationStaffingReceipt(value) {
        receipt = structuredClone(value);
      },
    } as WorkflowNodeExecutorContext);
    expect(receipt).toBeDefined();
    currentStore = replacement;
    await execute({
      node,
      runId: "wfrun-durable",
      resumed: true,
      deliberationStaffingReceipt: receipt,
    } as WorkflowNodeExecutorContext);

    expect(loadStore).toHaveBeenCalledTimes(1);
    expect(loadStoreSnapshot).toHaveBeenCalledWith(
      DEFAULT_PERSONALITY_STORE_REF,
      snapshot.digest,
      snapshot.revision,
    );
    const retried = downstream.mock.calls[1][0].node;
    expect(retried.goal).toContain("mimeograph-genomics");
    expect(retried.goal).not.toContain("mimeograph-chemist");
  });

  it("fails closed on retry when the receipted snapshot is missing", async () => {
    const node: Extract<WorkflowNode, { kind: "best-of-n" }> = {
      ...commonNode("missing"),
      kind: "best-of-n",
      goal: "Audit genome variant evidence",
      candidateModels: [model("candidate")],
      candidateCount: 1,
      evaluator: model("evaluator"),
      settings: {
        deliberation: {
          bestOfNPersonalityCount: 1,
          mimeographs: { mode: "auto", personalityRefs: [] },
        },
      },
    };
    const receipt: WorkflowDeliberationStaffingReceipt = {
      storeRef: DEFAULT_PERSONALITY_STORE_REF,
      source: snapshot.source,
      revision: snapshot.revision,
      storeDigest: snapshot.digest,
      selectedPersonalityRefs: ["genomics"],
      effectivePromptSha256: "f".repeat(64),
    };
    const downstream = vi.fn(async (): Promise<WorkflowNodeExecutorResult> => ({ output: null }));
    const loadStore = vi.fn(async () => snapshot);
    const execute = withDeliberationBindings(downstream, {
      loadStore,
      loadStoreSnapshot: vi.fn(async () => {
        throw new Error("snapshot deleted");
      }),
    });

    await expect(execute({
      node,
      runId: "wfrun-missing",
      resumed: true,
      deliberationStaffingReceipt: receipt,
    } as WorkflowNodeExecutorContext)).rejects.toThrow(
      /required by run wfrun-missing is unavailable; refusing to restaff/,
    );
    expect(loadStore).not.toHaveBeenCalled();
    expect(downstream).not.toHaveBeenCalled();
  });
});
