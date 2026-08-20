/**
 * Server-wide harness settings — the Claude Code binary-path override and the
 * Claude system-prompt override (matrix row 7).
 *
 * **Why here and not in an existing store.** `server/src` has no server-wide
 * settings store: `config.ts` is env-derived and read once at import,
 * `agent/capability-state.ts` owns a *project's* `sandbox/.pi/settings.json`,
 * and `KADY_PI_AGENT_DIR` belongs to `pi-coding-agent`. What the repo does have
 * is a convention — `~/.kady/<purpose>`, established three times in `config.ts`
 * (`pi-agent`, `skills-cache`, `personality-store`), each overridable by one
 * `KADY_*` variable — and an atomic write idiom (write `.tmp`, rename), used by
 * `capability-state.ts` and `sandbox-seed.ts`. This file follows both rather
 * than inventing a second config store. The path constant would sit better
 * beside its three siblings in `config.ts`; that file is outside lane F2's
 * writable set, so the relocation is written into `INTEGRATION.md`.
 *
 * A malformed or unreadable file is treated as "no override", never as an
 * error: a corrupt settings file must not make every workflow node fail.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Longest system-prompt override accepted. Bounded because it becomes argv. */
export const MAX_CLAUDE_SYSTEM_PROMPT_BYTES = 16 * 1024;

export interface ClaudeCodeHarnessSettings {
  /** Absolute path the user typed. Empty/absent means "resolve normally". */
  binaryPath?: string;
  /** Replaces Claude Code's own system prompt for relayed runs. */
  systemPrompt?: string;
}

export interface WorkflowHarnessSettings {
  version: 1;
  claudeCode: ClaudeCodeHarnessSettings;
}

const EMPTY_SETTINGS: WorkflowHarnessSettings = {
  version: 1,
  claudeCode: {},
};

export function workflowHarnessSettingsPath(): string {
  const configured = process.env.KADY_HARNESS_SETTINGS_PATH?.trim();
  if (configured) return path.resolve(configured);
  return path.join(os.homedir(), ".kady", "harness-settings.json");
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Never throws. A missing, unreadable or malformed file reads as no override. */
export function readWorkflowHarnessSettings(): WorkflowHarnessSettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(workflowHarnessSettingsPath(), "utf-8"));
  } catch {
    return structuredClone(EMPTY_SETTINGS);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return structuredClone(EMPTY_SETTINGS);
  }
  const claudeCodeRaw = (parsed as { claudeCode?: unknown }).claudeCode;
  const claudeCode: ClaudeCodeHarnessSettings = {};
  if (claudeCodeRaw && typeof claudeCodeRaw === "object" && !Array.isArray(claudeCodeRaw)) {
    const binaryPath = nonEmptyString((claudeCodeRaw as ClaudeCodeHarnessSettings).binaryPath);
    const systemPrompt = nonEmptyString(
      (claudeCodeRaw as ClaudeCodeHarnessSettings).systemPrompt,
    );
    if (binaryPath) claudeCode.binaryPath = binaryPath;
    if (systemPrompt && Buffer.byteLength(systemPrompt, "utf8") <= MAX_CLAUDE_SYSTEM_PROMPT_BYTES) {
      claudeCode.systemPrompt = systemPrompt;
    }
  }
  return { version: 1, claudeCode };
}

/** Atomic replace, so a crash mid-write cannot leave a half-parsed override. */
export function writeWorkflowHarnessSettings(settings: WorkflowHarnessSettings): void {
  const file = workflowHarnessSettingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(
    temporary,
    `${JSON.stringify({ version: 1, claudeCode: settings.claudeCode }, null, 2)}\n`,
    "utf-8",
  );
  fs.renameSync(temporary, file);
}

/** Read-modify-write of one harness's slice, preserving everything else. */
export function updateClaudeCodeHarnessSettings(
  mutate: (current: ClaudeCodeHarnessSettings) => ClaudeCodeHarnessSettings,
): WorkflowHarnessSettings {
  const current = readWorkflowHarnessSettings();
  const next: WorkflowHarnessSettings = {
    version: 1,
    claudeCode: mutate({ ...current.claudeCode }),
  };
  writeWorkflowHarnessSettings(next);
  return next;
}
