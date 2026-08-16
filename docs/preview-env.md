# Hermetic preview environment

The preview lifecycle boots all three Scientific DAG Studio services through
`start.mjs` on an isolated port set and state tree. It is intended for the
future Stably browser outer loop, not production data.

```bash
node scripts/preview-up.mjs \
  --backend-port 18000 \
  --frontend-port 13000 \
  --engine-port 13091

node scripts/preview-down.mjs
```

Before opening any sockets, `preview-up` runs
`node scripts/vendored-dist-build.mjs --if-stale`. The build script invokes
`bun run build:web` from `server/vendor/pipeline-engine/`, which is the
vendored Bun workspace owning `bun.lock` and filters the build to the web
package. The build receives the selected engine port as `PORT`; ambient
variables are not inherited. Its strict allowlist contains only the isolated
`HOME`, PATH-first Node/Bun/Git shims, `NODE_ENV`, `PORT`, isolated `TMPDIR`,
and optional `LANG`/`CI`. Preview creates that isolation and proves the Git
transport block before running the prebuild.

After Vite succeeds, the wrapper writes the ignored
`packages/web/dist/.vendored-dist-manifest.json`. Its schema-1 record contains:

- a SHA-256 fingerprint and per-file hashes for the complete enumerated input
  set, including web source/public/config/env files, the core and workflows
  package trees, every workspace package manifest/TypeScript config,
  `bunfig.toml`, the workspace package/lock/env files, and Bun/Node versions;
- the outer repository's full Git HEAD, or the literal `unknown` when Git
  identity is unavailable;
- the names and values of the non-credential Vite build environment inputs
  `NODE_ENV` and `PORT`;
- the dependency-install stamp derived from `bun.lock`, `bunfig.toml`, and the
  Bun version;
- the relative path, SHA-256, and byte count for every regular output file.

The wrapper runs `bun install --frozen-lockfile` when the ignored `.web-built`
install stamp beside `node_modules` differs, serializes installers/builders
with an ignored lock (reclaiming it after ten minutes), and fingerprints inputs
both before and after Bun runs. It writes no manifest when those fingerprints
differ. The post-build check recomputes that context, validates every recorded
output, and verifies every local `src`/`href` URL referenced by
`dist/index.html`, including root-local files such as `/favicon.png`.
Missing roots, symlinks, a missing manifest, Git/environment drift, changed
inputs, partial outputs, and broken asset references all fail closed. This
produces the bundle required by the workflow-engine server in a fresh clone
without committing generated assets or trusting filesystem timestamp
resolution.

Use `--no-build-dist` only when a caller has already built the bundle. The
option skips compilation, not validation: `preview-up` still exits before boot
when the manifest, build context, or any recorded/referenced output fails
validation. The standalone commands are:

```bash
npm run check:vendored-dist
npm run build:vendored-dist
node scripts/vendored-dist-build.mjs --if-stale
```

The primary `start.mjs` launcher delegates dependency synchronization and the
freshness-aware `--if-stale` build to that locked wrapper. It reuses a listener
only when the PID belongs to this checkout, the health endpoint responds, and
the manifest is fresh. Foreign listeners are never adopted. The workflow
engine remains optional: missing Bun still skips it, and a build/validation
failure warns with the repair command above and lets the rest of Kady continue.

`preview-up` creates a unique `/tmp/kady-preview-*` directory, including fresh
project, Pi-agent, skills-cache, workflow-supervisor, and log paths. It creates
a launch overlay with a blank `.env`, which prevents the copied launcher from
loading the repository file directly. However, the symlinked server currently
resolves its physical checkout path and can reload the checkout's real `.env`;
credential writes can also target that file. This confirmed server-side defect
is assigned to lane C5 (`server/src/env.ts`, the credentials writer, and preview
env-root wiring). Until C5 lands, the preview is not a credential-isolation
boundary. The overlay symlinks the checked-out `server/` and `web/` trees and
runs the checkout's exact `start.mjs` and `env-file.mjs` bytes.
It also includes a minimal `scripts/` directory containing byte-exact copies of
the three `vendored-dist-*.mjs` modules required by the launcher. Those modules
validate and build against the checkout resolved through the `server/` symlink,
so the overlay neither exposes `.git` nor substitutes `gitHead: "unknown"`.
The preview npm shim suppresses the launcher's update lookup and forces npm
offline; the vendored wrapper independently performs stamp-driven frozen Bun
installs when required.

The effective environment includes:

- `KADY_PREVIEW=1`;
- the selected `KADY_PORT`, `KADY_FRONTEND_PORT`, and `KADY_PIPELINE_ENGINE_PORT`;
- temporary `KADY_PROJECTS_ROOT`, `KADY_PI_AGENT_DIR`,
  `PI_CODING_AGENT_DIR`, `KADY_SKILLS_CACHE_DIR`, and workflow-supervisor paths;
- `KADY_SKILLS_REPO=kady-preview-nonexistent/none` and a blank
  `TELEGRAM_BOT_TOKEN`;
- scrubbed ambient variables whose names contain auth, PAT, key, token, secret,
  password, or credential markers.

The example values are in `deploy/preview/preview.env.example`; `preview-up`
replaces the state paths with its unique temporary root. Startup succeeds only
after the backend `/health`, web root, and workflow engine `/api/health` all
answer successfully. It then prints those URLs, the spawned root PID, and the
log location.

## Push block

Every preview descendant receives `GIT_ALLOW_PROTOCOL=file`,
`GIT_PROTOCOL_FROM_USER=0`, and `GIT_TERMINAL_PROMPT=0`. Thus Git rejects HTTP,
HTTPS, SSH, and Git-protocol transports before network I/O. A PATH-first Git
shim independently refuses any command containing the `push` subcommand while
delegating read-only/local commands. `preview-up` proves the protocol block
before boot with a push to the non-resolving scratch URL
`https://preview.invalid/kady-preview-blocked.git`; the expected message is
`fatal: transport 'https' not allowed`.

These controls prevent accidental pushes from ordinary preview subprocesses;
they are safety rails, not a security boundary against code that deliberately
replaces its environment or executes a trusted Git binary with a different
environment.

## Owned teardown

`preview-down` validates the state file, repository identity, temporary-root
shape, root PID, and launch working directory before signaling anything. It
sends `SIGTERM` to the recorded launcher's process group. `start.mjs` then uses
its normal backend IPC drain and detached-child group teardown. A second signal
is used only if the owned tree does not quiesce within 90 seconds.

Afterward, `preview-down` runs scoped `pgrep -f` checks for
`kady-workflow-supervisor`, `tsx/dist/preflight.cjs`, and
`vendor/pipeline-engine`. Candidate command/environment records must also contain
one of this preview's unique state paths, so an unrelated Kady checkout is not
claimed. Teardown fails unless all three scoped counts are zero. The temporary
state tree is then removed; pass `--keep-state` to retain its logs after the
zero-process proof.
