/**
 * Sub-agent definition files: parse, serialize, and CRUD.
 *
 * pi-subagents discovers project agents as markdown files with YAML-ish
 * frontmatter under `sandbox/.pi/agents/*.md`. This module is the single
 * owner of that directory:
 *   - the seeding path (scientific roster from subagents.ts, marker-gated so
 *     user deletions stick),
 *   - the settings API's list/save/delete/restore operations,
 *   - read-only access to the agents bundled inside the pi-subagents package.
 *
 * The frontmatter parser is a deliberate subset of YAML (flat `key: value`
 * lines, optional quotes, true/false booleans) matching how the package's own
 * agent files are authored. Unknown keys round-trip untouched via `extra` so
 * editing an agent in the UI never drops fields we don't model (defaultReads,
 * maxTokens, ...).
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { ProjectPaths } from "../projects.ts";
import { SUBAGENT_TYPES } from "./subagents.ts";
import { KDENSE_AGENTS } from "./kdense-agents.ts";

const require_ = createRequire(import.meta.url);

export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

// The deliberation backend an agent runs its reasoning through:
//   none         — plain model (default)
//   fusion-direct — force the model to OpenRouter Fusion (panel + judge)
//   council-tool  — add the native `council` tool to the agent's allowlist
export const DELIBERATION_BACKENDS = ["none", "fusion-direct", "council-tool"] as const;
export type DeliberationBackend = (typeof DELIBERATION_BACKENDS)[number];
// Canonical ref for fusion-direct; resolveModel() routes it to OpenRouter Fusion.
const FUSION_DIRECT_MODEL = "openrouter/openrouter/fusion";

export interface AgentFile {
  name: string;
  description: string;
  /** Where the definition lives. Only "project" agents are editable. */
  source: "project" | "builtin";
  model?: string;
  thinking?: string;
  /** Comma-separated tool allowlist, as authored (e.g. "read, grep, bash"). */
  tools?: string;
  systemPromptMode?: "append" | "replace";
  inheritProjectContext?: boolean;
  inheritSkills?: boolean;
  /**
   * Host-side convenience: which deliberation backend this agent uses. The writer
   * derives `model`/`tools` from it (applyDeliberationBackend) so pi-subagents — which
   * does not know this field — still enacts the choice.
   */
  deliberationBackend?: DeliberationBackend;
  /** Frontmatter keys we don't model, preserved verbatim on round-trip. */
  extra?: Record<string, string>;
  systemPrompt: string;
}

/** Editable fields accepted from the API (everything but name/source). */
export type AgentFilePatch = Omit<AgentFile, "name" | "source">;

function agentsDir(paths: ProjectPaths): string {
  return path.join(paths.sandbox, ".pi", "agents");
}

/** Marker that initial seeding ran; its presence makes user deletions stick. */
function seedMarkerPath(paths: ProjectPaths): string {
  return path.join(agentsDir(paths), ".seeded");
}

// --- frontmatter (YAML subset) --------------------------------------------

const KNOWN_KEYS = new Set([
  "name",
  "description",
  "model",
  "thinking",
  "tools",
  "systemPromptMode",
  "inheritProjectContext",
  "inheritSkills",
  "deliberationBackend",
]);

function unquote(value: string): string {
  const v = value.trim();
  if (
    (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
    (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
  ) {
    try {
      if (v.startsWith('"')) return JSON.parse(v) as string;
    } catch {
      /* fall through to manual strip */
    }
    return v.slice(1, -1);
  }
  return v;
}

export function parseAgentMarkdown(
  text: string,
  fallbackName: string,
  source: AgentFile["source"],
): AgentFile {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  const fm: Record<string, string> = {};
  let body = text;
  if (m) {
    body = m[2];
    for (const line of m[1].split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf(":");
      if (idx <= 0) continue;
      fm[trimmed.slice(0, idx).trim()] = unquote(trimmed.slice(idx + 1));
    }
  }
  const bool = (v: string | undefined) => (v === undefined ? undefined : v === "true");
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(fm)) {
    if (!KNOWN_KEYS.has(k)) extra[k] = v;
  }
  const mode = fm.systemPromptMode;
  return {
    name: fm.name || fallbackName,
    description: fm.description ?? "",
    source,
    model: fm.model || undefined,
    thinking: fm.thinking || undefined,
    tools: fm.tools || undefined,
    systemPromptMode: mode === "append" || mode === "replace" ? mode : undefined,
    inheritProjectContext: bool(fm.inheritProjectContext),
    inheritSkills: bool(fm.inheritSkills),
    deliberationBackend: DELIBERATION_BACKENDS.includes(fm.deliberationBackend as never)
      ? (fm.deliberationBackend as DeliberationBackend)
      : undefined,
    extra: Object.keys(extra).length > 0 ? extra : undefined,
    systemPrompt: body.trim(),
  };
}

/** YAML-safe single-line scalar (descriptions often contain colons). */
function yamlQuote(s: string): string {
  return JSON.stringify(s.replace(/\s+/g, " ").trim());
}

export function serializeAgentMarkdown(agent: Omit<AgentFile, "source">): string {
  const lines = ["---", `name: ${agent.name}`, `description: ${yamlQuote(agent.description)}`];
  if (agent.model) lines.push(`model: ${agent.model}`);
  if (agent.thinking) lines.push(`thinking: ${agent.thinking}`);
  if (agent.tools) lines.push(`tools: ${agent.tools}`);
  if (agent.systemPromptMode) lines.push(`systemPromptMode: ${agent.systemPromptMode}`);
  if (agent.inheritProjectContext !== undefined) {
    lines.push(`inheritProjectContext: ${agent.inheritProjectContext}`);
  }
  if (agent.inheritSkills !== undefined) lines.push(`inheritSkills: ${agent.inheritSkills}`);
  if (agent.deliberationBackend && agent.deliberationBackend !== "none") {
    lines.push(`deliberationBackend: ${agent.deliberationBackend}`);
  }
  for (const [k, v] of Object.entries(agent.extra ?? {})) lines.push(`${k}: ${v}`);
  lines.push("---", "", agent.systemPrompt.trim(), "");
  return lines.join("\n");
}

// --- listing ---------------------------------------------------------------

function readAgentFile(file: string, source: AgentFile["source"]): AgentFile | null {
  try {
    const text = fs.readFileSync(file, "utf-8");
    return parseAgentMarkdown(text, path.basename(file, ".md"), source);
  } catch {
    return null;
  }
}

export function listProjectAgents(paths: ProjectPaths): AgentFile[] {
  const dir = agentsDir(paths);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  return entries
    .sort()
    .map((f) => readAgentFile(path.join(dir, f), "project"))
    .filter((a): a is AgentFile => a !== null);
}

/** Agents bundled inside the pi-subagents package (read-only). */
export function listBuiltinAgents(): AgentFile[] {
  try {
    const pkgDir = path.dirname(require_.resolve("pi-subagents/package.json"));
    const dir = path.join(pkgDir, "agents");
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => readAgentFile(path.join(dir, f), "builtin"))
      .filter((a): a is AgentFile => a !== null);
  } catch {
    return [];
  }
}

/**
 * Full roster for the UI: project agents plus builtins that aren't shadowed
 * by a project agent of the same name (project definitions win in
 * pi-subagents' discovery order).
 */
export function listAgents(paths: ProjectPaths): AgentFile[] {
  const project = listProjectAgents(paths);
  const names = new Set(project.map((a) => a.name));
  const builtins = listBuiltinAgents().filter((a) => !names.has(a.name));
  return [...project, ...builtins];
}

// --- mutations ---------------------------------------------------------------

/**
 * Turn a deliberationBackend choice into the concrete `model`/`tools` that actually
 * enact it, so the on-disk agent file pi-subagents reads does the right thing:
 *   fusion-direct → pin the model to OpenRouter Fusion
 *   council-tool  → ensure `council` is in the tool allowlist
 *   none / unset   → leave model/tools untouched
 * Returns a new patch; never mutates the input.
 */
export function applyDeliberationBackend(patch: AgentFilePatch): AgentFilePatch {
  const backend = patch.deliberationBackend;
  if (!backend || backend === "none") return patch;
  const next: AgentFilePatch = { ...patch };
  if (backend === "fusion-direct") {
    next.model = FUSION_DIRECT_MODEL;
  } else if (backend === "council-tool") {
    const tools = (next.tools ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (!tools.includes("council")) tools.push("council");
    next.tools = tools.join(", ");
  }
  return next;
}

export function writeProjectAgent(
  paths: ProjectPaths,
  name: string,
  patch: AgentFilePatch,
): AgentFile {
  if (!AGENT_NAME_RE.test(name)) {
    throw new Error(`Invalid agent name "${name}" (lowercase letters, digits, - and _)`);
  }
  if (!patch.systemPrompt?.trim()) throw new Error("System prompt must not be empty");
  if (patch.thinking && !THINKING_LEVELS.includes(patch.thinking as never)) {
    throw new Error(`thinking must be one of: ${THINKING_LEVELS.join(", ")}`);
  }
  if (patch.deliberationBackend && !DELIBERATION_BACKENDS.includes(patch.deliberationBackend)) {
    throw new Error(`deliberationBackend must be one of: ${DELIBERATION_BACKENDS.join(", ")}`);
  }
  // Derive the effective model/tools from the backend choice before persisting.
  const agent: AgentFile = { ...applyDeliberationBackend(patch), name, source: "project" };
  const dir = agentsDir(paths);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), serializeAgentMarkdown(agent), "utf-8");
  return agent;
}

export function deleteProjectAgent(paths: ProjectPaths, name: string): boolean {
  if (!AGENT_NAME_RE.test(name)) return false;
  const file = path.join(agentsDir(paths), `${name}.md`);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file);
  return true;
}

// --- seeding ------------------------------------------------------------------

function rosterMarkdown(type: (typeof SUBAGENT_TYPES)[number]): string {
  return serializeAgentMarkdown({
    name: type.name,
    description: type.summary,
    systemPromptMode: "append",
    inheritProjectContext: true,
    inheritSkills: true,
    systemPrompt: type.systemPrompt,
  });
}

/**
 * One-time seeding of the scientific roster into a project. Gated by a marker
 * file so agents the user deleted in the UI stay deleted. Returns the number
 * of files written.
 */
/**
 * Seed the K-Dense persona agents (Karpathy, agentic data scientist) as editable project
 * agents, idempotently — only writes one that's absent, so a user's edits (or deletions)
 * stick. Deliberately NOT gated by the roster marker so they also appear in projects that
 * were seeded before these agents existed.
 */
export function seedKDenseAgents(paths: ProjectPaths): number {
  const dir = agentsDir(paths);
  fs.mkdirSync(dir, { recursive: true });
  let written = 0;
  for (const agent of KDENSE_AGENTS) {
    const file = path.join(dir, `${agent.name}.md`);
    if (fs.existsSync(file)) continue;
    fs.writeFileSync(file, serializeAgentMarkdown(agent), "utf-8");
    written++;
  }
  return written;
}

export function seedAgentFiles(paths: ProjectPaths): number {
  const dir = agentsDir(paths);
  fs.mkdirSync(dir, { recursive: true });
  // Ensure the K-Dense persona agents on every call (side effect; NOT counted in the
  // return so the contract — "number of roster files written" — stays unchanged).
  seedKDenseAgents(paths);
  if (fs.existsSync(seedMarkerPath(paths))) return 0;
  let written = 0;
  for (const type of SUBAGENT_TYPES) {
    const file = path.join(dir, `${type.name}.md`);
    if (fs.existsSync(file)) continue;
    fs.writeFileSync(file, rosterMarkdown(type), "utf-8");
    written++;
  }
  fs.writeFileSync(seedMarkerPath(paths), new Date().toISOString() + "\n", "utf-8");
  return written;
}

/**
 * Restore the default scientific agents, overwriting same-named files (the
 * Settings panel's "Restore defaults" action). User-created agents with other
 * names are untouched. Returns the restored names.
 */
export function restoreDefaultAgents(paths: ProjectPaths): string[] {
  const dir = agentsDir(paths);
  fs.mkdirSync(dir, { recursive: true });
  for (const type of SUBAGENT_TYPES) {
    fs.writeFileSync(path.join(dir, `${type.name}.md`), rosterMarkdown(type), "utf-8");
  }
  fs.writeFileSync(seedMarkerPath(paths), new Date().toISOString() + "\n", "utf-8");
  return SUBAGENT_TYPES.map((t) => t.name);
}
