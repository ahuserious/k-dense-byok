/**
 * Per-project skill seeding + listing.
 *
 * Skills are placed in `<sandbox>/.pi/skills/` so Pi's DefaultResourceLoader
 * (cwd = sandbox) auto-discovers and the agent activates them natively — no
 * orchestrator passthrough. The catalogue is the same K-Dense repo as before,
 * and the SKILL.md format is unchanged (Pi-compatible).
 *
 * Fast path: copy an existing sibling project's skills (local I/O). Slow path:
 * shallow-clone the repo once.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSkillsFromDir, type Skill } from "@earendil-works/pi-coding-agent";
import { PROJECTS_ROOT } from "../config.ts";
import type { ProjectPaths } from "../projects.ts";

const SKILLS_REPO = process.env.KADY_SKILLS_REPO ?? "K-Dense-AI/scientific-agent-skills";
const SKILLS_SUBPATH = "skills";
const SKILLS_BRANCH = process.env.KADY_SKILLS_BRANCH ?? "main";

/**
 * Committed, in-repo skill catalogue. This module lives at
 * `server/src/agent/skills.ts`; the seed dir is `server/seed/skills`, i.e.
 * two levels up from `src/agent` (→ `server/`) then `seed/skills`.
 *
 * Overridable via `KADY_SEED_SKILLS_DIR` — used by tests to isolate the
 * sibling/remote fallbacks, and by deployments that ship a different seed set.
 * Read at call time (not module load) so the override can be set per-test.
 */
function committedSeedSkillsDir(): string {
  return (
    process.env.KADY_SEED_SKILLS_DIR ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../seed/skills")
  );
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

/** Any other project's skills dir that already has skills (for the copy fast path). */
function findSiblingSkillsDir(excludeId: string): string | null {
  if (!fs.existsSync(PROJECTS_ROOT)) return null;
  for (const child of fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true })) {
    if (!child.isDirectory() || child.name === excludeId) continue;
    const candidate = path.join(PROJECTS_ROOT, child.name, "sandbox", ".pi", "skills");
    if (countSkillDirs(candidate) > 0) return candidate;
  }
  return null;
}

function copySkillDirs(srcDir: string, destDir: string): number {
  fs.mkdirSync(destDir, { recursive: true });
  let copied = 0;
  for (const d of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const src = path.join(srcDir, d.name);
    if (!fs.existsSync(path.join(src, "SKILL.md"))) continue;
    const dest = path.join(destDir, d.name);
    if (fs.existsSync(dest)) continue; // don't clobber existing/customized skills
    fs.cpSync(src, dest, { recursive: true });
    copied++;
  }
  return copied;
}

/** Shallow-clone the catalogue repo; returns its skills dir + the tmp root to delete. */
function cloneCatalogue(): { skillsDir: string; tmpRoot: string } | null {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kady-skills-"));
  const res = spawnSync(
    "git",
    ["clone", "--depth", "1", "--branch", SKILLS_BRANCH, `https://github.com/${SKILLS_REPO}.git`, tmp],
    { encoding: "utf-8", stdio: "pipe" },
  );
  const skillsDir = path.join(tmp, SKILLS_SUBPATH);
  if (res.status !== 0 || !fs.existsSync(skillsDir)) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return null;
  }
  return { skillsDir, tmpRoot: tmp };
}

/**
 * Ensure a project's skills dir (`<sandbox>/.pi/skills`) is populated. Returns
 * the number of skills.
 *
 * Sources, tried in order (each is non-clobbering; the first that yields skills
 * short-circuits the rest):
 *   1. the committed in-repo seed (`server/seed/skills`) — offline, deterministic;
 *   2. a sibling project's already-seeded skills (local I/O fast path);
 *   3. a shallow `git clone` of the remote catalogue (only if `allowRemote`).
 *
 * After populating `.pi/skills`, the same skills are mirrored into
 * `<sandbox>/.agents/skills` so imported Archon chat agents (which resolve
 * workflow-node `skills:` from `.agents/skills`, not `.pi/skills`) see them too.
 */
export function seedProjectSkills(paths: ProjectPaths, allowRemote = true): number {
  const dest = paths.skillsDir;
  if (countSkillDirs(dest) > 0) {
    // Already seeded (e.g. legacy project): still ensure the Archon mirror exists.
    seedArchonSkills(paths);
    return countSkillDirs(dest);
  }

  const seedDir = committedSeedSkillsDir();
  if (countSkillDirs(seedDir) > 0) {
    copySkillDirs(seedDir, dest);
  }
  if (countSkillDirs(dest) === 0) {
    const sibling = findSiblingSkillsDir(paths.id);
    if (sibling) copySkillDirs(sibling, dest);
  }
  if (countSkillDirs(dest) === 0 && allowRemote) {
    const catalogue = cloneCatalogue();
    if (catalogue) {
      try {
        copySkillDirs(catalogue.skillsDir, dest);
      } finally {
        fs.rmSync(catalogue.tmpRoot, { recursive: true, force: true });
      }
    }
  }

  seedArchonSkills(paths);
  return countSkillDirs(dest);
}

/**
 * Mirror the project's seeded `.pi/skills` into `<sandbox>/.agents/skills` so
 * Archon-style chat agents resolve their workflow-node `skills:` references.
 * Non-clobbering (reuses copySkillDirs), so user-customized Archon skills are
 * preserved. Returns the number of skills present in the Archon dir.
 */
export function seedArchonSkills(paths: ProjectPaths): number {
  const archonSkillsDir = path.join(paths.sandbox, ".agents", "skills");
  if (countSkillDirs(paths.skillsDir) > 0) {
    copySkillDirs(paths.skillsDir, archonSkillsDir);
  }
  return countSkillDirs(archonSkillsDir);
}

/** List installed skills for the project (parsed SKILL.md frontmatter). */
export function listProjectSkills(paths: ProjectPaths): Skill[] {
  if (!fs.existsSync(paths.skillsDir)) return [];
  return loadSkillsFromDir({ dir: paths.skillsDir, source: "project" }).skills;
}
