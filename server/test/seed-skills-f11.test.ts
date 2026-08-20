import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DefaultResourceLoader,
  SettingsManager,
  formatSkillsForPrompt,
} from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/config.ts";
import type { ProjectPaths } from "../src/projects.ts";
import {
  F11_SKILL_NAMES,
} from "../src/agent/skill-curator.ts";
import {
  listProjectSkills,
  seedProjectSkills,
  skillsDisabledDir,
} from "../src/agent/skills.ts";
import { validateWorkflowGraphDocument } from "../src/workflows/validate.ts";
import { WorkflowStore } from "../src/workflows/store.ts";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "kady-f11-skills-"));

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function projectPaths(id: string): ProjectPaths {
  const root = path.join(ROOT, id);
  const sandbox = path.join(root, "sandbox");
  const kadyDir = path.join(sandbox, ".kady");
  const workflowsDir = path.join(kadyDir, "workflows");
  const workflowBudgetDir = path.join(workflowsDir, "budget");
  const modalDir = path.join(kadyDir, "modal");
  const piDir = path.join(sandbox, ".pi");
  fs.mkdirSync(sandbox, { recursive: true });
  return {
    id,
    root,
    projectJson: path.join(root, "project.json"),
    sandbox,
    uploadDir: path.join(sandbox, "user_data"),
    kadyDir,
    runsDir: path.join(kadyDir, "runs"),
    notebookDir: path.join(kadyDir, "notebook"),
    provenanceDir: path.join(kadyDir, "provenance"),
    workflowsDir,
    workflowDefinitionsDir: path.join(workflowsDir, "definitions"),
    workflowRunsDir: path.join(workflowsDir, "runs"),
    workflowBudgetDir,
    workflowReservationsDir: path.join(workflowBudgetDir, "reservations"),
    modalDir,
    modalJobsDir: path.join(modalDir, "jobs"),
    modalReservationsDir: path.join(modalDir, "reservations"),
    modalCacheDir: path.join(modalDir, "cache"),
    modalEnvironmentsDir: path.join(modalDir, "environments"),
    skillsDir: path.join(piDir, "skills"),
    sessionsDir: path.join(piDir, "sessions"),
  };
}

const REQUIRED_EFFECT_TERMS: Record<(typeof F11_SKILL_NAMES)[number], RegExp[]> = {
  "autoresearch-graph-architect": [
    /POST \/dag-workflows\/validate/,
    /settings\.skills/,
    /revision conflict/i,
  ],
  "autoresearch-squared": [
    /maxEvaluations/,
    /Stop monitoring/,
    /persistedToRunState/,
  ],
  "prompt-elevation-to-dag": [
    /skills\/curator\/capabilities/,
    /available.*false/s,
    /parallel elevator/i,
  ],
  "workflow-supervisor": [
    /GET \/durability\/settings/,
    /presetId/,
    /stopAvailability/,
  ],
  "lean4-prover": [
    /kind: "lean4"/,
    /Lean4ProofArtifact/,
    /ARTIFACT_UNTRUSTED/,
  ],
  "create-scientific-agent": [
    /PUT \/agents\/<name>/,
    /mimeographs\.personalityRefs/,
    /source: "project"/,
  ],
  "infranodus-ontology-creator": [
    /mcp__infranodus__<sanitized-tool-name>/,
    /GET \/integrations/,
    /No suitable discovered tool/,
  ],
};

describe("F11 committed skill loading", () => {
  it("seeds, enables, parses, and exposes all seven through Pi's real resource loader", async () => {
    const paths = projectPaths("loader");
    await seedProjectSkills(paths, false);

    const listed = listProjectSkills(paths);
    const listedNames = new Set(listed.map((skill) => skill.name));
    for (const name of F11_SKILL_NAMES) {
      expect(listedNames.has(name), `${name} missing from listProjectSkills`).toBe(true);
      expect(
        fs.existsSync(path.join(skillsDisabledDir(paths), name, "SKILL.md")),
        `${name} was swept into the disabled directory`,
      ).toBe(false);
    }

    const agentDir = path.join(ROOT, "agent-dir");
    const loader = new DefaultResourceLoader({
      cwd: paths.sandbox,
      agentDir,
      settingsManager: SettingsManager.inMemory({}, { projectTrusted: true }),
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const loaded = loader.getSkills();
    expect(loaded.diagnostics).toEqual([]);
    const loadedNames = new Set(loaded.skills.map((skill) => skill.name));
    for (const name of F11_SKILL_NAMES) {
      expect(loadedNames.has(name), `${name} missing from DefaultResourceLoader`).toBe(true);
    }

    const prompt = formatSkillsForPrompt(loaded.skills);
    for (const name of F11_SKILL_NAMES) {
      expect(prompt).toContain(`<name>${name}</name>`);
    }
  });

  it("gives every skill concrete effect instructions and failure handling", () => {
    for (const name of F11_SKILL_NAMES) {
      const source = fs.readFileSync(
        path.join(REPO_ROOT, "server", "seed", "skills", name, "SKILL.md"),
        "utf8",
      );
      expect(source.length, `${name} is nominally short`).toBeGreaterThan(2_500);
      expect(source, `${name} lacks failure handling`).toMatch(/## Failure handling/);
      for (const term of REQUIRED_EFFECT_TERMS[name]) {
        expect(source, `${name} lacks ${String(term)}`).toMatch(term);
      }
    }
  });

  it("validates and saves the graph architect's shipped NodeSpec v1 example", () => {
    const source = fs.readFileSync(
      path.join(
        REPO_ROOT,
        "server",
        "seed",
        "skills",
        "autoresearch-graph-architect",
        "references",
        "minimal-autoresearch.json",
      ),
      "utf8",
    );
    const graph = JSON.parse(source) as unknown;
    const validation = validateWorkflowGraphDocument(graph);
    expect(validation).toMatchObject({ ok: true });
    if (!validation.ok) return;

    const store = new WorkflowStore();
    const saved = store.saveDefinition(
      "f11-autoresearch-example",
      validation.document.id,
      validation.document,
    );
    expect(saved.revision).toBe(1);
    expect(
      saved.graph.nodes[0]?.settings?.skills?.list,
    ).toContain("autoresearch-graph-architect");
    expect(store.readDefinition("f11-autoresearch-example", saved.id)?.graphSha256)
      .toMatch(/^[a-f0-9]{64}$/);
  });
});
