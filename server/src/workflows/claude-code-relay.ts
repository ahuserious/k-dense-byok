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
 *
 * **A relayed node leaves the supervised transport.** When the registry selects
 * this adapter, `supervisor/client.ts` returns a host that spawns the CLI *in
 * the backend process* instead of routing through `this.delegate(...)` to the
 * supervisor. The out-of-process isolation that is the supervised transport's
 * reason to exist does not apply to a relayed child, and
 * `delegateOptions.supervisedBudget` (`kady-node-executor.ts:1966-1968`) is not
 * read here, so the supervisor-side budget descriptor never sees a relayed run.
 * That is deliberate — the CLI is host-owned and there is no supervisor-side
 * process to own it — but it is a material property Teams A and C would
 * otherwise assume the other way, so it is stated here, in `docs/harnesses.md`
 * and in the interface file, and published as an `unboundControls` entry.
 *
 * **The node's bindings are honoured or the node is refused.** The tool policy
 * becomes real `--allowedTools` / `--disallowedTools` / `--permission-mode`
 * argv, the turn budget becomes `--max-turns`, the structured-output schema
 * travels on stdin, and the model reference is validated before it becomes
 * `--model`. Anything left — sampling, subagents, named skills, a non-Anthropic
 * model — fails the node before `spawn`. Dropping a binding silently would be
 * defect #54 one harness over, and for the tool policy it would also be a
 * security-relevant drop.
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
  /**
   * The JSON Schema the node's slot demands, as sent to the child, or
   * `undefined` for a text result. The executor builds every delegation as
   * `result: { kind: "structured", schema }` (`kady-node-executor.ts:1905`) and
   * `validateTerminalStructured` then fails the node unless the receipt carries
   * a structured value, so a relay that did not send the schema could not
   * satisfy the contract it is measured against.
   */
  readonly structuredSchema: unknown | undefined;
  /** Controls that reached the relay and that the CLI cannot express (see above). */
  readonly unboundControls: readonly string[];
  /**
   * sha256 over binary path + cwd + argv + system prompt + stdin — the launch
   * contract handed to the operating system, while carrying no filesystem path
   * into the receipt (#71).
   */
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
  /** `resolveS4NodeExecutionBindings` (`kady-node-executor.ts:337-340`). */
  toolPolicy?: { allowedTools?: unknown };
  subagents?: { mode?: unknown; permitted?: unknown };
  autonomy?: unknown;
  skills?: { mode?: unknown; configured?: unknown; delegated?: unknown };
  billingMode?: unknown;
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

/**
 * Kady tool-policy id → the Claude Code CLI tool names that express it.
 *
 * `resolveS4NodeExecutionBindings` builds `toolPolicy.allowedTools` out of Pi's
 * tool vocabulary (`kady-node-executor.ts:337-340`) and the trusted Pi child
 * enforces it with `pi.setActiveTools` (`workflow-delegation-session.ts:527-529`).
 * The relay has to enforce the *same* policy with the CLI's own vocabulary, or
 * `autonomy` — which NodeSpec v1 calls "the child tool/subagent access gate" —
 * is false for this harness. A `null` entry means no faithful translation
 * exists, and a node that asks for it is refused rather than quietly granted
 * something wider.
 *
 * `subagent` is deliberately `null`. The CLI's nearest equivalent is `Task`, and
 * a Task child is not itself constrained by this allowlist, so translating it
 * would grant strictly more than the node declared — the exact failure the
 * allowlist exists to prevent.
 */
export const CLAUDE_CODE_TOOL_TRANSLATION: Readonly<
  Record<string, readonly string[] | null>
> = {
  read: ["Read"],
  grep: ["Grep"],
  // The CLI has no separate directory-listing tool; Glob is the read-only
  // path-enumeration tool that `find` and `ls` both map onto.
  find: ["Glob"],
  ls: ["Glob"],
  subagent: null,
};

/**
 * Named on `--disallowedTools` on every relayed launch, whatever the allowlist
 * says. `--allowedTools` plus `--permission-mode default` already denies these
 * (an unlisted tool needs an interactive approval that `-p` cannot obtain), so
 * this is the second lock, not the first: if a future CLI changes the default
 * for unlisted tools, a relayed node must still not be able to write, execute
 * or reach the network.
 */
export const CLAUDE_CODE_DENIED_TOOLS = [
  "Bash",
  "BashOutput",
  "KillShell",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Task",
  "WebFetch",
  "WebSearch",
] as const;

/**
 * Not `bypassPermissions`, and not `acceptEdits`. In `-p` mode an approval
 * prompt cannot be answered, so `default` means "anything outside
 * `--allowedTools` fails" — fail-closed by construction.
 */
export const CLAUDE_CODE_PERMISSION_MODE = "default";

/**
 * Controls that reach the relay and that the CLI has no way to express. They are
 * NOT dropped silently: they are reported here, carried on every invocation, and
 * published on `GET /harnesses` so lane F8 and lane F1 render the corresponding
 * control disabled with this reason rather than live over a value nothing reads.
 */
export const CLAUDE_CODE_UNBOUND_CONTROLS: readonly {
  readonly control: string;
  readonly reason: string;
}[] = [
  {
    control: "toolBudget",
    reason:
      "The Claude Code CLI counts turns, not tool calls, so the node's soft/hard tool-call budget cannot be enforced on a relayed run. --max-turns bounds the loop and the read-only allowlist bounds what a turn can do.",
  },
  {
    control: "billingMode",
    reason:
      "A relayed run is billed to the credentials the local Claude Code binary holds, not to the Kady provider the node's billingMode was admitted against.",
  },
  {
    control: "supervisedBudget",
    reason:
      "A relayed run leaves the supervised transport: the CLI is spawned in the backend process, so the supervisor-side budget descriptor never sees it.",
  },
];

export type ClaudeCodeToolPolicyTranslation =
  | { ok: true; allowed: readonly string[] }
  | { ok: false; unbindable: readonly string[] };

/**
 * Translate the node's allowlist, or say which entries cannot be translated.
 * An id absent from the table is refused too: a tool added to Pi's vocabulary
 * later must fail this build rather than silently vanish from the relayed
 * child's policy.
 */
export function translateClaudeCodeToolPolicy(
  allowedTools: readonly string[],
): ClaudeCodeToolPolicyTranslation {
  const allowed = new Set<string>();
  const unbindable: string[] = [];
  for (const tool of allowedTools) {
    const translated = CLAUDE_CODE_TOOL_TRANSLATION[tool];
    if (!translated) {
      unbindable.push(tool);
      continue;
    }
    for (const name of translated) allowed.add(name);
  }
  if (unbindable.length > 0) return { ok: false, unbindable };
  return { ok: true, allowed: [...allowed] };
}

export const CLAUDE_CODE_MODEL_PROVIDER = "anthropic";

export type ClaudeCodeModelArgument =
  | { ok: true; model: string | undefined }
  | { ok: false; detail: string };

/**
 * `request.model` is `modelReference(resolution.model)`, i.e.
 * `` `${provider}/${id}` `` (`agent/models.ts:387-391`) — `openrouter/anthropic/
 * claude-sonnet-4`, `openai/gpt-5`, `openrouter/fusion`. `claude --model` takes
 * an Anthropic alias or model id, so handing it a provider-qualified slug either
 * errors or runs on a *different* model than the run receipted.
 *
 * Only `anthropic/<id>` translates. Everything else is refused with the same
 * fail-closed diagnostic sampling gets: rewriting `openrouter/anthropic/...` to
 * the bare Anthropic id would silently move the call — and the bill — to another
 * provider than the one the node resolved and the receipt records.
 */
export function claudeCodeModelArgument(
  reference: string | undefined,
): ClaudeCodeModelArgument {
  const raw = reference?.trim();
  // No model on the request is not a node declaration; the CLI picks its own.
  if (!raw) return { ok: true, model: undefined };
  const separator = raw.indexOf("/");
  const provider = separator > 0 ? raw.slice(0, separator) : "";
  const id = separator > 0 ? raw.slice(separator + 1) : "";
  if (provider !== CLAUDE_CODE_MODEL_PROVIDER || id.length === 0) {
    return {
      ok: false,
      detail:
        `resolved the model ${raw}, which the Claude Code CLI cannot run: it accepts Anthropic model ids only, and relaying a ${provider || "provider-less"} model reference would run the node somewhere other than the run receipt says`,
    };
  }
  return { ok: true, model: id };
}

/** One control the relay refuses, and the sentence that names the next action. */
export interface ClaudeCodeBindingRefusal {
  readonly control: string;
  readonly detail: string;
}

export interface ClaudeCodeBindingRefusalInput {
  readonly request: Pick<OwnedDelegationRequest, "model" | "skill">;
  readonly nodeControl: DecodedNodeControl | undefined;
}

function requestsDelegatedSkills(
  skill: OwnedDelegationRequest["skill"],
): boolean {
  if (skill === true) return true;
  if (typeof skill === "string") return skill.trim().length > 0;
  return Array.isArray(skill) && skill.length > 0;
}

/**
 * Every node binding the relay cannot honour, in one place.
 *
 * The principle is the one sampling already gets: a control that reaches this
 * adapter and cannot be applied fails the node before the process is spawned.
 * Dropping it silently would be defect #54 one harness over — and for the tool
 * policy and `subagents` it would also be a security-relevant drop, because
 * those are what stop a delegated child from doing more than the node declared.
 */
export function claudeCodeBindingRefusals(
  input: ClaudeCodeBindingRefusalInput,
): ClaudeCodeBindingRefusal[] {
  const refusals: ClaudeCodeBindingRefusal[] = [];
  for (const control of unbindableClaudeCodeControls(input.nodeControl)) {
    refusals.push({
      control,
      detail:
        `the Claude Code CLI has no ${control.replace("hyperparameters.", "")} flag`,
    });
  }

  const model = claudeCodeModelArgument(input.request.model);
  if (!model.ok) refusals.push({ control: "model", detail: model.detail });

  const nodeControl = input.nodeControl;
  if (!nodeControl) {
    refusals.push({
      control: "nodeControl",
      detail:
        "the trusted node-control envelope is missing or invalid, so the relay cannot prove which tool policy and bindings the node declared",
    });
  } else if (!Array.isArray(nodeControl.toolPolicy?.allowedTools)) {
    refusals.push({
      control: "autonomy/toolPolicy",
      detail:
        "the trusted node-control envelope does not contain a valid tool grant, so launching would fall back to the CLI's broader defaults",
    });
  }
  if (nodeControl) {
    const allowedTools = Array.isArray(nodeControl.toolPolicy?.allowedTools)
      ? (nodeControl.toolPolicy.allowedTools as unknown[]).filter(
        (tool): tool is string => typeof tool === "string",
      )
      : undefined;
    if (allowedTools) {
      const translated = translateClaudeCodeToolPolicy(allowedTools);
      if (!translated.ok) {
        refusals.push({
          control: "autonomy/toolPolicy",
          detail:
            `the Claude Code CLI cannot express the tool grant ${translated.unbindable.join(", ")} without granting more than the node declared`,
        });
      }
    }
    if (nodeControl.subagents?.permitted === true) {
      refusals.push({
        control: "subagents",
        detail:
          "a Claude Code subagent is not itself bound by this node's tool policy, so permitting subagents on a relayed node would grant more than the node declared",
      });
    }
    const configuredSkills = Array.isArray(nodeControl.skills?.configured)
      ? (nodeControl.skills.configured as unknown[])
      : [];
    const delegatedSkills = Array.isArray(nodeControl.skills?.delegated)
      ? (nodeControl.skills.delegated as unknown[])
      : [];
    if (
      configuredSkills.length > 0 ||
      delegatedSkills.length > 0 ||
      requestsDelegatedSkills(input.request.skill)
    ) {
      refusals.push({
        control: "skills",
        detail:
          "the relay has no way to inject the node's effective delegated skill set into the Claude Code CLI",
      });
    }
  }
  return refusals;
}

/**
 * The refusal thrown when `claudeCodeBindingRefusals` is non-empty. Shaped like
 * the registry's own dispatch diagnostic: a code, the harness, and a message
 * that names the user's next action and no filesystem path (#71).
 */
function claudeCodeBindingRefusalError(
  refusals: readonly ClaudeCodeBindingRefusal[],
): WorkflowHarnessDispatchError {
  const controls = refusals.map((refusal) => refusal.control).join(", ");
  const reasons = refusals.map((refusal) => refusal.detail).join("; ");
  return new WorkflowHarnessDispatchError(
    "WORKFLOW_HARNESS_NOT_BOUND",
    "claude-code",
    `This node cannot run on the Claude Code CLI: ${reasons}. Change ${controls} on this node, or run it on the pi harness.`,
  );
}

/** The JSON-Schema block the relayed child is told to satisfy. */
function structuredOutputInstruction(schema: unknown): string {
  return [
    "Respond with a single JSON object and nothing else.",
    "It must validate against this JSON Schema:",
    JSON.stringify(schema),
  ].join("\n");
}

export interface BuildClaudeCodeInvocationInput {
  request: Pick<
    OwnedDelegationRequest,
    "requestId" | "task" | "cwd" | "model" | "result" | "skill" | "turnBudget"
  >;
  binaryPath: string;
  binarySource: ClaudeCodeBinarySource;
  systemPrompt: string | undefined;
}

/**
 * Build the exact argv and stdin the relay will hand to the binary. Pure and
 * exported so a test can assert on the invocation without spawning anything —
 * which is what "the system-prompt override reaches the invoked binary" means
 * as a checkable claim.
 *
 * Throws `WorkflowHarnessDispatchError` when any binding the node declared
 * cannot be honoured, so there is exactly one place where a relayed node is
 * refused and it is upstream of `spawn`.
 */
export function buildClaudeCodeInvocation(
  input: BuildClaudeCodeInvocationInput,
): ClaudeCodeRelayInvocation {
  const { prompt, nodeControl } = stripNodeControlEnvelope(input.request.task);
  const refusals = claudeCodeBindingRefusals({
    request: input.request,
    nodeControl,
  });
  if (refusals.length > 0) throw claudeCodeBindingRefusalError(refusals);

  const argv: string[] = ["-p", "--output-format", "json"];
  const model = claudeCodeModelArgument(input.request.model);
  if (model.ok && model.model) argv.push("--model", model.model);
  if (input.systemPrompt) argv.push("--system-prompt", input.systemPrompt);

  // The node's tool grant, in the CLI's vocabulary. Present on every launch,
  // including the case where the node granted nothing: an empty --allowedTools
  // is the strongest policy, not the absence of one.
  const declaredTools = Array.isArray(nodeControl?.toolPolicy?.allowedTools)
    ? (nodeControl.toolPolicy.allowedTools as unknown[]).filter(
      (tool): tool is string => typeof tool === "string",
    )
    : undefined;
  if (declaredTools) {
    const translated = translateClaudeCodeToolPolicy(declaredTools);
    // Refused above; the guard is for the type, not for control flow.
    const allowed = translated.ok ? translated.allowed : [];
    argv.push("--allowedTools", allowed.join(","));
    argv.push("--disallowedTools", CLAUDE_CODE_DENIED_TOOLS.join(","));
    argv.push("--permission-mode", CLAUDE_CODE_PERMISSION_MODE);
  }

  const turnBudget = input.request.turnBudget;
  if (turnBudget && Number.isSafeInteger(turnBudget.maxTurns)) {
    const graceTurns = turnBudget.graceTurns ?? 0;
    argv.push("--max-turns", String(Math.max(1, turnBudget.maxTurns + graceTurns)));
  }

  const structuredSchema = input.request.result?.kind === "structured"
    ? input.request.result.schema
    : undefined;
  const stdin = structuredSchema === undefined
    ? prompt
    : `${prompt}\n\n${structuredOutputInstruction(structuredSchema)}`;

  // stdin is in the digest: the prompt and the schema are the only place the
  // node's actual work travels, so a digest without them is not a proof of what
  // was launched. The digest, not the path, is what reaches the receipt (#71).
  const launchContractDigest = crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        input.binaryPath,
        input.request.cwd,
        argv,
        input.systemPrompt ?? null,
        stdin,
      ]),
      "utf8",
    )
    .digest("hex");
  return {
    adapter: "claude-code-relay",
    binaryPath: input.binaryPath,
    binarySource: input.binarySource,
    argv,
    stdin,
    systemPrompt: input.systemPrompt,
    structuredSchema,
    unboundControls: CLAUDE_CODE_UNBOUND_CONTROLS.map((entry) => entry.control),
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
    let invocation: ClaudeCodeRelayInvocation;
    try {
      invocation = buildClaudeCodeInvocation({
        request,
        binaryPath: options.resolution.binaryPath,
        binarySource: options.resolution.source,
        systemPrompt: options.systemPrompt,
      });
    } catch (error) {
      // Fail before spawning, and before any usage is reported: a binding the
      // harness cannot honour is refused, not dropped (#54's defect class), and
      // the pre-reserved node budget is still settled rather than leaked.
      await delegateOptions.reconcileUsage({
        identity,
        reason: "protocol-error",
        progress: { started: false, tokens: 0, toolCalls: 0, durationMs: 0 },
      });
      throw error;
    }
    const structuredOutput = invocation.structuredSchema !== undefined;
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
