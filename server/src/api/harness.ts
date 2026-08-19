/**
 * Harness endpoints — what lane F8's "Settings ▸ Kady CLI" surface reads and
 * writes (matrix rows 7, 11, 12, 13, 15).
 *
 * `web/` is not this lane's, so this file is the whole of F2's contribution to
 * Gate U: the payload has to carry enough for F8 to render an *honest* state
 * (§6.7) without a second source of truth. That means every harness reports
 * whether an adapter exists, whether it resolves on this machine and how, and —
 * for Claude Code — the resolved path and the current override. A picker that
 * greys out a harness needs the reason, not just the boolean.
 *
 * Two defects constrain the shapes here:
 *  - **#71** — no response body ever contains a filesystem path the caller did
 *    not itself supply. `resolvedPath` is the single deliberate exception and it
 *    is a *value the user asked for*, on a 200, on a route whose entire purpose
 *    is to display it; it never appears in an error body.
 *  - **#62** — a malformed-but-200 body throws in the client's render phase. So
 *    the payload is built from validated inputs, every field is always present
 *    (`null`, never absent), and the array is never partially populated.
 */
import type { FastifyInstance } from "fastify";
import {
  WORKFLOW_HARNESS_REGISTRY,
  WorkflowHarnessDispatchError,
  selectWorkflowHarnessAdapter,
  type WorkflowHarnessId,
} from "../workflows/harness-registry.ts";
import {
  resolveClaudeCodeBinary,
  type ClaudeCodeBinaryResolution,
} from "../workflows/claude-code-relay.ts";
import {
  MAX_CLAUDE_SYSTEM_PROMPT_BYTES,
  readWorkflowHarnessSettings,
  updateClaudeCodeHarnessSettings,
} from "../workflows/harness-settings.ts";
import { lookPath } from "../binaries.ts";

/** How a harness's availability reads to the picker. */
export type HarnessAvailability =
  /** An adapter exists and the runtime resolves: selectable. */
  | "ready"
  /** An adapter exists but the binary does not resolve: disabled, with `detail`. */
  | "not-found"
  /** No adapter in this build: disabled, with `detail`. */
  | "no-adapter"
  /** The user's override does not resolve: disabled, with `detail`. */
  | "rejected";

export interface HarnessListEntry {
  id: WorkflowHarnessId;
  label: string;
  summary: string;
  /** Candidate command names; render them in the "install one of" hint. */
  executables: string[];
  adapter: string | null;
  hasAdapter: boolean;
  availability: HarnessAvailability;
  /** Command name that satisfied discovery, or null. Never a path. */
  resolvedExecutable: string | null;
  /** Present only when `availability !== "ready"`. The user's next action. */
  detail: string | null;
  /** True only for `claude-code`; F8 renders the path editor for it. */
  supportsBinaryPathOverride: boolean;
  /** Only ever non-null for a harness with `supportsBinaryPathOverride`. */
  binaryPath: HarnessBinaryPathState | null;
}

export interface HarnessBinaryPathState {
  /** Absolute path in use, or null when nothing resolves. */
  resolvedPath: string | null;
  /** Which source won: "override" | "env" | "native-installer" | "path". */
  source: string | null;
  /** The user's persisted override, echoed back verbatim, or null. */
  override: string | null;
  /** The persisted Claude system-prompt override, or null. */
  systemPrompt: string | null;
  /** Max bytes the system-prompt override accepts; F8 renders the counter. */
  systemPromptMaxBytes: number;
  state: "resolved" | "not-found" | "rejected";
  detail: string | null;
}

function claudeBinaryPathState(
  resolution: ClaudeCodeBinaryResolution,
  override: string | null,
  systemPrompt: string | null,
): HarnessBinaryPathState {
  const base = {
    override,
    systemPrompt,
    systemPromptMaxBytes: MAX_CLAUDE_SYSTEM_PROMPT_BYTES,
  };
  if (resolution.state === "resolved") {
    return {
      ...base,
      resolvedPath: resolution.binaryPath,
      source: resolution.source,
      state: "resolved",
      detail: null,
    };
  }
  return {
    ...base,
    resolvedPath: null,
    source: null,
    state: resolution.state,
    detail: resolution.detail,
  };
}

export interface HarnessListResponse {
  version: 1;
  harnesses: HarnessListEntry[];
}

export interface BuildHarnessListOptions {
  findExecutable?(command: string): string | null;
  resolveClaudeCode?: typeof resolveClaudeCodeBinary;
  readSettings?: typeof readWorkflowHarnessSettings;
}

/**
 * Pure builder, exported so a server test asserts on the payload rather than on
 * the route wiring, and so #62's "malformed but 200" can be pinned directly.
 */
export function buildHarnessList(
  options: BuildHarnessListOptions = {},
): HarnessListResponse {
  const findExecutable = options.findExecutable ?? lookPath;
  const resolveClaudeCode = options.resolveClaudeCode ?? resolveClaudeCodeBinary;
  const settings = (options.readSettings ?? readWorkflowHarnessSettings)().claudeCode;
  const claudeResolution = resolveClaudeCode({ settings, findExecutable });

  const harnesses = WORKFLOW_HARNESS_REGISTRY.map((definition): HarnessListEntry => {
    const supportsBinaryPathOverride = definition.exposesBinaryPath;
    const binaryPath = supportsBinaryPathOverride
      ? claudeBinaryPathState(
        claudeResolution,
        settings.binaryPath ?? null,
        settings.systemPrompt ?? null,
      )
      : null;

    let availability: HarnessAvailability;
    let resolvedExecutable: string | null = null;
    let detail: string | null = null;
    try {
      const selection = selectWorkflowHarnessAdapter(definition.id, {
        findExecutable,
        resolveManagedExecutable: () =>
          claudeResolution.state === "resolved" ? definition.executables[0] : null,
      });
      availability = "ready";
      resolvedExecutable = selection.executable ?? null;
      // A resolvable binary the user pointed at badly is still not ready.
      if (binaryPath && binaryPath.state !== "resolved") {
        availability = binaryPath.state === "rejected" ? "rejected" : "not-found";
        detail = binaryPath.detail;
        resolvedExecutable = null;
      }
    } catch (error) {
      if (!(error instanceof WorkflowHarnessDispatchError)) throw error;
      availability = definition.adapter
        ? binaryPath?.state === "rejected" ? "rejected" : "not-found"
        : "no-adapter";
      detail = binaryPath?.state === "rejected"
        ? binaryPath.detail
        : error.message;
    }

    return {
      id: definition.id,
      label: definition.label,
      summary: definition.summary,
      executables: [...definition.executables],
      adapter: definition.adapter ?? null,
      hasAdapter: definition.adapter !== undefined,
      availability,
      resolvedExecutable,
      detail,
      supportsBinaryPathOverride,
      binaryPath,
    };
  });

  return { version: 1, harnesses };
}

export interface HarnessErrorBody {
  error: "invalid-request" | "unresolvable-path" | "harness-settings-unavailable";
  detail: string;
}

/**
 * Reject before persisting. An override that does not resolve to an executable
 * file is refused with the reason; it is never written and never falls back to a
 * different binary. The echoed path is the caller's own (#71).
 */
export function validateClaudeBinaryPathOverride(
  body: unknown,
  resolve: typeof resolveClaudeCodeBinary = resolveClaudeCodeBinary,
): { ok: true; binaryPath: string } | { ok: false; status: 400; body: HarnessErrorBody } {
  const raw = (body as { binaryPath?: unknown } | null | undefined)?.binaryPath;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "invalid-request",
        detail: "Provide binaryPath as a non-empty string, or DELETE this setting to clear it.",
      },
    };
  }
  const binaryPath = raw.trim();
  if (binaryPath.length > 4_096) {
    return {
      ok: false,
      status: 400,
      body: { error: "invalid-request", detail: "binaryPath is too long." },
    };
  }
  const resolution = resolve({ settings: { binaryPath } });
  if (resolution.state !== "resolved" || resolution.source !== "override") {
    return {
      ok: false,
      status: 400,
      body: {
        error: "unresolvable-path",
        detail: resolution.state === "resolved"
          ? "That path did not take effect as an override."
          : resolution.detail,
      },
    };
  }
  return { ok: true, binaryPath: resolution.binaryPath };
}

export function validateClaudeSystemPromptOverride(
  body: unknown,
): { ok: true; systemPrompt: string } | { ok: false; status: 400; body: HarnessErrorBody } {
  const raw = (body as { systemPrompt?: unknown } | null | undefined)?.systemPrompt;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "invalid-request",
        detail: "Provide systemPrompt as a non-empty string, or DELETE it to restore the Claude Code default.",
      },
    };
  }
  const systemPrompt = raw.trim();
  if (Buffer.byteLength(systemPrompt, "utf8") > MAX_CLAUDE_SYSTEM_PROMPT_BYTES) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "invalid-request",
        detail: `systemPrompt must be at most ${MAX_CLAUDE_SYSTEM_PROMPT_BYTES} bytes.`,
      },
    };
  }
  return { ok: true, systemPrompt };
}

export interface RegisterHarnessRoutesOptions {
  buildList?: typeof buildHarnessList;
  update?: typeof updateClaudeCodeHarnessSettings;
  resolveClaudeCode?: typeof resolveClaudeCodeBinary;
}

export async function registerHarnessRoutes(
  app: FastifyInstance,
  options: RegisterHarnessRoutesOptions = {},
): Promise<void> {
  const buildList = options.buildList ?? buildHarnessList;
  const update = options.update ?? updateClaudeCodeHarnessSettings;
  const resolveClaudeCode = options.resolveClaudeCode ?? resolveClaudeCodeBinary;

  /** Every harness, its adapter state, and what resolves on this machine. */
  app.get("/harnesses", async (_request, reply) => {
    try {
      return buildList();
    } catch {
      // The store is best-effort by construction, so reaching here means
      // something structural. Answer with a shape the client can still render.
      reply.code(503);
      return {
        error: "harness-settings-unavailable",
        detail: "Harness settings could not be read. Retry, or restart the server.",
      } satisfies HarnessErrorBody;
    }
  });

  /** Set the Claude Code binary path. Rejected before persisting if unusable. */
  const putBinaryPath = async (
    request: { body: unknown },
    reply: { code(status: number): unknown },
  ): Promise<unknown> => {
    const validated = validateClaudeBinaryPathOverride(request.body, resolveClaudeCode);
    if (!validated.ok) {
      reply.code(validated.status);
      return validated.body;
    }
    update((current) => ({ ...current, binaryPath: validated.binaryPath }));
    return buildList();
  };
  app.put("/harnesses/claude-code/binary-path", putBinaryPath);
  app.post("/harnesses/claude-code/binary-path", putBinaryPath);

  /** Clear the override and fall back to the automatic resolution order. */
  app.delete("/harnesses/claude-code/binary-path", async () => {
    update(({ binaryPath: _cleared, ...rest }) => rest);
    return buildList();
  });

  /** Replace the Claude Code system prompt for relayed workflow nodes (row 7). */
  const putSystemPrompt = async (
    request: { body: unknown },
    reply: { code(status: number): unknown },
  ): Promise<unknown> => {
    const validated = validateClaudeSystemPromptOverride(request.body);
    if (!validated.ok) {
      reply.code(validated.status);
      return validated.body;
    }
    update((current) => ({ ...current, systemPrompt: validated.systemPrompt }));
    return buildList();
  };
  app.put("/harnesses/claude-code/system-prompt", putSystemPrompt);
  app.post("/harnesses/claude-code/system-prompt", putSystemPrompt);

  app.delete("/harnesses/claude-code/system-prompt", async () => {
    update(({ systemPrompt: _cleared, ...rest }) => rest);
    return buildList();
  });
}
