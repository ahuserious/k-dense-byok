import fs from "node:fs";
import path from "node:path";
import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists } from "../src/projects.ts";
import {
  applySkillCuration,
  F11_SKILL_NAMES,
  MAX_CURATED_SKILLS,
  readSkillCuratorSnapshot,
  SkillCuratorError,
} from "../src/agent/skill-curator.ts";
import { evaluateAutoresearchRun } from "../src/agent/skill-curator-autoresearch.ts";
import {
  destHarnessAdapterStatus,
  promptElevationAdapterStatus,
} from "../src/agent/skill-curator-prompt-elevation.ts";
import { seedProjectSkills } from "../src/agent/skills.ts";
import {
  resolveS4NodeExecutionBindings,
} from "../src/workflows/kady-node-executor.ts";
import type {
  WorkflowGraphDocument,
  WorkflowNode,
} from "../src/workflows/schema.ts";
import { WorkflowStore } from "../src/workflows/store.ts";
import { resolveNodeSpecV1 } from "../src/workflows/validate.ts";

function model() {
  return {
    requested: {
      source: "fixed" as const,
      provider: "ollama",
      model: "qwen3:32b",
      auth: { kind: "local" as const },
      reasoning: "high" as const,
    },
    resolution: { mode: "exact" as const },
  };
}

function graph(id: string, node?: WorkflowNode): WorkflowGraphDocument {
  return {
    schemaVersion: "1.0",
    id,
    name: "F11 curator workflow",
    entryNodeId: node?.id ?? "research",
    defaultModel: model(),
    limits: {
      maxIterations: 4,
      maxModelCalls: 8,
      maxParallelism: 2,
      maxSubagents: 2,
      timeoutMs: 60_000,
      maxTokens: 20_000,
      maxCostUsd: 2,
      maxRetries: 1,
    },
    evidence: {
      enabled: false,
      minimumIndependentSources: 0,
      requireArtifactReferences: false,
      onUnsupportedOutput: "fail",
    },
    nodes: [
      node ?? {
        id: "research",
        name: "Research",
        kind: "agent",
        terminal: true,
        workspace: { isolation: "read-only", writePaths: [] },
        prompt: "Produce one evidence-grounded result.",
      },
    ],
    edges: [],
  };
}

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
});

describe("skill curator workflow binding", () => {
  it("saves real NodeSkillsSchema.list refs and Pi loads what execution delegates", async () => {
    const projectId = "f11-curator-runtime";
    const paths = ensureProjectExists(projectId);
    await seedProjectSkills(paths, false);
    const store = new WorkflowStore();
    const original = store.saveDefinition(projectId, "curated-workflow", graph("curated-workflow"));

    const result = await applySkillCuration(
      projectId,
      paths,
      original.id,
      {
        expectedRevision: original.revision,
        nodeIds: ["research"],
        skillRefs: ["autoresearch-graph-architect", "autoresearch-squared"],
        skillsMode: "manual",
        writeMode: "replace",
      },
      { store },
    );

    expect(result.outcome).toBe("updated");
    const readBack = store.readDefinition(projectId, original.id);
    expect(readBack?.graph.nodes[0]?.settings?.skills).toEqual({
      mode: "manual",
      list: ["autoresearch-graph-architect", "autoresearch-squared"],
    });

    const node = readBack!.graph.nodes[0]!;
    const resolved = resolveNodeSpecV1(readBack!.graph, node);
    const bindings = resolveS4NodeExecutionBindings(resolved, paths, 2);
    expect(bindings.skills).toEqual({
      mode: "manual",
      configured: ["autoresearch-graph-architect", "autoresearch-squared"],
      delegated: ["autoresearch-graph-architect", "autoresearch-squared"],
    });

    const loader = new DefaultResourceLoader({
      cwd: paths.sandbox,
      agentDir: path.join(PROJECTS_ROOT, ".f11-test-agent"),
      settingsManager: SettingsManager.inMemory({}, { projectTrusted: true }),
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const loaded = new Map(
      loader.getSkills().skills.map((skill) => [skill.name, skill.filePath]),
    );
    for (const delegated of bindings.skills.delegated) {
      expect(loaded.get(delegated)).toMatch(/SKILL\.md$/);
    }

    const snapshot = readSkillCuratorSnapshot(projectId, paths, original.id, store);
    expect(snapshot.nodes[0]).toMatchObject({
      id: "research",
      skillsMode: "manual",
      skillRefs: ["autoresearch-graph-architect", "autoresearch-squared"],
    });
  });

  it("delegates optional source installation to the existing installer before saving", async () => {
    const projectId = "f11-curator-installer";
    const paths = ensureProjectExists(projectId);
    await seedProjectSkills(paths, false);
    const store = new WorkflowStore();
    const original = store.saveDefinition(projectId, "installer-workflow", graph("installer-workflow"));
    const install = vi.fn().mockResolvedValue({
      installed: ["autoresearch-graph-architect"],
      conflicts: [],
    });

    const result = await applySkillCuration(
      projectId,
      paths,
      original.id,
      {
        expectedRevision: original.revision,
        nodeIds: ["research"],
        skillRefs: ["autoresearch-graph-architect"],
        skillsMode: "manual",
        install: {
          source: "owner/skills",
          names: ["autoresearch-graph-architect"],
          stagingToken: "reviewed-tree",
          acknowledged: true,
        },
      },
      { store, install },
    );

    expect(install).toHaveBeenCalledWith(paths, expect.objectContaining({
      source: "owner/skills",
      acknowledged: true,
    }));
    expect(result.installed).toEqual({
      installed: ["autoresearch-graph-architect"],
      conflicts: [],
    });
  });

  it("binds existing personality refs without adding a schema field", async () => {
    const projectId = "f11-curator-personalities";
    const paths = ensureProjectExists(projectId);
    await seedProjectSkills(paths, false);
    const store = new WorkflowStore();
    const council: WorkflowNode = {
      id: "research",
      name: "Research council",
      kind: "council",
      terminal: true,
      workspace: { isolation: "read-only", writePaths: [] },
      goal: "Review the scientific claim from two independent perspectives.",
      members: [
        { id: "member-a", role: "Methodologist", model: model() },
        { id: "member-b", role: "Skeptic", model: model() },
      ],
      chair: model(),
      rounds: 1,
      preserveMinorityReports: true,
    };
    const original = store.saveDefinition(
      projectId,
      "personality-workflow",
      graph("personality-workflow", council),
    );

    const result = await applySkillCuration(
      projectId,
      paths,
      original.id,
      {
        expectedRevision: original.revision,
        nodeIds: ["research"],
        skillRefs: ["create-scientific-agent"],
        skillsMode: "manual",
        mimeographs: {
          mode: "manual",
          personalityRefs: ["methods/causal-reviewer", "statistics/skeptic"],
        },
      },
      {
        store,
        personalityInventory: () => ({
          available: true,
          storeRef: "scientific-agents/v1",
          reason: null,
          personalities: [
            { ref: "methods/causal-reviewer", title: "Causal reviewer" },
            { ref: "statistics/skeptic", title: "Statistical skeptic" },
          ],
        }),
      },
    );

    expect(
      result.definition.graph.nodes[0]?.settings?.deliberation,
    ).toMatchObject({
      bestOfNPersonalityCount: 2,
      mimeographs: {
        mode: "manual",
        personalityRefs: ["methods/causal-reviewer", "statistics/skeptic"],
      },
    });
  });

  it("makes lean4-prover a delegated skill on the existing Lean 4 executor node", async () => {
    const projectId = "f11-curator-lean4";
    const paths = ensureProjectExists(projectId);
    await seedProjectSkills(paths, false);
    const store = new WorkflowStore();
    const lean: WorkflowNode = {
      id: "research",
      name: "Verify arithmetic",
      kind: "lean4",
      terminal: true,
      workspace: { isolation: "read-only", writePaths: [] },
      goal: "Machine-check the arithmetic identity.",
      theorem: "theorem one_plus_one : 1 + 1 = 2 := by norm_num",
      mode: "verify",
      mathlib: true,
      skill: "byom-dag-fusion",
      evidence: {
        enabled: true,
        minimumIndependentSources: 0,
        requireArtifactReferences: true,
        onUnsupportedOutput: "rescue",
      },
    };
    const original = store.saveDefinition(
      projectId,
      "lean4-workflow",
      graph("lean4-workflow", lean),
    );
    const result = await applySkillCuration(
      projectId,
      paths,
      original.id,
      {
        expectedRevision: original.revision,
        nodeIds: ["research"],
        skillRefs: ["lean4-prover"],
        skillsMode: "manual",
        writeMode: "replace",
      },
      { store },
    );
    const node = result.definition.graph.nodes[0]!;
    const bindings = resolveS4NodeExecutionBindings(
      resolveNodeSpecV1(result.definition.graph, node),
      paths,
      2,
    );
    expect(node.kind).toBe("lean4");
    expect(bindings.skills.delegated).toEqual(["lean4-prover"]);
  });

  it("fails before writing when the 64-skill cap is exceeded", async () => {
    const projectId = "f11-curator-cap";
    const paths = ensureProjectExists(projectId);
    const store = new WorkflowStore();
    const original = store.saveDefinition(projectId, "cap-workflow", graph("cap-workflow"));
    const tooMany = Array.from(
      { length: MAX_CURATED_SKILLS + 1 },
      (_, index) => `skill-${String(index + 1)}`,
    );

    await expect(
      applySkillCuration(
        projectId,
        paths,
        original.id,
        {
          expectedRevision: original.revision,
          nodeIds: ["research"],
          skillRefs: tooMany,
          skillsMode: "manual",
        },
        { store },
      ),
    ).rejects.toMatchObject({
      status: 422,
      code: "REFERENCE_CAP_EXCEEDED",
    } satisfies Partial<SkillCuratorError>);
    expect(store.readDefinition(projectId, original.id)?.revision).toBe(1);
  });
});

describe("Autoresearch² live RunState adapter", () => {
  it("reads an actual run/event stream in both modes and enforces the autonomous bound", () => {
    const projectId = "f11-live-run";
    const store = new WorkflowStore();
    store.saveDefinition(projectId, "live-workflow", graph("live-workflow"));
    const manifest = store.createRun(projectId, {
      workflowId: "live-workflow",
      requestId: "f11-live-request",
      requestedBy: "user",
      input: { goal: "Critique the live run" },
    });
    let run = store.readRun(projectId, manifest.id)!;
    store.appendRunEvent(projectId, manifest.id, {
      eventId: "run-started-f11",
      type: "run_started",
    }, run.state.lastSeq);
    run = store.readRun(projectId, manifest.id)!;
    store.appendRunEvent(projectId, manifest.id, {
      eventId: "node-started-f11",
      type: "node_started",
      executionId: "dagx_f11-live-execution",
      nodeId: "research",
      attempt: 1,
      branchId: "entry",
    }, run.state.lastSeq);
    run = store.readRun(projectId, manifest.id)!;
    store.appendRunEvent(projectId, manifest.id, {
      eventId: "node-failed-f11",
      type: "node_failed",
      executionId: "dagx_f11-live-execution",
      nodeId: "research",
      attempt: 1,
      branchId: "entry",
      data: {
        error: {
          code: "OBSERVED_FAILURE",
          message: "The persisted research step failed.",
          retryable: false,
        },
        routeCondition: "failure",
      },
    }, run.state.lastSeq);

    const interactive = evaluateAutoresearchRun(projectId, manifest.id, {
      mode: "interactive",
      cycle: 1,
      maxEvaluations: 1,
    }, store);
    expect(interactive.needsUserInput).toBe(true);
    expect(interactive.critiques).toContainEqual(expect.objectContaining({
      title: expect.stringContaining("OBSERVED_FAILURE"),
      source: expect.objectContaining({ kind: "run-event" }),
    }));
    expect(interactive.persistedToRunState).toBe(false);

    const autonomous = evaluateAutoresearchRun(projectId, manifest.id, {
      mode: "autonomous",
      cycle: 2,
      maxEvaluations: 3,
      afterSeq: 0,
    }, store);
    expect(autonomous.remainingEvaluations).toBe(1);
    expect(autonomous.state.status).toBe("running");
    expect(autonomous.state.canStopRun).toBe(true);

    expect(() =>
      evaluateAutoresearchRun(projectId, manifest.id, {
        mode: "autonomous",
        cycle: 4,
        maxEvaluations: 3,
      }, store)
    ).toThrowError(/within the explicit maxEvaluations bound/);
  });
});

describe("prompt elevation adapter", () => {
  it("reuses F5's dest-index route and refuses a third elevator", () => {
    const unpublished = {
      hasRoute: () => false,
    };
    expect(promptElevationAdapterStatus(unpublished)).toEqual({
      available: false,
      interfaceDocument: "wave-f/interfaces/F5-elevate-to-dag.md",
      endpoint: "/elevate-to-dag",
      engine: "server/src/workflows/elevate-to-dag.ts",
      reason: expect.stringMatching(/unpublished on this dest index/i),
    });
    expect(
      promptElevationAdapterStatus({
        hasRoute: ({ method, url }) => method === "POST" && url === "/elevate-to-dag",
      }).available,
    ).toBe(true);
    expect(destHarnessAdapterStatus(unpublished)).toEqual({
      available: false,
      endpoint: "/harnesses",
      reason: expect.stringMatching(/unpublished on this dest index/i),
    });
    expect(
      destHarnessAdapterStatus({
        hasRoute: ({ method, url }) => method === "GET" && url === "/harnesses",
      }).available,
    ).toBe(true);
    expect(F11_SKILL_NAMES).toContain("prompt-elevation-to-dag");
  });
});
