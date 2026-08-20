import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import { seedProjectSkills } from "../src/agent/skills.ts";
import { resolvePaths, type ProjectPaths } from "../src/projects.ts";
import { resolveNodeSpecV1 } from "../src/workflows/validate.ts";
import {
  resolveS4NodeExecutionBindings,
  s4ControlledDelegationTask,
} from "../src/workflows/kady-node-executor.ts";
import type { WorkflowGraphDocument, WorkflowNode } from "../src/workflows/schema.ts";

/**
 * Gate B for master-brief row 21. A `SKILL.md` existing on disk is not evidence
 * of anything — that is the precedent this row was written against. These tests
 * exercise (a) the REAL committed-skill installer, `seedProjectSkills`, which is
 * what production calls, and (b) the effect of naming the skill on a node: the
 * launch policy the executor builds and the delegation envelope it dispatches.
 */

const PROJECT_ID = "seed-pipelines-skill-binding";
const STUDIO_SKILL = "scientific-dag-studio";
const OPERATIONS_SKILL = "scientific-pipelines";

const AUTHORING_CORPUS = [
  "two-runtimes.md",
  "typed-node-vocabulary.md",
  "legacy-dialect-nodes.md",
  "variables-and-outputs.md",
  "good-practices.md",
  "example-pipelines.md",
];

function resetProjects(): void {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
}

async function installedProject(): Promise<ProjectPaths> {
  const paths = resolvePaths(PROJECT_ID);
  fs.mkdirSync(paths.skillsDir, { recursive: true });
  // The real installer, with the network path disabled: committed skills only.
  await seedProjectSkills(paths, false);
  return paths;
}

function documentWith(node: WorkflowNode): WorkflowGraphDocument {
  return {
    schemaVersion: "1.0",
    id: "skill-binding",
    name: "Skill binding",
    entryNodeId: node.id,
    defaultModel: {
      requested: {
        source: "fixed",
        provider: "openrouter",
        model: "anthropic/claude-opus-4.8",
        auth: { kind: "api-key" },
        reasoning: "high",
      },
      resolution: { mode: "exact" },
    },
    limits: {
      maxIterations: 2,
      maxModelCalls: 2,
      maxParallelism: 1,
      maxSubagents: 1,
      timeoutMs: 600_000,
      maxTokens: 200_000,
      maxCostUsd: 2,
      maxRetries: 0,
    },
    evidence: {
      enabled: false,
      minimumIndependentSources: 0,
      requireArtifactReferences: false,
      onUnsupportedOutput: "fail",
    },
    nodes: [node],
    edges: [],
  };
}

function agentNodeWithSkills(
  mode: "auto" | "auto-manual" | "manual",
  list: string[],
): WorkflowNode {
  return {
    id: "design",
    name: "Design the pipeline",
    kind: "agent",
    terminal: true,
    workspace: { isolation: "read-only", writePaths: [] },
    settings: { version: 1, skills: { mode, list } },
    prompt: "Design a scientific pipeline for the researcher's goal.",
  };
}

beforeEach(resetProjects);
afterEach(() => fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }));

describe("the real committed-skill installer puts the builder skill in a project", () => {
  it("installs both committed skills through seedProjectSkills, not through an existence check", async () => {
    const paths = await installedProject();

    const installed = fs
      .readdirSync(paths.skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    expect(installed).toContain(STUDIO_SKILL);
    expect(installed).toContain(OPERATIONS_SKILL);
    expect(fs.existsSync(path.join(paths.skillsDir, STUDIO_SKILL, "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(paths.skillsDir, OPERATIONS_SKILL, "SKILL.md"))).toBe(true);
  });

  it("installs the DAG-authoring corpus alongside the skill, not just its front page", async () => {
    const paths = await installedProject();
    const recipes = path.join(paths.skillsDir, STUDIO_SKILL, "references", "recipes");

    expect(fs.readdirSync(recipes).sort()).toEqual([...AUTHORING_CORPUS].sort());
    for (const file of AUTHORING_CORPUS) {
      // Substance, not presence: a stub would pass an existence check.
      expect(fs.statSync(path.join(recipes, file)).size).toBeGreaterThan(3_000);
    }

    const operationsReferences = path.join(paths.skillsDir, OPERATIONS_SKILL, "references");
    expect(fs.readdirSync(operationsReferences).sort()).toEqual([
      "seeded-pipelines.md",
      "typed-workflow-operations.md",
    ]);
  });

  it("indexes the corpus from the installed SKILL.md so the agent reading it can find it", async () => {
    const paths = await installedProject();
    const studio = fs.readFileSync(
      path.join(paths.skillsDir, STUDIO_SKILL, "SKILL.md"),
      "utf8",
    );
    for (const file of AUTHORING_CORPUS) {
      expect(studio).toContain(`references/recipes/${file}`);
    }

    const operations = fs.readFileSync(
      path.join(paths.skillsDir, OPERATIONS_SKILL, "SKILL.md"),
      "utf8",
    );
    expect(operations).toContain("references/typed-workflow-operations.md");
    expect(operations).toContain("references/seeded-pipelines.md");
  });

  it("teaches the two runtimes rather than describing a surface this app does not ship", async () => {
    const paths = await installedProject();
    const twoRuntimes = fs.readFileSync(
      path.join(paths.skillsDir, STUDIO_SKILL, "references", "recipes", "two-runtimes.md"),
      "utf8",
    );

    // The claims that make the file load-bearing.
    expect(twoRuntimes).toContain("kind: \"fusion\"");
    expect(twoRuntimes).toContain("settings.skills");
    expect(twoRuntimes).toContain("approval");
    // The upstream corpus documented adapters and a CLI this app has no trace
    // of; carrying that prose over would make the skill lie to its reader.
    for (const absent of ["Discord", "Telegram", "Slack"]) {
      expect(twoRuntimes).not.toContain(absent);
    }
  });
});

describe("naming the skill on a node changes what the executor dispatches", () => {
  it("puts the installed skill into the node's delegated launch policy", async () => {
    const paths = await installedProject();
    const node = agentNodeWithSkills("manual", [STUDIO_SKILL]);
    const spec = resolveNodeSpecV1(documentWith(node), node);

    const bindings = resolveS4NodeExecutionBindings(spec, paths, 1);

    expect(bindings.skills).toEqual({
      mode: "manual",
      configured: [STUDIO_SKILL],
      delegated: [STUDIO_SKILL],
    });
    expect(bindings.harness).toBe("pi");
  });

  it("unions the project's installed skills with the node's list under auto-manual", async () => {
    const paths = await installedProject();
    const node = agentNodeWithSkills("auto-manual", ["statistical-analysis"]);
    const spec = resolveNodeSpecV1(documentWith(node), node);

    const bindings = resolveS4NodeExecutionBindings(spec, paths, 1);

    // The committed skills arrived from the real installer, not from the node.
    expect(bindings.skills.delegated).toContain(STUDIO_SKILL);
    expect(bindings.skills.delegated).toContain(OPERATIONS_SKILL);
    expect(bindings.skills.delegated).toContain("statistical-analysis");
    expect(bindings.skills.configured).toEqual(["statistical-analysis"]);
  });

  it("carries the skill into the delegation envelope the child process is actually launched with", async () => {
    const paths = await installedProject();
    const node = agentNodeWithSkills("manual", [STUDIO_SKILL]);
    const spec = resolveNodeSpecV1(documentWith(node), node);
    const bindings = resolveS4NodeExecutionBindings(spec, paths, 1);

    const task = s4ControlledDelegationTask(bindings, "Design a pipeline.");

    // The human-readable execution context the node's task carries.
    expect(task).toContain(`skills.mode=manual; skills=["${STUDIO_SKILL}"]`);
    // And the machine-readable envelope the trusted extension decodes.
    const envelope = task.split("\n")[0];
    const encoded = envelope.slice(envelope.indexOf(":") + 1);
    const decoded = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as { skills: { delegated: string[] } };
    expect(decoded.skills.delegated).toEqual([STUDIO_SKILL]);
  });

  it("gives a node with skills.mode manual nothing the node did not name", async () => {
    const paths = await installedProject();
    const node = agentNodeWithSkills("manual", ["statistical-analysis"]);
    const spec = resolveNodeSpecV1(documentWith(node), node);

    const bindings = resolveS4NodeExecutionBindings(spec, paths, 1);

    expect(bindings.skills.delegated).toEqual(["statistical-analysis"]);
    expect(bindings.skills.delegated).not.toContain(STUDIO_SKILL);
  });
});
