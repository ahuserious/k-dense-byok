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
`bun run build -- --outDir <staging-dir>` from
`server/vendor/pipeline-engine/packages/web/`, which runs the web package's existing
`tsc --noEmit && vite build` script while directing Vite into a staging tree.
The build receives the selected engine port as `PORT`; ambient
variables are not inherited. Its strict allowlist contains only the isolated
`HOME`, PATH-first Node/Bun/Git shims, `NODE_ENV`, `PORT`, isolated `TMPDIR`,
and optional `LANG`/`CI`. That prebuild child alone receives
`NODE_ENV=production`; ambient `NODE_ENV` is discarded by the preview ambient
allowlist and no service child inherits it. Preview creates that isolation and
proves the Git transport block before running the prebuild. Under
`KADY_PREVIEW=1` the builder additionally refuses to start Bun while any
automatic env file exists under `web/` or the vendored engine — the same guard
`preview-up` runs before it spawns the builder, and the one the launcher used
to run around its own (now retired) in-process engine install and web build.

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
- the dependency-install stamp derived from `bun.lock`, `bunfig.toml`, the
  workspace root and package manifests, and the Bun version;
- the relative path, SHA-256, and byte count for every regular output file.

The wrapper runs `bun install --frozen-lockfile` when either the ignored
`.web-built` record or the install-owned `node_modules/.bun-install-stamp`
differs. The stamp covers every workspace package manifest and is written only
when the install-input digest is unchanged before and after Bun runs. A
checkout-specific directory lock records the owner PID/start identity and
heartbeat; an existing lock is never reclaimed automatically, regardless of
age or a dead PID. Builders revalidate ownership immediately before Bun
can mutate dependencies and before dist promotion. Contenders wait for the
owner and recheck freshness. Builds publish by renaming a fully validated
staging tree instead of rewriting live `dist/`.
The wrapper fingerprints inputs both before and after Bun runs and writes no
manifest when those fingerprints differ. The post-build check recomputes that
context, validates every recorded output, and verifies every browser-loaded
local URL referenced by `dist/index.html`: `src`, `href`, `srcset`,
`imagesrcset`, `poster`, object `data`, and CSS `url()` in style attributes and
blocks, including root-local files such as `/favicon.png`.
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

### Build lock and recovery

All normal launches and previews rendezvous on the checkout-local lock directory
`server/vendor/pipeline-engine/node_modules/.vendored-dist-lock/build.lock.d`.
The holder creates that directory with `mkdir` (atomic; `EEXIST` means busy)
and publishes `owner.json` via a temporary file plus rename. The record contains
`version`, the owner PID, a host- and boot-scoped process-start identity,
`phase`, every active Bun install/build worker, `createdAt`, and `heartbeatAt`.
Release unlinks `owner.json` and removes the directory. There are no hard
links, recovery guards, tombstones, or nlink checks.

Any existing lock directory is busy. The build and launcher paths report the
owner record, or `unreadable owner record`, then poll until the deadline and
print the actionable recovery command. There is no automatic reclaim on a dead
PID, on age, or on anything else. CI uses a fresh checkout; a local crash is
one operator command. That removes every check-then-act reclaim race by
construction.

Linux identities use `/proc/<pid>/stat` field 22 plus the kernel boot ID;
macOS identities use `ps` start time under fixed `LC_ALL=C` and `TZ=UTC0`.
Identity methods are never compared across representations. Host scope is
checked before probing a PID: another host is always busy, and a different
boot ID on the same host proves the old process is gone. The checkout must be
used by one host, one PID namespace, and a local filesystem. Containers or VMs
that share this checkout, shared/network filesystems, and cross-host builders
are unsupported and therefore fail closed as busy.

Release unlinks `owner.json` and then `rmdir`s the directory. An `ENOTEMPTY`
there — a temporary owner file left behind by an interrupted write — is not an
error: the empty-of-owner directory stays, and every later launcher and builder
reads it as BUSY with an `unreadable owner record`. Recovering from that state
is the same one operator command, `--recover-lock` (with `--force`, because the
owner record is gone; see below).

`--recover-lock` is the only recovery path. A parseable `owner.json` is removed
only when the recorded wrapper PID and every recorded worker PID are dead by
the identity rules (same host and boot, then `ESRCH`). A host mismatch or any
unverifiable identity refuses recovery. If the directory is not empty once that
owner record is removed, recovery stops and prints the dirty path with its
remaining entries instead of deleting a tree it does not own; the lock stays
BUSY (now as an unreadable owner record) until the operator inspects those
entries and re-runs with `--force`. A missing or unreadable owner record also
refuses unless the operator adds `--force` and the occupant proof below finds
nothing. That `--force` path is an operator-confirmed action:

```bash
node scripts/vendored-dist-build.mjs --recover-lock
node scripts/vendored-dist-build.mjs --recover-lock --force
```

The `--force` occupant proof is fail-closed and has two independent parts:

- any process whose working directory is the vendored root or below it counts,
  whatever its command name — the POSIX gate waiter is `sh`, and Bun's build
  spawns `tsc`/`vite` children;
- any `node`/`bun` process whose command line contains the vendored root
  counts. The root is matched as a fixed string: `pgrep -f` takes an extended
  regular expression, so the path's metacharacters are escaped before the
  search. Non-node/bun commands that merely name the path (an editor, a `grep`)
  do not block recovery.

The vendored root is compared as a fully resolved path. A preview overlay
reaches the checkout through a symlinked `<launchRoot>/server`, and both cwd
proofs report resolved paths, so the root is `realpath`-resolved as a whole
rather than joined onto a resolved repository root.

A proof command that cannot run — missing `pgrep`/`lsof`, a timeout, a signal
death, or an exit status that is not an answer — refuses recovery rather than
reporting zero occupants. `pgrep` answers with exit 0 (matched) or 1 (nothing
matched); the full `lsof` cwd listing must exit 0, because a non-zero lsof
means it could not complete and its partial output could omit the very
occupant the proof exists to find; the per-PID `lsof` cwd lookup also accepts
exit 1, which means that PID is already gone. Anything else throws.

Both `--force` exits — the unreadable owner record and a valid-but-dead record
whose lock directory is dirty — run this same proof before removing anything.

SCOPE LIMIT: a mutator that changed its working directory away from the
vendored root and does not name the root in its arguments is invisible to both
parts of the proof. Occupants owned by another user (or by root) are also
outside the proof: an unprivileged caller cannot read their working directory,
and `lsof -w` suppresses the warning that would say so. On Linux a PID whose
`/proc/<pid>/cwd` answers `EACCES`/`EPERM` is not skipped — its working
directory is unprovable rather than known-outside, so it still goes through the
command-name check and counts as an occupant when it is a `node`/`bun` process;
only a PID that has gone away is dropped. `--force` therefore remains an
operator assertion that the build is really dead; it is not a proof of
exclusivity.

On Windows the CLI refuses `--recover-lock` (including `--force`): the gate
helper cannot prove the identity of the eventual Bun mutator. Any existing
lock directory remains busy. Close every Kady and Bun process, verify no build
worker remains, then manually remove `build.lock.d`. This lane has no Windows
CI coverage; Windows therefore uses this documented fail-closed limit rather
than an unverified recovery path.

The primary `start.mjs` launcher delegates dependency synchronization and the
freshness-aware `--if-stale` build to that locked wrapper. Preview mode is
check-only: the isolated prebuild is the sole builder, and the launcher fails
with `preview prebuild should have produced a fresh manifest` if a computed
fingerprint using the prebuild's `NODE_ENV`, `PORT`, or `TMPDIR` values does not
validate. Build-only defaults such as `NODE_ENV=production` are passed only to
Bun/Vite and the manifest checker; they are never exported to the launcher,
npm, backend, or frontend. It reuses a listener
only when the PID belongs to this checkout, the health endpoint responds, and
the manifest is fresh. A newly spawned engine is not marked available until a
listener in that child's process tree answers health and remains owned after
the response. Engine-port ownership is checked before backend/frontend spawn;
a foreign listener aborts startup rather than becoming the backend's proxy
target. A later engine exit or listener takeover terminates the launch instead
of leaving consumers pointed at a dead or foreign process. When the optional
engine is unavailable, the backend receives an explicit disabled state and
pipeline routes—including durable-admission reconciliation—return 503 without
fetching the configured engine URL. Missing Bun still skips the engine, and a
build/validation failure warns with the repair command above and lets the rest
of Kady continue. CLI engine-port selection takes precedence, but `.env` modern
and legacy port values are loaded before the launcher resolves the fallback.

`preview-up` creates a unique `/tmp/kady-preview-*` directory, including fresh
project, Pi-agent, skills-cache, workflow-supervisor, and log paths. It creates
a launch overlay with a blank `<launchRoot>/.env` and sets `KADY_ENV_FILE` to
that absolute path. The preview backend loads only `<launchRoot>/.env`, and
credential writes land there; the checkout's `.env` is never read or written
in preview mode. The overlay symlinks the checked-out `server/` tree and runs
the checkout's exact `start.mjs` and `env-file.mjs` bytes. Its `web/` project
root is instead the gitignored physical directory
`web/.preview/launch/web`. Preview startup recreates it from an explicit source
allowlist: `src`, `public`, package metadata, and enumerated Next, TypeScript,
PostCSS, Tailwind, and component configuration files. In-checkout source
symlinks are dereferenced only when their canonical target remains inside one
of those copied roots. Links to Git metadata, environment files, dependencies,
build output, preview state/destinations, vendored dist staging, any other
checkout path, a dangling target, or a directory cycle stop startup and name
the rejected class. The checkout's `web/` and `server/` roots must themselves
be real directories under the canonical checkout; every source entry is
canonicalized and checked even when its final component is not a symlink. A
post-copy walk requires the projected source set to
contain no symlinks. Lockfiles stay at the checkout ancestor so Turbopack does not
infer the projection itself as its filesystem root. The projection also copies
`server/package.json` into its sibling `server/` directory because the copied
Next config reads that version source through `../server/package.json`. Startup
prints the measured copy time. The checkout's top-level `web/node_modules`
must be a real directory; the projection links its canonical path and does not
traverse the dependency tree, whose internal layout remains the package
manager's responsibility. A symlinked dependency root is refused;
`.next` is a private real directory inside the projection. The
temporary launch overlay links its `web/` entry to this checkout-local project.
Consequently Turbopack discovers physical App Router files while every retained
symlink resolves under its inferred checkout filesystem root; preview creation
rejects any root entry whose canonical target escapes that root. Next 16 has no
supported switch that disables its forced development env-file reload, so the
projection also keeps env files created or modified in the checkout after
readiness outside Next's watched project root. Owned preview teardown removes
the marked projection.

The overlay also includes a minimal `scripts/` directory containing byte-exact
copies of the `vendored-dist-*.mjs` modules the launcher imports, plus the
`preview-environment.mjs`/`preview-launcher-observer.mjs` modules the copied
builder imports for its automatic-env-file guard. Those modules validate and
build against the checkout resolved through the `server/` symlink, so the
overlay neither exposes `.git` nor substitutes `gitHead: "unknown"`.
Dependencies must already be installed. The preview npm shim allows only the
launcher's exact `npm run prep --silent` command and rejects every other npm
invocation, including install, CI, prune, update, exec, and rebuild operations;
that also suppresses the launcher's update lookup. The vendored wrapper
independently performs stamp-driven frozen Bun installs when required.

The projection is an immutable source snapshot, not a live development mirror.
Edits to web routes, public assets, middleware, instrumentation, package
metadata, or configuration require `preview-down.mjs` followed by
`preview-up.mjs`. Preview startup records a SHA-256 manifest for the copied
source set and adds a preview-only `/api/preview-health` route. Readiness probes
that route and requires its JSON generation to match; backend and engine
readiness additionally require their recorded PID identities to remain live.
All three readiness ports must also be owned by the identity-validated service
PID or its recorded process group; a foreign listener prevents readiness and
is named without being signalled.
Later health probes return HTTP 503 and name the first drifted checkout file
rather than silently serving stale evidence.

Preview lifecycle mutations are serialized by an exclusive lock under
`deploy/preview/`. A unique generation is stored in both the published state
and the checkout-local projection marker. Concurrent up/down commands refuse
while another lifecycle operation owns the lock, and teardown removes a
projection only when its generation matches the state it locked and read.
`preview-up` holds this lock through generation-bound readiness and through any
failure cleanup; `preview-down` therefore refuses with the starting preview-up
PID instead of crossing generations.

## Recovery

Lifecycle state is fsynced to a same-directory temporary file and published by
atomic rename. The lifecycle lock is the directory
`deploy/preview/.lifecycle.lock.d`, created by atomic `mkdir`. Its atomically
published `owner.json` records version, operation, generation, PID, host and
boot identity, process birth identity, and creation time. Any existing lock
directory is BUSY, including one with a missing or unreadable owner. There is
no automatic takeover based on PID, age, or file state. CI jobs use fresh
checkouts; after a local crash, the operator performs one explicit recovery.
This removes every lifecycle check-then-act takeover race by construction.

`node scripts/preview-down.mjs --recover-lock` is the only recovery path and
must never run concurrently with preview-up or preview-down. A comparable owner
record is removed only after the same host and boot are established and its
recorded PID is absent. A missing or unreadable owner requires the explicit
operator-confirmed `--recover-lock --force` form. Forced recovery refuses while
any recorded preview port has a listener or `pgrep -f`/cwd inspection finds a
process referring to the exact recorded preview state-root path. Legacy v2/v3
lock files are parsed, but an owner lacking comparable host and boot identity
is refused with `cannot verify owner liveness`.

A crash between `owner.json`'s temporary-file write and its atomic rename can
leave a `.owner.json.<pid>.<uuid>.tmp` sibling inside the lock directory. The
normal `release()` unlinks `owner.json` and then `rmdir`s the directory, so that
leftover makes the `rmdir` fail with `ENOTEMPTY`: the lock directory survives
without a readable owner, and every later lifecycle command reports BUSY with an
unreadable owner record. That state is recovered with the explicit
`node scripts/preview-down.mjs --recover-lock --force` form, which is exactly the
form a missing or unreadable owner already requires, and which still refuses
while any recorded preview port has a listener or any process refers to the
recorded state root. `release()` is deliberately left as a plain `rmdir`: making
it delete unexpected directory contents would reintroduce a check-then-act
window on a path that runs while another operator may be recovering.

`preview-down` tolerates missing or malformed state when the owned projection
marker contains a non-null generation-bound launcher record. The disposable
launcher waits while `preview-up` atomically records its PID, PGID, birth
identity, and generation in the marker and state, then publishes a fully
written gate containing that exact generation. Its observer ignores absent,
empty, and wrong-generation gates and records the same tuple for backend,
frontend, and engine children. A recording failure kills the still-stopped
child group before the launcher fails. Teardown quiesces the launcher,
fresh-reads and merges service records until two consecutive reads match,
stops every matching group, and proves both recorded process and listener
counts are zero before deleting state. Failure retains state and the temporary
tree; a present malformed service record also fails this proof and is named.
Cwd remains only a secondary ownership check.

Known residual: detached services become schedulable for a microsecond-scale
window between spawn and the observer's immediate `SIGSTOP` plus durable
record. A launcher death in that window can leave an unrecorded group. The
existing stop-and-kill-on-record-failure logic narrows the window;
`preview-down` reports any listener on preview ports that it cannot attribute
and refuses to claim a clean teardown.

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
- isolated launcher `HOME`, `PATH`, and `TMPDIR`; `NODE_ENV` is absent — the
  ambient allowlist never carries it through;
- a separately computed strict vendored-build environment (`HOME`, the same
  shim-first `PATH`, build-only `NODE_ENV`, `PORT`, the same isolated `TMPDIR`,
  and optional `LANG`/`CI`) used only by the prebuild and freshness checker.
  Its `TMPDIR` and `PATH` must equal the launcher's, because the launcher
  re-fingerprints those values when it re-checks the prebuilt bundle;
- only the ambient interoperability variables named by the allowlist above. The
  allowlist supersedes the earlier credential-name scrubber for the preview
  environment: nothing outside the allowlist reaches a preview service, so
  auth/PAT/key/token/secret/password/credential names and database secrets such
  as `PGPASSWORD`, `MYSQL_PWD`, and `DATABASE_URL` are dropped by construction.
  The name-based scrubber is still what filters the non-preview launcher's own
  vendored-build environment.

The example values are in `deploy/preview/preview.env.example`; `preview-up`
replaces the state paths with its unique temporary root. Startup succeeds only
after the backend `/health`, web root, and workflow engine `/api/health` all
answer successfully. It then prints those URLs, the spawned root PID, and the
log location.

Preview startup never runs `npm install`. It requires the already-installed
backend `tsx` and frontend `next` entrypoints. When `web/tsconfig.json` exists,
it also requires TypeScript plus the React and Node type packages that Next
would otherwise try to repair automatically. Preview fails clearly before
launch when any required package is missing. Normal `start.mjs` launches retain
their existing install/update behaviour.

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

The launcher has exactly one exit owner. The first explicit signal starts the
graceful shutdown; a second latches forced mode and hands the exit to the
forced-shutdown coordinator. When a force cannot be verified — a supervisor
group that will not die, or an owned process group still alive after the force
deadline — the launcher prints `forced shutdown incomplete: …; send another
signal to retry` and deliberately stays alive so a later signal retries it.
Every other path that would otherwise end the process defers to that
coordinator while the retry hold is in place: the graceful shutdown, the
boot-time caller that is still inside the workflow engine's build/readiness
window, and `fail()`. A launcher that exits during the hold would abandon the
owned supervisor trees the hold exists to reap. The hold defers only that
deliberate handoff: a genuine crash during the hold — any non-sentinel
`uncaughtException` or `unhandledRejection` — still prints its stack and ends
the launcher with exit 1, because a launcher whose own state is unsound cannot
be trusted to retry the force.

Afterward, `preview-down` runs scoped `pgrep -f` checks for
`kady-workflow-supervisor`, `tsx/dist/preflight.cjs`, and
`vendor/pipeline-engine`. Candidate command/environment records must also contain
one of this preview's unique state paths, so an unrelated Kady checkout is not
claimed. Teardown fails unless all three scoped counts are zero. The temporary
state tree is then removed; pass `--keep-state` to retain its logs after the
zero-process proof.

## Operator verification

This recipe proves on a live stack that teardown refuses an incomplete service
record instead of half-tearing the generation down. It uses an isolated port set
so it never collides with a default preview. Every path below is read out of the
published state; do not hard-code one.

```bash
node scripts/preview-up.mjs \
  --backend-port 18100 --frontend-port 13100 --engine-port 13191

# The exact file readPreviewServiceStateSnapshot reads, plus a byte copy.
SERVICE_STATE=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("deploy/preview/.state.json","utf-8")).serviceStatePath)')
GENERATION=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("deploy/preview/.state.json","utf-8")).generation)')
cp "$SERVICE_STATE" "$SERVICE_STATE.operator-backup"
```

Corrupt the record to one classified status at a time and rerun teardown. Each
run must exit nonzero, name the status, and retain every artifact:

```bash
# invalid: right generation, wrong shape.
printf '%s' "{\"generation\":\"$GENERATION\",\"services\":[]}" > "$SERVICE_STATE"
# malformed: truncated JSON.
printf '{' > "$SERVICE_STATE"
# generation-mismatch: well-formed, wrong generation.
printf '%s' '{"generation":"00000000-0000-0000-0000-000000000000","services":{}}' > "$SERVICE_STATE"

node scripts/preview-down.mjs; echo "exit=$?"     # expect exit 1 + the status name
ls -d web/.preview deploy/preview/.state.json     # both retained
lsof -nP -iTCP:18100 -iTCP:13100 -iTCP:13191 -sTCP:LISTEN
```

Read the refusal's blast radius honestly. `preview-down` stops the recorded
launcher group *before* its first service-state read, so on a stack whose
launcher is still running the launcher's own teardown will already have drained
the services by the time the refusal prints; what the refusal proves there is
that state, projection, and temporary tree are retained and the lock is
released. To see the refusal signal nothing at all, reproduce the crash case:
`kill -KILL` the recorded launcher PID first, so the detached service groups are
orphaned and keep listening. Teardown then finds no live launcher group, refuses
on the first read, and leaves all three recorded service PIDs alive with their
listeners bound.

Restore the byte copy and tear down for real:

```bash
mv "$SERVICE_STATE.operator-backup" "$SERVICE_STATE"
node scripts/preview-down.mjs; echo "exit=$?"     # expect exit 0
lsof -nP -iTCP:18100 -iTCP:13100 -iTCP:13191 -sTCP:LISTEN   # expect no output
ls -d web/.preview deploy/preview/.state.json deploy/preview/.lifecycle.lock.d
```

The final teardown removes the projection, the lifecycle state, and the
temporary tree; the last `ls` must report all three as absent. A refused
teardown still releases the lifecycle lock on exit, so `.lifecycle.lock.d` is
absent throughout. If it is not, the lock is held by a dead PID or has an
unreadable owner; recover it with one explicit
`node scripts/preview-down.mjs --recover-lock` (adding `--force` only for the
missing/unreadable-owner case described under Recovery) before rerunning.
