/**
 * The Claude Code relay — matrix rows 7 and 16, and the first second adapter.
 *
 * A workflow node declaring `harness: "claude-code"` reaches the shared dispatch
 * decision (`harness-registry.ts` → `selectWorkflowHarnessAdapter`), which now
 * selects `claude-code-relay` instead of throwing. This module is that adapter:
 * it resolves the Claude Code executable, invokes it in print (`-p`) mode, and
 * returns the same `DagFusionDelegationReceipt` the Pi delegation host returns,
 * so the node executor's budget, usage and receipt paths are untouched.
 *
 * **Resolution reuses the vendored engine's order, it does not reinvent it.**
 * `server/vendor/pipeline-engine/packages/providers/src/claude/binary-resolver.ts`
 * is the origin of the order and of the two anchors named below
 * (`CLAUDE_BIN_PATH_ENV_VAR`, `claudeNativeInstallerPath()`). That module cannot
 * be imported here: it statically imports a package from the vendored engine's
 * own bun workspace, which is not installed on the Kady server's module path,
 * and the vendored engine runs as a separate bun process. `claude-code-relay-vendor-
 * parity.test.ts` reads the vendored file and fails the build if these anchors
 * drift, so the two spellings are one policy enforced by a gate rather than by
 * convention. Two host-only differences, both deliberate:
 *
 *  1. A persisted override (`harness-settings.ts`) is applied *first*. The
 *     vendored resolver's config override sits below `if (!BUNDLED_IS_BINARY)
 *     return undefined;` (`binary-resolver.ts:162`), so in dev mode — the mode
 *     this repo runs in — routing the user's override through it would produce a
 *     Settings control that silently does nothing.
 *  2. A final PATH scan for the registry's `claude-code` candidates. The vendored
 *     resolver can return `undefined` and let the Claude Agent SDK find its own
 *     bundled binary; a host that must `spawn()` has no such fallback.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  DagFusionDelegationReceipt,
  DelegateDagFusionNodeOptions,
  OwnedDelegationRequest,
} from "../../pi-packages/dag-fusion-drive/index.ts";
import { lookPath } from "../binaries.ts";
import type * as WorkflowDelegationSession from "../agent/workflow-delegation-session.ts";
import {
  WorkflowHarnessDispatchError,
  workflowHarnessDefinition,
  type WorkflowHarnessAdapterSelection,
} from "./harness-registry.ts";
import {
  readWorkflowHarnessSettings,
  type ClaudeCodeHarnessSettings,
} from "./harness-settings.ts";

/**
 * The node-control envelope marker. Declared here rather than imported as a
 * value: `workflow-delegation-session.ts` reaches this module through the
 * dispatch seam, and a value import would close that into a module cycle. The
 * type annotation is the guard — it is the exported constant's literal type, so
 * changing the marker there fails this file at compile time.
 */
const WORKFLOW_NODE_CONTROL_ENVELOPE_PREFIX:
  typeof WorkflowDelegationSession.WORKFLOW_NODE_CONTROL_ENVELOPE_PREFIX =
    "KADY_NODE_CONTROL_V1:";

/** Mirrors `binary-resolver.ts` `CLAUDE_BIN_PATH_ENV_VAR`; pinned by the parity test. */
export const CLAUDE_BIN_PATH_ENV_VAR = "CLAUDE_BIN_PATH";
/** Mirrors `binary-resolver.ts` `CLAUDE_BINARY_NAME`; pinned by the parity test. */
export const CLAUDE_BINARY_NAME =
  process.platform === "win32" ? "claude.exe" : "claude";
/** Mirrors `binary-resolver.ts` `claudeNativeInstallerPath()`; pinned by the parity test. */
export function claudeNativeInstallerPath(): string {
  return path.join(os.homedir(), ".local", "bin", CLAUDE_BINARY_NAME);
}

export type ClaudeCodeBinarySource =
  | "override"
  | "env"
  | "native-installer"
  | "path";

export type ClaudeCodeBinaryResolution =
  | {
    state: "resolved";
    /** Absolute path. Server-side only: never put this in an error body. */
    binaryPath: string;
    source: ClaudeCodeBinarySource;
  }
  | { state: "not-found"; detail: string }
  | {
    state: "rejected";
    source: ClaudeCodeBinarySource;
    /** Safe to render: it quotes the path the *user* supplied (#71). */
    detail: string;
  };

export interface ResolveClaudeCodeBinaryOptions {
  settings?: ClaudeCodeHarnessSettings;
  env?: NodeJS.ProcessEnv;
  findExecutable?(command: string): string | null;
  /** Injected for tests; production uses `fs.statSync` semantics. */
  classifyPath?(candidate: string): "file" | "directory" | "missing";
}

/** The vendored `pathKind` semantics: a directory is not spawnable. */
function classifyPathDefault(candidate: string): "file" | "directory" | "missing" {
  try {
    const stat = fs.statSync(candidate);
    if (stat.isFile()) return "file";
    if (stat.isDirectory()) return "directory";
    return "missing";
  } catch {
    return "missing";
  }
}

/**
 * The vendored `validateAndExpand` semantics: a directory containing the binary
 * expands to the contained executable, anything else is a legible rejection.
 */
function expandUserSuppliedPath(
  rawPath: string,
  classify: (candidate: string) => "file" | "directory" | "missing",
): { ok: true; binaryPath: string } | { ok: false; detail: string } {
  const kind = classify(rawPath);
  if (kind === "file") return { ok: true, binaryPath: rawPath };
  if (kind === "directory") {
    const contained = path.join(rawPath, CLAUDE_BINARY_NAME);
    if (classify(contained) === "file") return { ok: true, binaryPath: contained };
    return {
      ok: false,
      detail:
        `"${rawPath}" is a directory and does not contain ${CLAUDE_BINARY_NAME}. Point this setting at the Claude Code executable itself.`,
    };
  }
  return {
    ok: false,
    detail:
      `"${rawPath}" is not an executable file. Point this setting at the Claude Code executable itself, or clear it to resolve automatically.`,
  };
}

const NOT_FOUND_DETAIL =
  "Claude Code was not found. Install it (curl -fsSL https://claude.ai/install.sh | bash), or set the Claude Code path in Settings.";

/**
 * Resolve the Claude Code executable. Order: persisted override → the
 * `CLAUDE_BIN_PATH` environment variable → the canonical native-installer
 * location → a PATH scan of the registry's candidates. Fails closed: an
 * override that does not resolve is `rejected` and never falls through to a
 * different binary, because silently running something the user did not select
 * is worse than saying no.
 */
export function resolveClaudeCodeBinary(
  options: ResolveClaudeCodeBinaryOptions = {},
): ClaudeCodeBinaryResolution {
  const settings = options.settings ?? readWorkflowHarnessSettings().claudeCode;
  const env = options.env ?? process.env;
  const classify = options.classifyPath ?? classifyPathDefault;
  const findExecutable = options.findExecutable ?? lookPath;

  const override = settings.binaryPath?.trim();
  if (override) {
    const expanded = expandUserSuppliedPath(override, classify);
    return expanded.ok
      ? { state: "resolved", binaryPath: expanded.binaryPath, source: "override" }
      : { state: "rejected", source: "override", detail: expanded.detail };
  }

  const fromEnvironment = env[CLAUDE_BIN_PATH_ENV_VAR]?.trim();
  if (fromEnvironment) {
    const expanded = expandUserSuppliedPath(fromEnvironment, classify);
    return expanded.ok
      ? { state: "resolved", binaryPath: expanded.binaryPath, source: "env" }
      : { state: "rejected", source: "env", detail: expanded.detail };
  }

  const nativeInstaller = claudeNativeInstallerPath();
  if (classify(nativeInstaller) === "file") {
    return { state: "resolved", binaryPath: nativeInstaller, source: "native-installer" };
  }

  for (const command of workflowHarnessDefinition("claude-code").executables) {
    const found = findExecutable(command);
    if (found) return { state: "resolved", binaryPath: found, source: "path" };
  }
  return { state: "not-found", detail: NOT_FOUND_DETAIL };
}

/**
 * Discovery answer for the registry's `resolveManagedExecutable` hook. Returns
 * the *command name*, never the path — the selection is receipted and logged.
 */
export function claudeCodeManagedExecutable(
  options: ResolveClaudeCodeBinaryOptions = {},
): string | null {
  const resolution = resolveClaudeCodeBinary(options);
  return resolution.state === "resolved" ? CLAUDE_BINARY_NAME : null;
}

/** Everything the relay handed to the operating system, for receipts and tests. */
export interface ClaudeCodeRelayInvocation {
  readonly adapter: "claude-code-relay";
  readonly binaryPath: string;
  readonly binarySource: ClaudeCodeBinarySource;
  readonly argv: readonly string[];
  readonly stdin: string;
  readonly systemPrompt: string | undefined;
  /** sha256 over binary path + argv + system prompt: pathless proof of the launch. */
  readonly launchContractDigest: string;
  readonly requestId: string;
}

export interface ClaudeCodeProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunClaudeCodeProcessInput {
  binaryPath: string;
  argv: readonly string[];
  stdin: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export type RunClaudeCodeProcess = (
  input: RunClaudeCodeProcessInput,
) => Promise<ClaudeCodeProcessResult>;

const defaultRunClaudeCodeProcess: RunClaudeCodeProcess = (input) =>
  new Promise<ClaudeCodeProcessResult>((resolve, reject) => {
    const child = spawn(input.binaryPath, [...input.argv], {
      cwd: input.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      // The relayed child is a CLI, not a shell: no shell interpolation of the
      // prompt, ever. The prompt travels on stdin for the same reason.
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, input.timeoutMs);
    const onAbort = (): void => {
      child.kill("SIGKILL");
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin.end(input.stdin, "utf8");
  });

/**
 * The `KADY_NODE_CONTROL_V1:` envelope the executor prefixes onto the task is a
 * *Pi extension* protocol (`workflow-delegation-session.ts`). Claude Code has no
 * such extension, so the relay decodes it, keeps it out of the prompt, and uses
 * it to decide honestly whether this node's bindings can be honoured at all.
 */
interface DecodedNodeControl {
  harness?: unknown;
  providerRequest?: {
    temperature?: unknown;
    top_p?: unknown;
    sampling?: Record<string, unknown>;
  };
}

export interface StrippedRelayTask {
  prompt: string;
  nodeControl: DecodedNodeControl | undefined;
}

export function stripNodeControlEnvelope(task: string): StrippedRelayTask {
  if (!task.startsWith(WORKFLOW_NODE_CONTROL_ENVELOPE_PREFIX)) {
    return { prompt: task, nodeControl: undefined };
  }
  const newline = task.indexOf("\n");
  const encoded = task.slice(
    WORKFLOW_NODE_CONTROL_ENVELOPE_PREFIX.length,
    newline === -1 ? undefined : newline,
  );
  const prompt = newline === -1 ? "" : task.slice(newline + 1).replace(/^\n+/, "");
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    );
    if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
      return { prompt, nodeControl: decoded as DecodedNodeControl };
    }
  } catch {
    // A malformed envelope is not a reason to leak base64 into a model prompt.
  }
  return { prompt, nodeControl: undefined };
}

/** NodeSpec v1 defaults; a value away from these is a user choice, not a default. */
const NODE_SPEC_DEFAULT_TEMPERATURE = 1;
const NODE_SPEC_DEFAULT_TOP_P = 1;

/**
 * `claude -p` has no sampling flags. Dropping `temperature`/`top_p`/`sampling`
 * here would be defect #54 one harness over, so a node that declares them and
 * selects this harness is refused before the process is spawned.
 */
export function unbindableClaudeCodeControls(
  nodeControl: DecodedNodeControl | undefined,
): string[] {
  const providerRequest = nodeControl?.providerRequest;
  if (!providerRequest) return [];
  const unbindable: string[] = [];
  if (
    typeof providerRequest.temperature === "number" &&
    providerRequest.temperature !== NODE_SPEC_DEFAULT_TEMPERATURE
  ) {
    unbindable.push("hyperparameters.temperature");
  }
  if (
    typeof providerRequest.top_p === "number" &&
    providerRequest.top_p !== NODE_SPEC_DEFAULT_TOP_P
  ) {
    unbindable.push("hyperparameters.top_p");
  }
  for (const key of Object.keys(providerRequest.sampling ?? {})) {
    unbindable.push(`hyperparameters.sampling.${key}`);
  }
  return unbindable;
}

export interface BuildClaudeCodeInvocationInput {
  request: Pick<OwnedDelegationRequest, "requestId" | "task" | "model">;
  binaryPath: string;
  binarySource: ClaudeCodeBinarySource;
  systemPrompt: string | undefined;
  structuredOutput: boolean;
}

/**
 * Build the exact argv and stdin the relay will hand to the binary. Pure and
 * exported so a test can assert on the invocation without spawning anything —
 * which is what "the system-prompt override reaches the invoked binary" means
 * as a checkable claim.
 */
export function buildClaudeCodeInvocation(
  input: BuildClaudeCodeInvocationInput,
): ClaudeCodeRelayInvocation {
  const { prompt } = stripNodeControlEnvelope(input.request.task);
  const argv: string[] = ["-p", "--output-format", "json"];
  if (input.request.model) argv.push("--model", input.request.model);
  if (input.systemPrompt) argv.push("--system-prompt", input.systemPrompt);
  const launchContractDigest = crypto
    .createHash("sha256")
    .update(
      JSON.stringify([input.binaryPath, argv, input.systemPrompt ?? null]),
      "utf8",
    )
    .digest("hex");
  return {
    adapter: "claude-code-relay",
    binaryPath: input.binaryPath,
    binarySource: input.binarySource,
    argv,
    stdin: input.structuredOutput
      ? `${prompt}\n\nRespond with a single JSON object and nothing else.`
      : prompt,
    systemPrompt: input.systemPrompt,
    launchContractDigest,
    requestId: input.request.requestId,
  };
}

function parseClaudePrintPayload(stdout: string): {
  text: string;
  usage: { input: number; output: number; cost: number; turns: number };
} {
  const fallback = {
    text: stdout.trim(),
    usage: { input: 0, output: 0, cost: 0, turns: 1 },
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return fallback;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fallback;
  const payload = parsed as {
    result?: unknown;
    total_cost_usd?: unknown;
    num_turns?: unknown;
    usage?: { input_tokens?: unknown; output_tokens?: unknown };
  };
  const numeric = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  return {
    text: typeof payload.result === "string" ? payload.result : stdout.trim(),
    usage: {
      input: numeric(payload.usage?.input_tokens),
      output: numeric(payload.usage?.output_tokens),
      cost: numeric(payload.total_cost_usd),
      turns: Math.max(1, numeric(payload.num_turns)),
    },
  };
}

/** Structured requests get JSON or an explicit `structured_output_failed`. */
function parseStructuredValue(text: string): unknown | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

export interface ClaudeCodeRelayHostOptions {
  selection: WorkflowHarnessAdapterSelection;
  resolution: Extract<ClaudeCodeBinaryResolution, { state: "resolved" }>;
  systemPrompt: string | undefined;
  runProcess?: RunClaudeCodeProcess;
}

export interface ClaudeCodeRelaySession {
  readonly harnessSelection: WorkflowHarnessAdapterSelection;
  readonly host: {
    delegate(
      request: OwnedDelegationRequest,
      options: DelegateDagFusionNodeOptions,
    ): Promise<DagFusionDelegationReceipt>;
  };
  /** Every invocation this session built, newest last. The run's relay receipt. */
  readonly invocations: readonly ClaudeCodeRelayInvocation[];
}

/**
 * Build the relay session. The caller has already made the dispatch decision;
 * this only turns the selected adapter into a delegation host.
 */
export function createClaudeCodeRelaySession(
  options: ClaudeCodeRelayHostOptions,
): ClaudeCodeRelaySession {
  const runProcess = options.runProcess ?? defaultRunClaudeCodeProcess;
  const invocations: ClaudeCodeRelayInvocation[] = [];

  const delegate = async (
    request: OwnedDelegationRequest,
    delegateOptions: DelegateDagFusionNodeOptions,
  ): Promise<DagFusionDelegationReceipt> => {
    const identity = {
      requestId: request.requestId,
      ownerRunId: request.ownerRunId,
      nodeId: request.nodeId,
    };
    const started = Date.now();
    const { nodeControl } = stripNodeControlEnvelope(request.task);
    const unbindable = unbindableClaudeCodeControls(nodeControl);
    if (unbindable.length > 0) {
      // Fail before spawning, and before any usage is reported: a control the
      // harness cannot express is refused, not dropped (#54's defect class).
      await delegateOptions.reconcileUsage({
        identity,
        reason: "protocol-error",
        progress: { started: false, tokens: 0, toolCalls: 0, durationMs: 0 },
      });
      throw new WorkflowHarnessDispatchError(
        "WORKFLOW_HARNESS_NOT_BOUND",
        "claude-code",
        `The Claude Code CLI cannot apply ${unbindable.join(", ")}. Remove those node settings, or run this node on the pi harness.`,
      );
    }

    const structuredOutput = request.result?.kind === "structured";
    const invocation = buildClaudeCodeInvocation({
      request,
      binaryPath: options.resolution.binaryPath,
      binarySource: options.resolution.source,
      systemPrompt: options.systemPrompt,
      structuredOutput,
    });
    invocations.push(invocation);

    const outcome = await runProcess({
      binaryPath: invocation.binaryPath,
      argv: invocation.argv,
      stdin: invocation.stdin,
      cwd: request.cwd,
      timeoutMs: request.timeoutMs,
      signal: delegateOptions.signal,
    });
    const durationMs = Date.now() - started;
    const payload = parseClaudePrintPayload(outcome.stdout);
    const structuredValue = structuredOutput
      ? parseStructuredValue(payload.text)
      : undefined;

    const status: "completed" | "failed" | "timed_out" | "structured_output_failed" =
      outcome.timedOut
        ? "timed_out"
        : outcome.code !== 0
        ? "failed"
        : structuredOutput && structuredValue === undefined
        ? "structured_output_failed"
        : "completed";

    const usage = {
      input: payload.usage.input,
      output: payload.usage.output,
      cacheRead: 0,
      cacheWrite: 0,
      cost: payload.usage.cost,
      turns: payload.usage.turns,
      toolCalls: 0,
      durationMs,
    };
    const progress = {
      started: true,
      model: request.model,
      tokens: usage.input + usage.output,
      toolCalls: 0,
      durationMs,
    };
    await delegateOptions.reconcileUsage({
      identity,
      reason: "terminal-response",
      responseStatus: status,
      usage,
      progress,
    });

    return {
      identity,
      requested: {
        agent: request.agent,
        model: request.model,
        thinking: request.thinking,
      },
      resolved: {
        // The relay path taken, recorded on the receipt. The resolved binary is
        // proved by the digest rather than by the path, which must not travel to
        // anything user-facing (#71).
        agent: "claude-code-relay",
        model: request.model,
        thinking: request.thinking,
        launchContractDigest: invocation.launchContractDigest,
      },
      response: {
        ...identity,
        status,
        runId: `claude-code-relay:${request.requestId}`,
        agent: "claude-code-relay",
        model: request.model,
        thinking: request.thinking,
        launchContractDigest: invocation.launchContractDigest,
        ...(status === "completed" || status === "structured_output_failed"
          ? {
            result: structuredOutput
              ? { kind: "structured" as const, value: structuredValue ?? null }
              : { kind: "text" as const, text: payload.text },
          }
          : {}),
        ...(status === "completed"
          ? {}
          : {
            error: outcome.timedOut
              ? "The Claude Code CLI did not finish within the node deadline."
              : outcome.code !== 0
              ? `The Claude Code CLI exited with status ${String(outcome.code)}.`
              : "The Claude Code CLI did not return a single JSON object.",
          }),
        usage,
      },
      usage: { ...usage, totalTokens: usage.input + usage.output },
      progress,
    } as unknown as DagFusionDelegationReceipt;
  };

  return {
    harnessSelection: options.selection,
    host: { delegate },
    invocations,
  };
}

export interface OpenClaudeCodeRelayOptions {
  selection: WorkflowHarnessAdapterSelection;
  settings?: ClaudeCodeHarnessSettings;
  runProcess?: RunClaudeCodeProcess;
  resolve?: typeof resolveClaudeCodeBinary;
}

/**
 * The seam both transports call once the registry has selected this adapter.
 * Fails closed with the dispatch diagnostic when the binary does not resolve —
 * an unresolvable default is an honest "not found", never a silent fallback.
 */
export function openClaudeCodeRelay(
  options: OpenClaudeCodeRelayOptions,
): ClaudeCodeRelaySession {
  const settings = options.settings ?? readWorkflowHarnessSettings().claudeCode;
  const resolution = (options.resolve ?? resolveClaudeCodeBinary)({ settings });
  if (resolution.state !== "resolved") {
    throw new WorkflowHarnessDispatchError(
      resolution.state === "not-found"
        ? "WORKFLOW_HARNESS_NOT_INSTALLED"
        : "WORKFLOW_HARNESS_NOT_BOUND",
      "claude-code",
      resolution.detail,
    );
  }
  return createClaudeCodeRelaySession({
    selection: options.selection,
    resolution,
    systemPrompt: settings.systemPrompt,
    runProcess: options.runProcess,
  });
}
