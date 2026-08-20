# AGENTS.md

K-Dense BYOK ("Kady") — a local, bring-your-own-keys AI research assistant. See
`README.md` for the product tour and `docs/` for feature guides. This branch
(`DAG-Pipelines`) adds a two-tier top nav (DAG Pipelines / Agent Console /
Raindrop tabs), an optional Archon "Pipeline Builder" sidecar, and optional
Raindrop agent-trace tooling on top of the base app.

## Services

| Service | Port | Dev command (from repo root) | Required? |
|---|---|---|---|
| Backend (TypeScript + Pi agent) | 8000 | `cd server && npm run dev` | Yes |
| Frontend (Next.js 16 / React 19) | 3000 | `cd web && npm run dev -- -p 3000` | Yes |
| Archon "Pipeline Builder" sidecar | 3091 | via `./start.sh` | Optional |
| Raindrop Workshop (trace debugger) | 5899 | via `./start.sh` | Optional |

`./start.sh` orchestrates all of the above; standard per-service commands live in
each `package.json`. Node ≥ 22 is required (≥ 22.19 recommended; lower 22.x works
with an `EBADENGINE` warning).

## Cursor Cloud specific instructions

- **Standard commands live in `package.json`** (`server/`, `web/`) — dev, test,
  typecheck, lint, prep. This section only records non-obvious caveats.
- **Model access is bring-your-own-keys and is NOT committed.** `.env` is
  git-ignored, so keys never arrive with the branch. The backend + UI boot
  without a key, but the agent chat cannot run until one of these is provided:
  set `OPENROUTER_API_KEY` (and optionally other provider keys) in the repo-root
  `.env`, connect a subscription in Settings → Model providers, or point
  `OLLAMA_BASE_URL` at a running Ollama. In Cloud, add `OPENROUTER_API_KEY` via
  the Secrets panel so it is injected as an env var. `server/src/env.ts` also
  auto-loads a repo-root `.env` at boot.
- **`uv` is required for the agent's Python + the preview helper venv** and is
  installed to `~/.local/bin` (must be on `PATH`). It is not reinstalled by the
  update script; a fresh VM without it degrades Python previews/tasks to
  "deps-missing" but the app still runs. Install with
  `curl -LsSf https://astral.sh/uv/install.sh | sh` if missing.
- **Run `cd server && npm run prep` once** after install to seed the default
  project and the committed scientific skills (`server/seed/skills`, ~117). It is
  idempotent. `[archon-prep] sidecar down` in its output is expected when the
  Archon sidecar is not running and is harmless.
- **Optional sidecars are non-fatal and skipped when absent.** The Archon
  Pipeline Builder needs a sibling `../Archon` checkout + `bun`; Raindrop
  Workshop needs a sibling `../raindrop-slim` checkout + `bun`. Without them, the
  DAG "Pipeline Builder" and Console → Raindrop tabs render an
  unavailable/embed-empty state; the rest of the app is unaffected. The backend
  reads `RAINDROP_LOCAL_DEBUGGER` (defaults to `http://127.0.0.1:5899/v1/`); with
  no Raindrop daemon and no `RAINDROP_WRITE_KEY`, tracing simply has nowhere to
  go and nothing egresses.
- **Playwright e2e (`web/e2e/*`) needs browsers installed** via
  `cd web && npx playwright install` before `npx playwright test`. They are not
  part of the default `npm test` (which is Vitest) and are not run in setup.
- **Ports 8000/3000 must be free.** `start.sh` auto-reaps leftover Kady
  processes it started; when running services by hand, stop the previous dev
  processes before restarting.
