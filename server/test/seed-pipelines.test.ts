import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import {
  SEED_PIPELINES_DIR,
  SEED_PIPELINE_PROVENANCE_SOURCE,
  listSeedPipelineFiles,
  seedProjectPipelines,
  translateSeedPipeline,
} from "../src/workflows/seed-pipelines.ts";
import { previewLegacyPipelineWorkflow } from "../src/workflows/legacy-pipeline-import.ts";
import { resolveNodeSpecV1 } from "../src/workflows/validate.ts";
import { SEEDED_PIPELINES } from "../../e2e/wave-f/f7/seeded-pipeline-inventory.ts";
import {
  WorkflowStore,
  runWorkflowDag,
  type ModelRequest,
  type WorkflowGraphDocument,
  type WorkflowModelResolutionReceipt,
  type WorkflowNodeExecutorContext,
  type WorkflowNodeExecutorResult,
} from "../src/workflows/index.ts";

/**
 * Gate B for master-brief row 20: the committed seed pipelines LOAD, VALIDATE
 * and RUN.
 *
 * "Validate" alone is deliberately not what these tests assert. They drive the
 * seeds through the same three pieces production uses — the legacy translator,
 * the workflow store, and `runWorkflowDag` — and assert on the effect: which
 * definitions the workflow-list read returns, which node executed in which
 * order, and which prompt and which resolved model reached the executor's
 * dispatch boundary for each node.
 */

const PROJECT_ID = "seed-pipelines-test";
const SECOND_PROJECT_ID = "seed-pipelines-test-second";

const scratchDirs: string[] = [];

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-pipelines-"));
  scratchDirs.push(dir);
  return dir;
}

function resetProjects(): void {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
}

function seedSource(file: string): string {
  return fs.readFileSync(path.join(SEED_PIPELINES_DIR, file), "utf8");
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

interface ExecutedNode {
  readonly nodeId: string;
  readonly prompt: string | undefined;
  readonly model: ModelRequest | undefined;
  readonly skills: { mode: string; list: string[] };
  readonly harness: string;
}

function receiptFor(model: ModelRequest): WorkflowModelResolutionReceipt {
  const requested = model.requested;
  if (requested.source !== "fixed") {
    throw new Error("Seed pipelines resolve fixed models only.");
  }
  return {
    request: model,
    resolved: {
      provider: requested.provider,
      model: requested.model,
      auth: requested.auth,
      reasoning: requested.reasoning,
      runtime: "pi",
    },
    fallbackUsed: false,
  };
}

/**
 * Records what the runner actually handed the node, then completes it. This is
 * the dispatch boundary: everything below it is the provider transport, which a
 * seeded-content test has no business standing up.
 */
function recordingExecutor(
  document: WorkflowGraphDocument,
  executed: ExecutedNode[],
) {
  return (context: WorkflowNodeExecutorContext): WorkflowNodeExecutorResult => {
    const { node } = context;
    const spec = resolveNodeSpecV1(
      document,
      node,
      "model" in node ? node.model : undefined,
    );
    executed.push({
      nodeId: node.id,
      prompt: "prompt" in node ? node.prompt : undefined,
      model: spec.model,
      skills: { mode: spec.skills.mode, list: [...spec.skills.list] },
      harness: spec.harness,
    });
    if (spec.model) context.recordModelResolution("agent", receiptFor(spec.model));
    return { output: `${node.id} done` };
  };
}

beforeEach(resetProjects);

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
});

describe("the committed seed pipelines load and validate", () => {
  it("ships exactly the three pipelines imported from the source branch", () => {
    expect(listSeedPipelineFiles()).toEqual([
      "composed-research-pipeline.yaml",
      "data-scientist.yaml",
      "research-starter.yaml",
    ]);
  });

  it("translates every committed seed into a document that validates", () => {
    const summary = listSeedPipelineFiles().map((file) => {
      const workflowId = file.replace(/\.yaml$/, "");
      const result = translateSeedPipeline(seedSource(file), workflowId, file);
      if (!result.ok) {
        throw new Error(`${file} did not translate: ${result.issues.join("; ")}`);
      }
      return {
        file,
        dialect: result.dialect,
        id: result.document.id,
        nodes: result.document.nodes.length,
        edges: result.document.edges.length,
      };
    });

    expect(summary).toEqual([
      {
        file: "composed-research-pipeline.yaml",
        dialect: "typed-nodespec-v1",
        id: "composed-research-pipeline",
        nodes: 24,
        edges: 23,
      },
      {
        file: "data-scientist.yaml",
        dialect: "typed-nodespec-v1",
        id: "data-scientist",
        nodes: 5,
        edges: 4,
      },
      {
        file: "research-starter.yaml",
        dialect: "legacy-pipeline-yaml",
        id: "research-starter",
        nodes: 3,
        edges: 2,
      },
    ]);
  });

  it("hands the legacy-dialect seed to the translator the runtime already has, not to a second parser", () => {
    const source = seedSource("research-starter.yaml");
    const viaLoader = translateSeedPipeline(source, "research-starter", "research-starter.yaml");
    const viaRuntimeTranslator = previewLegacyPipelineWorkflow({
      source,
      workflowId: "research-starter",
      reasoning: "high",
    });

    expect(viaLoader.ok).toBe(true);
    if (!viaLoader.ok) return;
    // The only difference the loader is permitted to introduce is the seed's
    // own provenance stamp.
    const { provenance, ...withoutProvenance } = viaLoader.document;
    expect(withoutProvenance).toEqual(viaRuntimeTranslator.graph);
    expect(provenance).toEqual({
      source: SEED_PIPELINE_PROVENANCE_SOURCE,
      id: "research-starter.yaml",
      sha256: sha256(source),
    });
  });

  it("matches the inventory the Playwright specs are written against, field for field", () => {
    const measured = listSeedPipelineFiles().map((file) => {
      const result = translateSeedPipeline(seedSource(file), file.replace(/\.yaml$/, ""), file);
      if (!result.ok) throw new Error(`${file} did not translate.`);
      const { document } = result;
      return {
        id: document.id,
        name: document.name,
        nodeCount: document.nodes.length,
        edgeCount: document.edges.length,
        entryNodeId: document.entryNodeId,
      };
    });

    // The e2e fixture cannot drift from the product without this failing.
    expect(measured).toEqual(
      SEEDED_PIPELINES.map((pipeline) => ({
        id: pipeline.id,
        name: pipeline.name,
        nodeCount: pipeline.nodeCount,
        edgeCount: pipeline.edgeCount,
        entryNodeId: pipeline.entryNodeId,
      })),
    );

    for (const pipeline of SEEDED_PIPELINES) {
      const result = translateSeedPipeline(
        seedSource(`${pipeline.id}.yaml`),
        pipeline.id,
        `${pipeline.id}.yaml`,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.document.description, `${pipeline.id} description`)
        .toContain(pipeline.descriptionPhrase);
    }
  });

  it("carries no legacy-brand token in any seeded document, source or translated", () => {
    for (const file of listSeedPipelineFiles()) {
      const source = seedSource(file);
      const result = translateSeedPipeline(source, file.replace(/\.yaml$/, ""), file);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      // Assembled from fragments so this assertion is not itself a violation of
      // the ban it enforces.
      const bannedToken = ["arch", "on"].join("");
      expect(source.toLowerCase()).not.toContain(bannedToken);
      expect(JSON.stringify(result.document).toLowerCase()).not.toContain(bannedToken);
    }
  });
});

describe("seeding a project's workflow library", () => {
  it("writes definitions the workflow-list read returns, with their source bytes recorded", async () => {
    const store = new WorkflowStore();

    const report = await seedProjectPipelines(PROJECT_ID, { store });

    expect({ seeded: report.seeded, skipped: report.skipped, rejected: report.rejected })
      .toEqual({ seeded: 3, skipped: 0, rejected: 0 });

    // listDefinitions is exactly what GET /dag-workflows maps over.
    const listed = store.listDefinitions(PROJECT_ID);
    expect(listed.map((definition) => definition.id).sort()).toEqual([
      "composed-research-pipeline",
      "data-scientist",
      "research-starter",
    ]);
    expect(listed.map((definition) => definition.graph.name).sort()).toEqual([
      "Composed Research Pipeline",
      "Data Scientist",
      "Research Starter",
    ]);

    for (const definition of listed) {
      expect(definition.graph.provenance).toEqual({
        source: SEED_PIPELINE_PROVENANCE_SOURCE,
        id: `${definition.id}.yaml`,
        sha256: sha256(seedSource(`${definition.id}.yaml`)),
      });
      expect(definition.graphSha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("never clobbers a project's own edits on a later seed pass", async () => {
    const store = new WorkflowStore();
    await seedProjectPipelines(PROJECT_ID, { store });

    const before = store.readDefinition(PROJECT_ID, "research-starter");
    expect(before).not.toBeNull();
    const edited: WorkflowGraphDocument = {
      ...before!.graph,
      name: "My edited starter",
    };
    store.saveDefinition(PROJECT_ID, "research-starter", edited, {
      expectedRevision: before!.revision,
    });

    const second = await seedProjectPipelines(PROJECT_ID, { store });

    expect({ seeded: second.seeded, skipped: second.skipped, rejected: second.rejected })
      .toEqual({ seeded: 0, skipped: 3, rejected: 0 });
    expect(store.readDefinition(PROJECT_ID, "research-starter")?.graph.name)
      .toBe("My edited starter");
  });

  it("reports a malformed seed instead of throwing, and still seeds the others", async () => {
    const seedDir = scratch();
    fs.copyFileSync(
      path.join(SEED_PIPELINES_DIR, "research-starter.yaml"),
      path.join(seedDir, "research-starter.yaml"),
    );
    fs.writeFileSync(
      path.join(seedDir, "broken.yaml"),
      "name: Broken\nprovider: pi\ninteractive: true\nnodes: []\n",
      "utf8",
    );

    const store = new WorkflowStore();
    const report = await seedProjectPipelines(SECOND_PROJECT_ID, { store, seedDir });

    expect({ seeded: report.seeded, rejected: report.rejected }).toEqual({
      seeded: 1,
      rejected: 1,
    });
    const broken = report.outcomes.find((outcome) => outcome.file === "broken.yaml");
    expect(broken?.status).toBe("rejected");
    expect(broken?.issues.join(" ")).toContain("interactive");
    expect(store.readDefinition(SECOND_PROJECT_ID, "research-starter")).not.toBeNull();
    expect(store.readDefinition(SECOND_PROJECT_ID, "broken")).toBeNull();
  });
});

describe("a seeded pipeline runs", () => {
  it("executes research-starter through the durable runner in dependency order", async () => {
    const store = new WorkflowStore();
    await seedProjectPipelines(PROJECT_ID, { store });
    const document = store.readDefinition(PROJECT_ID, "research-starter")!.graph;

    const manifest = store.createRun(PROJECT_ID, {
      workflowId: "research-starter",
      requestId: "seed-research-starter",
      requestedBy: "api",
      input: { goal: "Exercise the seeded research starter." },
    });
    const executed: ExecutedNode[] = [];

    const result = await runWorkflowDag({
      projectId: PROJECT_ID,
      runId: manifest.id,
      store,
      executeNode: recordingExecutor(document, executed),
    });

    expect(result.state.status).toBe("succeeded");
    expect(executed.map((node) => node.nodeId)).toEqual(
      SEEDED_PIPELINES.find((pipeline) => pipeline.id === "research-starter")!.executionOrder,
    );

    // The seed's own prompt text is what reached the dispatch boundary, with
    // the two placeholders the importer rewrites already rewritten.
    expect(executed[0].prompt).toContain("Restate the request in your own words");
    expect(executed[0].prompt).toContain(
      "[Kady run goal and variables from the verified run context]",
    );
    expect(executed[0].prompt).not.toContain("$ARGUMENTS");
    expect(executed[1].prompt).toContain("[verified inbound output from node scope]");
    expect(executed[2].prompt).toContain("[verified inbound output from node research]");

    // The model the seed declares is the model the executor was given.
    for (const node of executed) {
      expect(node.model?.requested).toMatchObject({
        source: "fixed",
        provider: "openrouter",
        model: "anthropic/claude-opus-4.8",
      });
      expect(node.harness).toBe("pi");
    }

    const events = store.readRunEvents(PROJECT_ID, manifest.id, { limit: 200 }).events;
    expect(events[0].type).toBe("run_queued");
    expect(events.at(-1)?.type).toBe("run_succeeded");
    expect(events.filter((event) => event.type === "node_succeeded")).toHaveLength(3);
  });

  it("executes data-scientist and gives every node the skills its seed declares", async () => {
    const store = new WorkflowStore();
    await seedProjectPipelines(PROJECT_ID, { store });
    const document = store.readDefinition(PROJECT_ID, "data-scientist")!.graph;

    const manifest = store.createRun(PROJECT_ID, {
      workflowId: "data-scientist",
      requestId: "seed-data-scientist",
      requestedBy: "api",
      input: { goal: "Exercise the seeded data-science loop." },
    });
    const executed: ExecutedNode[] = [];

    const result = await runWorkflowDag({
      projectId: PROJECT_ID,
      runId: manifest.id,
      store,
      executeNode: recordingExecutor(document, executed),
    });

    expect(result.state.status).toBe("succeeded");
    expect(executed.map((node) => node.nodeId)).toEqual(
      SEEDED_PIPELINES.find((pipeline) => pipeline.id === "data-scientist")!.executionOrder,
    );
    expect(
      executed.map((node) => ({ nodeId: node.nodeId, skills: node.skills })),
    ).toEqual([
      {
        nodeId: "plan",
        skills: {
          mode: "auto-manual",
          list: ["exploratory-data-analysis", "statistical-analysis"],
        },
      },
      {
        nodeId: "code",
        skills: {
          mode: "auto-manual",
          list: ["exploratory-data-analysis", "polars", "matplotlib"],
        },
      },
      {
        nodeId: "review",
        skills: { mode: "auto-manual", list: ["scientific-critical-thinking"] },
      },
      {
        nodeId: "reflect",
        skills: {
          mode: "auto-manual",
          list: ["scientific-critical-thinking", "statistical-analysis"],
        },
      },
      {
        nodeId: "summarize",
        skills: { mode: "auto-manual", list: ["scientific-writing"] },
      },
    ]);
  });
});
