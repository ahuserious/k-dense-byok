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
package. That prebuild child alone receives `NODE_ENV=production`; ambient
`NODE_ENV` is discarded and no service child inherits it. The build script then
re-runs the fail-closed freshness check. This produces the ignored
`packages/web/dist/` required by the workflow-engine server in a fresh clone
without committing generated assets.

Use `--no-build-dist` only when a caller has already built the bundle. The
option skips compilation, not validation: `preview-up` still exits before boot
when `dist/index.html` is missing or older than a build input. The standalone
commands are:

```bash
npm run check:vendored-dist
npm run build:vendored-dist
node scripts/vendored-dist-build.mjs --if-stale
```

`preview-up` creates a unique `/tmp/kady-preview-*` directory, including fresh
project, Pi-agent, skills-cache, workflow-supervisor, and log paths. It creates
a launch overlay with a blank `<launchRoot>/.env` and sets `KADY_ENV_FILE` to
that absolute path. The preview backend loads only `<launchRoot>/.env`, and
credential writes land there; the checkout's `.env` is never read or written
in preview mode. The overlay symlinks the checked-out `server/` tree and runs
the checkout's exact `start.mjs` and `env-file.mjs` bytes. Its `web/` project
root is instead the gitignored physical directory
`web/.preview/launch/web`. Preview startup recreates it and copies every web-root
entry except `.next`, `.preview`, `node_modules`, package-manager lockfiles, and
the automatic env filenames. This includes the physical `src/app` route tree,
`public`, package metadata, and Next, TypeScript, PostCSS, Tailwind, and other
root configuration files. In-checkout source symlinks are dereferenced into
physical snapshot bytes; an outside-pointing link or directory cycle stops
startup, and a post-copy walk requires the projected source set to contain no
symlinks. Lockfiles stay at the checkout ancestor so Turbopack does not
infer the projection itself as its filesystem root. The projection also copies
`server/package.json` into its sibling `server/` directory because the copied
Next config reads that version source through `../server/package.json`. Startup
prints the measured copy time. `node_modules` alone remains linked to its
canonical path within the checkout and is not traversed by the snapshot walk;
`.next` is a private real directory inside the projection. The
temporary launch overlay links its `web/` entry to this checkout-local project.
Consequently Turbopack discovers physical App Router files while every retained
symlink resolves under its inferred checkout filesystem root; preview creation
rejects any root entry whose canonical target escapes that root. Next 16 has no
supported switch that disables its forced development env-file reload, so the
projection also keeps env files created or modified in the checkout after
readiness outside Next's watched project root. Owned preview teardown removes
the marked projection. Dependencies must already be installed; the preview npm
shim suppresses the launcher's update lookup and forces npm offline.

The projection is an immutable source snapshot, not a live development mirror.
Edits to web routes, public assets, middleware, instrumentation, package
metadata, or configuration require `preview-down.mjs` followed by
`preview-up.mjs`. Preview startup records a SHA-256 manifest for the copied
source set and adds a preview-only `/api/preview-health` route. Readiness probes
that route; later health probes return HTTP 503 and name the first drifted
checkout file rather than silently serving stale evidence.

Preview lifecycle mutations are serialized by an exclusive lock under
`deploy/preview/`. A unique generation is stored in both the published state
and the checkout-local projection marker. Concurrent up/down commands refuse
while another lifecycle operation owns the lock, and teardown removes a
projection only when its generation matches the state it locked and read.

## Recovery

Lifecycle state is fsynced to a same-directory temporary file and published by
atomic rename. The exclusive lock records its PID, cross-platform process start
identity, generation, and creation time. If that PID is dead, or the PID has
been reused with a different start identity, the next command recovers the
stale lock only when every readable state/projection generation agrees; a live
owner remains busy. Recovery is logged with the stale PID and recorded start
identity.

`preview-down` tolerates missing or malformed state when the owned projection
marker remains valid. It uses the marker's generation and launch metadata to
remove only that projection, and signals a launcher or listener only after its
working directory proves it belongs to this checkout. An unproven listener is
never signalled: teardown refuses with the affected port and asks the operator
to stop the unrelated listener or restore matching state before retrying.

Backend env selection fails closed. With `KADY_PREVIEW=1`, `KADY_ENV_FILE`
must be present, non-blank, absolute, and resolve to a regular file under the
canonical `KADY_PREVIEW_LAUNCH_ROOT`; missing, relative, outside-root, and
outside-pointing symlink values stop startup. Outside preview mode,
`KADY_ENV_FILE` is rejected so the launcher and backend cannot disagree about
which file owns persisted credentials.

The workflow engine receives `ARCHON_HOME=<stateRoot>/pipeline-engine-home`, a
new empty directory created by `preview-up`; an ambient `ARCHON_HOME` is never
preserved. The filtered Bun package runs with
`server/vendor/pipeline-engine/packages/server` as its actual cwd. Preview boot
therefore refuses every automatic env candidate: `.env`, `.env.local`, and the
development, production, and test variants both with and without `.local`.
Those checks use the canonical checkout paths for `web/`, the vendored
workspace root, `packages/web`, and `packages/server`, plus the server package
cwd's legacy data-directory env file. They run immediately before vendored
preparation, Next startup, engine install/build, and engine startup, closing
validation-to-start windows without patching vendored code. The standalone
vendored build script repeats the same refusal in preview mode immediately
before its Bun build spawn.

Before its first child process, `preview-up` replaces its own environment with
an explicit allowlist. It may retain ambient `PATH`, `TMPDIR`, `LANG`, `TERM`,
`CI`, and the two validated browser-facing origin overrides. It does not retain
ambient `NODE_ENV`; each service runtime establishes its own mode. It then adds
only the preview's isolated `HOME`, engine home, ports, state paths, loopback
service URLs, and safety controls. All other ambient values are dropped,
including Docker/workspace selectors, database and cloud-tracing configuration,
proxy variables, the host SSH agent socket, and the host Pi-agent directory.
The sanitized environment is used by the supervisor and every service
descendant; the prebuild gets the same base plus its build-only production
mode.

The effective environment includes:

- `KADY_PREVIEW=1`;
- `KADY_ENV_FILE=<launchRoot>/.env`;
- `KADY_PREVIEW_LAUNCH_ROOT=<launchRoot>`;
- `ARCHON_HOME=<stateRoot>/pipeline-engine-home`;
- the selected `KADY_PORT`, `KADY_FRONTEND_PORT`, and `KADY_PIPELINE_ENGINE_PORT`;
- temporary `KADY_PROJECTS_ROOT`, `KADY_PI_AGENT_DIR`,
  `PI_CODING_AGENT_DIR`, `KADY_SKILLS_CACHE_DIR`, and workflow-supervisor paths;
- `KADY_SKILLS_REPO=kady-preview-nonexistent/none` and a blank
  `TELEGRAM_BOT_TOKEN`;
- only the ambient interoperability variables named by the allowlist above.

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
