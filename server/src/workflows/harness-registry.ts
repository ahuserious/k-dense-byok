/**
 * The harness registry — one table, not scattered conditionals.
 *
 * Before this file the harness literal set was spelled five times in `server/`
 * (`schema.ts` TypeBox union, `supervisor/protocol.ts` wire tuple,
 * `agent/workflow-delegation-session.ts` TS union + `HARNESS_EXECUTABLES`, and
 * `validate.ts`'s `ResolvedNodeSpecV1.harness`), which is the defect class the
 * NodeSpec v1 freeze exists to prevent, one file over. Every one of those is now
 * a derivation of `WORKFLOW_HARNESS_REGISTRY`: **adding a harness is one row.**
 *
 * The module is deliberately pure — no `node:fs`, no `node:child_process`, no
 * imports from `agent/` or `supervisor/`. The wire codec loads it, the TypeBox
 * schema type-checks against it, and the executor's dispatch seam calls into it,
 * so anything heavier here would leak into all three. Executable discovery is
 * injected (`findExecutable`); binary resolution for `claude-code` lives in
 * `claude-code-relay.ts`, which is where the filesystem belongs.
 */

/** Every harness literal in the frozen `HarnessSchema` union, in contract order. */
export const WORKFLOW_HARNESS_IDS = [
  "pi",
  "claude-code",
  "codex",
  "opencode",
  "copilot",
  "deepseek",
  "grok-cli",
  "oh-my-pi",
] as const;

export type WorkflowHarnessId = (typeof WORKFLOW_HARNESS_IDS)[number];

/**
 * Which trusted runtime a harness selects. `undefined` is an honest state, not
 * a placeholder: the literal is authorised by the contract, reaches the dispatch
 * decision, and fails closed there with a diagnostic that names the next action.
 */
export type WorkflowHarnessAdapterKind = "pi-delegation" | "claude-code-relay";

export interface WorkflowHarnessDefinition {
  /** The frozen contract literal. */
  readonly id: WorkflowHarnessId;
  /** Human label; the Settings picker renders this, never the raw id. */
  readonly label: string;
  /**
   * Candidate command names probed on PATH, most specific first. A harness with
   * an adapter still lists them so "installed?" is answerable for the picker.
   */
  readonly executables: readonly string[];
  /** The runtime this harness selects, or `undefined` when none is bound yet. */
  readonly adapter: WorkflowHarnessAdapterKind | undefined;
  /** One sentence the endpoint hands to the web layer; no filesystem paths. */
  readonly summary: string;
  /**
   * `true` only for harnesses whose resolved binary path is a user-visible,
   * user-overridable setting. Today that is `claude-code` alone (matrix row 7).
   */
  readonly exposesBinaryPath: boolean;
}

/**
 * THE table. Executable candidate names and the reasoning behind each pick are
 * recorded in `docs/harnesses.md`; a wrong guess is one string here, and the
 * fail-closed message names the candidates so the user can see the guess.
 */
export const WORKFLOW_HARNESS_REGISTRY: readonly WorkflowHarnessDefinition[] = [
  {
    id: "pi",
    label: "Pi (built in)",
    executables: ["pi"],
    adapter: "pi-delegation",
    summary:
      "The vendored pi-subagents delegation runtime. The default, and the only harness the node-control envelope targets.",
    exposesBinaryPath: false,
  },
  {
    id: "claude-code",
    label: "Claude Code CLI",
    executables: ["claude"],
    adapter: "claude-code-relay",
    summary:
      "The Claude Code CLI, invoked in print (-p) mode through the Kady relay. Its binary path is resolved from the same sources the vendored engine uses and can be overridden here.",
    exposesBinaryPath: true,
  },
  {
    id: "codex",
    label: "Codex CLI",
    executables: ["codex"],
    adapter: undefined,
    summary: "The Codex CLI. No trusted delegation adapter in this build yet.",
    exposesBinaryPath: false,
  },
  {
    id: "opencode",
    label: "OpenCode CLI",
    executables: ["opencode"],
    adapter: undefined,
    summary: "The OpenCode CLI. No trusted delegation adapter in this build yet.",
    exposesBinaryPath: false,
  },
  {
    id: "copilot",
    label: "GitHub Copilot CLI",
    executables: ["github-copilot", "copilot"],
    adapter: undefined,
    summary:
      "The GitHub Copilot CLI. No trusted delegation adapter in this build yet.",
    exposesBinaryPath: false,
  },
  {
    id: "deepseek",
    label: "DeepSeek CLI",
    executables: ["deepseek", "deepseek-cli"],
    adapter: undefined,
    summary: "The DeepSeek CLI. No trusted delegation adapter in this build yet.",
    exposesBinaryPath: false,
  },
  {
    id: "grok-cli",
    label: "Grok CLI",
    executables: ["grok", "grok-cli"],
    adapter: undefined,
    summary: "The Grok CLI. No trusted delegation adapter in this build yet.",
    exposesBinaryPath: false,
  },
  {
    id: "oh-my-pi",
    label: "oh-my-pi",
    executables: ["oh-my-pi", "ohmypi"],
    adapter: undefined,
    summary: "The oh-my-pi harness. No trusted delegation adapter in this build yet.",
    exposesBinaryPath: false,
  },
];

const REGISTRY_BY_ID = new Map<WorkflowHarnessId, WorkflowHarnessDefinition>(
  WORKFLOW_HARNESS_REGISTRY.map((definition) => [definition.id, definition]),
);

// A row missing from the table would otherwise surface as a runtime `undefined`
// at the dispatch seam. Fail at import instead: the table is the contract.
for (const id of WORKFLOW_HARNESS_IDS) {
  if (!REGISTRY_BY_ID.has(id)) {
    throw new Error(`Workflow harness registry is missing a row for "${id}".`);
  }
}

export function isWorkflowHarnessId(value: unknown): value is WorkflowHarnessId {
  return typeof value === "string" &&
    REGISTRY_BY_ID.has(value as WorkflowHarnessId);
}

export function workflowHarnessDefinition(
  harness: WorkflowHarnessId,
): WorkflowHarnessDefinition {
  const definition = REGISTRY_BY_ID.get(harness);
  if (!definition) {
    throw new Error(`Unknown workflow harness "${String(harness)}".`);
  }
  return definition;
}

/** Derived so `HARNESS_EXECUTABLES` cannot drift from the table. */
export function workflowHarnessExecutables(
  harness: WorkflowHarnessId,
): readonly string[] {
  return workflowHarnessDefinition(harness).executables;
}

export type WorkflowHarnessDispatchErrorCode =
  | "WORKFLOW_HARNESS_NOT_INSTALLED"
  | "WORKFLOW_HARNESS_NOT_BOUND";

/**
 * The dispatch diagnostic. Its message names the user's next action and never
 * contains a filesystem path (#71): the *fact* that a candidate resolved is
 * reported, the path it resolved to is not, because this text reaches HTTP
 * bodies and run receipts the user did not supply the path to.
 */
export class WorkflowHarnessDispatchError extends Error {
  constructor(
    readonly code: WorkflowHarnessDispatchErrorCode,
    readonly harness: WorkflowHarnessId,
    message: string,
  ) {
    super(message);
    this.name = "WorkflowHarnessDispatchError";
  }
}

/**
 * The observable result of the dispatch decision. Returning this — rather than
 * only throwing — is what makes the seam assertable: a caller can prove *which*
 * adapter the registry selected, which is the bar the NodeSpec contract sets for
 * `harness` reaching BOUND ("a server test asserts on which adapter the dispatch
 * selected", condition 2).
 */
export interface WorkflowHarnessAdapterSelection {
  readonly harness: WorkflowHarnessId;
  readonly label: string;
  readonly adapter: WorkflowHarnessAdapterKind;
  /**
   * The command name that satisfied discovery, never an absolute path — the
   * selection is logged and receipted, and #71 forbids leaking paths there.
   */
  readonly executable: string | undefined;
}

export interface SelectWorkflowHarnessAdapterOptions {
  /** Injected PATH scan; `workflow-delegation-session.ts` supplies `lookPath`. */
  findExecutable(command: string): string | null;
  /**
   * Discovery for harnesses whose binary is *not* found on PATH alone. Claude
   * Code is the case that exists: the native installer writes to `~/.local/bin`,
   * which is frequently absent from a service's PATH, and a user override is
   * honoured ahead of both. Returns the command name that satisfied discovery —
   * never the path, which must not enter the selection (#71). `null` means the
   * harness is genuinely not installed.
   */
  resolveManagedExecutable?(
    definition: WorkflowHarnessDefinition,
  ): string | null;
}

/**
 * The harness → adapter decision, with no knowledge of which transport owns the
 * resulting session. Both transports call it before the node executor reserves
 * any budget: the in-process executor through `dispatchWorkflowHarness`, and the
 * supervised transport through its own `getDelegationSession` override.
 *
 * A harness with an adapter returns a selection naming it. A harness without one
 * throws — `WORKFLOW_HARNESS_NOT_INSTALLED` when no candidate command exists on
 * this machine, `WORKFLOW_HARNESS_NOT_BOUND` when one does but this build has no
 * trusted adapter for it — so installing a CLI changes the message but cannot
 * accidentally grant it workflow authority.
 */
export function selectWorkflowHarnessAdapter(
  harness: WorkflowHarnessId,
  options: SelectWorkflowHarnessAdapterOptions,
): WorkflowHarnessAdapterSelection {
  const definition = workflowHarnessDefinition(harness);
  if (definition.adapter === "pi-delegation") {
    // Pi is bundled with the server; probing PATH for it would make a working
    // default depend on the user's shell.
    return {
      harness,
      label: definition.label,
      adapter: definition.adapter,
      executable: undefined,
    };
  }

  let installed: { command: string } | undefined;
  if (definition.exposesBinaryPath && options.resolveManagedExecutable) {
    const managed = options.resolveManagedExecutable(definition);
    if (managed !== null) installed = { command: managed };
  } else {
    for (const command of definition.executables) {
      if (options.findExecutable(command) !== null) {
        installed = { command };
        break;
      }
    }
  }

  if (!installed) {
    throw new WorkflowHarnessDispatchError(
      "WORKFLOW_HARNESS_NOT_INSTALLED",
      harness,
      `Workflow harness ${harness} is not installed. Install one of: ${definition.executables.join(", ")}.`,
    );
  }
  if (!definition.adapter) {
    throw new WorkflowHarnessDispatchError(
      "WORKFLOW_HARNESS_NOT_BOUND",
      harness,
      `Workflow harness ${harness} is installed as ${installed.command}, but this Kady build has no trusted delegation adapter for it. Select a harness with an adapter, or keep the node on pi.`,
    );
  }
  return {
    harness,
    label: definition.label,
    adapter: definition.adapter,
    executable: installed.command,
  };
}
