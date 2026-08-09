/**
 * Per-project skill seeding + listing.
 *
 * Skills are placed in `<sandbox>/.pi/skills/` so Pi's DefaultResourceLoader
 * (cwd = sandbox) auto-discovers and the agent activates them natively — no
 * orchestrator passthrough. The catalogue is the same K-Dense repo as before,
 * and the SKILL.md format is unchanged (Pi-compatible).
 *
 * Fast path: copy an existing sibling project's skills (local I/O). Slow path:
 * fetch the catalogue once through `skills-fetch.ts`.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  loadSkillsFromDir,
  type ResourceDiagnostic,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { KADY_PI_AGENT_DIR, PROJECTS_ROOT, REPO_ROOT } from "../config.ts";
import type { ProjectPaths } from "../projects.ts";
import type { ToggleResult } from "./capability-state.ts";
import { fetchCatalogue } from "./skills-fetch.ts";

const DEFAULT_DISABLED_MIGRATION = "package-skills-disabled-v1";
const RETIRED_COMMITTED_SKILLS_MIGRATION = "retired-committed-skills-v1";
const RETIRED_SKILL_NOTICE = ".kady-retirement.json";

// deprecated-compat: exact fingerprints of committed skill trees removed by
// the Scientific DAG Studio rename. These values were calculated from the
// immutable lane base so user edits can never be mistaken for shipped bytes.
const LEGACY_COMMITTED_SKILL_FINGERPRINTS: Readonly<Record<string, string>> = {
  archon: "a47542ca754c4fa50369be63c0bd8591cfd74f39bbb249a7682a3148516b2aba",
  "scientific-pipeline-builder":
    "564746fb4f3f4c4fdc5d7ace9a30bd5e47163215497b02e3d25c4c56edb8850b",
};

/**
 * Skills committed in-repo (scientific-dag-studio + scientific-pipelines — the DAG
 * Builder chat rail's preloads). Unlike the fetched catalogue they need no
 * network, and they are topped up on EVERY seed call so existing projects
 * pick up newly-committed skills too (mirrors the reference tree's c60a013).
 */
const COMMITTED_SKILLS_DIR = path.join(REPO_ROOT, "server", "seed", "skills");

/**
 * One place skills are installed: a project sandbox, or the user-level Pi agent
 * directory shared by every project.
 *
 * Pi loads both — `package-manager.ts`'s builtin resolution adds
 * `<agentDir>/skills` unconditionally and `<cwd>/.pi/skills` when the project
 * is trusted — and child `pi` processes running subagents inherit the same
 * agent dir, so a global skill reaches them too. Project entries are resolved
 * first and skill-name collisions are first-wins, so **a project skill shadows
 * a global one of the same name**.
 */
export interface SkillRoot {
  kind: "project" | "global";
  /** Project id, or "global"; used in messages only. */
  id: string;
  skillsDir: string;
  disabledDir: string;
  archivedDir: string;
  /** Holds this root's manifest, staging area and migration markers. */
  stateDir: string;
}

/** Either an explicit root or a project, which implies its own root. */
export type SkillScopeRef = ProjectPaths | SkillRoot;

export function projectSkillRoot(paths: ProjectPaths): SkillRoot {
  const piDir = path.join(paths.sandbox, ".pi");
  return {
    kind: "project",
    id: paths.id,
    skillsDir: paths.skillsDir,
    disabledDir: path.join(piDir, "skills-disabled"),
    archivedDir: path.join(piDir, "skills-archived"),
    stateDir: paths.kadyDir,
  };
}

/**
 * The user-level root. State lives in a `kady-skills/` subdirectory rather than
 * loose in the agent dir, because `PI_CODING_AGENT_DIR` may deliberately point
 * at a standalone Pi installation whose files are not ours to crowd.
 */
export function globalSkillRoot(): SkillRoot {
  return {
    kind: "global",
    id: "global",
    skillsDir: path.join(KADY_PI_AGENT_DIR, "skills"),
    disabledDir: path.join(KADY_PI_AGENT_DIR, "skills-disabled"),
    archivedDir: path.join(KADY_PI_AGENT_DIR, "skills-archived"),
    stateDir: path.join(KADY_PI_AGENT_DIR, "kady-skills"),
  };
}

/** Normalize either accepted shape to a root. */
export function asSkillRoot(ref: SkillScopeRef): SkillRoot {
  return "kind" in ref ? ref : projectSkillRoot(ref);
}

export type SkillScope = "project" | "global";

/** Resolve a request's `scope` parameter; unknown values fall back to project. */
export function skillRootForScope(paths: ProjectPaths, scope?: string): SkillRoot {
  return scope === "global" ? globalSkillRoot() : projectSkillRoot(paths);
}

/**
 * Package-reference skills add standing context that current models generally
 * do not need. Keep them installed so users can opt in from Settings, but seed
 * them into the disabled directory for new projects.
 *
 * Workflow, data-source, and platform skills remain enabled. Modal and
 * HypoGeniC are intentional exceptions: although broader than libraries, they
 * are package-backed and should also default to disabled.
 */
const DEFAULT_DISABLED_SKILLS = new Set([
  "aeon",
  "anndata",
  "arboreto",
  "astropy",
  "biopython",
  "bioservices",
  "cellxgene-census",
  "cirq",
  "cobrapy",
  "dask",
  "datamol",
  "deepchem",
  "deeptools",
  "esm",
  "etetoolkit",
  "flowio",
  "fluidsim",
  "geniml",
  "geopandas",
  "gget",
  "gtars",
  "histolab",
  "hypogenic",
  "lamindb",
  "markitdown",
  "matchms",
  "matplotlib",
  "medchem",
  "modal",
  "molfeat",
  "networkx",
  "neurokit2",
  "openpiv",
  "pathml",
  "pennylane",
  "polars",
  "polars-bio",
  "pufferlib",
  "pydeseq2",
  "pydicom",
  "pyhealth",
  "pylabrobot",
  "pymatgen",
  "pymc",
  "pymoo",
  "pyopenms",
  "pysam",
  "pytdc",
  "pytorch-lightning",
  "pyzotero",
  "qiskit",
  "qutip",
  "rdkit",
  "scanpy",
  "scikit-bio",
  "scikit-learn",
  "scikit-survival",
  "scvelo",
  "scvi-tools",
  "seaborn",
  "shap",
  "simpy",
  "stable-baselines3",
  "statsmodels",
  "sympy",
  "tiledbvcf",
  "timesfm-forecasting",
  "torch-geometric",
  "torchdrug",
  "transformers",
  "umap-learn",
  "vaex",
  "zarr-python",
]);

export function isSkillDefaultDisabled(name: string): boolean {
  return DEFAULT_DISABLED_SKILLS.has(name);
}

function countSkillDirs(dir: string): number {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(
      (d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, "SKILL.md")),
    ).length;
  } catch {
    return 0;
  }
}

export function skillsDisabledDir(ref: SkillScopeRef): string {
  return asSkillRoot(ref).disabledDir;
}

function countInstalledSkills(ref: SkillScopeRef): number {
  const root = asSkillRoot(ref);
  return countSkillDirs(root.skillsDir) + countSkillDirs(root.disabledDir);
}

function defaultDisabledMigrationMarker(paths: ProjectPaths): string {
  return path.join(paths.kadyDir, "migrations", DEFAULT_DISABLED_MIGRATION);
}

function retiredCommittedSkillsMigrationMarker(paths: ProjectPaths): string {
  return path.join(paths.kadyDir, "migrations", RETIRED_COMMITTED_SKILLS_MIGRATION);
}

function retiredCommittedSkillsDir(paths: ProjectPaths): string {
  return path.join(
    paths.sandbox,
    ".pi",
    ".retired",
    RETIRED_COMMITTED_SKILLS_MIGRATION,
  );
}

/** Stable content-and-layout fingerprint for one complete skill directory. */
export function fingerprintSkillDirectory(root: string): string {
  const hash = crypto.createHash("sha256");
  hash.update("kady-skill-tree-v1\0");

  const walk = (dir: string, relativeDir: string): void => {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        hash.update(`d\0${relative}\0`);
        walk(absolute, relative);
      } else if (entry.isFile()) {
        hash.update(`f\0${relative}\0`);
        hash.update(fs.readFileSync(absolute));
        hash.update("\0");
      } else if (entry.isSymbolicLink()) {
        hash.update(`l\0${relative}\0${fs.readlinkSync(absolute)}\0`);
      }
    }
  };

  walk(root, "");
  return hash.digest("hex");
}

/**
 * Retire committed skills removed by the naming sweep exactly once per
 * project. Shipped bytes are archived; user-edited bytes remain installed but
 * disabled, with a notice explaining the replacement and safety decision.
 */
export function applyRetiredCommittedSkillMigration(
  paths: ProjectPaths,
  expectedFingerprints: Readonly<Record<string, string>> =
    LEGACY_COMMITTED_SKILL_FINGERPRINTS,
): void {
  const marker = retiredCommittedSkillsMigrationMarker(paths);
  if (fs.existsSync(marker)) return;

  const disabledDir = skillsDisabledDir(paths);
  const retiredDir = retiredCommittedSkillsDir(paths);
  for (const [name, shippedFingerprint] of Object.entries(expectedFingerprints)) {
    const enabled = path.join(paths.skillsDir, name);
    const disabled = path.join(disabledDir, name);
    const source = fs.existsSync(enabled) ? enabled : fs.existsSync(disabled) ? disabled : null;
    if (!source) continue;

    if (fingerprintSkillDirectory(source) === shippedFingerprint) {
      fs.mkdirSync(retiredDir, { recursive: true });
      fs.renameSync(source, path.join(retiredDir, name));
      continue;
    }

    fs.mkdirSync(disabledDir, { recursive: true });
    if (source !== disabled) fs.renameSync(source, disabled);
    fs.writeFileSync(
      path.join(disabled, RETIRED_SKILL_NOTICE),
      JSON.stringify(
        {
          migration: RETIRED_COMMITTED_SKILLS_MIGRATION,
          status: "disabled",
          reason: "This removed committed skill contains user modifications and was preserved disabled.",
          replacements: ["scientific-dag-studio", "scientific-pipelines"],
        },
        null,
        2,
      ) + "\n",
      "utf-8",
    );
  }

  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, "", "utf-8");
}

/**
 * Apply the package-skill default once to an existing project. The marker is
 * written only after skills exist and all moves finish, so a later explicit
 * user enable is preserved.
 */
export function applyDefaultSkillStates(paths: ProjectPaths): void {
  const marker = defaultDisabledMigrationMarker(paths);
  if (fs.existsSync(marker) || countInstalledSkills(paths) === 0) return;

  const disabledDir = skillsDisabledDir(paths);
  for (const name of DEFAULT_DISABLED_SKILLS) {
    const src = path.join(paths.skillsDir, name);
    const dest = path.join(disabledDir, name);
    if (!fs.existsSync(path.join(src, "SKILL.md")) || fs.existsSync(dest)) continue;
    fs.mkdirSync(disabledDir, { recursive: true });
    fs.renameSync(src, dest);
  }

  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, "", "utf-8");
}

/** Another project's enabled/disabled dirs that have skills (copy fast path). */
function findSiblingSkillDirs(excludeId: string): string[] | null {
  if (!fs.existsSync(PROJECTS_ROOT)) return null;
  for (const child of fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true })) {
    if (!child.isDirectory() || child.name === excludeId) continue;
    const piDir = path.join(PROJECTS_ROOT, child.name, "sandbox", ".pi");
    const candidates = [path.join(piDir, "skills"), path.join(piDir, "skills-disabled")];
    if (candidates.some((candidate) => countSkillDirs(candidate) > 0)) return candidates;
  }
  return null;
}

function copySkillDirs(srcDir: string, paths: ProjectPaths): number {
  if (!fs.existsSync(srcDir)) return 0;
  let copied = 0;
  for (const d of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const src = path.join(srcDir, d.name);
    if (!fs.existsSync(path.join(src, "SKILL.md"))) continue;
    const enabled = path.join(paths.skillsDir, d.name);
    const disabled = path.join(skillsDisabledDir(paths), d.name);
    if (fs.existsSync(enabled) || fs.existsSync(disabled)) continue; // preserve user state/customizations
    const destDir = DEFAULT_DISABLED_SKILLS.has(d.name)
      ? skillsDisabledDir(paths)
      : paths.skillsDir;
    const dest = path.join(destDir, d.name);
    fs.mkdirSync(destDir, { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
    copied++;
  }
  return copied;
}

/**
 * Ensure a project's skills dir is populated. Returns the number of skills.
 * `allowRemote=false` skips the download (fast path only).
 */
export async function seedProjectSkills(
  paths: ProjectPaths,
  allowRemote = true,
): Promise<number> {
  // Committed skills ALWAYS top up, non-clobbering (copySkillDirs skips
  // anything already enabled/disabled), so an EXISTING project gains newly
  // committed skills instead of short-circuiting on an already-populated dir.
  // Record whether the project had skills BEFORE the top-up: a fresh project
  // must still fall through to the sibling/catalogue seeding below, not be
  // counted as populated just because the committed skills landed first.
  const hadSkillsBeforeTopUp = countInstalledSkills(paths) > 0;
  copySkillDirs(COMMITTED_SKILLS_DIR, paths);

  if (hadSkillsBeforeTopUp) {
    applyRetiredCommittedSkillMigration(paths);
    applyDefaultSkillStates(paths);
    return countInstalledSkills(paths);
  }

  const sibling = findSiblingSkillDirs(paths.id);
  if (sibling) {
    for (const sourceDir of sibling) copySkillDirs(sourceDir, paths);
    if (countInstalledSkills(paths) > 0) {
      applyRetiredCommittedSkillMigration(paths);
      applyDefaultSkillStates(paths);
      return countInstalledSkills(paths);
    }
  }
  if (allowRemote) {
    try {
      // Staging is left in place: the sync pass that follows a seed reuses the
      // same download instead of fetching the catalogue a second time.
      const catalogue = await fetchCatalogue();
      try {
        copySkillDirs(catalogue.skillsDir, paths);
      } finally {
        catalogue.cleanup();
      }
    } catch {
      // A failed download leaves the project skill-less but usable; the daily
      // sync and the Settings refresh both retry.
    }
  }
  applyRetiredCommittedSkillMigration(paths);
  applyDefaultSkillStates(paths);
  return countInstalledSkills(paths);
}

/**
 * A SKILL.md the loader complained about. `loaded: false` means the skill is
 * installed on disk but Pi could not parse it, so it is invisible to both the
 * agent and the Settings list — the failure is otherwise silent.
 */
export interface SkillProblem {
  name: string;
  state: "enabled" | "disabled";
  loaded: boolean;
  message: string;
}

function loadSkillDir(dir: string): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
  if (!fs.existsSync(dir)) return { skills: [], diagnostics: [] };
  return loadSkillsFromDir({ dir, source: "project" });
}

/** Directory name a diagnostic path points at (…/<name>/SKILL.md). */
function skillNameFromPath(p: string | undefined): string {
  if (!p) return "(unknown)";
  return path.basename(path.dirname(p));
}

function toProblems(
  { skills, diagnostics }: { skills: Skill[]; diagnostics: ResourceDiagnostic[] },
  state: "enabled" | "disabled",
): SkillProblem[] {
  const loaded = new Set(skills.map((s) => s.name));
  return diagnostics.map((d) => {
    const name = d.collision?.name ?? skillNameFromPath(d.path);
    return { name, state, loaded: loaded.has(name), message: d.message.trim() };
  });
}

/** List installed (enabled) skills for a scope (parsed SKILL.md frontmatter). */
export function listProjectSkills(ref: SkillScopeRef): Skill[] {
  return loadSkillDir(asSkillRoot(ref).skillsDir).skills;
}

/** Skill directory names: no separators, no dot-dot. */
export const SKILL_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/** Installed-but-disabled skills (parsed SKILL.md frontmatter). */
export function listDisabledSkills(ref: SkillScopeRef): Skill[] {
  return loadSkillDir(asSkillRoot(ref).disabledDir).skills;
}

/**
 * Both skill lists plus every loader diagnostic, in one pass over each dir.
 * The API surfaces `problems` so a malformed SKILL.md shows up in Settings
 * instead of just disappearing from the catalogue.
 */
export function listSkillsWithProblems(ref: SkillScopeRef): {
  enabled: Skill[];
  disabled: Skill[];
  problems: SkillProblem[];
} {
  const root = asSkillRoot(ref);
  const enabled = loadSkillDir(root.skillsDir);
  const disabled = loadSkillDir(root.disabledDir);
  return {
    enabled: enabled.skills,
    disabled: disabled.skills,
    problems: [...toProblems(enabled, "enabled"), ...toProblems(disabled, "disabled")],
  };
}

/** Directory holding a skill in either state, or null when not installed. */
export function findSkillDir(ref: SkillScopeRef, name: string): string | null {
  if (!SKILL_NAME_RE.test(name)) return null;
  const root = asSkillRoot(ref);
  for (const base of [root.skillsDir, root.disabledDir]) {
    const dir = path.join(base, name);
    if (fs.existsSync(path.join(dir, "SKILL.md"))) return dir;
  }
  return null;
}

/** Raw SKILL.md text from whichever location holds the skill; null if absent. */
export function readSkillSource(ref: SkillScopeRef, name: string): string | null {
  const dir = findSkillDir(ref, name);
  if (!dir) return null;
  try {
    return fs.readFileSync(path.join(dir, "SKILL.md"), "utf-8");
  } catch {
    return null;
  }
}

function moveSkill(fromDir: string, toDir: string, name: string): ToggleResult {
  if (!SKILL_NAME_RE.test(name)) {
    return { ok: false, status: 400, detail: `Invalid skill name "${name}"` };
  }
  const src = path.join(fromDir, name);
  const dest = path.join(toDir, name);
  if (!fs.existsSync(path.join(src, "SKILL.md"))) {
    return { ok: false, status: 404, detail: `No such skill in this state: "${name}"` };
  }
  if (fs.existsSync(dest)) {
    return { ok: false, status: 409, detail: `A skill named "${name}" already exists at the target` };
  }
  fs.mkdirSync(toDir, { recursive: true });
  fs.renameSync(src, dest);
  return { ok: true };
}

export function disableSkill(ref: SkillScopeRef, name: string): ToggleResult {
  const root = asSkillRoot(ref);
  return moveSkill(root.skillsDir, root.disabledDir, name);
}

export function enableSkill(ref: SkillScopeRef, name: string): ToggleResult {
  const root = asSkillRoot(ref);
  return moveSkill(root.disabledDir, root.skillsDir, name);
}
