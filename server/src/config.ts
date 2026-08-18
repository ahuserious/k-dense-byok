/**
 * Process-wide configuration: directories, ports, and env-derived knobs.
 *
 * The TS backend replaces the Python FastAPI + ADK server. It keeps the same
 * on-disk `projects/` layout (so existing user data is preserved) but drops the
 * Gemini-CLI / LiteLLM / MCP machinery.
 */
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Repo root = parent of `server/`. */
export const REPO_ROOT = path.resolve(__dirname, "..", "..");

/** Root that holds every project directory. Overridable for tests. */
export const PROJECTS_ROOT = path.resolve(
  process.env.KADY_PROJECTS_ROOT
    ? process.env.KADY_PROJECTS_ROOT
    : path.join(REPO_ROOT, "projects"),
);

/** App-scoped Pi configuration/auth directory, established by env.ts. */
const rawPiAgentDir =
  process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".kady", "pi-agent");
export const KADY_PI_AGENT_DIR = path.resolve(
  rawPiAgentDir === "~"
    ? os.homedir()
    : rawPiAgentDir.startsWith("~/") || rawPiAgentDir.startsWith("~\\")
      ? path.join(os.homedir(), rawPiAgentDir.slice(2))
      : rawPiAgentDir,
);

/**
 * Default skill catalogue. Lives here rather than in `agent/skills.ts` so the
 * CLI-backed fetcher can reference it without importing back into the module
 * that installs from it.
 */
export const SKILLS_REPO =
  process.env.KADY_SKILLS_REPO ?? "K-Dense-AI/scientific-agent-skills";
export const SKILLS_BRANCH = process.env.KADY_SKILLS_BRANCH ?? "main";

/**
 * Staging cache the `skills` CLI fetches into. Deliberately outside any
 * project sandbox: one download per source serves every project, and nothing
 * here is canonical — `skills-sync.ts` installs from it into the live skill
 * dirs and remains their only writer.
 */
export const KADY_SKILLS_CACHE_DIR = path.resolve(
  process.env.KADY_SKILLS_CACHE_DIR?.trim() ||
    path.join(os.homedir(), ".kady", "skills-cache"),
);

/**
 * Deliberation personalities are not Pi skills. They are fetched from the
 * scientific-agents profile repository into a server-owned store that is
 * deliberately outside every project sandbox and the Pi agent directory.
 */
export const PERSONALITY_STORE_REPO =
  process.env.KADY_PERSONALITY_STORE_REPO ?? "ahuserious/scientific-agents";
/** Administrative source lock. Deliberation remains unavailable until both are pinned. */
export const PERSONALITY_STORE_COMMIT =
  process.env.KADY_PERSONALITY_STORE_COMMIT?.trim().toLowerCase() ?? "";
export const PERSONALITY_STORE_MANIFEST_SHA256 =
  process.env.KADY_PERSONALITY_STORE_MANIFEST_SHA256?.trim().toLowerCase() ?? "";
export const KADY_PERSONALITY_STORE_DIR = path.resolve(
  process.env.KADY_PERSONALITY_STORE_DIR?.trim() ||
    path.join(os.homedir(), ".kady", "personality-store"),
);

export const DEFAULT_PROJECT_ID = "default";

/** HTTP port for the backend (matches the old ADK server). */
export const PORT = Number(process.env.KADY_PORT ?? process.env.PORT ?? 8000);
export const HOST = process.env.KADY_HOST ?? "127.0.0.1";

/** Default orchestrator model, routed through Pi's OpenRouter provider. */
export const DEFAULT_MODEL_PROVIDER =
  process.env.DEFAULT_MODEL_PROVIDER ?? "openrouter";
export const DEFAULT_MODEL_ID =
  process.env.DEFAULT_MODEL_ID ?? "anthropic/claude-opus-5";

/**
 * Local Ollama daemon: `/api/tags` for discovery, its OpenAI-compatible `/v1`
 * surface for dispatch.
 *
 * No default. A `http://localhost:11434` fallback meant an install that had
 * never named a daemon still probed whatever happened to listen on Ollama's
 * port of the backend's host — and this route was worse than its
 * OpenAI-compatible sibling below, not merely equal to it. That one at least
 * computed a `configured` flag; /ollama/models had no notion of "unconfigured"
 * at all, so it answered `available: true` and enumerated a stranger's models
 * straight into the picker, where agent/models.ts had registered the provider
 * at the same default and made them selectable and dispatchable. Unset (or
 * blank) therefore means "the feature is off": the route attempts no fetch, and
 * no provider is registered. Same treatment as RAINDROP_BASE_URL (NT-4) and
 * OPENAI_COMPATIBLE_BASE_URL (#57); this is #64, the widest of the three.
 *
 * The cost is borne by the user who runs Ollama on its default port and has no
 * `.env` at all: they must now name the daemon once. `.env.example` already
 * ships `OLLAMA_BASE_URL=http://localhost:11434` uncommented, so anyone who set
 * up from the documented template is unaffected.
 */
export const OLLAMA_BASE_URL: string | undefined =
  process.env.OLLAMA_BASE_URL?.trim() || undefined;

function deprecatedEnvironmentValue(currentName: string, legacyName: string): string | undefined {
  const currentValue = process.env[currentName];
  if (currentValue !== undefined) return currentValue;
  const legacyValue = process.env[legacyName];
  if (legacyValue !== undefined) {
    console.warn(`[deprecated] ${legacyName} is deprecated; use ${currentName} instead.`);
  }
  return legacyValue;
}

/**
 * Base URL of the vendored workflow engine (the "Scientific DAG Workflow
 * Designer", served from server/vendor/pipeline-engine). start.mjs spawns it as
 * an owned child on KADY_PIPELINE_ENGINE_PORT (default 3091); the /pipelines routes
 * proxy to it and answer 503 while it is down.
 */
export const PIPELINE_ENGINE_BASE_URL =
  deprecatedEnvironmentValue("PIPELINE_ENGINE_BASE_URL", "ARCHON_BASE_URL") ??
  `http://127.0.0.1:${deprecatedEnvironmentValue(
    "KADY_PIPELINE_ENGINE_PORT",
    "KADY_ARCHON_PORT",
  ) ?? "3091"}`;

/** Explicit launcher-owned disabled state; avoids attempting a proxied fetch. */
export const PIPELINE_ENGINE_DISABLED =
  process.env.KADY_PIPELINE_ENGINE_DISABLED === "1";

/**
 * Base URL of the optional local Raindrop Workshop UI (the OSS agent-trace
 * debugger, an external sibling checkout — NOT vendored). Only the
 * /raindrop/health probe reads this; when nothing listens there the Raindrop
 * view simply keeps its native session-trace panel.
 *
 * No default. A `http://localhost:5899` fallback meant an install that had
 * never been pointed at a Workshop still reached out to whatever happened to
 * listen on that port of the backend's host — an unrelated dev server's traces
 * reported back to the UI as a healthy Workshop. Unset therefore means "the
 * feature is off": /raindrop/health answers without any outbound fetch at all.
 * The web side dropped the same default from RAINDROP_URL
 * (web/src/lib/embed-config.ts); this is the server half of that fix.
 */
export const RAINDROP_BASE_URL: string | undefined =
  process.env.RAINDROP_BASE_URL?.trim() || undefined;

/**
 * Local OpenAI-compatible model server (LM Studio, vLLM, text-generation-webui,
 * …) discovered through the standard `/v1/models` endpoint. vLLM's default
 * (8000) collides with this backend, so those users must move one of the two.
 *
 * No default. A `http://localhost:1234` fallback meant an install that had
 * never named a server still probed whatever happened to listen on LM Studio's
 * port of the backend's host: OPENAI_COMPATIBLE_CONFIGURED shaped the answer
 * but suppressed nothing, so /openai-compatible/models replied
 * `{available: false, configured: false}` while the process had already
 * resolved `localhost` and opened a socket to :1234 and read whatever answered
 * there. Unset (or blank) therefore means "the feature is off" — the route
 * attempts no fetch at all — which is the same treatment RAINDROP_BASE_URL
 * above got for the identical defect (NT-4); this is #57, one port over.
 *
 * Losing the fallback costs the user who runs LM Studio on its default port
 * and never configured anything their zero-config discovery. That discovery is
 * exactly the unrequested egress being removed, and it was already invisible
 * to most of them: the picker hides the section unless `available` or
 * `configured` holds, and this population reported `configured: false`.
 */
export const OPENAI_COMPATIBLE_BASE_URL: string | undefined =
  process.env.OPENAI_COMPATIBLE_BASE_URL?.trim() || undefined;

/**
 * Whether the user explicitly pointed us at a server. The picker hides the
 * section entirely unless this is true or a server actually answers, so the
 * majority who have never run one never see a dead "not running" row.
 *
 * Now literally "is there an address to probe", so it is also the route's
 * fetch guard rather than a label the route computes and then ignores.
 */
export const OPENAI_COMPATIBLE_CONFIGURED = Boolean(OPENAI_COMPATIBLE_BASE_URL);

/** Whether Modal-style remote compute is configured (kept for /config parity). */
export function modalConfigured(): boolean {
  return Boolean(process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET);
}
