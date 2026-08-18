/**
 * Named-project registry and path resolution — TS port of kady_agent/projects.py.
 *
 * Each project is self-contained under `projects/<id>/`. The on-disk layout is
 * preserved from the Python app (so existing data keeps working) minus the
 * Gemini-CLI / MCP / SQLite bits, which are gone:
 *
 *   projects/
 *     index.json                         registry
 *     <id>/
 *       project.json                     metadata (ProjectMeta)
 *       sandbox/                          working dir (Pi agent cwd)
 *         pyproject.toml                  uv-managed Python env (deps via `uv add`)
 *         AGENTS.md                       user-editable system-prompt extension
 *         .venv/                          sandbox venv (created by `uv run`/`uv sync`)
 *         user_data/                      uploads
 *         .pi/skills/                     per-project Pi skills
 *         .pi/sessions/                   Pi JSONL session files
 *         .kady/runs/<sessionId>/costs.jsonl   cost ledger
 *         .kady/workflows/budget/reservations/ durable DAG budget records
 */
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_PROJECT_ID, PROJECTS_ROOT } from "./config.ts";
import { LEGACY_ENGINE_DATA_DIRECTORY } from "./legacy-engine-data.ts";
import { isSamePath } from "./path-containment.ts";
import { isWithin } from "./sandbox-fs.ts";
import { currentProjectId } from "./scope.ts";
import { seedSandboxFiles } from "./sandbox-seed.ts";

const INDEX_PATH = path.join(PROJECTS_ROOT, "index.json");
const RESERVED_IDS = new Set(["new", "index", "archive", "..", "."]);
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface ProjectMeta {
  id: string;
  name: string;
  description: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  /** Hard USD cap on cumulative cost across the project; null = unlimited. */
  spendLimitUsd: number | null;
}

export interface ProjectPaths {
  id: string;
  root: string;
  projectJson: string;
  sandbox: string;
  uploadDir: string;
  kadyDir: string;
  runsDir: string;
  notebookDir: string;
  provenanceDir: string;
  workflowsDir: string;
  workflowDefinitionsDir: string;
  workflowRunsDir: string;
  workflowBudgetDir: string;
  workflowReservationsDir: string;
  modalDir: string;
  modalJobsDir: string;
  modalReservationsDir: string;
  modalCacheDir: string;
  modalEnvironmentsDir: string;
  skillsDir: string;
  sessionsDir: string;
}

// --- helpers -------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function tsOf(iso: string): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

function metaFromDict(data: Record<string, unknown>): ProjectMeta {
  const rawLimit = data.spendLimitUsd;
  let spendLimit: number | null = null;
  if (rawLimit !== null && rawLimit !== undefined && rawLimit !== "") {
    const n = Number(rawLimit);
    spendLimit = Number.isFinite(n) ? n : null;
  }
  return {
    id: String(data.id ?? ""),
    name: String(data.name ?? ""),
    description: String(data.description ?? ""),
    tags: Array.isArray(data.tags) ? data.tags.map((t) => String(t)) : [],
    createdAt: String(data.createdAt ?? ""),
    updatedAt: String(data.updatedAt ?? ""),
    archived: Boolean(data.archived ?? false),
    spendLimitUsd: spendLimit,
  };
}

function validateId(projectId: string): void {
  if (!ID_RE.test(projectId) || RESERVED_IDS.has(projectId)) {
    throw new Error(`Invalid project id: ${projectId}`);
  }
}

function mintProjectId(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const suffix = crypto.randomBytes(3).toString("hex");
  return base && base !== "proj" ? `${base}-${suffix}` : `proj-${suffix}`;
}

// --- path resolution -----------------------------------------------------

export function resolvePaths(projectId: string): ProjectPaths {
  const id = projectId || DEFAULT_PROJECT_ID;
  const root = path.resolve(PROJECTS_ROOT, id);
  if (!isWithin(PROJECTS_ROOT, root)) {
    throw new Error(`Invalid project id ${id}`);
  }
  const sandbox = path.join(root, "sandbox");
  const kadyDir = path.join(sandbox, ".kady");
  const workflowsDir = path.join(kadyDir, "workflows");
  const workflowBudgetDir = path.join(workflowsDir, "budget");
  const modalDir = path.join(kadyDir, "modal");
  const piDir = path.join(sandbox, ".pi");
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

export function activePaths(): ProjectPaths {
  return resolvePaths(currentProjectId());
}

// --- registry I/O --------------------------------------------------------

function ensureProjectsRoot(): void {
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
}

interface IndexFile {
  projects: Record<string, Record<string, unknown>>;
}

function loadIndex(): IndexFile {
  try {
    const data = JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8"));
    if (data && typeof data === "object" && "projects" in data) {
      return data as IndexFile;
    }
  } catch {
    /* missing or malformed → empty */
  }
  return { projects: {} };
}

/**
 * Atomic JSON write with a per-writer temp name.
 *
 * A shared `<file>.tmp` is only safe while one writer exists: `npm run prep`
 * (or a second backend) writing at the same time would have its half-written
 * temp renamed into place by the other, corrupting the registry.
 */
function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf-8");
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

function saveIndex(index: IndexFile): void {
  ensureProjectsRoot();
  writeJsonAtomic(INDEX_PATH, index);
}

function readProjectJson(paths: ProjectPaths): ProjectMeta | null {
  try {
    const data = JSON.parse(fs.readFileSync(paths.projectJson, "utf-8"));
    if (data && typeof data === "object") return metaFromDict(data);
  } catch {
    /* missing or malformed */
  }
  return null;
}

function writeProjectJson(paths: ProjectPaths, meta: ProjectMeta): void {
  fs.mkdirSync(paths.root, { recursive: true });
  writeJsonAtomic(paths.projectJson, meta);
}

// --- public registry API -------------------------------------------------

export function listProjects(): ProjectMeta[] {
  ensureProjectsRoot();
  const index = loadIndex();
  const known = new Set(Object.keys(index.projects));

  let adopted = false;
  if (fs.existsSync(PROJECTS_ROOT)) {
    for (const child of fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true })) {
      if (!child.isDirectory() || known.has(child.name)) continue;
      const meta = readProjectJson(resolvePaths(child.name));
      if (!meta) continue;
      index.projects[meta.id] = meta as unknown as Record<string, unknown>;
      known.add(meta.id);
      adopted = true;
    }
  }
  if (adopted) saveIndex(index);

  const out = Object.values(index.projects).map(metaFromDict);
  // non-archived first, then by updatedAt desc
  out.sort((a, b) => {
    const archDiff = (a.archived ? 1 : 0) - (b.archived ? 1 : 0);
    if (archDiff !== 0) return archDiff;
    return tsOf(b.updatedAt || b.createdAt) - tsOf(a.updatedAt || a.createdAt);
  });
  return out;
}

export function getProject(projectId: string): ProjectMeta | null {
  const index = loadIndex();
  const raw = index.projects[projectId];
  if (raw) return metaFromDict(raw);
  return readProjectJson(resolvePaths(projectId));
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  tags?: string[];
  projectId?: string;
  spendLimitUsd?: number | null;
}

// --- project repository containment --------------------------------------

/**
 * Git's own answer to "which variables bind a process to one specific
 * repository", as printed by `git rev-parse --local-env-vars` — the list Git
 * itself clears before acting on a different repository.
 *
 * This copy exists only as the fallback for when that invocation cannot be run.
 * It is not the source of truth and must not be maintained as one: a
 * hand-written denylist is exactly how the incident behind this module
 * happened, and how it happened a second time. `GIT_CONFIG` was missing from
 * the hand-written list, and `git config <key> <value>` without `--local`
 * honours it while every other Git command ignores it — so ownership was proven
 * correctly and the identity write still landed in the operator's checkout.
 *
 * Pinned by `project-repository-containment.test.ts`, which fails if the
 * installed Git names a variable this constant does not.
 */
export const GIT_LOCAL_ENVIRONMENT_KEYS_FALLBACK: readonly string[] = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_DIR",
  "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
];

/**
 * Inherited Git state is removed by a RULE, not by a list: every environment
 * variable whose name begins with `GIT_` goes, and this module re-supplies the
 * handful it needs itself as explicit per-invocation overrides.
 *
 * A list was tried twice and was wrong twice. Round 14's hand-written list
 * missed `GIT_CONFIG`, which redirected an identity write into a developer's
 * checkout. Round 15's derivation from `git rev-parse --local-env-vars` missed
 * `GIT_TRACE`, which is not repository-binding and so is not on that list, but
 * names a file Git appends to — one unauthenticated request was enough to
 * destroy a checkout's `.git/config` with it. The installed git binary
 * references 236 distinct `GIT_*` names against the 15 `--local-env-vars`
 * prints; the gap is not closable by enumeration, and the next `GIT_*` variable
 * Git gains is covered by a prefix and not by any list.
 *
 * Nothing this module runs needs an inherited `GIT_*` variable: identity, index
 * location and pathspec handling are all passed per invocation.
 */
const INHERITED_GIT_ENVIRONMENT_PREFIX = "GIT_";

function withoutInheritedGitEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...source };
  for (const key of Object.keys(environment)) {
    if (key.startsWith(INHERITED_GIT_ENVIRONMENT_PREFIX)) delete environment[key];
  }
  return environment;
}

/**
 * Variables Git omits from `--local-env-vars` because they steer repository
 * *discovery* rather than bind an already-chosen one, and that still have to
 * go: a ceiling directory changes which enclosing repository a sandbox resolves
 * to, and a namespace changes which refs a write lands on.
 */
const DISCOVERY_STEERING_GIT_ENVIRONMENT_KEYS: readonly string[] = [
  "GIT_CEILING_DIRECTORIES",
  "GIT_NAMESPACE",
];

/**
 * Configuration a project repository is not allowed to supply, forced on every
 * Git invocation this module makes.
 *
 * A project sandbox is writable by whatever runs in it — the agent is launched
 * with `cwd` set to it — and `<sandbox>/.git` is inside the sandbox. So the
 * repository's own `config`, its `.git/hooks` directory, its
 * `.git/info/attributes` and its in-tree `.gitattributes` are all attacker
 * controlled, and Git runs what they name, as the server. Nothing about
 * ownership is wrong in that case: the sandbox really does own its repository.
 * It is Git executing sandbox-supplied code on the server's behalf, and it
 * reproduces the 2026-08-17 incident (an identity rewritten and a branch ref
 * moved in a developer's checkout) against a correct containment proof.
 *
 * `-c` is the mechanism because it outranks every configuration file and cannot
 * itself be injected: this module scrubs `GIT_*` from the environment, so
 * `GIT_CONFIG_COUNT`/`GIT_CONFIG_PARAMETERS` cannot re-arm what these disable.
 * An environment variable would be scrubbed by that same rule.
 *
 * Measured against the exact invocation set below (git 2.54.0), the keys that
 * actually execute something are `core.hooksPath` — which also relocates hooks
 * away from the sandbox's own `.git/hooks`, the default location, which is
 * equally writable — and `core.fsmonitor`. The rest are unreachable only
 * because this module runs no diff, no network transport, no interactive
 * command and no `upload-pack`; they are pinned here so that stays true by
 * construction rather than by argument, and `projectGitSubcommands` pins the
 * invocation set that reasoning rests on.
 *
 * `os.devNull` is the inert value: it cannot be made into a directory holding a
 * hook, and it cannot be executed.
 */
const PROJECT_GIT_CONFIG_OVERRIDES: readonly string[] = [
  "--no-pager",
  "-c", `core.hooksPath=${os.devNull}`,
  "-c", "core.fsmonitor=false",
  "-c", `core.sshCommand=${os.devNull}`,
  "-c", `core.editor=${os.devNull}`,
  "-c", `sequence.editor=${os.devNull}`,
  "-c", "credential.helper=",
  "-c", "uploadpack.packObjectsHook=",
  "-c", "core.alternateRefsCommand=",
  "-c", "diff.external=",
  "-c", "commit.gpgsign=false",
];

/**
 * Every Git subcommand this module is allowed to run. The class analysis above
 * — "a hostile `diff.<driver>.textconv` cannot reach us because we never diff"
 * — is only true of this set, so the set is named here and asserted by the
 * containment tests: adding an invocation forces the analysis to be redone
 * rather than silently invalidated.
 */
export const PROJECT_GIT_SUBCOMMANDS: readonly string[] = [
  "commit-tree",
  "config",
  "for-each-ref",
  "hash-object",
  "init",
  "ls-files",
  "read-tree",
  "rev-parse",
  "update-index",
  "update-ref",
  "write-tree",
];

/** Every Git invocation this module makes, with the overrides prepended. */
function projectGitArguments(args: string[]): string[] {
  return [...PROJECT_GIT_CONFIG_OVERRIDES, ...args];
}

/**
 * A slow or wedged `git` on PATH must not be able to hold up server start:
 * discovery runs synchronously while this module initialises, so it is bounded
 * and falls through to the pinned fallback when the bound is hit.
 */
const GIT_DISCOVERY_TIMEOUT_MS = 2_000;

function discoverGitLocalEnvironmentKeys(): string[] | null {
  // Discovery itself runs with the inherited Git environment already gone, so
  // an inherited GIT_DIR cannot steer the answer it is asked for.
  const environment: NodeJS.ProcessEnv = withoutInheritedGitEnvironment(process.env);
  try {
    const printed = execFileSync("git", projectGitArguments(["rev-parse", "--local-env-vars"]), {
      env: environment,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_DISCOVERY_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    const keys = printed.split("\n").map((line) => line.trim()).filter(Boolean);
    return keys.length > 0 ? keys : null;
  } catch {
    return null;
  }
}

/**
 * Every Git environment variable a project-repository invocation starts
 * without. A backend started from inside a developer's checkout (or from a Git
 * hook, alias, or rebase todo script) inherits them, and `git -C <sandbox>
 * config` / `update-ref` would then operate on THAT repository while
 * `rev-parse --show-toplevel` still reports the sandbox. That is how a project
 * bootstrap once wrote an identity into a real checkout and moved its branch
 * ref.
 *
 * Since round 17 this is the *second* pass: the prefix rule in
 * `withoutInheritedGitEnvironment` already removes every `GIT_*` name, and this
 * list would only add something if Git ever named a repository-binding variable
 * that is not called `GIT_something`. It is kept because it is the derivation
 * that proves the prefix rule is not weaker than Git's own answer, and a
 * containment test fails if the two ever disagree.
 *
 * Derived from Git, not from this file: resolved once per process, falling back
 * to `GIT_LOCAL_ENVIRONMENT_KEYS_FALLBACK` if `git rev-parse` cannot be run at
 * all, prints nothing, or does not answer inside `GIT_DISCOVERY_TIMEOUT_MS`.
 */
export const RELOCATING_GIT_ENVIRONMENT_KEYS: readonly string[] = [
  ...new Set([
    ...(discoverGitLocalEnvironmentKeys() ?? GIT_LOCAL_ENVIRONMENT_KEYS_FALLBACK),
    ...GIT_LOCAL_ENVIRONMENT_KEYS_FALLBACK,
    ...DISCOVERY_STEERING_GIT_ENVIRONMENT_KEYS,
  ]),
].sort();

/**
 * The environment for every project-repository Git invocation.
 *
 * The prefix rule does the work. `RELOCATING_GIT_ENVIRONMENT_KEYS` is applied
 * on top of it as a second pass that costs nothing and would matter for exactly
 * one thing: a repository-binding variable Git names that does *not* begin with
 * `GIT_`. There is none today, and a containment test fails if one appears.
 *
 * Exported so the rule itself is testable — the previous two scrubs each had a
 * correct-looking mechanism whose gap only showed up in behaviour.
 */
export function projectGitEnvironment(
  overrides: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const environment = withoutInheritedGitEnvironment(process.env);
  for (const key of RELOCATING_GIT_ENVIRONMENT_KEYS) delete environment[key];
  return Object.assign(environment, overrides);
}

const PROJECT_REPOSITORY_AUTHOR_NAME = "Kady";
const PROJECT_REPOSITORY_AUTHOR_EMAIL = "kady@localhost";

/**
 * Authoring identity for the commits this module writes, passed per-invocation
 * on every one of them. A repository this module did not create keeps whatever
 * identity it has — a sandbox-owned repository that arrived with no commits and
 * no `user.name`/`user.email` of its own is legitimate — so no commit here may
 * depend on `git config` having been written, nor fall through to the host's
 * global Git identity.
 */
const PROJECT_REPOSITORY_IDENTITY_ENVIRONMENT = {
  GIT_AUTHOR_NAME: PROJECT_REPOSITORY_AUTHOR_NAME,
  GIT_AUTHOR_EMAIL: PROJECT_REPOSITORY_AUTHOR_EMAIL,
  GIT_COMMITTER_NAME: PROJECT_REPOSITORY_AUTHOR_NAME,
  GIT_COMMITTER_EMAIL: PROJECT_REPOSITORY_AUTHOR_EMAIL,
};

/** Which containment invariant a sandbox violated, carried on the thrown error. */
export type ProjectRepositoryInvariant =
  | "sandbox_git_is_a_pointer_file"
  | "sandbox_git_common_dir_is_foreign"
  | "sandbox_is_not_repository_toplevel"
  | "sandbox_inside_tracked_repository";

const PROJECT_REPOSITORY_INVARIANT_REASONS: Record<ProjectRepositoryInvariant, string> = {
  sandbox_git_is_a_pointer_file:
    "its .git entry is not a repository directory but a pointer (a linked worktree, a submodule, or a symlink), so the repository it names belongs to someone else",
  sandbox_git_common_dir_is_foreign:
    "its .git directory borrows another repository's refs and objects through a commondir pointer, so every ref it writes lands in that repository",
  sandbox_is_not_repository_toplevel:
    "it is not the toplevel of the repository that owns it",
  sandbox_inside_tracked_repository:
    "it resolves inside an existing repository that already has tracked content",
};

/**
 * A project sandbox is not, and must not become, part of a repository it does
 * not own. Thrown instead of adopting one: no `git init` over it, no identity
 * written into it, no ref of it moved.
 *
 * This is an operator misconfiguration (a projects root pointed at a source
 * checkout), not bad user input — see `refuseProjectRepositoryContainment` in
 * `index.ts`, which answers it rather than letting the request be scoped
 * somewhere else.
 */
export class ProjectRepositoryContainmentError extends Error {
  readonly code = "project_repository_containment";
  readonly sandbox: string;
  readonly offendingToplevel: string | null;
  readonly invariant: ProjectRepositoryInvariant;

  constructor(
    sandbox: string,
    offendingToplevel: string | null,
    invariant: ProjectRepositoryInvariant,
  ) {
    super(
      `Refusing to initialize the project repository at ${sandbox}: ` +
        `${PROJECT_REPOSITORY_INVARIANT_REASONS[invariant]} ` +
        `(repository toplevel: ${offendingToplevel ?? "unresolved"}; ` +
        `invariant: ${invariant}). A project sandbox must own its repository; ` +
        `point the projects root at a directory that is not inside a Git checkout.`,
    );
    this.name = "ProjectRepositoryContainmentError";
    this.sandbox = sandbox;
    this.offendingToplevel = offendingToplevel;
    this.invariant = invariant;
  }
}

/**
 * What owns the sandbox, once proven:
 *  - `absent`            no repository owns it; this call may create one
 *  - `own-empty`         it is its own toplevel and holds no history at all
 *  - `own-with-history`  it is its own toplevel and holds history; hands off
 * Anything else throws ProjectRepositoryContainmentError.
 */
type ProjectRepositoryOwnership = "absent" | "own-empty" | "own-with-history";

function gitOutputOrNull(workingDirectory: string, args: string[]): string | null {
  try {
    return execFileSync("git", projectGitArguments(["-C", workingDirectory, ...args]), {
      env: projectGitEnvironment(),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Git's stdout together with whether it succeeded, because the ownership proof
 * asks one invocation two questions at once: where the repository is, which is
 * always answerable, and whether HEAD resolves, whose legitimate "no" — a
 * repository with no commits yet — is reported as a non-zero exit *after* the
 * first answer has already been printed.
 */
function gitOutputAndStatus(
  workingDirectory: string,
  args: string[],
): { lines: string[]; ok: boolean } {
  const split = (output: string): string[] => {
    const trimmed = output.trim();
    return trimmed.length > 0 ? trimmed.split("\n") : [];
  };
  try {
    const output = execFileSync("git", projectGitArguments(["-C", workingDirectory, ...args]), {
      env: projectGitEnvironment(),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { lines: split(output), ok: true };
  } catch (error) {
    const stdout = (error as { stdout?: string | Buffer | null }).stdout;
    return { lines: typeof stdout === "string" ? split(stdout) : [], ok: false };
  }
}

function resolveRealPath(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * The worktree a common Git directory belongs to: its parent for the usual
 * `<toplevel>/.git`, otherwise the directory itself (a submodule's
 * `.git/modules/<name>` has no toplevel of its own).
 */
function toplevelOwningCommonDirectory(resolvedCommonDirectory: string): string {
  return path.basename(resolvedCommonDirectory) === ".git"
    ? path.dirname(resolvedCommonDirectory)
    : resolvedCommonDirectory;
}

/**
 * The repository a `.git` pointer file hands work to: the main worktree for a
 * linked worktree, otherwise the common Git directory itself.
 */
function pointerRepositoryToplevel(sandbox: string): string | null {
  const commonDirectory = gitOutputOrNull(sandbox, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (commonDirectory === null) return null;
  return toplevelOwningCommonDirectory(resolveRealPath(commonDirectory));
}

/**
 * The deepest directory that exists at or above `target`. Git resolves a
 * repository by walking upward from a directory that exists, so this is where
 * the walk for a not-yet-created sandbox starts — and it gives the same answer
 * the sandbox itself will give once it is created, because everything between
 * the two is about to be created empty.
 */
function deepestExistingDirectory(target: string): string | null {
  let candidate = path.resolve(target);
  for (;;) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      /* does not exist yet; keep walking up */
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
}

/** True when a repository already holds content worth protecting. */
function repositoryHasTrackedContent(toplevel: string): boolean {
  if (gitOutputOrNull(toplevel, ["rev-parse", "--verify", "HEAD"]) !== null) return true;
  const trackedFiles = gitOutputOrNull(toplevel, ["ls-files"]);
  return trackedFiles !== null && trackedFiles.length > 0;
}

/*
 * There is deliberately no memo here.
 *
 * Round 16 cached the `own-with-history` verdict against a fingerprint of five
 * `stat` fields of `<sandbox>/.git`. That is unsound, and the boundary is
 * exact: a directory's `mtime`/`ctime`/`size` move when an entry is created,
 * removed or renamed, and not when a file already inside it is overwritten in
 * place. `.git/config` always exists after `git init`, so rewriting it with
 * `open(…, "r+")` — two ordinary writes, both available to code running in the
 * sandbox — changed what the proof would answer while leaving the fingerprint
 * identical, and the stale "owned" verdict pulled a foreign checkout's file
 * contents into a project run snapshot.
 *
 * Hashing `.git/config` instead of stat-ing it does not fix it either, because
 * the bytes of that file are not the check's read set. `extensions.worktreeConfig`
 * makes Git also read `.git/config.worktree`, and `core.worktree` set *there*
 * redirects `--show-toplevel` exactly as it does from `.git/config` — measured
 * against git 2.54.0. Turning the extension on and creating that file both
 * invalidate any fingerprint, and then rewriting it in place invalidates
 * neither: `.git/config` is byte-identical and `.git` stats identical, while
 * the answer has changed. Every candidate fingerprint is a hand-maintained
 * list of the files Git happened to consult, which is the same kind of list
 * that was wrong in rounds 14 and 15 — and the only way to learn the real list
 * is to run the check.
 *
 * The proof therefore runs on every call. Deleting the memo alone costs
 * ~20.1 ms per `ensureProjectExists` against ~5.1 ms before containment
 * existed; the invocation below gets that back to ~10.7 ms by asking one
 * `rev-parse` for both halves of ownership and for HEAD, which is a subprocess
 * fewer rather than an answer remembered.
 */

/**
 * Prove which repository — if any — owns `sandbox`, refusing every arrangement
 * in which writing to it would write to somebody else's repository.
 *
 * `fs.existsSync(<sandbox>/.git)` does not prove ownership: the entry can be a
 * worktree/submodule pointer, it can be a directory that borrows another
 * repository's store, and its absence does not stop Git from walking up into an
 * enclosing checkout.
 *
 * `sandbox` need not exist yet — the enclosing-repository half of the proof is
 * answered from the deepest directory above it that does, so a caller can refuse
 * before it creates anything.
 */
function inspectProjectRepositoryOwnership(sandbox: string): ProjectRepositoryOwnership {
  const resolvedSandbox = resolveRealPath(sandbox);
  let gitEntry: fs.Stats | null = null;
  try {
    gitEntry = fs.lstatSync(path.join(sandbox, ".git"));
  } catch {
    gitEntry = null;
  }

  if (gitEntry !== null && !gitEntry.isDirectory()) {
    // `--show-toplevel` would answer "the sandbox" for a linked worktree, which
    // hides the repository actually at risk; the common Git directory names it.
    throw new ProjectRepositoryContainmentError(
      resolvedSandbox,
      pointerRepositoryToplevel(sandbox),
      "sandbox_git_is_a_pointer_file",
    );
  }

  if (gitEntry !== null) {
    // One invocation answers both halves of ownership and whether the
    // repository holds history. The two halves of ownership are which
    // repository claims this directory as its toplevel, and whose refs and
    // objects that claim actually resolves to: they differ whenever the `.git`
    // directory holds a `commondir` file — `--show-toplevel` still answers "the
    // sandbox" while every ref written lands in the repository `commondir`
    // names. `--verify --quiet HEAD` appends a third line when HEAD resolves
    // and exits non-zero without one when it does not, having already printed
    // the first two.
    const located = gitOutputAndStatus(sandbox, [
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-common-dir",
      "--verify",
      "--quiet",
      "HEAD",
    ]);
    const resolvedToplevel =
      located.lines.length >= 2 ? resolveRealPath(located.lines[0]) : null;
    if (resolvedToplevel === null || !isSamePath(resolvedToplevel, resolvedSandbox)) {
      throw new ProjectRepositoryContainmentError(
        resolvedSandbox,
        resolvedToplevel,
        "sandbox_is_not_repository_toplevel",
      );
    }
    const resolvedCommonDirectory = resolveRealPath(located.lines[1]);
    const ownGitDirectory = resolveRealPath(path.join(sandbox, ".git"));
    if (!isSamePath(resolvedCommonDirectory, ownGitDirectory)) {
      throw new ProjectRepositoryContainmentError(
        resolvedSandbox,
        toplevelOwningCommonDirectory(resolvedCommonDirectory),
        "sandbox_git_common_dir_is_foreign",
      );
    }
    if (located.ok && located.lines.length === 3) return "own-with-history";
    // An unborn HEAD is not proof of an empty repository: HEAD can point at a
    // branch that does not exist yet while the history lives on other refs.
    // Only a repository with no refs at all is one this call may commit into.
    const anyRef = gitOutputOrNull(sandbox, [
      "for-each-ref",
      "--count=1",
      "--format=%(refname)",
    ]);
    if (anyRef === null || anyRef.length === 0) return "own-empty";
    return "own-with-history";
  }

  // No repository of its own: Git would walk upward from here. An enclosing
  // repository that already tracks content means the projects root was pointed
  // at a source checkout — a configuration error, not something to initialize
  // a nested repository inside.
  const walkStart = deepestExistingDirectory(sandbox);
  if (walkStart === null) return "absent";
  const enclosingToplevel = gitOutputOrNull(walkStart, ["rev-parse", "--show-toplevel"]);
  if (enclosingToplevel !== null) {
    const resolvedEnclosing = resolveRealPath(enclosingToplevel);
    if (repositoryHasTrackedContent(resolvedEnclosing)) {
      throw new ProjectRepositoryContainmentError(
        resolvedSandbox,
        resolvedEnclosing,
        "sandbox_inside_tracked_repository",
      );
    }
  }
  return "absent";
}

function processIsRunning(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function acquireProjectRepositoryLock(sandbox: string): () => void {
  const lockPath = path.join(path.dirname(sandbox), ".git-init.lock");
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const descriptor = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(descriptor, `${process.pid}\n`, "utf-8");
      return () => {
        fs.closeSync(descriptor);
        fs.rmSync(lockPath, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let ownerProcessId = Number.NaN;
      try {
        ownerProcessId = Number.parseInt(fs.readFileSync(lockPath, "utf-8").trim(), 10);
      } catch {
        // An interrupted writer left an unreadable lock; remove it below.
      }
      if (!Number.isSafeInteger(ownerProcessId) || !processIsRunning(ownerProcessId)) {
        fs.rmSync(lockPath, { force: true });
        continue;
      }
      Atomics.wait(waitBuffer, 0, 0, 25);
    }
  }
  throw new Error(`Timed out initializing project repository: ${sandbox}`);
}

const BASELINE_EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".kady",
  ".pi",
  ".venv",
  "node_modules",
]);

function isBaselineCredentialName(name: string): boolean {
  const lowerName = name.toLowerCase();
  return (
    lowerName.startsWith(".env") ||
    /(^|[._-])credentials?([._-]|$)/.test(lowerName)
  );
}

/** Enumerate only privacy-safe regular files/symlinks for the bootstrap commit. */
function privacySafeProjectSnapshotPaths(sandbox: string): string[] {
  const permittedPaths: string[] = [];
  const visit = (absoluteDirectory: string, relativeDirectory: string): void => {
    for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
      const isAllowedEngineDataRoot =
        relativeDirectory === "" && entry.name === LEGACY_ENGINE_DATA_DIRECTORY;
      if (
        BASELINE_EXCLUDED_DIRECTORIES.has(entry.name) ||
        isBaselineCredentialName(entry.name) ||
        (entry.name.startsWith(".") && !isAllowedEngineDataRoot)
      ) {
        continue;
      }
      const relativePath = relativeDirectory
        ? path.posix.join(relativeDirectory, entry.name)
        : entry.name;
      const absolutePath = path.join(absoluteDirectory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath, relativePath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        permittedPaths.push(relativePath);
      }
    }
  };
  visit(sandbox, "");
  return permittedPaths;
}


/**
 * Stage `permittedPaths` into the temporary index without letting the sandbox's
 * own repository choose what code runs.
 *
 * `git add` resolves every path through the attribute stack — the sandbox's
 * in-tree `.gitattributes` *and* its `.git/info/attributes`, both writable by
 * whatever runs in the sandbox — and executes the `filter.<driver>.clean`
 * named there, as the server, once per staged file. Unlike `core.hooksPath`
 * this cannot be turned off with `-c`: the driver name is chosen by the
 * attacker, so there is no fixed key to override.
 *
 * Hashing the bytes here removes the machinery instead of configuring it.
 * `hash-object --no-filters` consults no attributes and runs no filter, and
 * `update-index --index-info` records the object names it is handed. Verified
 * to produce a byte-identical tree to `git add --force` for regular files,
 * executable files, symlinks, and paths containing a newline.
 *
 * The one deliberate behaviour change: content is recorded exactly as it is on
 * disk, so a `text`/`eol` attribute no longer rewrites line endings on the way
 * in — which is what a snapshot of the sandbox's inputs should do anyway.
 */
function stageProjectSnapshotPaths(
  sandbox: string,
  gitEnvironment: NodeJS.ProcessEnv,
  permittedPaths: string[],
): void {
  if (permittedPaths.length === 0) return;

  const modeForPath = new Map<string, string>();
  const objectNameForPath = new Map<string, string>();
  const batchedPaths: string[] = [];
  const individuallyHashedPaths: string[] = [];

  for (const relativePath of permittedPaths) {
    const entry = fs.lstatSync(path.join(sandbox, relativePath));
    if (entry.isSymbolicLink()) {
      modeForPath.set(relativePath, "120000");
      individuallyHashedPaths.push(relativePath);
      continue;
    }
    modeForPath.set(relativePath, (entry.mode & 0o111) !== 0 ? "100755" : "100644");
    // `--stdin-paths` is newline-delimited, so a path containing one cannot go
    // through the batch and is hashed from its bytes instead.
    if (/[\n\r]/.test(relativePath)) individuallyHashedPaths.push(relativePath);
    else batchedPaths.push(relativePath);
  }

  if (batchedPaths.length > 0) {
    const objectNames = execFileSync(
      "git",
      projectGitArguments(["-C", sandbox, "hash-object", "--no-filters", "-w", "--stdin-paths"]),
      {
        env: gitEnvironment,
        input: batchedPaths.join("\n") + "\n",
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    )
      .trim()
      .split("\n");
    if (objectNames.length !== batchedPaths.length) {
      throw new Error(
        `git hash-object returned ${objectNames.length} object names for ` +
          `${batchedPaths.length} paths in ${sandbox}`,
      );
    }
    batchedPaths.forEach((relativePath, index) => {
      objectNameForPath.set(relativePath, objectNames[index]);
    });
  }

  for (const relativePath of individuallyHashedPaths) {
    const absolutePath = path.join(sandbox, relativePath);
    // A symlink is stored as a blob holding its target, which is what Git does
    // and what keeps the link from being followed out of the sandbox.
    const content =
      modeForPath.get(relativePath) === "120000"
        ? Buffer.from(fs.readlinkSync(absolutePath))
        : fs.readFileSync(absolutePath);
    objectNameForPath.set(
      relativePath,
      execFileSync(
        "git",
        projectGitArguments(["-C", sandbox, "hash-object", "--no-filters", "-w", "--stdin"]),
        { env: gitEnvironment, input: content, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      ).trim(),
    );
  }

  // NUL-terminated records, so a path containing a newline or a tab still
  // names exactly one entry.
  const indexRecords = permittedPaths
    .map(
      (relativePath) =>
        `${modeForPath.get(relativePath)} ${objectNameForPath.get(relativePath)}\t${relativePath}\0`,
    )
    .join("");
  execFileSync(
    "git",
    projectGitArguments(["-C", sandbox, "update-index", "-z", "--index-info"]),
    { env: gitEnvironment, input: indexRecords, stdio: ["pipe", "ignore", "pipe"] },
  );
}

/**
 * Create the sandbox's very first commit from a temporary index. Only ever
 * called for a repository the sandbox owns and whose HEAD is unborn.
 */
function writeProjectBaselineCommit(sandbox: string): void {
  const temporaryDirectory = fs.mkdtempSync(path.join(path.dirname(sandbox), ".git-baseline-"));
  const temporaryIndex = path.join(temporaryDirectory, "index");
  const gitEnvironment = projectGitEnvironment({
    ...PROJECT_REPOSITORY_IDENTITY_ENVIRONMENT,
    GIT_INDEX_FILE: temporaryIndex,
    GIT_LITERAL_PATHSPECS: "1",
  });
  try {
    execFileSync("git", projectGitArguments(["-C", sandbox, "read-tree", "--empty"]), {
      env: gitEnvironment,
      stdio: "ignore",
    });
    stageProjectSnapshotPaths(sandbox, gitEnvironment, privacySafeProjectSnapshotPaths(sandbox));
    const tree = execFileSync("git", projectGitArguments(["-C", sandbox, "write-tree"]), {
      env: gitEnvironment,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const commit = execFileSync(
      "git",
      projectGitArguments(["-C", sandbox, "commit-tree", tree, "-m", "Initialize Kady project"]),
      {
        env: gitEnvironment,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
    // The empty old-value makes Git itself refuse the update unless the ref is
    // still unborn: a history that appeared since the check above is never
    // overwritten, even under a lock this process does not hold.
    execFileSync("git", projectGitArguments(["-C", sandbox, "update-ref", "HEAD", commit, ""]), {
      env: projectGitEnvironment(),
      stdio: "ignore",
    });
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

/**
 * Give the sandbox a repository of its own with one baseline commit.
 *
 * Exported for the containment regression tests, which need to point it at
 * hostile directory layouts a projects root would never produce on purpose.
 *
 * Refuses — loudly, with ProjectRepositoryContainmentError — rather than
 * touching a repository it did not create. Ownership is proven before the lock
 * is taken so a refusal leaves no lock file behind in someone's checkout.
 */
export function ensureProjectRepository(sandbox: string): void {
  if (inspectProjectRepositoryOwnership(sandbox) === "own-with-history") return;
  const releaseLock = acquireProjectRepositoryLock(sandbox);
  try {
    let ownership = inspectProjectRepositoryOwnership(sandbox);
    if (ownership === "own-with-history") return;
    if (ownership === "absent") {
      execFileSync("git", projectGitArguments(["init", "--quiet", sandbox]), {
        env: projectGitEnvironment(),
        stdio: "ignore",
      });
      // Re-prove ownership: only a repository this call brought into existence
      // may be given an identity.
      ownership = inspectProjectRepositoryOwnership(sandbox);
      if (ownership === "absent") {
        throw new ProjectRepositoryContainmentError(
          resolveRealPath(sandbox),
          null,
          "sandbox_is_not_repository_toplevel",
        );
      }
      if (ownership === "own-empty") {
        // `--local` names the file to write: the repository's own config, the
        // one ownership was just proven for. Without it `git config` honours
        // GIT_CONFIG and writes wherever that points — the variable is scrubbed
        // above, and this makes a future regression that unscrubs it a loud
        // error here instead of a silent write into somebody's checkout.
        execFileSync(
          "git",
          projectGitArguments([
            "-C", sandbox, "config", "--local", "user.name", PROJECT_REPOSITORY_AUTHOR_NAME,
          ]),
          { env: projectGitEnvironment(), stdio: "ignore" },
        );
        execFileSync(
          "git",
          projectGitArguments([
            "-C", sandbox, "config", "--local", "user.email", PROJECT_REPOSITORY_AUTHOR_EMAIL,
          ]),
          { env: projectGitEnvironment(), stdio: "ignore" },
        );
      }
    }
    // An existing repository keeps its identity and its history: the baseline
    // commit is only ever the first commit of a repository that has none.
    if (ownership === "own-empty") writeProjectBaselineCommit(sandbox);
  } finally {
    releaseLock();
  }
}

/**
 * Materialize the sandbox inputs visible to a workflow as an unreachable-by-branch
 * Git commit, then retain it under a Kady-owned ref for the lifetime of the run.
 * A temporary index keeps the user's checkout, index, and current branch untouched.
 */
export function createProjectRunSnapshot(projectId: string, runIdentity: string): string {
  // TODO(#33-hardening): bound retained snapshot refs/manifests and add safe GC in the hardening lane.
  validateId(projectId);
  const paths = ensureProjectExists(projectId);
  const temporaryDirectory = fs.mkdtempSync(path.join(paths.root, ".run-snapshot-"));
  const temporaryIndex = path.join(temporaryDirectory, "index");
  const gitEnvironment = projectGitEnvironment({
    ...PROJECT_REPOSITORY_IDENTITY_ENVIRONMENT,
    GIT_INDEX_FILE: temporaryIndex,
    GIT_LITERAL_PATHSPECS: "1",
  });
  try {
    execFileSync("git", projectGitArguments(["-C", paths.sandbox, "read-tree", "--empty"]), {
      env: gitEnvironment,
      stdio: "ignore",
    });
    stageProjectSnapshotPaths(
      paths.sandbox,
      gitEnvironment,
      privacySafeProjectSnapshotPaths(paths.sandbox),
    );
    const tree = execFileSync("git", projectGitArguments(["-C", paths.sandbox, "write-tree"]), {
      env: gitEnvironment,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const parent = execFileSync("git", projectGitArguments(["-C", paths.sandbox, "rev-parse", "HEAD"]), {
      env: projectGitEnvironment(),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const snapshot = execFileSync(
      "git",
      projectGitArguments([
        "-C", paths.sandbox, "commit-tree", tree, "-p", parent, "-m", `Kady run snapshot ${runIdentity}`,
      ]),
      {
        env: gitEnvironment,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
    const snapshotRef = crypto.createHash("sha256").update(runIdentity).digest("hex");
    execFileSync(
      "git",
      projectGitArguments([
        "-C", paths.sandbox, "update-ref", `refs/kady/run-snapshots/${snapshotRef}`, snapshot,
      ]),
      { env: projectGitEnvironment(), stdio: "ignore" },
    );
    return snapshot;
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function createProject(input: CreateProjectInput): ProjectMeta {
  const name = (input.name || "").trim() || "Untitled project";
  const projectId = input.projectId ?? mintProjectId(name);
  validateId(projectId);

  const paths = resolvePaths(projectId);
  if (fs.existsSync(paths.root)) {
    throw new Error(`Project already exists: ${projectId}`);
  }

  let limit: number | null = null;
  if (input.spendLimitUsd !== null && input.spendLimitUsd !== undefined) {
    const v = Number(input.spendLimitUsd);
    if (!Number.isFinite(v)) throw new Error("spendLimitUsd must be a number or null");
    if (v < 0) throw new Error("spendLimitUsd must be >= 0");
    limit = v;
  }

  const now = nowIso();
  const meta: ProjectMeta = {
    id: projectId,
    name,
    description: (input.description || "").trim(),
    tags: (input.tags || []).map((t) => t.trim()).filter(Boolean),
    createdAt: now,
    updatedAt: now,
    archived: false,
    spendLimitUsd: limit,
  };
  try {
    fs.mkdirSync(paths.sandbox, { recursive: true });
    seedSandboxFiles(paths);
    ensureProjectRepository(paths.sandbox);
    writeProjectJson(paths, meta);
  } catch (error) {
    fs.rmSync(paths.root, { recursive: true, force: true });
    throw error;
  }

  const index = loadIndex();
  index.projects[meta.id] = meta as unknown as Record<string, unknown>;
  saveIndex(index);
  return meta;
}

const UNSET = Symbol("unset");

export interface UpdateProjectInput {
  name?: string;
  description?: string;
  tags?: string[];
  archived?: boolean;
  spendLimitUsd?: number | null | typeof UNSET;
}

export function updateProject(projectId: string, patch: UpdateProjectInput): ProjectMeta {
  const meta = getProject(projectId);
  if (!meta) throw new Error(`No such project: ${projectId}`);

  if (patch.name !== undefined) meta.name = patch.name.trim() || meta.name;
  if (patch.description !== undefined) meta.description = patch.description.trim();
  if (patch.tags !== undefined) meta.tags = patch.tags.map((t) => t.trim()).filter(Boolean);
  if (patch.archived !== undefined) meta.archived = Boolean(patch.archived);
  if (patch.spendLimitUsd !== undefined && patch.spendLimitUsd !== UNSET) {
    if (patch.spendLimitUsd === null) {
      meta.spendLimitUsd = null;
    } else {
      const v = Number(patch.spendLimitUsd);
      if (!Number.isFinite(v)) throw new Error("spendLimitUsd must be a number or null");
      if (v < 0) throw new Error("spendLimitUsd must be >= 0");
      meta.spendLimitUsd = v;
    }
  }
  meta.updatedAt = nowIso();

  const paths = resolvePaths(projectId);
  writeProjectJson(paths, meta);
  const index = loadIndex();
  index.projects[meta.id] = meta as unknown as Record<string, unknown>;
  saveIndex(index);
  return meta;
}

export function deleteProject(projectId: string): void {
  if (projectId === DEFAULT_PROJECT_ID) {
    throw new Error("The default project cannot be deleted");
  }
  validateId(projectId);
  const paths = resolvePaths(projectId);
  if (fs.existsSync(paths.root)) fs.rmSync(paths.root, { recursive: true, force: true });
  const index = loadIndex();
  delete index.projects[projectId];
  saveIndex(index);
}

/** Bump a project's updatedAt timestamp (best-effort; used after sandbox writes). */
export function touchProject(projectId: string): void {
  try {
    const meta = getProject(projectId);
    if (!meta) return;
    meta.updatedAt = nowIso();
    const paths = resolvePaths(projectId);
    writeProjectJson(paths, meta);
    const index = loadIndex();
    index.projects[meta.id] = meta as unknown as Record<string, unknown>;
    saveIndex(index);
  } catch {
    /* best-effort */
  }
}

/**
 * Create the directory skeleton for a project if it doesn't exist yet. Cheap;
 * runs on every request via the scope hook. Does not seed skills (that's the
 * heavier `prep`/`sandbox/init` path).
 */
export function ensureProjectExists(projectId: string): ProjectPaths {
  validateId(projectId);
  const paths = resolvePaths(projectId);
  // Before anything is created. `ensureProjectRepository` refuses on its own,
  // but by the time it is reached the skeleton and the seed files have already
  // been written — into the developer's checkout, in exactly the configuration
  // the refusal exists to catch, and again on every request, since this hook
  // re-runs the same prefix each time. A refusal must leave no trace.
  inspectProjectRepositoryOwnership(paths.sandbox);
  fs.mkdirSync(paths.root, { recursive: true });
  fs.mkdirSync(paths.sandbox, { recursive: true });
  fs.mkdirSync(paths.kadyDir, { recursive: true });
  // Covers projects that predate sandbox seeding; no-op once the files exist.
  seedSandboxFiles(paths);
  // Project workspaces are execution repositories. This also upgrades the
  // default project and sandboxes created before Git initialization existed.
  ensureProjectRepository(paths.sandbox);

  if (!fs.existsSync(paths.projectJson)) {
    const now = nowIso();
    const meta: ProjectMeta = {
      id: projectId,
      name: projectId.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      description: "",
      tags: [],
      createdAt: now,
      updatedAt: now,
      archived: false,
      spendLimitUsd: null,
    };
    writeProjectJson(paths, meta);
    const index = loadIndex();
    if (!(projectId in index.projects)) {
      index.projects[projectId] = meta as unknown as Record<string, unknown>;
      saveIndex(index);
    }
  }
  return paths;
}

export { UNSET };
