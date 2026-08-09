# VENDORED-FROM

## Origin

- **Source path (vendor time):** `/Users/DanBot/archon` (local clone; on this
  case-insensitive filesystem it is the same directory as the reference
  deployment's live sidecar clone `/Users/DanBot/Archon`)
- **Upstream project:** Archon (`archon`, private bun workspace) — upstream
  version **v0.4.1**
- **Source commit:** `e77a338e` — `git describe`: `v0.4.1-226-ge77a338e`
  ("fix(credentials,pi): deliver Claude subscriptions to Pi in direct chat
  (#1984) (#2000)")
- **Vendored on:** 2026-08-07
- **License:** MIT — Copyright (c) 2025-2026 Cole Medin. The verbatim license
  text travels with this copy at `./LICENSE` (see the MIT condition: the
  copyright + permission notice must be included in all copies or substantial
  portions of the Software).

## What was vendored

The 9 workspace packages the engine + builder need, plus the root workspace
files required to install/build/run:

- `packages/{server,adapters,core,git,paths,providers,workflows,isolation,web}`
- `migrations/`
- root `bun.lock`, `bunfig.toml`, `tsconfig.json`, `LICENSE`
- root `package.json` — **pruned**: scripts reduced to
  `start`/`dev:server`/`build:web`/`dev:web`/`type-check`; lint/format/husky
  (`prepare`)/CLI/docs/binary scripts removed; lint-related devDependencies
  dropped. `workspaces`, `engines`, `overrides`, and runtime root
  `dependencies` kept as upstream. Renamed to `archon-engine-vendored`.

## Excluded

`auth-service/`, `packages/cli`, `packages/docs-web`, `deploy/`, `homebrew/`,
`examples/`, `assets/` (root; not referenced by the server — the served
`/assets/*` route is the built web dist), `docker-compose*`, `Dockerfile*`,
`docker-entrypoint.sh`, `Caddyfile.example`, `.github`/husky hooks, `scripts/`
(release/codegen tooling; generated outputs are already committed in the
packages), `.git`, `node_modules`, `packages/web/dist` (rebuilt at install
time; git-ignored via this directory's `.gitignore`).

## Overlay provenance (debrand/rebrand — BAKED)

The source clone's working tree already carried the K-Dense
debrand/rebrand/model overlays from `server/seed/archon-rebrand/`
(`apply-rebrand.sh`, `apply-debrand.sh`, `apply-archon-models.sh`) as
uncommitted modifications on top of `e77a338e`, hand-reconciled against this
(v0.4.1+226) source. This vendored copy captures that overlaid state — i.e.
the overlays are **baked into the committed source**, not applied at boot.
Verified at vendor time by re-running all three overlay scripts against a
scratch copy: every source-file step reported already-applied/no-op, and the
resulting tree was byte-identical.

Overlay-affected files (working-tree diff vs `e77a338e` at vendor time):

- `packages/web/index.html` (title → "K-Dense Pipeline Builder")
- `packages/web/public/favicon.png` (+ new `public/kdense-logo.png`)
- `packages/web/src/components/layout/{TopNav,Sidebar,Layout}.tsx`
- `packages/web/src/components/workflows/BuilderToolbar.tsx` (full-file overlay)
- `packages/web/src/components/workflows/WorkflowBuilder.tsx`
  (+ new `CanvasChatPopout.tsx`)
- `packages/web/src/experiments/console/components/ProjectRail.tsx`
  (full-file overlay)
- `packages/web/src/experiments/console/lib/model-options.ts`
  (+ hand-fixed `model-options.test.ts`)
- `packages/web/src/experiments/console/theme.css` (de-purple)
- `packages/web/src/index.css` (kady-raindrop-chrome append)
- `packages/web/src/routes/WorkflowsPage.tsx`
- `packages/workflows/src/defaults/tier-defaults.json` (model/effort tiers)

NOT baked (runtime state, applied by the launcher/env instead): the overlay
scripts' `~/.archon/config.yaml` seeding (`defaultAssistant: pi`, assistant
models, `tiers.large`). The launcher passes `DEFAULT_AI_ASSISTANT=pi` as the
env-level fallback.

## Runtime notes

- Requires **bun** (`engines.bun ^1.3.0`). Server entry:
  `bun --filter '@archon/server' start` → `packages/server/src/index.ts`.
- SQLite state defaults to `~/.archon/` (`archon.db`, `config.yaml`, …);
  override the whole state dir with `ARCHON_HOME`.
- Health: `GET /api/health` → `{"status":"ok"}`. Builder UI:
  `/legacy/workflows/builder` (serves `packages/web/dist`; build with
  `bun run build:web`).
- Platform adapters: Telegram was REMOVED outright in the S2a
  de-instrumentation (a set TELEGRAM_BOT_TOKEN is ignored, never fatal);
  remaining adapters (Slack/GitHub/Discord) are env-gated and stay dormant
  without their credentials ("web-only mode"). Telemetry/update-check/remote
  egress was removed or gated default-off per docs/adr/S2a-vendor-egress.md.
