/**
 * System + misc endpoints: /skills (installed catalogue), /ollama/models
 * (local model discovery), and /sandbox/init (heavier per-project bootstrap).
 * /health and /config live in index.ts.
 */
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { OLLAMA_BASE_URL, REPO_ROOT } from "../config.ts";
import { activePaths } from "../projects.ts";
import { listProjectSkills, seedProjectSkills } from "../agent/skills.ts";
import { syncSandboxVenv } from "../sandbox-seed.ts";

const GITHUB_REPO = "K-Dense-AI/k-dense-byok";
const VERSION_CACHE_TTL_MS = 60 * 60 * 1000; // re-check at most once per hour
let versionCache: { ts: number; latestVersion: string | null } | null = null;

// Kady's canonical model catalogue (the same `web/src/data/models.json` that the chat
// model picker and the Pi agent's pricing both read). Exposed so the Pipeline Builder
// (Archon) and any other out-of-process client can drive their model lists from the
// SAME list as chat instead of maintaining a divergent copy. Read once and cached in
// memory — the file is shipped with the build and doesn't change at runtime.
const MODELS_CATALOGUE_PATH = path.join(REPO_ROOT, "web", "src", "data", "models.json");
let modelsCatalogueCache: unknown[] | null = null;

function loadModelsCatalogue(): unknown[] {
  if (modelsCatalogueCache) return modelsCatalogueCache;
  const raw = JSON.parse(fs.readFileSync(MODELS_CATALOGUE_PATH, "utf-8")) as unknown[];
  modelsCatalogueCache = Array.isArray(raw) ? raw : [];
  return modelsCatalogueCache;
}

export async function registerSystemRoutes(app: FastifyInstance): Promise<void> {
  // Server-side proxy for the "latest release" check. Doing the GitHub fetch
  // here (instead of the browser) keeps the unauthenticated-rate-limit 403 out
  // of the user's console, lets us cache across reloads, and can use a token if
  // one is configured. Always 200s with a (possibly null) version.
  app.get("/version/latest", async () => {
    const now = Date.now();
    if (versionCache && now - versionCache.ts < VERSION_CACHE_TTL_MS) {
      return { latestVersion: versionCache.latestVersion };
    }
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const token = process.env.GITHUB_TOKEN;
      const resp = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
        {
          signal: ctrl.signal,
          headers: {
            Accept: "application/vnd.github+json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        },
      );
      clearTimeout(t);
      if (!resp.ok) {
        versionCache = { ts: now, latestVersion: null };
        return { latestVersion: null };
      }
      const data = (await resp.json()) as { tag_name?: string };
      const latestVersion = (data.tag_name ?? "").replace(/^v/, "") || null;
      versionCache = { ts: now, latestVersion };
      return { latestVersion };
    } catch {
      versionCache = { ts: now, latestVersion: null };
      return { latestVersion: null };
    }
  });

  // The single Kady-owned model catalogue endpoint. Project-agnostic (no active-project
  // dependency) and cache-friendly so Archon/clients can poll cheaply and stay in lockstep
  // with the chat model list. Returns the raw catalogue array (the `Model` UI shape:
  // {id, label, provider, pricing, ...}), exactly what `useModels()` merges from.
  app.get("/models/catalogue", async (_req, reply) => {
    try {
      const models = loadModelsCatalogue();
      reply.header("Cache-Control", "public, max-age=3600");
      return { models };
    } catch (err) {
      // Missing/unreadable catalogue: answer 200 with an empty list so a client can
      // degrade gracefully rather than crash. Surface the cause in logs.
      reply.log.warn(
        `[models] Failed to read catalogue at ${MODELS_CATALOGUE_PATH}: ${(err as Error).message}`,
      );
      return { models: [] as unknown[] };
    }
  });

  app.get("/skills", async () => {
    return listProjectSkills(activePaths()).map((s) => ({
      id: s.name,
      name: s.name,
      description: s.description,
    }));
  });

  // Seed the project's skills (network clone allowed). Used by first-run / a
  // "populate skills" action. Cheap no-op once skills exist.
  app.post<{ Querystring: { remote?: string; venv?: string } }>("/sandbox/init", async (req) => {
    const paths = activePaths();
    const allowRemote = req.query.remote !== "false";
    const count = seedProjectSkills(paths, allowRemote);
    const venvSynced = req.query.venv === "true" ? syncSandboxVenv(paths) : false;
    return { ok: true, skills: count, venvSynced };
  });

  // Proxy local Ollama tags → the UI Model shape. Returns available:false if
  // Ollama isn't running (the picker just hides the section).
  app.get("/ollama/models", async () => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2000);
      const resp = await fetch(`${OLLAMA_BASE_URL.replace(/\/+$/, "")}/api/tags`, {
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!resp.ok) return { available: false, models: [] };
      const data = (await resp.json()) as { models?: { name: string }[] };
      const models = (data.models ?? []).map((m) => ({
        id: `ollama/${m.name}`,
        label: m.name,
        provider: "Ollama",
        tier: "budget",
        context_length: 0,
        pricing: { prompt: 0, completion: 0 },
        modality: "text->text",
        description: `Local Ollama model: ${m.name}`,
      }));
      return { available: true, models };
    } catch {
      return { available: false, models: [] };
    }
  });
}
