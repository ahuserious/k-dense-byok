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
/**
 * A project Git invocation that failed for a reason this module cannot pin on
 * containment.
 *
 * Typed rather than a bare `Error` because of what the round-19 review found in
 * its contention tallies: these arrive at the caller as an *unclassified* 500,
 * indistinguishable from a crash, when in fact they are a known and bounded
 * outcome — either a bug here or the sandbox breaking its own repository
 * underneath a write. A caller that wants to tell those apart from an internal
 * fault can now do it on `code` instead of on the message text.
 *
 * The message stays deliberately thin. `execFileSync` puts the whole argv in
 * its own message, and for this module that argv is the overrides-laden project
 * Git command line naming every pinned config key and the absolute paths of the
 * repository and the sandbox. Name the operation and the sandbox, keep the exit
 * status, drop the rest.
 */
export class ProjectGitWriteError extends Error {
  readonly code = "project_git_invocation_failed";
  readonly operation: string;
  readonly sandbox: string;
  readonly status: number | null;

  constructor(operation: string, sandbox: string, status: number | null) {
    super(`Project git ${operation} failed for ${sandbox}: exited ${status ?? "abnormally"}`);
    this.name = "ProjectGitWriteError";
    this.operation = operation;
    this.sandbox = sandbox;
    this.status = status;
  }
}

function projectGitFailure(operation: string, sandbox: string, error: unknown): Error {
  const status = (error as { status?: number | null }).status;
  return new ProjectGitWriteError(operation, sandbox, status ?? null);
}

/**
 * A sandbox read that failed while a run snapshot was being assembled, for a
 * reason other than the entry having simply gone away.
 *
 * The entry going away is not this error: a snapshot enumerates the sandbox and
 * then stats and reads what it enumerated, and an agent doing ordinary work in
 * its own sandbox — a build writing and deleting temporary files, a test run, an
 * install — moves files between those two steps constantly. A file that is no
 * longer there is genuinely not part of the snapshot, so it is skipped, which is
 * what `git add` does with the same race. Only a read that fails for some other
 * reason reaches here.
 *
 * Unlike `ProjectGitWriteError`, this message names **no path at all**, not even
 * the sandbox. The raw Node error this replaces named the offending entry —
 * `ENOENT: no such file or directory, lstat '<sandbox>/churn16.txt'` — and that
 * is a path the caller never asked about, produced by an internal walk, arriving
 * as an unclassified 500 on the pipeline-run route. The sandbox is kept on a
 * field so an operator with the process can still correlate it; nothing about
 * which entry failed is put where an HTTP client can read it.
 */
export class ProjectSnapshotError extends Error {
  readonly code = "project_snapshot_failed";
  readonly operation: string;
  readonly sandbox: string;
  readonly errno: string | null;

  constructor(operation: string, sandbox: string, errno: string | null) {
    super(
      `Project snapshot ${operation} failed under the project sandbox` +
        (errno ? `: ${errno}` : ""),
    );
    this.name = "ProjectSnapshotError";
    this.operation = operation;
    this.sandbox = sandbox;
    this.errno = errno;
  }
}

/**
 * The errno codes that mean "the path this walk enumerated no longer names
 * anything", and nothing more alarming than that.
 *
 * `ENOENT` is the entry itself being removed. `ENOTDIR` is a directory
 * component of it being replaced by a file, which is the same event seen from
 * one level up. Everything else — `EACCES`, `EIO`, `ELOOP`, `EPERM` — is a read
 * this module could not complete for a reason the enumeration cannot explain
 * away, and is raised rather than silently dropping the entry from the snapshot.
 */
const VANISHED_SANDBOX_ENTRY_CODES = new Set(["ENOENT", "ENOTDIR"]);

function sandboxEntryVanished(error: unknown): boolean {
  const errno = (error as NodeJS.ErrnoException | null)?.code;
  return typeof errno === "string" && VANISHED_SANDBOX_ENTRY_CODES.has(errno);
}

function projectSnapshotFailure(
  operation: string,
  sandbox: string,
  error: unknown,
): ProjectSnapshotError {
  const errno = (error as NodeJS.ErrnoException | null)?.code;
  return new ProjectSnapshotError(
    operation,
    sandbox,
    typeof errno === "string" ? errno : null,
  );
}

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

/**
 * The environment for an invocation that writes, bound to the repository the
 * proof has just accepted instead of re-resolving `<sandbox>/.git` for itself.
 *
 * The proof and the writes it authorises are separate `git` processes, so
 * without this every one of them re-reads the pointer file — and the pointer
 * file is in the sandbox. Naming the proven directory outright means a pointer
 * swapped between the proof and the write changes nothing about where the write
 * lands; a swap is then only ever visible to the *next* call's proof, which
 * refuses it.
 *
 * `GIT_DIR` and `GIT_WORK_TREE` are on the scrub list precisely because an
 * *inherited* pair steers this module's writes into somebody's checkout. These
 * are applied after the scrub, from a path this process derived and just
 * proved, which is the opposite direction.
 */
function boundProjectGitEnvironment(
  sandbox: string,
  overrides: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return projectGitEnvironment({
    GIT_DIR: projectRepositoryDirectory(sandbox),
    GIT_WORK_TREE: sandbox,
    ...overrides,
  });
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
  | "sandbox_inside_tracked_repository"
  | "sandbox_git_directory_shadows_project_repository"
  | "project_repository_holds_a_symlink"
  | "project_repository_changed_under_the_scan";

const PROJECT_REPOSITORY_INVARIANT_REASONS: Record<ProjectRepositoryInvariant, string> = {
  sandbox_git_is_a_pointer_file:
    "its .git entry hands work to a repository other than the project's own — a linked worktree, a submodule, a symlink, or a rewritten pointer — so the repository it names belongs to someone else",
  sandbox_git_common_dir_is_foreign:
    "its .git directory borrows another repository's refs and objects through a commondir pointer, so every ref it writes lands in that repository",
  sandbox_is_not_repository_toplevel:
    "it is not the toplevel of the repository that owns it",
  sandbox_inside_tracked_repository:
    "it resolves inside an existing repository that already has tracked content",
  sandbox_git_directory_shadows_project_repository:
    "a second repository was created inside it while the project's own repository already sits beside it, and which of the two owns the sandbox is not this module's to guess",
  project_repository_holds_a_symlink:
    "the repository directory holds a symbolic link, so the objects and refs written through it would land wherever that link leads rather than in the repository",
  project_repository_changed_under_the_scan:
    "the repository directory changed while the scan that proves it holds no redirect was reading it, so what the scan answered about is not what the write would have opened",
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

/** The proven state of a sandbox's repository, and where that repository sits. */
interface ProjectRepositoryProof {
  ownership: ProjectRepositoryOwnership;
  /**
   * The repository directory is still `<sandbox>/.git` — inside the sandbox,
   * where whatever runs there can replace its entries with symlinks. Nothing
   * may be written through it until it has been relocated beside the sandbox.
   */
  repositoryIsInsideSandbox: boolean;
  /**
   * Our own pointer file survives in the sandbox naming a repository directory
   * that is gone. The ownership is `absent` — there is no repository — but the
   * pointer has to be removed before one can be created, because `git init`
   * handed a worktree whose `.git` is a gitfile naming a missing directory
   * fails outright rather than replacing it.
   */
  pointerOutlivedItsRepository: boolean;
}

function gitOutputOrNull(
  workingDirectory: string,
  args: string[],
  environment: NodeJS.ProcessEnv = projectGitEnvironment(),
): string | null {
  try {
    return execFileSync("git", projectGitArguments(["-C", workingDirectory, ...args]), {
      env: environment,
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
 * A path resolved through its parent, keeping its last component as written.
 *
 * `fs.realpathSync` answers nothing at all for a path whose last component is
 * missing, and `resolveRealPath`'s fallback then leaves the symlinked
 * components *above* it unresolved too. Comparing the pointer's target with
 * the repository directory that way went wrong in exactly one case and it is
 * the case that matters: once the repository directory is deleted, one side of
 * the comparison is `/tmp/…/sandbox.git` and the other is
 * `/private/tmp/…/sandbox.git`, so the module refused its own pointer instead
 * of recovering. The parent — the project directory — always exists, so
 * resolving that and re-joining the basename gives the same answer whether or
 * not the leaf is there.
 *
 * The leaf is deliberately not resolved. Whether it is itself a symbolic link
 * is proven separately, by `lstat` and by the subtree rule; resolving it here
 * would instead make a symlinked repository directory compare equal to
 * whatever it names.
 */
function resolveRealPathOfParent(target: string): string {
  const resolved = path.resolve(target);
  return path.join(resolveRealPath(path.dirname(resolved)), path.basename(resolved));
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
 * Where a project's Git repository lives: beside the sandbox, at
 * `<sandbox>.git`, never inside it.
 *
 * Round 18 moved it here from `<sandbox>/.git` and asserted that this put it
 * out of the sandbox's reach. That assertion was false, and correcting it
 * matters more than the move did. The main agent session is created with
 * `cwd: paths.sandbox` and a tool list containing `bash`
 * (`agent/tools.ts`, `agent/session-registry.ts`); that shell runs as the
 * server user, with no path filter in the tool and no OS confinement anywhere
 * in this server. `cd ..` reaches this directory. `../../<other>/sandbox.git`
 * reaches another project's. An absolute path reaches anything the server user
 * can write, including a host-private root under `$HOME`.
 *
 * So *location is not a boundary here*, and no choice of location makes it one:
 * moving the repository to a repositories root outside the projects root would
 * lengthen the path an attacker types and nothing else, while orphaning
 * repositories on `deleteProject`, breaking the "a project is self-contained
 * under `projects/<id>/`" layout this file documents, and spending a second
 * on-disk migration in two rounds. Turning location back into a boundary needs
 * something outside this module: a path filter on the agent's own tools, OS
 * confinement of the agent process, or running Git as a different uid.
 *
 * What this module can do is refuse to write *through* a repository directory
 * it has not just proven. The invariants below prove things about
 * `<sandbox>/.git` and about which repository claims the sandbox; the subtree
 * rule proves the contents of the directory those writes are bound to; and
 * since round 19 the second is re-proven immediately before every Git process
 * that writes, rather than once when the directory was attached — see
 * `projectGitWrite`. That is what closes the attack this comment used to deny:
 * two `ln -s` from the agent's own shell replacing `<sandbox>.git/objects` and
 * `<sandbox>.git/refs` with links at a checkout next door, after which every
 * ownership question still answered correctly while `hash-object` and
 * `update-ref` planted a Kady-authored commit and its objects in that
 * checkout, `fsck` clean, so nothing announced it.
 *
 * The pointer file keeps its shape: `<sandbox>/.git` is the gitfile Git itself
 * writes for `--separate-git-dir`, and a pointer that does not resolve to this
 * sandbox's own repository directory is refused rather than followed.
 */
function projectRepositoryDirectory(sandbox: string): string {
  const resolved = path.resolve(sandbox);
  return path.join(path.dirname(resolved), `${path.basename(resolved)}.git`);
}

/** The pointer file Git itself writes for `--separate-git-dir`. */
function gitDirectoryPointerContents(repositoryDirectory: string): string {
  return `gitdir: ${repositoryDirectory}\n`;
}

/**
 * The repository a `<sandbox>/.git` pointer file hands work to, resolved the
 * way Git resolves it — a relative target is relative to the directory holding
 * the pointer — or null when the entry is not a pointer file at all.
 *
 * Only the resolved target is checked, never the bytes. Whatever this module
 * writes into that file, anything running in the sandbox can write too, so
 * "the host wrote it" is not a property the file can carry; where it points is
 * the property that decides whether following it is safe.
 *
 * This parse deliberately diverges from Git's and must stay stricter, not
 * looser. `read_gitfile_gently` requires `"gitdir: "` including the space and
 * then takes everything from byte 8 to the end of the buffer, so a file with a
 * second line names one path to Git and a different, shorter one here. Both
 * directions of that divergence land on a refusal today — no space fails the
 * prefix test and is refused as a pointer this module will not follow, and a
 * junk second line parses here to the project's own repository and then leaves
 * Git unable to resolve `…/sandbox.git\nJUNK`, so the ownership proof prints
 * fewer lines than it needs and refuses. Making the parse match Git's byte for
 * byte would be the permissive direction: it would start following targets
 * that are currently refused, and the two parses would still have to agree for
 * that to be safe. Refusing what the two read differently is the safe half.
 */
function gitDirectoryPointerTarget(sandbox: string): string | null {
  let contents: string;
  try {
    contents = fs.readFileSync(path.join(sandbox, ".git"), "utf-8");
  } catch {
    return null;
  }
  const firstLine = contents.split("\n", 1)[0] ?? "";
  if (!firstLine.startsWith("gitdir:")) return null;
  const target = firstLine.slice("gitdir:".length).trim();
  return target.length > 0 ? path.resolve(sandbox, target) : null;
}

/**
 * Refuse a repository directory holding a symbolic link anywhere inside it.
 *
 * Git creates no symbolic link under a Git directory, so the rule is about the
 * whole subtree rather than about the handful of entries that happen to matter
 * today: burying the link deeper does not get around it, and an entry Git
 * invents in a later version is covered without being named.
 *
 * Round 18 ran this only when the directory was relocated or re-attached, on
 * the reasoning that it was afterwards out of the sandbox's reach. It is not —
 * see `projectRepositoryDirectory` — so a link planted after the attach was
 * never looked at again, and that is the whole of the attack this round
 * closes. It now also runs immediately before each Git process that writes,
 * through `projectGitWrite`, which is the moment its answer is actually
 * load-bearing.
 *
 * What it covers is symbolic links, and only those. A hard link is
 * indistinguishable from an ordinary file and passes; that is deliberate
 * rather than overlooked. A hard link is not a write primitive here — hard
 * links to directories are unavailable to a non-root user, and every file Git
 * rewrites under a Git directory (`config`, `packed-refs`, loose refs, loose
 * objects, the index) it rewrites through a lock file plus `rename`, which
 * breaks the link rather than writing through it — while refusing a link count
 * above one would refuse a repository that an ordinary `git clone --local`
 * elsewhere on the machine had hard-linked objects out of. Bind mounts are in
 * the same category and cannot be distinguished from a directory at all.
 *
 * A filesystem error raised while walking is a refusal, not a crash. Under a
 * sandbox that is rewriting the directory concurrently, `lstat` and `readdir`
 * see entries that vanish or change type between the parent listing and the
 * recursive visit, and the round-19 review measured what that produced: a raw
 * `ENOENT: … scandir '<repository path>'` escaping this module as an
 * unclassified 500 carrying a server-side absolute path. Structurally it is the
 * same event the scan exists to catch — the directory it is proving is not the
 * directory the write would open — so it answers with the same typed refusal.
 *
 * The walk's cost is a function of the object store, and nothing here bounds
 * it. Measured on this build, medians of ten, one walk and one whole snapshot:
 *
 *     repository entries    walk      snapshot
 *                     49    0.29 ms     79.6 ms
 *                  2,338    4.72 ms    102.7 ms
 *                 22,378   14.04 ms    167.6 ms
 *                222,418  113.15 ms    819.5 ms
 *
 * Linear in the entry count, five walks per snapshot — at 222k entries the
 * walks are roughly 570 ms of that 820 ms — and the store only grows: this
 * module never runs `gc`, `gc` is not in `PROJECT_GIT_SUBCOMMANDS`, and none of
 * the pinned subcommands trigger git's auto-gc, so loose objects and retained
 * `refs/kady/run-snapshots/*` accumulate for the life of the project. Every
 * snapshot pays for every object every previous snapshot left behind, so the
 * practical ceiling is set by retention rather than by the walk: a project at a
 * few thousand runs is in the tens of milliseconds, one that never gets
 * collected reaches a second per snapshot.
 *
 * No bound is imposed *here* on purpose. A walk that stops early, samples, or
 * skips a subtree is a check with a hole in it — the incomplete-list shape that
 * failed rounds 14–16 — and the sandbox picks which directory the hole lands
 * in. The bound belongs where the growth is: retention and a safe `gc`, tracked
 * at `TODO(#33-hardening)` in `createProjectRunSnapshot`.
 */
function refuseRepositoryDirectoryHoldingSymlink(
  resolvedSandbox: string,
  repositoryDirectory: string,
): void {
  const refuseChangedUnderTheScan = (offendingPath: string): never => {
    throw new ProjectRepositoryContainmentError(
      resolvedSandbox,
      resolveRealPath(offendingPath),
      "project_repository_changed_under_the_scan",
    );
  };
  let repositoryEntry: fs.Stats;
  try {
    repositoryEntry = fs.lstatSync(repositoryDirectory);
  } catch {
    return refuseChangedUnderTheScan(repositoryDirectory);
  }
  if (!repositoryEntry.isDirectory()) {
    // The directory itself, not only what is under it: a symlink here
    // redirects every write without holding a symlink inside.
    throw new ProjectRepositoryContainmentError(
      resolvedSandbox,
      resolveRealPath(repositoryDirectory),
      "project_repository_holds_a_symlink",
    );
  }
  const visit = (directory: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return void refuseChangedUnderTheScan(directory);
    }
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new ProjectRepositoryContainmentError(
          resolvedSandbox,
          resolveRealPath(child),
          "project_repository_holds_a_symlink",
        );
      }
      if (entry.isDirectory()) visit(child);
    }
  };
  visit(repositoryDirectory);
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
 * The half of the proof Git answers: that `sandbox` is the toplevel of the
 * repository claiming it, that the refs and objects that claim resolves to are
 * `expectedGitDirectory`'s, and whether that repository already holds history.
 */
function proveSandboxOwnsRepository(
  sandbox: string,
  resolvedSandbox: string,
  expectedGitDirectory: string,
): ProjectRepositoryOwnership {
  // One invocation answers both halves of ownership and whether the repository
  // holds history. The two halves of ownership are which repository claims this
  // directory as its toplevel, and whose refs and objects that claim actually
  // resolves to: they differ whenever the Git directory holds a `commondir`
  // file — `--show-toplevel` still answers "the sandbox" while every ref
  // written lands in the repository `commondir` names. `--verify --quiet HEAD`
  // appends a third line when HEAD resolves and exits non-zero without one when
  // it does not, having already printed the first two.
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
  if (!isSamePath(resolvedCommonDirectory, resolveRealPath(expectedGitDirectory))) {
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

/**
 * Prove which repository — if any — owns `sandbox`, refusing every arrangement
 * in which writing to it would write to somebody else's repository.
 *
 * `fs.existsSync(<sandbox>/.git)` does not prove ownership: the entry can be a
 * worktree/submodule pointer, it can be a directory that borrows another
 * repository's store, and its absence does not stop Git from walking up into an
 * enclosing checkout.
 *
 * Since round 18 the entry this expects there is the pointer file naming
 * `<sandbox>.git` — see `projectRepositoryDirectory`. A `.git` *directory* is
 * still proven exactly as before and then reported as needing relocation, so
 * every sandbox created before this round keeps working and is moved out of
 * reach on its next call rather than refused.
 *
 * `sandbox` need not exist yet — the enclosing-repository half of the proof is
 * answered from the deepest directory above it that does, so a caller can refuse
 * before it creates anything.
 */
function inspectProjectRepositoryOwnership(sandbox: string): ProjectRepositoryProof {
  const resolvedSandbox = resolveRealPath(sandbox);
  const repositoryDirectory = projectRepositoryDirectory(sandbox);
  let gitEntry: fs.Stats | null = null;
  try {
    gitEntry = fs.lstatSync(path.join(sandbox, ".git"));
  } catch {
    gitEntry = null;
  }

  if (gitEntry !== null && !gitEntry.isDirectory()) {
    // The only non-directory entry this module follows is a pointer at the
    // project's own repository directory. A symlink, a linked-worktree pointer,
    // a submodule pointer and a pointer rewritten to name somebody else's
    // repository all land here — `--show-toplevel` would answer "the sandbox"
    // for a linked worktree, which hides the repository actually at risk, so
    // the common Git directory names it instead.
    const pointerTarget = gitEntry.isFile() ? gitDirectoryPointerTarget(sandbox) : null;
    if (
      pointerTarget === null ||
      !isSamePath(
        // Both sides resolved the same way, and through the parent rather than
        // the leaf: `git init --separate-git-dir` writes the realpath into the
        // pointer while this module computes the path as configured, so on a
        // projects root with a symlinked component the two agree only while the
        // repository directory exists to be resolved. See
        // `resolveRealPathOfParent`.
        resolveRealPathOfParent(pointerTarget),
        resolveRealPathOfParent(repositoryDirectory),
      )
    ) {
      throw new ProjectRepositoryContainmentError(
        resolvedSandbox,
        pointerRepositoryToplevel(sandbox),
        "sandbox_git_is_a_pointer_file",
      );
    }
    let repositoryEntry: fs.Stats | null = null;
    try {
      repositoryEntry = fs.lstatSync(repositoryDirectory);
    } catch {
      repositoryEntry = null;
    }
    if (repositoryEntry === null) {
      // Our own pointer, naming a repository that is gone. Treated as no
      // repository at all, so `git init --separate-git-dir` writes both again
      // rather than every later call failing to resolve a dangling pointer.
      return {
        ownership: "absent",
        repositoryIsInsideSandbox: false,
        pointerOutlivedItsRepository: true,
      };
    }
    if (!repositoryEntry.isDirectory()) {
      // The repository directory sits outside the sandbox, so this is not
      // reachable from inside it — but proving where writes land is cheaper
      // than assuming the parent directory is beyond reach.
      throw new ProjectRepositoryContainmentError(
        resolvedSandbox,
        resolveRealPath(repositoryDirectory),
        "project_repository_holds_a_symlink",
      );
    }
    return {
      ownership: proveSandboxOwnsRepository(sandbox, resolvedSandbox, repositoryDirectory),
      repositoryIsInsideSandbox: false,
      pointerOutlivedItsRepository: false,
    };
  }

  if (gitEntry !== null) {
    if (fs.existsSync(repositoryDirectory)) {
      // A second repository created inside a sandbox whose own repository
      // already sits beside it. Which of the two owns the sandbox is not
      // something to guess, and adopting the inner one is exactly the move
      // relocation exists to prevent.
      throw new ProjectRepositoryContainmentError(
        resolvedSandbox,
        resolveRealPath(path.join(sandbox, ".git")),
        "sandbox_git_directory_shadows_project_repository",
      );
    }
    return {
      ownership: proveSandboxOwnsRepository(
        sandbox,
        resolvedSandbox,
        path.join(sandbox, ".git"),
      ),
      repositoryIsInsideSandbox: true,
      pointerOutlivedItsRepository: false,
    };
  }

  // No repository of its own: Git would walk upward from here. An enclosing
  // repository that already tracks content means the projects root was pointed
  // at a source checkout — a configuration error, not something to initialize
  // a nested repository inside.
  const walkStart = deepestExistingDirectory(sandbox);
  if (walkStart === null) {
    return {
      ownership: "absent",
      repositoryIsInsideSandbox: false,
      pointerOutlivedItsRepository: false,
    };
  }
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
  return {
    ownership: "absent",
    repositoryIsInsideSandbox: false,
    pointerOutlivedItsRepository: false,
  };
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

/**
 * Re-prove that the sandbox still owns the repository the next write is about
 * to be bound to.
 *
 * This is the Git half of the check `projectGitWrite` runs: which repository
 * claims the sandbox as its toplevel, and whose refs and objects that claim
 * actually resolves to. It costs a subprocess, and it runs per write invocation
 * anyway, because the two halves catch different things. The filesystem half —
 * the subtree rule — catches a symbolic link. It cannot catch a `commondir`
 * file, which is ordinary text and redirects every ref and object written
 * through `GIT_DIR` into the repository it names; only Git can answer where its
 * refs and objects actually resolve, so Git is asked, immediately before each
 * write rather than once when the repository was attached.
 */
function proveProjectRepositoryBeforeWriting(sandbox: string): void {
  const proof = inspectProjectRepositoryOwnership(sandbox);
  if (proof.ownership === "absent" || proof.repositoryIsInsideSandbox) {
    throw new ProjectRepositoryContainmentError(
      resolveRealPath(sandbox),
      resolveRealPath(path.join(sandbox, ".git")),
      "sandbox_is_not_repository_toplevel",
    );
  }
}

/**
 * Run a Git invocation that writes into the project's repository, proving the
 * repository directory holds no redirect immediately before the process starts.
 *
 * Every write this module performs goes through here, so a call added later
 * cannot miss the check without also missing `-C`, the pinned subcommand list
 * and the argument overrides. `read-tree` and `update-index` are deliberately
 * not routed through it: they write the temporary index named by
 * `GIT_INDEX_FILE` and nothing in the repository.
 *
 * Proving per invocation rather than once per batch is the point. A snapshot
 * spends tens of milliseconds across seven processes, and `update-ref` — the
 * process whose write is worth stealing — is the last of them; a single check at
 * the top of the batch would leave the whole batch as the window.
 *
 * What remains is a TOCTOU window, and it is *winnable*. Do not read the
 * per-invocation proof as closing it. Measured, on this build:
 *
 *  - **A few percent of run snapshots averaged across duty cycles, and as often
 *    as one in eleven at the worst cycle measured**, are stolen by a *blind*
 *    competing writer with no timing signal and no knowledge of this module — a
 *    plain on/off duty cycle replacing one entry the write goes through with a
 *    symbolic link, i.e. `ln -s` and `rm` in the agent's own shell.
 *
 *    Sweeps over three duty cycles planted 15 Kady-authored refs in 600 rounds
 *    (2.5%), 25 in 600 (4.2%) and 46 in 1,200 (3.8%) in a repository this module
 *    does not own — 95% binomial intervals spanning roughly 1.8%–6.1%.
 *
 *    Quote that average only with the duty cycle attached, because averaging
 *    over cycles hides the peak, and the peak is what a maintainer plans
 *    against. At the worst cycle measured, `on=2 ms off=10 ms`, three
 *    measurements of this build give 5.0% (10/200, round-19 review), 7.1%
 *    (57/800, round-20 review) and 6.0% (119/2,000, this lane, ten independent
 *    200-round runs spanning 3.0%–9.0%). Pooled: 186 in 3,000 rounds = 6.2%,
 *    95% CI 5.4%–7.1%, with no contributing measurement's own interval reaching
 *    above 9.1%. **Plan against 5%–9% per run snapshot at the peak.** An earlier
 *    revision of this comment said "up to 4.5% at the most favourable duty
 *    cycle", generalised from a single 9-in-200 row; every measurement taken
 *    since has come out above it, which is the direction that matters. If this
 *    figure is re-measured, move it towards the top of the interval, not the
 *    middle.
 *  - **Every time**, for an attacker with an oracle for the window — a `git`
 *    shim on `PATH` that plants the redirect after both checks have returned.
 *    There is nothing probabilistic about the defect; the duty cycle only sets
 *    how often a blind attacker happens to land in it.
 *  - The window is **~3–5 ms** for `update-ref`, most of which is git's process
 *    startup and repository setup, and **wider** for an entry the subtree walk
 *    visits early: the walk is a recursive `readdir` — 0.3 ms on a fresh
 *    repository, 4.7 ms at 2,338 entries, 113 ms at 222k (see
 *    `refuseRepositoryDirectoryHoldingSymlink`) — so an entry it has already
 *    passed can be replaced while the rest of it is still running, and on a
 *    large object store that is the dominant term. The window is not only
 *    "after both checks return", and it grows with the repository.
 *  - A stolen write **returns success**. Nothing after the spawn re-examines the
 *    repository, so the snapshot answers with an object name as if it had landed
 *    where it was meant to. Silence is the property that made the 2026-08-17
 *    incident what it was, and this module does not remove it.
 *
 * Round 19's own race harness reported "0 wins in 200 rounds"; that measured
 * something else and is corrected in `c5-r19.report.md`. Its attacker renamed
 * `<repo>/refs` away wholesale, and git's `is_git_directory()` requires
 * `$GIT_DIR/refs` to exist — so `rev-parse --show-toplevel` failed and every
 * round was refused by `proveProjectRepositoryBeforeWriting` before the subtree
 * scan or the write was reached. It measured this module noticing a *broken*
 * repository, not a *redirected* one.
 *
 * None of this is closable from inside this process. Git addresses its
 * repository by path, so any check this module makes is a check about a path
 * whose meaning the sandbox can change afterwards, and no amount of re-checking
 * changes that — it only narrows the interval. Closing it needs one of three
 * things, none of them this module's to write, all tracked as task #70:
 *
 *  1. a path filter on the agent's own tools, so the sandbox cannot name
 *     `<sandbox>.git` at all — the smallest of the three, and the one the other
 *     two depend on a repository location for;
 *  2. OS-level confinement of the agent's processes to the sandbox subtree
 *     (mount namespace, `sandbox-exec`, or equivalent);
 *  3. running Git as a different uid from the one the agent's shell runs as, so
 *     the sandbox has no write permission on the repository directory.
 *
 * Until one of those lands, the honest statement of this module's property is:
 * a redirect that is *stable* is refused, on every write, by both halves of the
 * proof; a redirect that is *raced against a specific write* lands somewhere
 * between about one time in eleven and one time in a hundred, depending on how
 * the competing writer's period phases against this module's cadence, and lands
 * silently. See `projectRepositoryDirectory`.
 */
function projectGitWrite(
  sandbox: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; input?: string | Buffer; capture?: boolean },
): string {
  proveProjectRepositoryBeforeWriting(sandbox);
  refuseRepositoryDirectoryHoldingSymlink(
    resolveRealPath(sandbox),
    projectRepositoryDirectory(sandbox),
  );
  let output: string;
  try {
    output = execFileSync("git", projectGitArguments(["-C", sandbox, ...args]), {
      env: options.env,
      input: options.input,
      encoding: "utf-8",
      stdio: [
        options.input === undefined ? "ignore" : "pipe",
        options.capture === true ? "pipe" : "ignore",
        "pipe",
      ],
    });
  } catch (error) {
    // A write that failed *because* the sandbox redirected the repository
    // underneath it says so, rather than answering with a bare exit status. The
    // round-19 review's contention runs produced 31 `Project git update-ref
    // failed … exited 128` rows out of 600, every one of them the sandbox
    // breaking its own repository mid-write, and reported as if git had simply
    // misbehaved. Re-proving costs one subprocess and one walk on a path that
    // has already failed, and the answer is only substituted when it is a
    // containment refusal — a genuine git failure is still a git failure.
    //
    // It answers for a redirect that is still there, which is the case worth
    // naming, and not for one already withdrawn: an attacker toggling the entry
    // on a duty cycle can have removed it before this runs, and then the module
    // genuinely cannot prove why git failed. Those keep the `ProjectGitWriteError`
    // answer rather than being reported as containment on a guess — the failure
    // is typed and the caller can tell it from an internal fault, which is what
    // was actually missing.
    throw containmentCauseOfFailedWrite(sandbox) ?? projectGitFailure(args[0], sandbox, error);
  }
  return options.capture === true ? output.trim() : "";
}

/**
 * Which containment invariant, if any, a failed write broke — asked after the
 * failure, on the same two halves that were asked before it.
 *
 * Returns `null` when the repository is still intact, which is the ordinary
 * case: a write can fail for reasons that have nothing to do with containment
 * (a full disk, a broken `git` on `PATH`), and those must keep their own
 * message. Anything the re-proof throws that is *not* a containment refusal is
 * discarded rather than raised: this runs on an error path, and a second error
 * raised while classifying the first would lose it.
 */
function containmentCauseOfFailedWrite(sandbox: string): ProjectRepositoryContainmentError | null {
  try {
    proveProjectRepositoryBeforeWriting(sandbox);
    refuseRepositoryDirectoryHoldingSymlink(
      resolveRealPath(sandbox),
      projectRepositoryDirectory(sandbox),
    );
  } catch (error) {
    if (error instanceof ProjectRepositoryContainmentError) return error;
  }
  return null;
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

/**
 * Enumerate only privacy-safe regular files/symlinks for the bootstrap commit.
 *
 * A directory removed between its parent being read and it being descended into
 * is dropped rather than raised — see `ProjectSnapshotError` for why that is the
 * ordinary case rather than the exceptional one. The sandbox root is not that
 * case: if it cannot be read at all there is no snapshot to take, and answering
 * with an empty file list would record a project as having lost every file it
 * has. That is raised.
 */
function privacySafeProjectSnapshotPaths(sandbox: string): string[] {
  const permittedPaths: string[] = [];
  const visit = (absoluteDirectory: string, relativeDirectory: string): void => {
    let directoryEntries: fs.Dirent[];
    try {
      directoryEntries = fs.readdirSync(absoluteDirectory, { withFileTypes: true });
    } catch (error) {
      if (relativeDirectory !== "" && sandboxEntryVanished(error)) return;
      throw projectSnapshotFailure("enumerate", sandbox, error);
    }
    for (const entry of directoryEntries) {
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
 * Stage `permittedPaths` into the temporary index, recording for each one the
 * mode and blob `git add --force` would record — for the blob content policy
 * this module pins, which is attribute-free.
 *
 * "Stage `permittedPaths`" is one qualifier short: an entry that has gone away
 * since the enumeration produced that list is dropped here rather than failing
 * the snapshot, so what is recorded is the sandbox as it was found, not as it
 * was listed. `ProjectSnapshotError` says why.
 *
 * That qualifier is load-bearing and the divergence it names is deliberate. A
 * sandbox holding a `.gitattributes` makes the two trees differ: `* text=auto`
 * alone is enough to change a CRLF file's blob under `git add` and not here,
 * because `--no-filters` is exactly what stops an attacker-supplied
 * `filter.<name>.clean` from running as the server. Parity is with what `git
 * add --force` records *when no attribute applies*, not with whatever the
 * sandbox's own `.gitattributes` asks for; a snapshot is meant to record the
 * bytes on disk, and a reader comparing the two trees on a project that has a
 * `.gitattributes` should expect them to differ there. The attribute file is
 * not itself in either tree — `privacySafeProjectSnapshotPaths` drops every
 * dotfile — so the divergence shows up only in the blobs it would have applied
 * to, which is the confusing way round to find it: hence the qualifier, here,
 * in writing.
 *
 * Every blob is hashed by one `hash-object --stdin-paths`, including the two
 * kinds of entry that cannot be named on that stream as they stand: a symbolic
 * link, whose content is its target rather than the file it points at, and a
 * path holding a newline, which the stream cannot delimit. Both are written to
 * a file in `scratchDirectory` under a plain name and hashed from there —
 * `--no-filters` means no attribute lookup, so the blob a path produces does
 * not depend on where the path is, and the object names come out identical.
 *
 * Doing it in one invocation rather than one per awkward entry is not only
 * tidier: each write invocation re-proves the repository directory (see
 * `projectGitWrite`), and a per-entry loop made that proof's cost the product
 * of the sandbox's symbolic-link count and the repository's size — 200 links
 * against a repository holding 20,000 loose objects took a snapshot from
 * 1.1 s to 5.3 s, and both of those numbers are the sandbox's to choose.
 */
function stageProjectSnapshotPaths(
  sandbox: string,
  scratchDirectory: string,
  gitEnvironment: NodeJS.ProcessEnv,
  permittedPaths: string[],
): void {
  if (permittedPaths.length === 0) return;

  const modeForPath = new Map<string, string>();
  const objectNameForPath = new Map<string, string>();
  // What Git is asked to hash, in order, and which sandbox-relative path each
  // answer belongs to.
  const hashedPaths: string[] = [];
  const pathForAnswer: string[] = [];
  // The effective value, not the repository's own: `git add` resolves this key
  // through the whole config stack, and matching its tree means resolving it
  // the same way. Absent means true, which is what `git init` writes wherever
  // the filesystem keeps the bit.
  const executableBitIsRecorded =
    gitOutputOrNull(
      sandbox,
      ["config", "--type=bool", "--get", "core.fileMode"],
      gitEnvironment,
    ) !== "false";

  const stageFromScratch = (relativePath: string, content: Buffer): void => {
    const scratchPath = path.join(scratchDirectory, `blob-${hashedPaths.length}`);
    try {
      fs.writeFileSync(scratchPath, content);
    } catch (error) {
      throw projectSnapshotFailure("scratch write", sandbox, error);
    }
    hashedPaths.push(scratchPath);
    pathForAnswer.push(relativePath);
  };

  // The entries that were still there when this loop reached them, in
  // enumeration order. Not `permittedPaths`: an agent working in its own
  // sandbox removes files between the enumeration and this loop, and an entry
  // that has gone is dropped from the snapshot rather than failing it.
  const stagedPaths: string[] = [];

  for (const relativePath of permittedPaths) {
    const absolutePath = path.join(sandbox, relativePath);
    let entry: fs.Stats;
    try {
      entry = fs.lstatSync(absolutePath);
    } catch (error) {
      if (sandboxEntryVanished(error)) continue;
      throw projectSnapshotFailure("stat", sandbox, error);
    }
    if (entry.isSymbolicLink()) {
      // A symlink is stored as a blob holding its target, which is what Git
      // does and what keeps the link from being followed out of the sandbox.
      let linkTarget: string;
      try {
        linkTarget = fs.readlinkSync(absolutePath);
      } catch (error) {
        if (sandboxEntryVanished(error)) continue;
        throw projectSnapshotFailure("readlink", sandbox, error);
      }
      modeForPath.set(relativePath, "120000");
      stagedPaths.push(relativePath);
      stageFromScratch(relativePath, Buffer.from(linkTarget));
      continue;
    }
    // S_IXUSR, the bit Git reads — a file executable only by its group or by
    // others is a regular `100644` blob to Git, and to this.
    const isExecutable = executableBitIsRecorded && (entry.mode & 0o100) !== 0;
    // `--stdin-paths` is newline-delimited, so a path containing one is hashed
    // from its bytes instead of by name.
    if (/[\n\r]/.test(relativePath)) {
      let content: Buffer;
      try {
        content = fs.readFileSync(absolutePath);
      } catch (error) {
        if (sandboxEntryVanished(error)) continue;
        throw projectSnapshotFailure("read", sandbox, error);
      }
      modeForPath.set(relativePath, isExecutable ? "100755" : "100644");
      stagedPaths.push(relativePath);
      stageFromScratch(relativePath, content);
    } else {
      modeForPath.set(relativePath, isExecutable ? "100755" : "100644");
      stagedPaths.push(relativePath);
      hashedPaths.push(relativePath);
      pathForAnswer.push(relativePath);
    }
  }

  // Everything enumerated has gone since. There is nothing to hash and nothing
  // to record, and `hash-object --stdin-paths` must not be handed a bare
  // newline.
  if (stagedPaths.length === 0) return;

  // One sliver of the same race is left and is not closed here: an ordinary
  // entry is named to `hash-object` rather than read by this process, so a file
  // that survives the `lstat` above and goes before Git opens it fails the whole
  // batch. That window is the width of the remaining loop plus one process
  // spawn, against the whole enumeration for the window above it — 490 rounds
  // of the churn probes that reproduced the `lstat` failure 77 times in 80 did
  // not hit it once. It is bounded and typed rather than raw: `projectGitWrite`
  // answers it as `ProjectGitWriteError`, operation `hash-object`. Closing it
  // means reading every blob into scratch, which is a read and a write per file
  // for every snapshot, and that is the wrong trade for a window this narrow.
  const objectNames = projectGitWrite(
    sandbox,
    ["hash-object", "--no-filters", "-w", "--stdin-paths"],
    { env: gitEnvironment, input: hashedPaths.join("\n") + "\n", capture: true },
  ).split("\n");
  if (objectNames.length !== hashedPaths.length) {
    throw new Error(
      `git hash-object returned ${objectNames.length} object names for ` +
        `${hashedPaths.length} paths in ${sandbox}`,
    );
  }
  pathForAnswer.forEach((relativePath, index) => {
    objectNameForPath.set(relativePath, objectNames[index]);
  });

  // NUL-terminated records, so a path containing a newline or a tab still
  // names exactly one entry.
  const indexRecords = stagedPaths
    .map(
      (relativePath) =>
        `${modeForPath.get(relativePath)} ${objectNameForPath.get(relativePath)}\t${relativePath}\0`,
    )
    .join("");
  try {
    execFileSync(
      "git",
      projectGitArguments(["-C", sandbox, "update-index", "-z", "--index-info"]),
      { env: gitEnvironment, input: indexRecords, stdio: ["pipe", "ignore", "pipe"] },
    );
  } catch (error) {
    throw projectGitFailure("update-index", sandbox, error);
  }
}

/**
 * Create the sandbox's very first commit from a temporary index. Only ever
 * called for a repository the sandbox owns and whose HEAD is unborn, and under
 * the repository lock.
 */
function writeProjectBaselineCommit(sandbox: string): void {
  const temporaryDirectory = fs.mkdtempSync(path.join(path.dirname(sandbox), ".git-baseline-"));
  const temporaryIndex = path.join(temporaryDirectory, "index");
  const gitEnvironment = boundProjectGitEnvironment(sandbox, {
    ...PROJECT_REPOSITORY_IDENTITY_ENVIRONMENT,
    GIT_INDEX_FILE: temporaryIndex,
    GIT_LITERAL_PATHSPECS: "1",
  });
  try {
    try {
      execFileSync("git", projectGitArguments(["-C", sandbox, "read-tree", "--empty"]), {
        env: gitEnvironment,
        stdio: "ignore",
      });
    } catch (error) {
      throw projectGitFailure("read-tree", sandbox, error);
    }
    stageProjectSnapshotPaths(
      sandbox,
      temporaryDirectory,
      gitEnvironment,
      privacySafeProjectSnapshotPaths(sandbox),
    );
    const tree = projectGitWrite(sandbox, ["write-tree"], {
      env: gitEnvironment,
      capture: true,
    });
    const commit = projectGitWrite(
      sandbox,
      ["commit-tree", tree, "-m", "Initialize Kady project"],
      { env: gitEnvironment, capture: true },
    );
    // The empty old-value makes Git itself refuse the update unless the ref is
    // still unborn: a history that appeared since the check above is never
    // overwritten, even under a lock this process does not hold.
    projectGitWrite(sandbox, ["update-ref", "HEAD", commit, ""], {
      env: boundProjectGitEnvironment(sandbox),
    });
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

/**
 * Move a sandbox's own repository out of the sandbox, so that nothing inside it
 * can decide where the repository's writes land.
 *
 * The rename is what makes this safe rather than racy: it is one atomic
 * filesystem operation, and once it returns, the directory's contents are
 * frozen with respect to anything running in the sandbox. Only then are they
 * proven free of symlinks — checking first and moving afterwards would leave a
 * window in which a link could be added between the two.
 *
 * A refusal here leaves the repository beside the sandbox with no pointer to
 * it. That state is not silently recoverable: the next call re-attaches it only
 * after proving it clean again, so a repository that failed this check stays
 * failed rather than going live on the following request.
 */
function relocateProjectRepositoryBesideSandbox(sandbox: string): void {
  const resolvedSandbox = resolveRealPath(sandbox);
  const repositoryDirectory = projectRepositoryDirectory(sandbox);
  fs.renameSync(path.join(sandbox, ".git"), repositoryDirectory);
  refuseRepositoryDirectoryHoldingSymlink(resolvedSandbox, repositoryDirectory);
  // `wx`: if anything re-created `.git` in the sandbox while this ran, that is
  // the shadowing case, and it is refused rather than overwritten.
  fs.writeFileSync(
    path.join(sandbox, ".git"),
    gitDirectoryPointerContents(repositoryDirectory),
    { encoding: "utf-8", mode: 0o644, flag: "wx" },
  );
}

/**
 * Create the repository and hand the sandbox its pointer, without ever handing
 * Git a path inside the sandbox.
 *
 * `git init --separate-git-dir=R W` run directly on the sandbox is a
 * repository-relocation gadget whenever `W/.git` is a symbolic link: Git
 * *moves* the repository that link names to `R` and leaves a pointer behind in
 * it. Proving `<sandbox>/.git` absent first does not close that, because the
 * proof is an `lstat` and the write is a process spawn some milliseconds later,
 * and one `ln -s` from the sandbox in between is all it takes. Round 18's
 * reviewer proved the gadget in raw Git and ran 40 rounds against a spinning
 * attacker without winning the race; a window nobody has won is still a window.
 *
 * So Git is given a staging worktree this call creates itself — an empty
 * `mkdtemp` directory under the project root, whose name the sandbox does not
 * know in advance and which has no `.git` entry for anything to redirect — and
 * the sandbox's own entry is claimed afterwards with `link`, which fails
 * `EEXIST` on anything already at that path, symbolic links included, and does
 * not follow it. Nothing here reconstructs by hand what `git init` decides:
 * the repository is whatever Git wrote, and the pointer is byte-for-byte the
 * gitfile Git wrote, moved to the sandbox rather than composed.
 *
 * `repositoryDirectory` may already exist — a repository whose pointer was
 * deleted is re-attached here — and re-running `git init` over it preserves its
 * refs, its tags, its reflog and its identity, which is the migration case that
 * matters most.
 */
function initializeProjectRepository(sandbox: string, repositoryDirectory: string): void {
  fs.mkdirSync(sandbox, { recursive: true });
  const stagingWorktree = fs.mkdtempSync(path.join(path.dirname(sandbox), ".git-init-"));
  try {
    try {
      execFileSync(
        "git",
        projectGitArguments([
          "init",
          "--quiet",
          `--separate-git-dir=${repositoryDirectory}`,
          stagingWorktree,
        ]),
        {
          env: projectGitEnvironment(),
          stdio: "ignore",
        },
      );
    } catch (error) {
      throw projectGitFailure("init", sandbox, error);
    }
    try {
      fs.linkSync(path.join(stagingWorktree, ".git"), path.join(sandbox, ".git"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Something took `<sandbox>/.git` while this call was creating the
      // repository. That is the claim doing its job — a raw `EEXIST` carrying
      // a temporary path is not what a caller should be told about it.
      throw new ProjectRepositoryContainmentError(
        resolveRealPath(sandbox),
        resolveRealPath(path.join(sandbox, ".git")),
        "sandbox_git_directory_shadows_project_repository",
      );
    }
  } finally {
    fs.rmSync(stagingWorktree, { recursive: true, force: true });
  }
}

/**
 * Give the sandbox a repository of its own, beside it, with one baseline commit.
 *
 * Exported for the containment regression tests, which need to point it at
 * hostile directory layouts a projects root would never produce on purpose.
 *
 * Refuses — loudly, with ProjectRepositoryContainmentError — rather than
 * touching a repository it did not create. Ownership is proven before the lock
 * is taken so a refusal leaves no lock file behind in someone's checkout.
 */
export function ensureProjectRepository(sandbox: string): void {
  const proof = inspectProjectRepositoryOwnership(sandbox);
  if (proof.ownership === "own-with-history" && !proof.repositoryIsInsideSandbox) return;
  const repositoryDirectory = projectRepositoryDirectory(sandbox);
  const releaseLock = acquireProjectRepositoryLock(sandbox);
  try {
    let { ownership, repositoryIsInsideSandbox, pointerOutlivedItsRepository } =
      inspectProjectRepositoryOwnership(sandbox);
    if (repositoryIsInsideSandbox) {
      // A sandbox from before round 18, or one whose repository this call is
      // about to write through. Ownership has just been proven for it, which is
      // what makes moving it this module's to move.
      relocateProjectRepositoryBesideSandbox(sandbox);
      ({ ownership, repositoryIsInsideSandbox, pointerOutlivedItsRepository } =
        inspectProjectRepositoryOwnership(sandbox));
      if (repositoryIsInsideSandbox) {
        throw new ProjectRepositoryContainmentError(
          resolveRealPath(sandbox),
          resolveRealPath(path.join(sandbox, ".git")),
          "sandbox_git_directory_shadows_project_repository",
        );
      }
    }
    if (ownership === "own-with-history") return;
    if (ownership === "absent") {
      if (pointerOutlivedItsRepository) {
        // The recovery this module documented but did not perform. `git init
        // --separate-git-dir=X W` where `W/.git` is a gitfile naming a missing
        // X fails outright — `fatal: not a git repository: X` — so the project
        // stayed 500-ing on every request until someone deleted the pointer by
        // hand, and on the default project the scope hook made that every
        // request the server answers. Removing our own dangling pointer here
        // does not by itself make the create path safe — an entry can appear at
        // that path again a microsecond later — which is why the pointer is
        // re-claimed with `link` rather than written over; see
        // `initializeProjectRepository`.
        //
        // The history that pointer named is gone before this runs, and this
        // does not bring it back: the project restarts from a fresh baseline
        // commit. That is the documented behaviour and the alternative is a
        // sticky whole-server refusal, but it does mean anything with write
        // access to the repository directory — which, per
        // `projectRepositoryDirectory`, includes the sandbox — can discard a
        // project's history and have the next request quietly start a new one.
        fs.rmSync(path.join(sandbox, ".git"), { force: true });
      }
      if (fs.existsSync(repositoryDirectory)) {
        // A repository directory that outlived its pointer file is re-attached
        // rather than replaced, so deleting the pointer does not silently cost
        // a project its history. This call did not create it, and the one thing
        // that can leave a hostile one behind is a relocation that refused
        // after the move, so it is proven clean before it is attached.
        refuseRepositoryDirectoryHoldingSymlink(resolveRealPath(sandbox), repositoryDirectory);
      }
      initializeProjectRepository(sandbox, repositoryDirectory);
      // Re-prove ownership: only a repository this call brought into existence
      // may be given an identity.
      ({ ownership, repositoryIsInsideSandbox, pointerOutlivedItsRepository } =
        inspectProjectRepositoryOwnership(sandbox));
      if (ownership === "absent" || repositoryIsInsideSandbox) {
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
        projectGitWrite(
          sandbox,
          ["config", "--local", "user.name", PROJECT_REPOSITORY_AUTHOR_NAME],
          { env: boundProjectGitEnvironment(sandbox) },
        );
        projectGitWrite(
          sandbox,
          ["config", "--local", "user.email", PROJECT_REPOSITORY_AUTHOR_EMAIL],
          { env: boundProjectGitEnvironment(sandbox) },
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
  // The same lock `ensureProjectRepository` takes, held across the whole batch:
  // a relocation or a re-attach running concurrently with these writes would be
  // deciding where they land while they are in flight. `ensureProjectExists`
  // has released it by the time it returns, so this cannot deadlock on itself.
  const releaseLock = acquireProjectRepositoryLock(paths.sandbox);
  try {
    return writeProjectRunSnapshot(paths, runIdentity);
  } finally {
    releaseLock();
  }
}

function writeProjectRunSnapshot(paths: ProjectPaths, runIdentity: string): string {
  const temporaryDirectory = fs.mkdtempSync(path.join(paths.root, ".run-snapshot-"));
  const temporaryIndex = path.join(temporaryDirectory, "index");
  const gitEnvironment = boundProjectGitEnvironment(paths.sandbox, {
    ...PROJECT_REPOSITORY_IDENTITY_ENVIRONMENT,
    GIT_INDEX_FILE: temporaryIndex,
    GIT_LITERAL_PATHSPECS: "1",
  });
  try {
    try {
      execFileSync("git", projectGitArguments(["-C", paths.sandbox, "read-tree", "--empty"]), {
        env: gitEnvironment,
        stdio: "ignore",
      });
    } catch (error) {
      throw projectGitFailure("read-tree", paths.sandbox, error);
    }
    stageProjectSnapshotPaths(
      paths.sandbox,
      temporaryDirectory,
      gitEnvironment,
      privacySafeProjectSnapshotPaths(paths.sandbox),
    );
    const tree = projectGitWrite(paths.sandbox, ["write-tree"], {
      env: gitEnvironment,
      capture: true,
    });
    let parent: string;
    try {
      parent = execFileSync("git", projectGitArguments(["-C", paths.sandbox, "rev-parse", "HEAD"]), {
        env: boundProjectGitEnvironment(paths.sandbox),
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch (error) {
      throw projectGitFailure("rev-parse", paths.sandbox, error);
    }
    const snapshot = projectGitWrite(
      paths.sandbox,
      ["commit-tree", tree, "-p", parent, "-m", `Kady run snapshot ${runIdentity}`],
      { env: gitEnvironment, capture: true },
    );
    const snapshotRef = crypto.createHash("sha256").update(runIdentity).digest("hex");
    projectGitWrite(
      paths.sandbox,
      ["update-ref", `refs/kady/run-snapshots/${snapshotRef}`, snapshot],
      { env: boundProjectGitEnvironment(paths.sandbox) },
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
