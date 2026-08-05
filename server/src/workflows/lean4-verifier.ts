import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  TrustedLeanExecutionPolicy,
  TrustedLeanPreflightRequest,
  TrustedLeanPreflightResult,
  TrustedLeanVerificationRequest,
  TrustedLeanVerificationResult,
  TrustedLeanVerifier,
} from "./kady-node-executor.ts";
import type { WorkflowArtifactReference } from "./run-state.ts";
import { apiRelative, isWithin } from "../sandbox-fs.ts";
import { lookPath } from "../binaries.ts";
import { trustedLeanArtifactPaths } from "./lean4-artifacts.ts";

export const DEFAULT_KADY_LEAN_PROJECT_DIRECTORY = "lean-project";
export const DEFAULT_KADY_LEAN_TIMEOUT_MS = 120_000;

const MAX_LEAN_SOURCE_BYTES = 512 * 1024;
const MAX_LEAN_PROOF_BODY_BYTES = 32 * 1024;
const MAX_VERIFIER_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_SUMMARY_BYTES = 4 * 1024;
const VERIFIER_TIMEOUT_GRACE_MS = 5_000;
const GIT_INSPECTION_TIMEOUT_MS = 15_000;
const LEAN_NAME = /^[A-Za-z_][A-Za-z0-9_']*(?:\.[A-Za-z_][A-Za-z0-9_']*)*$/;
const GIT_OBJECT_ID = /^[a-f0-9]{40,64}$/;
const ALLOWED_LEAN_AXIOMS = new Set(["propext", "Classical.choice", "Quot.sound"]);
const ALLOWED_AXIOMS_RECEIPT_PREFIX = "byom-dag-fusion: allowed_axioms=";

const DEFAULT_VERIFIER_SCRIPT = fileURLToPath(new URL(
  "../../pi-packages/dag-fusion-drive/skills/byom-dag-fusion/scripts/verify-lean4.mjs",
  import.meta.url,
));

interface VerifierProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputExceeded: boolean;
}

interface CreateTrustedLeanVerifierOptions {
  verifierScriptPath?: string;
  lakeProjectDirectory?: string;
  timeoutMs?: number;
  executionPolicy?: TrustedLeanExecutionPolicy;
  runVerifier?: typeof runVerifierProcess;
}

interface PinnedMathlibIdentity {
  lakeProject: string;
  revision: string;
  tree: string;
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Lean verification was cancelled.");
  error.name = "AbortError";
  return error;
}

function statRealDirectory(directory: string, description: string): string {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(directory);
  } catch {
    throw new Error(`${description} is missing.`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${description} must be a real directory, not a symbolic link.`);
  }
  return fs.realpathSync(directory);
}

function projectRelativePath(value: string): boolean {
  if (!value || value.length > 1_024 || value.includes("\\")) return false;
  if (path.posix.isAbsolute(value) || path.posix.normalize(value) !== value) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function ensureSafeParent(sandbox: string, file: string): void {
  const sandboxReal = statRealDirectory(sandbox, "Project sandbox");
  if (!isWithin(sandbox, file)) {
    throw new Error("Lean audit output escaped the project sandbox.");
  }
  const relativeParent = apiRelative(sandbox, path.dirname(file));
  let current = sandbox;
  for (const component of relativeParent.split("/").filter(Boolean)) {
    current = path.join(current, component);
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("Lean audit output traverses a non-directory or symbolic link.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      fs.mkdirSync(current, { mode: 0o700 });
      const created = fs.lstatSync(current);
      if (!created.isDirectory() || created.isSymbolicLink()) {
        throw new Error("Lean audit directory could not be created safely.");
      }
    }
  }
  if (!isWithin(sandboxReal, fs.realpathSync(path.dirname(file)))) {
    throw new Error("Lean audit output resolved outside the project sandbox.");
  }
}

function writeAtomicManagedFile(sandbox: string, file: string, contents: string): void {
  ensureSafeParent(sandbox, file);
  try {
    const existing = fs.lstatSync(file);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error("Lean audit target must be a regular non-symlink file.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600,
    );
    fs.writeFileSync(descriptor, contents, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

function artifactReference(sandbox: string, relativePath: string): WorkflowArtifactReference {
  const absolute = path.resolve(sandbox, ...relativePath.split("/"));
  const bytes = fs.readFileSync(absolute);
  return {
    path: relativePath,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    mediaType: relativePath.endsWith(".lean") ? "text/x-lean" : "text/plain",
  };
}

function inferTheoremName(source: string): string | undefined {
  const declaration = /^\s*(?:theorem|lemma)\s+([A-Za-z_][A-Za-z0-9_']*(?:\.[A-Za-z_][A-Za-z0-9_']*)*)\b/m.exec(
    source,
  );
  return declaration?.[1];
}

function deterministicSolveTheoremName(request: TrustedLeanVerificationRequest): string {
  const digest = createHash("sha256")
    .update(request.workflowId)
    .update("\0")
    .update(request.nodeId)
    .update("\0")
    .update(request.theorem)
    .digest("hex")
    .slice(0, 24);
  return `kady_dag_${digest}`;
}

function solveSource(request: TrustedLeanVerificationRequest): {
  source: string;
  theoremName: string;
} {
  if (request.proofBody === undefined) {
    throw new Error("Lean solve mode requires a solver-authored proof body.");
  }
  const proofBodyBytes = Buffer.byteLength(request.proofBody, "utf8");
  if (proofBodyBytes < 1 || proofBodyBytes > MAX_LEAN_PROOF_BODY_BYTES) {
    throw new Error(
      `Lean proof body must contain between 1 and ${MAX_LEAN_PROOF_BODY_BYTES} UTF-8 bytes.`,
    );
  }
  if (request.proofBody.includes("\0")) {
    throw new Error("Lean proof body cannot contain NUL bytes.");
  }
  const theoremName = deterministicSolveTheoremName(request);
  const indentedProofBody = request.proofBody
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join("\n");
  return {
    theoremName,
    source: [
      ...(request.mathlib ? ["import Mathlib", ""] : []),
      `theorem ${theoremName} : ${request.theorem} := by`,
      indentedProofBody,
      "",
    ].join("\n"),
  };
}

function verificationSource(request: TrustedLeanVerificationRequest): {
  source: string;
  theoremName?: string;
} {
  if (request.mode === "solve") return solveSource(request);
  if (request.proofBody !== undefined) {
    throw new Error("Lean verify mode accepts reviewed complete source, not a solver proof body.");
  }
  return {
    source: request.theorem,
    theoremName: inferTheoremName(request.theorem),
  };
}

const LEAN_CHILD_ENV_ALLOWLIST = [
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "WINDIR",
] as const;

/** The verifier child never inherits provider keys, auth tokens, or Node flags. */
export function leanVerifierChildEnvironment(
  timeoutMs: number,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of LEAN_CHILD_ENV_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  environment.BYOM_DAG_FUSION_TIMEOUT_MS = String(timeoutMs);
  return environment;
}

function boundedDetail(stdout: string, stderr: string): string {
  const combined = `${stderr.trim()}\n${stdout.trim()}`.trim();
  if (!combined) return "The trusted Lean verifier returned no diagnostic output.";
  return Buffer.byteLength(combined) <= MAX_SUMMARY_BYTES
    ? combined
    : Buffer.from(combined).subarray(0, MAX_SUMMARY_BYTES).toString("utf8") + "…";
}

function parseAllowedAxiomsReceipt(stdout: string): string[] | undefined {
  const receiptLines = stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith(ALLOWED_AXIOMS_RECEIPT_PREFIX));
  if (receiptLines.length !== 1) return undefined;

  const payload = receiptLines[0].slice(ALLOWED_AXIOMS_RECEIPT_PREFIX.length);
  if (payload === "none") return [];
  const assumptions = payload.split(",");
  if (
    assumptions.length === 0 ||
    assumptions.some((assumption) => !ALLOWED_LEAN_AXIOMS.has(assumption)) ||
    new Set(assumptions).size !== assumptions.length
  ) {
    return undefined;
  }
  return assumptions;
}

function regularNonSymlinkFile(file: string, description: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    throw new Error(`${description} is missing.`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${description} must be a regular non-symlink file.`);
  }
}

function readManifestMathlibRevision(lakeProject: string): string {
  const manifestFile = path.join(lakeProject, "lake-manifest.json");
  regularNonSymlinkFile(manifestFile, "Pinned Lake manifest");
  let manifest: unknown;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  } catch {
    throw new Error("Pinned Lake manifest is not valid JSON.");
  }
  const packages = manifest && typeof manifest === "object" && !Array.isArray(manifest)
    ? (manifest as { packages?: unknown }).packages
    : undefined;
  const mathlibPackages = Array.isArray(packages)
    ? packages.filter((candidate) =>
      candidate && typeof candidate === "object" &&
      (candidate as { name?: unknown }).name === "mathlib"
    )
    : [];
  if (mathlibPackages.length !== 1) {
    throw new Error("Pinned Lake manifest must contain exactly one Mathlib dependency.");
  }
  const mathlibPackage = mathlibPackages[0] as {
    rev?: unknown;
    type?: unknown;
    url?: unknown;
  };
  const normalizedUrl = typeof mathlibPackage.url === "string"
    ? mathlibPackage.url.replace(/\/+$/, "").replace(/\.git$/, "")
    : "";
  if (
    mathlibPackage.type !== "git" ||
    normalizedUrl !== "https://github.com/leanprover-community/mathlib4"
  ) {
    throw new Error("Pinned Lake manifest must use the official Mathlib Git repository.");
  }
  const revision = mathlibPackage.rev;
  if (typeof revision !== "string" || !/^[a-f0-9]{40}$/i.test(revision)) {
    throw new Error("Pinned Lake manifest Mathlib revision must be a full commit SHA.");
  }
  return revision.toLowerCase();
}

function runTrustedGit(git: string, checkout: string, args: string[]): string {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  const environment = leanVerifierChildEnvironment(GIT_INSPECTION_TIMEOUT_MS);
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = nullDevice;
  environment.GIT_OPTIONAL_LOCKS = "0";
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.LC_ALL = "C";
  const result = spawnSync(
    git,
    [
      "-c",
      `core.hooksPath=${nullDevice}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "credential.helper=",
      "--no-pager",
      ...args,
    ],
    {
      cwd: checkout,
      env: environment,
      encoding: "utf8",
      timeout: GIT_INSPECTION_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(`Pinned Mathlib checkout could not be inspected with Git (${result.status ?? "spawn"}).`);
  }
  return result.stdout.trim();
}

/**
 * Bind a verification to a clean detached checkout whose commit matches the
 * Lake manifest. The pre/post comparison detects mutation during execution;
 * same-user immutability still depends on the explicit execution opt-in.
 */
export function inspectPinnedMathlibCheckout(lakeProject: string): PinnedMathlibIdentity {
  const lakeProjectReal = statRealDirectory(lakeProject, "Pinned Lake project");
  const manifestRevision = readManifestMathlibRevision(lakeProjectReal);
  const mathlibCandidate = path.join(lakeProjectReal, ".lake", "packages", "mathlib");
  const mathlibCheckout = statRealDirectory(mathlibCandidate, "Pinned Mathlib checkout");
  if (!isWithin(lakeProjectReal, mathlibCheckout)) {
    throw new Error("Pinned Mathlib checkout resolved outside the Lake project.");
  }
  const gitDirectory = path.join(mathlibCheckout, ".git");
  statRealDirectory(gitDirectory, "Pinned Mathlib Git directory");
  const headFile = path.join(gitDirectory, "HEAD");
  regularNonSymlinkFile(headFile, "Pinned Mathlib HEAD");
  const detachedHead = fs.readFileSync(headFile, "utf8").trim().toLowerCase();
  if (!GIT_OBJECT_ID.test(detachedHead)) {
    throw new Error("Pinned Mathlib checkout must use a detached immutable commit HEAD.");
  }

  const git = lookPath("git");
  if (!git) throw new Error("Git is unavailable for pinned Mathlib integrity inspection.");
  const revision = runTrustedGit(git, mathlibCheckout, ["rev-parse", "--verify", "HEAD^{commit}"])
    .toLowerCase();
  const tree = runTrustedGit(git, mathlibCheckout, ["rev-parse", "--verify", "HEAD^{tree}"])
    .toLowerCase();
  const dirty = runTrustedGit(git, mathlibCheckout, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (!GIT_OBJECT_ID.test(revision) || revision !== detachedHead || revision !== manifestRevision) {
    throw new Error("Pinned Mathlib HEAD does not match its Lake manifest revision.");
  }
  if (!GIT_OBJECT_ID.test(tree)) {
    throw new Error("Pinned Mathlib tree identity is invalid.");
  }
  if (dirty) {
    throw new Error("Pinned Mathlib checkout is dirty or contains untracked files.");
  }
  return { lakeProject: lakeProjectReal, revision, tree };
}

function killVerifierTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The verifier may have exited between the close check and the signal.
    }
  }
}

async function runVerifierProcess(options: {
  script: string;
  source: string;
  theoremName: string;
  lakeProject: string;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<VerifierProcessResult> {
  if (options.signal.aborted) throw abortError(options.signal);

  return await new Promise<VerifierProcessResult>((resolve, reject) => {
    const environment = leanVerifierChildEnvironment(options.timeoutMs);

    const child = spawn(
      process.execPath,
      [options.script, options.source, options.theoremName, options.lakeProject],
      {
        cwd: options.lakeProject,
        env: environment,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let outputExceeded = false;
    let timedOut = false;
    let settled = false;
    let cancellationError: Error | undefined;

    const finishReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      killVerifierTree(child);
      reject(error);
    };
    const collect = (target: Buffer[], chunk: Buffer): void => {
      if (outputExceeded) return;
      outputBytes += chunk.length;
      if (outputBytes > MAX_VERIFIER_OUTPUT_BYTES) {
        outputExceeded = true;
        killVerifierTree(child);
        return;
      }
      target.push(chunk);
    };
    const onAbort = (): void => {
      if (settled || cancellationError) return;
      cancellationError = abortError(options.signal);
      // Do not reject yet. The promise settles only from `close`, after the
      // detached POSIX process group has been killed and the child reaped.
      killVerifierTree(child);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killVerifierTree(child);
    }, options.timeoutMs + VERIFIER_TIMEOUT_GRACE_MS);

    options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal.aborted) onAbort();
    child.stdout?.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", finishReject);
    child.once("close", (exitCode, closeSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      if (cancellationError) {
        reject(cancellationError);
        return;
      }
      resolve({
        exitCode,
        signal: closeSignal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        outputExceeded,
      });
    });
  });
}

/**
 * Create Kady's trusted Lean verifier. Solve-mode models supply only a proof
 * body; this host builds the exact declaration and is the only artifact writer.
 * The opt-in mode is deliberately named unsandboxed because Lean retains the
 * current OS account's filesystem and network authority.
 */
export function createTrustedLeanVerifier(
  options: CreateTrustedLeanVerifierOptions = {},
): TrustedLeanVerifier {
  const verifierScript = path.resolve(options.verifierScriptPath ?? DEFAULT_VERIFIER_SCRIPT);
  const lakeProjectDirectory = options.lakeProjectDirectory ?? DEFAULT_KADY_LEAN_PROJECT_DIRECTORY;
  const timeoutMs = options.timeoutMs ?? DEFAULT_KADY_LEAN_TIMEOUT_MS;
  const executionPolicy = options.executionPolicy ?? (
    process.env.KADY_ALLOW_UNSANDBOXED_LEAN === "1" ? "unsandboxed-opt-in" : "disabled"
  );
  const runVerifier = options.runVerifier ?? runVerifierProcess;
  if (!projectRelativePath(lakeProjectDirectory)) {
    throw new Error("Kady's Lean project directory must be sandbox-relative and canonical.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) {
    throw new Error("Kady's Lean timeout must be between 1000 and 600000 milliseconds.");
  }

  const preflight = async (
    request: TrustedLeanPreflightRequest,
  ): Promise<TrustedLeanPreflightResult> => {
    if (request.signal.aborted) throw abortError(request.signal);
    if (executionPolicy === "disabled") {
      return {
        status: "unavailable",
        executionPolicy,
        summary:
          "Lean execution is disabled by default. A server owner must set KADY_ALLOW_UNSANDBOXED_LEAN=1 after reviewing the same-user filesystem and network authority.",
      };
    }
    if (process.platform === "win32") {
      return {
        status: "unavailable",
        executionPolicy,
        summary:
          "Unsandboxed Lean execution is unavailable on Windows because Kady cannot yet guarantee descendant-process termination on cancellation.",
      };
    }
    try {
      regularNonSymlinkFile(verifierScript, "Trusted byom-dag-fusion verifier");
      const sandboxReal = statRealDirectory(request.paths.sandbox, "Project sandbox");
      const candidate = path.join(request.paths.sandbox, ...lakeProjectDirectory.split("/"));
      const lakeProject = statRealDirectory(
        candidate,
        `Pinned Lake project ${lakeProjectDirectory}`,
      );
      if (!isWithin(sandboxReal, lakeProject)) {
        throw new Error("Pinned Lake project resolved outside the project sandbox.");
      }
      const identity = inspectPinnedMathlibCheckout(lakeProject);
      return {
        status: "ready",
        executionPolicy,
        mathlibRevision: identity.revision,
        mathlibTree: identity.tree,
        summary:
          "Unsandboxed Lean execution is explicitly enabled; it retains the Kady OS account's filesystem and network authority.",
      };
    } catch (error) {
      return {
        status: "unavailable",
        executionPolicy,
        summary: `${
          error instanceof Error ? error.message : "Pinned Lean environment is unavailable."
        } Kady did not install or update Lean automatically.`,
      };
    }
  };

  const verify = async (
    request: TrustedLeanVerificationRequest,
  ): Promise<TrustedLeanVerificationResult> => {
    if (request.signal.aborted) throw abortError(request.signal);
    const preflightResult = await preflight(request);
    if (preflightResult.status !== "ready") {
      return {
        status: "unavailable",
        executionPolicy: preflightResult.executionPolicy,
        summary: preflightResult.summary,
      };
    }

    let prepared: ReturnType<typeof verificationSource>;
    try {
      prepared = verificationSource(request);
    } catch (error) {
      return {
        status: "failed",
        executionPolicy,
        summary: error instanceof Error ? error.message : "Lean source could not be constructed.",
      };
    }
    const sourceBytes = Buffer.byteLength(prepared.source, "utf8");
    if (sourceBytes === 0 || sourceBytes > MAX_LEAN_SOURCE_BYTES) {
      return {
        status: "failed",
        executionPolicy,
        summary: `Lean source must contain between 1 and ${MAX_LEAN_SOURCE_BYTES} UTF-8 bytes.`,
      };
    }
    const theoremName = prepared.theoremName;
    if (!theoremName || !LEAN_NAME.test(theoremName)) {
      return {
        status: "failed",
        executionPolicy,
        summary: "A named Lean theorem or lemma could not be identified in the reviewed source.",
      };
    }
    if (!request.mathlib && /^\s*import\s+Mathlib(?:\.|\s|$)/m.test(prepared.source)) {
      return {
        status: "failed",
        theoremName,
        executionPolicy,
        summary: "This node disabled Mathlib, but its reviewed source imports Mathlib.",
      };
    }

    const artifactPaths = trustedLeanArtifactPaths(request.runId, request.executionId);
    const sourceFile = path.resolve(request.paths.sandbox, ...artifactPaths.proof.split("/"));
    const logFile = path.resolve(request.paths.sandbox, ...artifactPaths.log.split("/"));
    const existingArtifacts = (): WorkflowArtifactReference[] => {
      const artifacts: WorkflowArtifactReference[] = [];
      for (const artifactPath of [artifactPaths.proof, artifactPaths.log]) {
        try {
          artifacts.push(artifactReference(request.paths.sandbox, artifactPath));
        } catch {
          // A missing file cannot be represented as a verified artifact receipt.
        }
      }
      return artifacts;
    };
    const result = (
      status: TrustedLeanVerificationResult["status"],
      summary: string,
      extra: Partial<TrustedLeanVerificationResult> = {},
    ): TrustedLeanVerificationResult => ({
      status,
      summary,
      theoremName,
      executionPolicy,
      mathlibRevision: preflightResult.mathlibRevision,
      mathlibTree: preflightResult.mathlibTree,
      artifacts: existingArtifacts(),
      ...extra,
    });

    try {
      writeAtomicManagedFile(request.paths.sandbox, sourceFile, prepared.source);
    } catch (error) {
      return result(
        "failed",
        `Lean source could not be preserved safely: ${
          error instanceof Error ? error.message : "unknown filesystem error"
        }`,
      );
    }
    const expectedSourceSha256 = createHash("sha256").update(prepared.source).digest("hex");

    let processResult: VerifierProcessResult;
    try {
      processResult = await runVerifier({
        script: verifierScript,
        source: sourceFile,
        theoremName,
        lakeProject: path.join(request.paths.sandbox, ...lakeProjectDirectory.split("/")),
        timeoutMs,
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal.aborted) throw abortError(request.signal);
      const summary = error instanceof Error ? error.message : "Trusted Lean verifier could not start.";
      try {
        writeAtomicManagedFile(request.paths.sandbox, logFile, `${summary}\n`);
      } catch {
        // The returned source receipt still records the failure if the log path is unsafe.
      }
      return result("unavailable", summary);
    }

    const postflightErrors: string[] = [];
    try {
      const postflight = inspectPinnedMathlibCheckout(
        path.join(request.paths.sandbox, ...lakeProjectDirectory.split("/")),
      );
      if (
        postflight.revision !== preflightResult.mathlibRevision ||
        postflight.tree !== preflightResult.mathlibTree
      ) {
        postflightErrors.push("Pinned Mathlib revision or tree changed during verification.");
      }
    } catch (error) {
      postflightErrors.push(error instanceof Error
        ? error.message
        : "Pinned Mathlib identity could not be rechecked after verification.");
    }
    try {
      const sourceReceipt = artifactReference(request.paths.sandbox, artifactPaths.proof);
      if (
        sourceReceipt.size !== sourceBytes ||
        sourceReceipt.sha256 !== expectedSourceSha256
      ) {
        postflightErrors.push("Host-owned Lean source changed during verification.");
      }
    } catch {
      postflightErrors.push("Host-owned Lean source could not be rechecked after verification.");
    }

    const completeLog = [
      `execution_id=${request.executionId}`,
      `workflow_id=${request.workflowId}`,
      `node_id=${request.nodeId}`,
      `theorem=${theoremName}`,
      `execution_policy=${executionPolicy}`,
      `mathlib_revision=${preflightResult.mathlibRevision}`,
      `mathlib_tree=${preflightResult.mathlibTree}`,
      `exit_code=${String(processResult.exitCode)}`,
      `signal=${processResult.signal ?? "none"}`,
      ...postflightErrors.map((error) => `integrity_error=${error}`),
      "--- stdout ---",
      processResult.stdout,
      "--- stderr ---",
      processResult.stderr,
    ].join("\n");
    try {
      writeAtomicManagedFile(request.paths.sandbox, logFile, completeLog);
    } catch (error) {
      return result(
        "failed",
        `Lean verifier output could not be preserved safely: ${
          error instanceof Error ? error.message : "unknown filesystem error"
        }`,
      );
    }

    if (postflightErrors.length > 0) {
      return result("failed", postflightErrors.join(" "));
    }
    if (processResult.outputExceeded) {
      return result(
        "failed",
        `Trusted Lean verifier exceeded the ${MAX_VERIFIER_OUTPUT_BYTES}-byte output limit.`,
      );
    }
    if (processResult.timedOut || processResult.exitCode === 124) {
      return result(
        "unavailable",
        `Trusted Lean verification timed out after ${timeoutMs} milliseconds.`,
      );
    }
    if (processResult.exitCode !== 0) {
      return result(
        processResult.exitCode === 69 ? "unavailable" : "failed",
        boundedDetail(processResult.stdout, processResult.stderr),
      );
    }

    const toolchain = /^byom-dag-fusion: toolchain=(.+)$/m.exec(processResult.stdout)?.[1]?.trim();
    const reportedMathlibRevision = /^byom-dag-fusion: mathlib_revision=(.+)$/m.exec(
      processResult.stdout,
    )?.[1]?.trim().toLowerCase();
    const assumptions = parseAllowedAxiomsReceipt(processResult.stdout);
    if (
      !toolchain || !reportedMathlibRevision ||
      reportedMathlibRevision !== preflightResult.mathlibRevision ||
      assumptions === undefined
    ) {
      return result(
        "failed",
        "Trusted Lean verifier succeeded without a matching toolchain receipt, matching pinned Mathlib receipt, and one unique valid allowed-axiom receipt.",
      );
    }

    return result(
      "verified",
      `Lean verified ${theoremName} with ${toolchain}, Mathlib ${reportedMathlibRevision}, and tree ${preflightResult.mathlibTree}.`,
      {
        ...(request.mode === "solve" ? { normalizedStatement: request.theorem } : {}),
        toolchain,
        assumptions,
        translationGaps: [
          "Lean checked the formal source; correspondence between that formalization and the research claim remains a separate evidence obligation.",
        ],
      },
    );
  };
  verify.preflight = preflight;
  return verify;
}
