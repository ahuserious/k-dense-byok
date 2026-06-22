/**
 * Per-project Archon bootstrap. Prepares a project's sandbox so the Archon
 * sidecar can run workflows against it:
 *
 *   1. ensure the sandbox is a git repo (Archon's worktree isolation needs one);
 *   2. write `.archon/config.yaml` pinning `assistant: pi` (so Archon drives the
 *      same Pi SDK Kady embeds — and so it does NOT auto-detect claude/codex);
 *   3. seed the committed starter pipelines into `.archon/workflows/`;
 *   4. register the sandbox with Archon as a codebase.
 *
 * Every step is best-effort: this runs during prep/first-touch, and a missing
 * git binary or a down sidecar must not abort project setup. Failures are logged
 * to stderr and swallowed.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectPaths } from "../../projects.ts";
import { ArchonUnavailableError, registerCodebase } from "./client.ts";

/**
 * Committed seed pipelines: this module lives at
 * `server/src/agent/archon/prep.ts`; the seed dir is `server/seed/pipelines`,
 * i.e. three levels up from `src/agent/archon` (→ `server/`) then
 * `seed/pipelines`. Overridable via `KADY_SEED_PIPELINES_DIR` for tests.
 */
function committedSeedPipelinesDir(): string {
  return (
    process.env.KADY_SEED_PIPELINES_DIR ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../seed/pipelines")
  );
}

/** Best-effort log for a swallowed prep failure. */
function logPrepWarning(message: string): void {
  process.stderr.write(`[archon-prep] ${message}\n`);
}

/**
 * Ensure `sandbox` is a git repo. Archon's worktree isolation checks out the
 * codebase via git, so a non-git sandbox can't run isolated workflows. We init
 * and make one initial commit so `git worktree` has a base ref. Best-effort —
 * a missing/failing git binary just logs and returns.
 */
function ensureGitRepo(sandbox: string): void {
  if (fs.existsSync(path.join(sandbox, ".git"))) return;

  const gitOptions = { cwd: sandbox, encoding: "utf-8" as const, stdio: "pipe" as const };
  const init = spawnSync("git", ["init"], gitOptions);
  if (init.status !== 0) {
    logPrepWarning(`git init failed in ${sandbox}: ${init.stderr ?? init.error?.message ?? "unknown"}`);
    return;
  }

  // Stage and commit whatever the sandbox already has. `-c user.*` keeps the
  // commit from failing on machines/CI where git identity isn't configured
  // globally, without mutating the user's global git config.
  spawnSync("git", ["add", "-A"], gitOptions);
  const commit = spawnSync(
    "git",
    [
      "-c", "user.name=Kady",
      "-c", "user.email=kady@local",
      "commit", "--allow-empty", "-m", "Initial commit (Archon worktree base)",
    ],
    gitOptions,
  );
  if (commit.status !== 0) {
    logPrepWarning(`initial commit failed in ${sandbox}: ${commit.stderr ?? commit.error?.message ?? "unknown"}`);
  }
}

/**
 * Write `.archon/config.yaml` with `assistant: pi` if absent. We deliberately do
 * NOT create a `.claude` or `.codex` folder — their presence flips Archon's
 * assistant auto-detection away from Pi.
 */
function ensureArchonConfig(sandbox: string): void {
  const archonDir = path.join(sandbox, ".archon");
  fs.mkdirSync(archonDir, { recursive: true });
  const configPath = path.join(archonDir, "config.yaml");
  if (fs.existsSync(configPath)) return;
  fs.writeFileSync(configPath, "assistant: pi\n", "utf-8");
}

/**
 * Ensure `.archon/workflows/` exists and copy the committed seed pipelines into
 * it. Non-clobbering: a workflow the user has already customized (same filename)
 * is left untouched.
 */
function seedWorkflows(sandbox: string): void {
  const workflowsDir = path.join(sandbox, ".archon", "workflows");
  fs.mkdirSync(workflowsDir, { recursive: true });

  const seedDir = committedSeedPipelinesDir();
  if (!fs.existsSync(seedDir)) {
    logPrepWarning(`seed pipelines dir not found: ${seedDir}`);
    return;
  }
  for (const entry of fs.readdirSync(seedDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
    const dest = path.join(workflowsDir, entry.name);
    if (fs.existsSync(dest)) continue; // don't clobber a customized pipeline
    fs.copyFileSync(path.join(seedDir, entry.name), dest);
  }
}

/**
 * Run the full per-project Archon bootstrap (git repo, config, workflows,
 * codebase registration). Best-effort end to end — never throws fatally, so the
 * caller can fire it during prep without guarding. The codebase registration
 * specifically swallows `ArchonUnavailableError` (the sidecar may be down).
 */
export async function prepArchonForProject(paths: ProjectPaths): Promise<void> {
  const { sandbox } = paths;
  try {
    fs.mkdirSync(sandbox, { recursive: true });
    ensureGitRepo(sandbox);
    ensureArchonConfig(sandbox);
    seedWorkflows(sandbox);
  } catch (err) {
    logPrepWarning(`local setup failed for ${paths.id}: ${(err as Error).message}`);
  }

  try {
    await registerCodebase(sandbox);
  } catch (err) {
    if (err instanceof ArchonUnavailableError) {
      logPrepWarning(`sidecar down; skipped codebase registration for ${paths.id}`);
    } else {
      logPrepWarning(`codebase registration failed for ${paths.id}: ${(err as Error).message}`);
    }
  }
}
