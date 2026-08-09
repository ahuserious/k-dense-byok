import fs from "node:fs";
import path from "node:path";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  getAgentDir,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { ProjectPaths } from "../projects.ts";
import { lookPath } from "../binaries.ts";
import { apiRelative } from "../sandbox-fs.ts";
import { seedAgentFiles } from "./agent-files.ts";
import {
  assertDagFusionPackageSeeded,
  createDagFusionWorkflowSessionBridge,
  dagFusionExtensionPath,
  seedDagFusionPackage,
} from "./dag-fusion-bridge.ts";
import type {
  DagFusionDelegationHost,
  DagFusionDelegationHostSnapshot,
} from "../../pi-packages/dag-fusion-drive/index.ts";
import { defaultModel } from "./models.ts";
import {
  getModelRegistry,
  getModelRuntime,
} from "./session-registry.ts";
import { subagentsExtensionPath } from "./subagent-bridge.ts";
import { ensureWebAccess } from "./web-access-bridge.ts";

export interface WorkflowDelegationSession {
  readonly projectId: string;
  /** In-memory Pi session used only to own extension runtime state. */
  readonly session: AgentSession;
  /** Trusted host API; prompts never receive this object as a tool. */
  readonly host: DagFusionDelegationHost;
  readonly disposed: boolean;
  snapshot(): WorkflowDelegationSessionSnapshot;
  dispose(options?: DisposeWorkflowDelegationSessionOptions): Promise<void>;
}

export interface WorkflowDelegationSessionSnapshot {
  projectId: string;
  disposed: boolean;
  host: DagFusionDelegationHostSnapshot;
}

export interface DisposeWorkflowDelegationSessionOptions {
  /** Project deletion uses this non-blocking guard to preserve an owned Pi session. */
  rejectIfOwnedLeaves?: boolean;
}

export type WorkflowHarness =
  | "pi"
  | "claude-code"
  | "codex"
  | "opencode"
  | "copilot";

export type WorkflowHarnessDispatchErrorCode =
  | "WORKFLOW_HARNESS_NOT_INSTALLED"
  | "WORKFLOW_HARNESS_NOT_BOUND";

export class WorkflowHarnessDispatchError extends Error {
  constructor(
    readonly code: WorkflowHarnessDispatchErrorCode,
    readonly harness: WorkflowHarness,
    message: string,
  ) {
    super(message);
    this.name = "WorkflowHarnessDispatchError";
  }
}

export interface WorkflowHarnessDispatchDependencies {
  pi(
    projectId: string,
    paths: ProjectPaths,
  ): Promise<WorkflowDelegationSession>;
  findExecutable(command: string): string | null;
}

export interface S4ConditionCheck {
  requirement: string;
  kind: "sandbox-path" | "named-input" | "when";
  passed: boolean;
  detail: string;
}

export interface S4ConditionEvaluation {
  passed: boolean;
  checks: S4ConditionCheck[];
}

export class S4NodeConditionError extends Error {
  readonly code = "WORKFLOW_NODE_CONDITION_UNMET";

  constructor(readonly evaluation: S4ConditionEvaluation) {
    const failures = evaluation.checks
      .filter((check) => !check.passed)
      .map((check) => `${check.requirement}: ${check.detail}`)
      .join("; ");
    super(`Node conditions were not met before execution admission: ${failures}`);
    this.name = "S4NodeConditionError";
  }
}

export interface S4ConditionContext {
  runInput: { variables?: Record<string, unknown> };
  attempt: number;
  resumed: boolean;
  inbound: Array<{ fromNodeId: string }>;
}

export interface S4NodeBindingIssue {
  code: "s4-node-binding-invalid";
  path: string;
  message: string;
}

const S4_RESERVED_SAMPLING_KEYS = new Set([
  "messages",
  "model",
  "tools",
  "stream",
  "max_tokens",
  "temperature",
  "top_p",
]);

export function applyS4ProviderRequestBindings(
  payload: Record<string, unknown>,
  providerRequest: {
    temperature: number;
    top_p: number;
    sampling: Record<string, string | number | boolean>;
  },
): Record<string, unknown> {
  const bound: Record<string, unknown> = {
    ...payload,
    temperature: providerRequest.temperature,
    top_p: providerRequest.top_p,
  };
  for (const [key, value] of Object.entries(providerRequest.sampling)) {
    if (!S4_RESERVED_SAMPLING_KEYS.has(key)) bound[key] = value;
  }
  return bound;
}

/** Pure merge-time validation hook for controls that would be unsafe to defer. */
export function s4NodeBindingIssues(
  spec: {
    hyperparameters: { sampling: Record<string, unknown> };
    conditions: { when?: string; exists: string[] };
  },
  settingsPath: string,
): S4NodeBindingIssue[] {
  const issues: S4NodeBindingIssue[] = [];
  for (const key of Object.keys(spec.hyperparameters.sampling)) {
    if (S4_RESERVED_SAMPLING_KEYS.has(key)) {
      issues.push({
        code: "s4-node-binding-invalid",
        path: `${settingsPath}/hyperparameters/sampling/${key}`,
        message: `Sampling key ${key} is reserved; use its dedicated NodeSpec field.`,
      });
    }
  }
  for (const [index, requirement] of spec.conditions.exists.entries()) {
    if (
      !requirement.startsWith("input:") && !requirement.startsWith("inputs.") &&
      (requirement.includes("\0") || path.isAbsolute(requirement) ||
        requirement.split(/[\\/]+/).includes(".."))
    ) {
      issues.push({
        code: "s4-node-binding-invalid",
        path: `${settingsPath}/conditions/exists/${index}`,
        message: "conditions.exists paths must remain relative to the project sandbox.",
      });
    }
  }
  return issues;
}

function conditionPropertyAt(
  root: unknown,
  segments: string[],
): { found: boolean; value?: unknown } {
  let current = root;
  for (const segment of segments) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return { found: false };
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return { found: false };
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

function conditionReference(
  expression: string,
  context: S4ConditionContext,
): { found: boolean; value?: unknown } {
  const segments = expression.split(".").filter(Boolean);
  const root = segments.shift();
  if (root === "inputs" || root === "variables") {
    return conditionPropertyAt(context.runInput.variables ?? {}, segments);
  }
  if (root === "run") return conditionPropertyAt(context.runInput, segments);
  if (root === "attempt") return { found: true, value: context.attempt };
  if (root === "resumed") return { found: true, value: context.resumed };
  if (root === "inbound") {
    const nodeId = segments.shift();
    if (!nodeId) return { found: false };
    const inbound = context.inbound.find((entry) => entry.fromNodeId === nodeId);
    return inbound ? conditionPropertyAt(inbound, segments) : { found: false };
  }
  return { found: false };
}

function sandboxPathExists(sandboxRoot: string, relativePath: string): boolean {
  if (
    relativePath.includes("\0") || path.isAbsolute(relativePath) ||
    relativePath.split(/[\\/]+/).includes("..")
  ) return false;
  const sandbox = path.resolve(sandboxRoot);
  const target = path.resolve(sandbox, relativePath);
  const relative = apiRelative(sandbox, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;

  let existing = target;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return false;
    existing = parent;
  }
  try {
    const realSandbox = fs.realpathSync(sandbox);
    const realExisting = fs.realpathSync(existing);
    const realRelative = apiRelative(realSandbox, realExisting);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) return false;
  } catch {
    return false;
  }
  return fs.existsSync(target);
}

/**
 * Evaluate the frozen condition language without eval or shell expansion.
 * `when` accepts true/false or one boolean reference, optionally prefixed by
 * `!`/`not`: inputs.*, variables.*, run.*, inbound.<nodeId>.*, or resumed.
 * Missing and non-boolean references fail closed. `exists` accepts sandbox
 * relative paths plus named inputs written as `input:name` or `inputs.name`.
 */
export function evaluateS4NodeConditions(
  spec: { conditions: { when?: string; exists: string[] } },
  context: S4ConditionContext,
  sandboxRoot: string,
): S4ConditionEvaluation {
  const checks: S4ConditionCheck[] = [];
  for (const requirement of spec.conditions.exists) {
    const namedInput = requirement.startsWith("input:")
      ? requirement.slice("input:".length).split(".").filter(Boolean)
      : requirement.startsWith("inputs.")
        ? requirement.slice("inputs.".length).split(".").filter(Boolean)
        : undefined;
    if (namedInput) {
      const result = conditionPropertyAt(context.runInput.variables ?? {}, namedInput);
      checks.push({
        requirement,
        kind: "named-input",
        passed: result.found,
        detail: result.found ? "named input is present" : "named input is missing",
      });
      continue;
    }
    const passed = sandboxPathExists(sandboxRoot, requirement);
    checks.push({
      requirement,
      kind: "sandbox-path",
      passed,
      detail: passed ? "sandbox path exists" : "sandbox path is missing or unsafe",
    });
  }

  if (spec.conditions.when !== undefined) {
    let expression = spec.conditions.when.trim();
    let negate = false;
    if (expression.startsWith("!")) {
      negate = true;
      expression = expression.slice(1).trim();
    } else if (expression.startsWith("not ")) {
      negate = true;
      expression = expression.slice(4).trim();
    }
    let found = true;
    let value: unknown;
    if (expression === "true" || expression === "false") {
      value = expression === "true";
    } else {
      const resolved = conditionReference(expression, context);
      found = resolved.found;
      value = resolved.value;
    }
    const passed = found && typeof value === "boolean" && (negate ? !value : value);
    checks.push({
      requirement: spec.conditions.when,
      kind: "when",
      passed,
      detail: !found
        ? "condition reference is missing"
        : typeof value !== "boolean"
          ? "condition reference is not boolean"
          : `condition evaluated to ${String(negate ? !value : value)}`,
    });
  }
  return { passed: checks.every((check) => check.passed), checks };
}

/** Runner-facing one-line gate used before ModelCallTracker construction. */
export function assertS4NodeConditions(
  spec: { conditions: { when?: string; exists: string[] } },
  context: S4ConditionContext,
  sandboxRoot: string,
): void {
  const evaluation = evaluateS4NodeConditions(spec, context, sandboxRoot);
  if (!evaluation.passed) throw new S4NodeConditionError(evaluation);
}

const HARNESS_EXECUTABLES: Record<Exclude<WorkflowHarness, "pi">, string[]> = {
  "claude-code": ["claude"],
  codex: ["codex"],
  opencode: ["opencode"],
  copilot: ["github-copilot", "copilot"],
};

/**
 * Select the node's execution harness without silently falling back to Pi.
 * Pi is the fully bound Wave-B implementation. Other frozen harness values
 * have an explicit discovery seam so installing a CLI changes the diagnostic,
 * but cannot accidentally grant it workflow authority before an adapter lands.
 */
export async function dispatchWorkflowHarness(
  harness: WorkflowHarness,
  projectId: string,
  paths: ProjectPaths,
  dependencyOverrides: Partial<WorkflowHarnessDispatchDependencies> = {},
): Promise<WorkflowDelegationSession> {
  const dependencies: WorkflowHarnessDispatchDependencies = {
    pi: getOrCreateWorkflowDelegationSession,
    findExecutable: lookPath,
    ...dependencyOverrides,
  };
  if (harness === "pi") return dependencies.pi(projectId, paths);

  const installed = HARNESS_EXECUTABLES[harness]
    .map((command) => dependencies.findExecutable(command))
    .find((candidate): candidate is string => candidate !== null);
  if (!installed) {
    throw new WorkflowHarnessDispatchError(
      "WORKFLOW_HARNESS_NOT_INSTALLED",
      harness,
      `Workflow harness ${harness} is not installed. Install one of: ${HARNESS_EXECUTABLES[harness].join(", ")}.`,
    );
  }
  throw new WorkflowHarnessDispatchError(
    "WORKFLOW_HARNESS_NOT_BOUND",
    harness,
    `Workflow harness ${harness} was found at ${installed}, but this Kady build has no trusted delegation adapter for it.`,
  );
}

interface LiveWorkflowDelegationSession extends WorkflowDelegationSession {
  readonly disposed: boolean;
}

const liveSessions = new Map<string, Promise<LiveWorkflowDelegationSession>>();
const closingSessions = new Map<string, Promise<void>>();

export const WORKFLOW_NODE_CONTROL_ENVELOPE_PREFIX = "KADY_NODE_CONTROL_V1:";

const WORKFLOW_NODE_CONTROL_EXTENSION = `
const PREFIX = ${JSON.stringify("KADY_NODE_CONTROL_V1:")};
const RESERVED_SAMPLING_KEYS = new Set(["messages", "model", "tools", "stream", "max_tokens", "temperature", "top_p"]);

export default function workflowNodeControl(pi) {
  let activePolicy;
  pi.on("input", (event) => {
    if (!event.text.startsWith(PREFIX)) return { action: "continue" };
    const newline = event.text.indexOf("\\n");
    if (newline < 0) throw new Error("Kady node-control envelope has no task body.");
    const encoded = event.text.slice(PREFIX.length, newline);
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!parsed || parsed.version !== 1 || parsed.harness !== "pi") {
      throw new Error("Kady node-control envelope is invalid or targets another harness.");
    }
    activePolicy = parsed;
    const available = new Set(pi.getAllTools().map((tool) => tool.name));
    const selected = parsed.toolPolicy.allowedTools.filter((tool) => available.has(tool));
    pi.setActiveTools(selected);
    return { action: "transform", text: event.text.slice(newline + 1), images: event.images };
  });
  pi.on("before_provider_request", (event) => {
    if (!activePolicy || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
      return event.payload;
    }
    const payload = { ...event.payload };
    payload.temperature = activePolicy.providerRequest.temperature;
    payload.top_p = activePolicy.providerRequest.top_p;
    for (const [key, value] of Object.entries(activePolicy.providerRequest.sampling)) {
      if (!RESERVED_SAMPLING_KEYS.has(key)) payload[key] = value;
    }
    return payload;
  });
}
`.trimStart();

function workflowNodeControlPackageDir(paths: ProjectPaths): string {
  return path.join(paths.kadyDir, "workflow-node-control-v1");
}

/** Seed the trusted child-only policy extension used by per-node S4 bindings. */
export function seedWorkflowNodeControlPackage(paths: ProjectPaths): void {
  const packageDir = workflowNodeControlPackageDir(paths);
  fs.mkdirSync(packageDir, { recursive: true });
  const packageJson = JSON.stringify({
    name: "kady-workflow-node-control",
    version: "1.0.0",
    private: true,
    type: "module",
    pi: { extensions: ["./index.mjs"] },
  }, null, 2) + "\n";
  const files = new Map([
    [path.join(packageDir, "package.json"), packageJson],
    [path.join(packageDir, "index.mjs"), WORKFLOW_NODE_CONTROL_EXTENSION],
  ]);
  for (const [file, contents] of files) {
    let current: string | undefined;
    try {
      current = fs.readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (current !== contents) fs.writeFileSync(file, contents, { encoding: "utf8", mode: 0o600 });
  }

  const settingsPath = path.join(paths.sandbox, ".pi", "settings.json");
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  const packages = Array.isArray(settings.packages) ? [...settings.packages] : [];
  if (!packages.includes(packageDir)) {
    packages.push(packageDir);
    settings.packages = packages;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  }
}

export function assertWorkflowNodeControlPackageSeeded(paths: ProjectPaths): void {
  const packageDir = workflowNodeControlPackageDir(paths);
  const settingsPath = path.join(paths.sandbox, ".pi", "settings.json");
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  if (
    !Array.isArray(settings.packages) || !settings.packages.includes(packageDir) ||
    !fs.existsSync(path.join(packageDir, "index.mjs"))
  ) {
    throw new Error("DAG workflow child settings do not contain the S4 node-control package.");
  }
}

function assertProjectIdentity(projectId: string, paths: ProjectPaths): void {
  if (projectId !== paths.id) {
    throw new Error(
      `Workflow delegation project ${projectId} does not match paths for ${paths.id}.`,
    );
  }
}

/**
 * Prepare the immutable child-runtime boundary before any budget admission.
 * The out-of-process workflow supervisor and the embedded fallback both use
 * this exact seeding/trust check so transport placement cannot change which
 * Pi packages a DAG leaf is allowed to load.
 */
export function prepareWorkflowDelegationProject(
  projectId: string,
  paths: ProjectPaths,
): void {
  assertProjectIdentity(projectId, paths);
  seedAgentFiles(paths);
  ensureWebAccess(paths);
  seedDagFusionPackage(paths);
  assertDagFusionPackageSeeded(paths);
  seedWorkflowNodeControlPackage(paths);
  assertWorkflowNodeControlPackageSeeded(paths);
}

async function buildWorkflowDelegationSession(
  projectId: string,
  paths: ProjectPaths,
  removeFromRegistry: () => void,
): Promise<LiveWorkflowDelegationSession> {
  assertProjectIdentity(projectId, paths);

  // Child Pi processes discover their project-scoped specialist roster and
  // package resources from the sandbox. These seeders are idempotent and do
  // not make the host session an ordinary persistent chat.
  prepareWorkflowDelegationProject(projectId, paths);

  const bridge = createDagFusionWorkflowSessionBridge();
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: paths.sandbox,
    agentDir: getAgentDir(),
    settingsManager,
    // Load only the two public runtime entries needed by the trusted host.
    // Project packages remain available to the child Pi processes through the
    // seeded settings file, but unrelated parent extensions are not admitted.
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [
      subagentsExtensionPath(),
      dagFusionExtensionPath(),
    ],
    extensionFactories: [bridge.extension],
  });

  let session: AgentSession | undefined;
  try {
    await resourceLoader.reload();
    const created = await createAgentSession({
      cwd: paths.sandbox,
      agentDir: getAgentDir(),
      model: defaultModel(getModelRegistry()),
      modelRuntime: getModelRuntime(),
      resourceLoader,
      sessionManager: SessionManager.inMemory(paths.sandbox),
      settingsManager,
      // This session exists to give pi-subagents a live extension context and
      // event bus. It is never prompted and exposes no model-facing tools.
      noTools: "all",
      tools: [],
    });
    session = created.session;
    const host = bridge.getHost();
    let disposed = false;
    let disposal: Promise<void> | undefined;

    return {
      projectId,
      session,
      host,
      get disposed(): boolean {
        return disposed;
      },
      snapshot(): WorkflowDelegationSessionSnapshot {
        return {
          projectId,
          disposed,
          host: host.snapshot(),
        };
      },
      dispose(options: DisposeWorkflowDelegationSessionOptions = {}): Promise<void> {
        if (disposal) return disposal;
        const hostSnapshot = host.snapshot();
        if (options.rejectIfOwnedLeaves && hostSnapshot.pending.length > 0) {
          const quarantined = hostSnapshot.quarantined.length;
          return Promise.reject(
            new Error(
              quarantined > 0
                ? `Project ${projectId} has ${quarantined} quarantined DAG child execution(s); deletion is blocked until exact terminal acknowledgement.`
                : `Project ${projectId} still owns ${hostSnapshot.pending.length} DAG child execution(s); deletion is blocked until they settle.`,
            ),
          );
        }
        disposed = true;

        let closing!: Promise<void>;
        closing = (async () => {
          // Stop owned leaves before tearing down the event bus they use for
          // cancellation and terminal usage reconciliation.
          try {
            await bridge.dispose();
          } finally {
            session?.clearQueue();
            try {
              if (session && !session.isIdle) await session.abort();
            } finally {
              session?.dispose();
            }
          }
        })().finally(() => {
          // Keep the disposed-but-closing session discoverable for diagnostics
          // while the host waits for a quarantined tuple's exact terminal
          // acknowledgement. `getOrCreate` still waits on `closingSessions`, so
          // retaining this registry entry cannot reopen or reuse the session.
          removeFromRegistry();
          if (closingSessions.get(projectId) === closing) {
            closingSessions.delete(projectId);
          }
        });
        disposal = closing;
        closingSessions.set(projectId, closing);
        return closing;
      },
    };
  } catch (error) {
    try {
      await bridge.dispose();
    } finally {
      session?.dispose();
    }
    throw error;
  }
}

/**
 * Return the one process-local workflow extension session for a project.
 * Concurrent callers share the same construction promise and host.
 */
export function getOrCreateWorkflowDelegationSession(
  projectId: string,
  paths: ProjectPaths,
): Promise<WorkflowDelegationSession> {
  try {
    assertProjectIdentity(projectId, paths);
  } catch (error) {
    return Promise.reject(error);
  }
  const closing = closingSessions.get(projectId);
  if (closing) {
    return closing.then(
      () => getOrCreateWorkflowDelegationSession(projectId, paths),
      () => getOrCreateWorkflowDelegationSession(projectId, paths),
    );
  }
  const existing = liveSessions.get(projectId);
  if (existing) return existing;

  let creation!: Promise<LiveWorkflowDelegationSession>;
  creation = buildWorkflowDelegationSession(projectId, paths, () => {
    if (liveSessions.get(projectId) === creation) liveSessions.delete(projectId);
  }).catch((error) => {
    if (liveSessions.get(projectId) === creation) liveSessions.delete(projectId);
    throw error;
  });
  liveSessions.set(projectId, creation);
  return creation;
}

/** Dispose the dedicated host for one project, including an in-flight build. */
export async function disposeWorkflowDelegationSession(
  projectId: string,
  options: DisposeWorkflowDelegationSessionOptions = {},
): Promise<void> {
  const pending = liveSessions.get(projectId);
  if (pending) {
    const session = await pending;
    await session.dispose(options);
    return;
  }
  await closingSessions.get(projectId);
}

/** Read-only process-local diagnostics for project deletion and operators. */
export async function workflowDelegationSessionSnapshot(
  projectId: string,
): Promise<WorkflowDelegationSessionSnapshot | undefined> {
  const pending = liveSessions.get(projectId);
  if (!pending) return undefined;
  return (await pending).snapshot();
}

/** Deterministic process-shutdown hook for all dedicated workflow sessions. */
export async function disposeAllWorkflowDelegationSessions(): Promise<void> {
  const pending = [...liveSessions.values()];
  await Promise.allSettled(
    pending.map(async (entry) => {
      const session = await entry;
      await session.dispose();
    }),
  );
  await Promise.allSettled([...closingSessions.values()]);
}

/** Test/diagnostic snapshot; does not expose mutable registry state. */
export function workflowDelegationSessionCount(): number {
  return liveSessions.size;
}
