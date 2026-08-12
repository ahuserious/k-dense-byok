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
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PROJECT_ID, PROJECTS_ROOT } from "./config.ts";
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

function hasProjectRepositoryCommit(sandbox: string): boolean {
  // Do not let Git walk upward into Kady's own checkout: the sandbox itself
  // must own the repository used for engine worktree isolation.
  if (!fs.existsSync(path.join(sandbox, ".git"))) return false;
  try {
    execFileSync("git", ["-C", sandbox, "rev-parse", "--verify", "HEAD"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
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
      const isAllowedEngineDataRoot = relativeDirectory === "" && entry.name === ".archon";
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

function ensureProjectRepository(sandbox: string): void {
  if (hasProjectRepositoryCommit(sandbox)) return;
  const releaseLock = acquireProjectRepositoryLock(sandbox);
  try {
    if (hasProjectRepositoryCommit(sandbox)) return;
    if (!fs.existsSync(path.join(sandbox, ".git"))) {
      execFileSync("git", ["init", "--quiet", sandbox], { stdio: "ignore" });
    }
    execFileSync("git", ["-C", sandbox, "config", "user.name", "Kady"], { stdio: "ignore" });
    execFileSync(
      "git",
      ["-C", sandbox, "config", "user.email", "kady@localhost"],
      { stdio: "ignore" },
    );
    const temporaryDirectory = fs.mkdtempSync(path.join(path.dirname(sandbox), ".git-baseline-"));
    const temporaryIndex = path.join(temporaryDirectory, "index");
    const gitEnvironment = {
      ...process.env,
      GIT_INDEX_FILE: temporaryIndex,
      GIT_LITERAL_PATHSPECS: "1",
    };
    try {
      execFileSync("git", ["-C", sandbox, "read-tree", "--empty"], {
        env: gitEnvironment,
        stdio: "ignore",
      });
      const permittedPaths = privacySafeProjectSnapshotPaths(sandbox);
      if (permittedPaths.length > 0) {
        execFileSync(
          "git",
          ["-C", sandbox, "add", "--force", "--", ...permittedPaths],
          { env: gitEnvironment, stdio: "ignore" },
        );
      }
      const tree = execFileSync("git", ["-C", sandbox, "write-tree"], {
        env: gitEnvironment,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      const commit = execFileSync(
        "git",
        ["-C", sandbox, "commit-tree", tree, "-m", "Initialize Kady project"],
        {
          env: gitEnvironment,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      ).trim();
      execFileSync("git", ["-C", sandbox, "update-ref", "HEAD", commit], {
        stdio: "ignore",
      });
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  } finally {
    releaseLock();
  }
}

export interface ProjectRunSnapshotLimits {
  maxFiles: number;
  maxBytes: number;
}

export interface ProjectRunSnapshotEntry {
  path: string;
  size: number;
}

export interface ProjectRunSnapshotManifest {
  version: 1;
  runIdentityHash: string;
  snapshotRef: string;
  snapshotSha: string;
  createdAt: string;
  fileCount: number;
  totalBytes: number;
  entries: ProjectRunSnapshotEntry[];
}

export const PROJECT_RUN_SNAPSHOT_LIMITS: ProjectRunSnapshotLimits = {
  maxFiles: 20_000,
  maxBytes: 1024 * 1024 * 1024,
};

export class ProjectRunSnapshotLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectRunSnapshotLimitError";
  }
}

const RUN_SNAPSHOT_MANIFEST_DIRECTORY = "run-snapshots";
const MAX_GIT_CAPTURE_BYTES = 32 * 1024 * 1024;

function snapshotIdentity(runIdentity: string): { hash: string; ref: string } {
  const hash = crypto.createHash("sha256").update(runIdentity).digest("hex");
  return { hash, ref: `refs/kady/run-snapshots/${hash}` };
}

function runSnapshotManifestPath(paths: ProjectPaths, identityHash: string): string {
  return path.join(paths.kadyDir, RUN_SNAPSHOT_MANIFEST_DIRECTORY, `${identityHash}.json`);
}

function isPrivacySafeRunSnapshotPath(relativePath: string): boolean {
  const segments = relativePath.split("/");
  return segments.every((segment, index) => {
    if (BASELINE_EXCLUDED_DIRECTORIES.has(segment) || isBaselineCredentialName(segment)) return false;
    return !segment.startsWith(".") || (index === 0 && segment === ".archon");
  });
}

async function runGit(
  sandbox: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: Buffer } = {},
): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", sandbox, ...args], {
      env: options.env ?? process.env,
      stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let captureExceeded = false;
    const capture = (target: Buffer[], chunk: Buffer): void => {
      capturedBytes += chunk.length;
      if (capturedBytes > MAX_GIT_CAPTURE_BYTES) {
        captureExceeded = true;
        child.kill();
        return;
      }
      target.push(chunk);
    };
    child.stdout!.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr!.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (captureExceeded) {
        reject(new ProjectRunSnapshotLimitError("Snapshot file listing exceeded its bounded capture budget."));
      } else if (code !== 0) {
        reject(new Error(`git ${args[0] ?? "command"} failed: ${Buffer.concat(stderr).toString("utf-8").trim()}`));
      } else {
        resolve(Buffer.concat(stdout));
      }
    });
    if (options.input) child.stdin!.end(options.input);
  });
}

function assertSnapshotBounds(
  entries: ProjectRunSnapshotEntry[],
  limits: ProjectRunSnapshotLimits,
): number {
  if (entries.length > limits.maxFiles) {
    throw new ProjectRunSnapshotLimitError(
      `Run snapshot exceeds the ${limits.maxFiles}-file limit (${entries.length} files).`,
    );
  }
  const totalBytes = entries.reduce((total, entry) => total + entry.size, 0);
  if (totalBytes > limits.maxBytes) {
    throw new ProjectRunSnapshotLimitError(
      `Run snapshot exceeds the ${limits.maxBytes}-byte limit (${totalBytes} bytes).`,
    );
  }
  return totalBytes;
}

/** Enumerate Git-visible, privacy-safe inputs and reject the request before staging if bounded limits are exceeded. */
export async function buildProjectRunSnapshotManifest(
  sandbox: string,
  limits: ProjectRunSnapshotLimits = PROJECT_RUN_SNAPSHOT_LIMITS,
): Promise<{ entries: ProjectRunSnapshotEntry[]; fileCount: number; totalBytes: number }> {
  const output = await runGit(sandbox, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "--deduplicate",
    "-z",
  ]);
  const candidates = output.toString("utf-8").split("\0").filter(Boolean);
  const entries: ProjectRunSnapshotEntry[] = [];
  let totalBytes = 0;
  for (const relativePath of candidates) {
    if (!isPrivacySafeRunSnapshotPath(relativePath)) continue;
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(path.join(sandbox, ...relativePath.split("/")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) continue;
    entries.push({ path: relativePath, size: stat.size });
    totalBytes += stat.size;
    if (entries.length > limits.maxFiles) {
      throw new ProjectRunSnapshotLimitError(
        `Run snapshot exceeds the ${limits.maxFiles}-file limit (${entries.length} files).`,
      );
    }
    if (totalBytes > limits.maxBytes) {
      throw new ProjectRunSnapshotLimitError(
        `Run snapshot exceeds the ${limits.maxBytes}-byte limit (${totalBytes} bytes).`,
      );
    }
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return { entries, fileCount: entries.length, totalBytes };
}

function stagedSnapshotEntries(output: Buffer): ProjectRunSnapshotEntry[] {
  const entries: ProjectRunSnapshotEntry[] = [];
  for (const row of output.toString("utf-8").split("\0")) {
    if (!row) continue;
    const tab = row.indexOf("\t");
    const header = row.slice(0, tab).split(/\s+/);
    const size = Number(header[3]);
    const entryPath = row.slice(tab + 1);
    if (tab < 0 || !Number.isSafeInteger(size) || size < 0 || !entryPath) {
      throw new Error("Git returned a malformed run snapshot tree entry.");
    }
    entries.push({ path: entryPath, size });
  }
  return entries;
}

/**
 * Materialize bounded workflow inputs as an unreachable-by-branch Git commit.
 * Git work runs asynchronously so snapshotting does not block the request event loop.
 */
export async function createProjectRunSnapshot(
  projectId: string,
  runIdentity: string,
  limits: ProjectRunSnapshotLimits = PROJECT_RUN_SNAPSHOT_LIMITS,
): Promise<string> {
  validateId(projectId);
  const paths = ensureProjectExists(projectId);
  const planned = await buildProjectRunSnapshotManifest(paths.sandbox, limits);
  const temporaryDirectory = await fs.promises.mkdtemp(path.join(paths.root, ".run-snapshot-"));
  const temporaryIndex = path.join(temporaryDirectory, "index");
  const gitEnvironment = {
    ...process.env,
    GIT_INDEX_FILE: temporaryIndex,
    GIT_LITERAL_PATHSPECS: "1",
  };
  const identity = snapshotIdentity(runIdentity);
  const manifestPath = runSnapshotManifestPath(paths, identity.hash);
  try {
    await runGit(paths.sandbox, ["read-tree", "--empty"], { env: gitEnvironment });
    if (planned.entries.length > 0) {
      const pathspec = Buffer.from(`${planned.entries.map((entry) => entry.path).join("\0")}\0`);
      await runGit(paths.sandbox, [
        "add",
        "--force",
        "--pathspec-from-file=-",
        "--pathspec-file-nul",
      ], { env: gitEnvironment, input: pathspec });
    }
    const tree = (await runGit(paths.sandbox, ["write-tree"], { env: gitEnvironment }))
      .toString("utf-8").trim();
    const stagedEntries = stagedSnapshotEntries(
      await runGit(paths.sandbox, ["ls-tree", "-r", "-l", "-z", tree], { env: gitEnvironment }),
    );
    const totalBytes = assertSnapshotBounds(stagedEntries, limits);
    const parent = (await runGit(paths.sandbox, ["rev-parse", "HEAD"]))
      .toString("utf-8").trim();
    const snapshot = (await runGit(paths.sandbox, [
      "commit-tree",
      tree,
      "-p",
      parent,
      "-m",
      `Kady run snapshot ${identity.hash}`,
    ], { env: gitEnvironment })).toString("utf-8").trim();
    await runGit(paths.sandbox, ["update-ref", identity.ref, snapshot]);
    const manifest: ProjectRunSnapshotManifest = {
      version: 1,
      runIdentityHash: identity.hash,
      snapshotRef: identity.ref,
      snapshotSha: snapshot,
      createdAt: nowIso(),
      fileCount: stagedEntries.length,
      totalBytes,
      entries: stagedEntries,
    };
    await fs.promises.mkdir(path.dirname(manifestPath), { recursive: true });
    const temporaryManifest = `${manifestPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.promises.writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      await fs.promises.rename(temporaryManifest, manifestPath);
    } catch (error) {
      await fs.promises.rm(temporaryManifest, { force: true });
      await runGit(paths.sandbox, ["update-ref", "-d", identity.ref]).catch(() => undefined);
      throw error;
    }
    return snapshot;
  } finally {
    await fs.promises.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

/** Delete the only Kady-owned reachability root after terminal settlement or run deletion. */
export async function deleteProjectRunSnapshot(projectId: string, runIdentity: string): Promise<void> {
  validateId(projectId);
  const paths = resolvePaths(projectId);
  const identity = snapshotIdentity(runIdentity);
  await runGit(paths.sandbox, ["update-ref", "-d", identity.ref]).catch((error) => {
    if (fs.existsSync(path.join(paths.sandbox, ".git"))) throw error;
  });
  await fs.promises.rm(runSnapshotManifestPath(paths, identity.hash), { force: true });
}

export async function projectRunSnapshotExists(projectId: string, runIdentity: string): Promise<boolean> {
  validateId(projectId);
  const paths = resolvePaths(projectId);
  const identity = snapshotIdentity(runIdentity);
  try {
    await runGit(paths.sandbox, ["show-ref", "--verify", "--quiet", identity.ref]);
    return true;
  } catch {
    return false;
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
