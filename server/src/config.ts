/**
 * Process-wide configuration: directories, ports, and env-derived knobs.
 *
 * The TS backend replaces the Python FastAPI + ADK server. It keeps the same
 * on-disk `projects/` layout (so existing user data is preserved) but drops the
 * Gemini-CLI / LiteLLM / MCP machinery.
 */
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

export const DEFAULT_PROJECT_ID = "default";

/** HTTP port for the backend (matches the old ADK server). */
export const PORT = Number(process.env.KADY_PORT ?? process.env.PORT ?? 8000);
export const HOST = process.env.KADY_HOST ?? "127.0.0.1";

/** Default orchestrator model, routed through Pi's OpenRouter provider. */
export const DEFAULT_MODEL_PROVIDER =
  process.env.DEFAULT_MODEL_PROVIDER ?? "openrouter";
export const DEFAULT_MODEL_ID =
  process.env.DEFAULT_MODEL_ID ?? "anthropic/claude-opus-4.8";

export const OLLAMA_BASE_URL =
  process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

/** Base URL of the Archon sidecar (the "Pipelines" workflow engine). Pinned off :3000
 *  and :8000 by default; the Kady /pipelines routes proxy to it. */
export const ARCHON_BASE_URL =
  process.env.ARCHON_BASE_URL ?? "http://localhost:3091";

/** Base URL of the local Raindrop Workshop UI (the OSS agent-trace debugger), surfaced
 *  in the Console's "Raindrop" tab. Local-only; the Kady /raindrop/health route proxies
 *  to it so the tab can degrade gracefully (the browser can't probe it cross-origin). */
export const RAINDROP_BASE_URL =
  process.env.RAINDROP_BASE_URL ?? "http://localhost:5899";

/** Whether Modal-style remote compute is configured (kept for /config parity). */
export function modalConfigured(): boolean {
  return Boolean(process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET);
}
