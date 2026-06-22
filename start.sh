#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

echo "============================================"
echo "  Kady — Starting up"
echo "============================================"
echo

# ---- Step 1: Check & install missing tools ----

echo "Checking dependencies..."

# Node.js — runs the backend, the frontend, and the embedded Pi agent.
if ! command -v node &>/dev/null; then
    if ! command -v brew &>/dev/null; then
        echo "  Node.js not found and Homebrew is not available to install it."
        echo "  Please install Node.js (>= 22.19) manually: https://nodejs.org/"
        exit 1
    fi
    echo "  Node.js not found — installing via Homebrew..."
    brew install node
else
    NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
    NODE_MINOR=$(node -p "process.versions.node.split('.')[1]")
    # Node < 22 fails to build/install the packages, so stop here rather
    # than let npm install crash with a confusing error later.
    if [ "$NODE_MAJOR" -lt 22 ]; then
        echo "  ✗ Node.js $(node -v) is too old — Kady needs Node.js >= 22 to"
        echo "    build and install its packages."
        if command -v brew &>/dev/null; then
            echo "    Upgrade with 'brew install node', then run ./start.sh again."
        else
            echo "    Upgrade via https://nodejs.org/ or your version manager"
            echo "    (e.g. 'nvm install 22'), then run ./start.sh again."
        fi
        exit 1
    fi
    echo "  Node.js ✓ ($(node -v))"
    if [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 19 ]; then
        echo "  ⚠ Pi recommends Node >= 22.19; you have $(node -v). It usually still works."
    fi
fi

# uv — the agent runs all sandbox Python through uv (`uv run`, `uv add`).
# Without it, every Python task the agent attempts will fail.
if command -v uv &>/dev/null || [ -x "$HOME/.local/bin/uv" ]; then
    echo "  uv ✓"
else
    echo "  uv not found — installing..."
    if command -v brew &>/dev/null; then
        brew install uv
    else
        curl -LsSf https://astral.sh/uv/install.sh | sh
    fi
fi
# The official installer puts uv in ~/.local/bin; make it visible to the
# backend and the sandbox sessions we spawn below.
export PATH="$HOME/.local/bin:$PATH"

# git — used to download the scientific skills catalogue during prep.
if command -v git &>/dev/null; then
    echo "  git ✓"
else
    echo "  ⚠ git not found — the skills catalogue download will be skipped."
    echo "    Install git (e.g. 'xcode-select --install' on macOS) to get skills."
fi

# python3 — only used for the .h5ad file-preview helper; everything else
# goes through uv. Warn, don't block.
if command -v python3 &>/dev/null; then
    echo "  python3 ✓"
else
    echo "  ⚠ python3 not found — .h5ad previews in the file panel won't work."
fi

# curl — used for the Ollama check and the startup health checks below.
if command -v curl &>/dev/null; then
    echo "  curl ✓"
else
    echo "  ⚠ curl not found — skipping the Ollama check and startup health checks."
fi

# Pi itself needs no separate install: it's an npm dependency of server/
# (@earendil-works/pi-coding-agent), installed/updated by npm install below.
echo "  Pi agent ✓ (bundled with backend packages — no global install needed)"

echo

# ---- Step 2: Install / update packages ----
# npm install is idempotent: first run installs everything (including the Pi
# SDK), later runs pick up dependency changes after a git pull.

install_packages() {
    local dir=$1 label=$2
    echo "Installing $label packages..."
    if ! (cd "$dir" && npm install --no-audit --no-fund --loglevel=error); then
        echo
        echo "  ✗ Installing the $label packages failed (see the error above)."
        echo "    The most common cause is a network problem — check your internet"
        echo "    connection and run ./start.sh again. If it keeps failing, run"
        echo "    'cd $dir && npm install' to see the full error, or report it at"
        echo "    https://github.com/K-Dense-AI/k-dense-byok/issues"
        exit 1
    fi
}

install_packages server "backend"
install_packages web "frontend"

echo

# ---- Step 3: Environment variables ----
# Keys live in a root .env (or kady_agent/.env, the legacy location). The
# backend auto-loads these via src/env.ts; exporting here covers the frontend
# and any child processes too.

if [ ! -f .env ] && [ ! -f kady_agent/.env ] && [ -f .env.example ]; then
    echo "No .env found — creating one from .env.example."
    cp .env.example .env
    echo "  → Edit .env and set OPENROUTER_API_KEY (or run a local Ollama)."
fi

if [ -f .env ]; then
    echo "Loading environment from .env..."
    set -a; source .env; set +a
elif [ -f kady_agent/.env ]; then
    echo "Loading environment from kady_agent/.env..."
    set -a; source kady_agent/.env; set +a
fi

# Sanity check: the agent needs OpenRouter or a reachable Ollama to do anything.
OLLAMA_URL="${OLLAMA_BASE_URL:-http://localhost:11434}"
if [ -z "$OPENROUTER_API_KEY" ]; then
    if curl -s --max-time 2 "$OLLAMA_URL/api/tags" &>/dev/null; then
        echo "  No OPENROUTER_API_KEY set — using local Ollama at $OLLAMA_URL."
    else
        echo
        echo "  ⚠ No OPENROUTER_API_KEY in .env and no Ollama at $OLLAMA_URL."
        echo "    The UI will start, but the agent cannot run until you either:"
        echo "      - add OPENROUTER_API_KEY to .env (https://openrouter.ai/keys), or"
        echo "      - start a local Ollama (https://ollama.com) with a pulled model."
        echo
    fi
fi

# ---- Step 4: Make sure the ports are free ----
# A previous run that didn't shut down cleanly can leave processes holding the
# ports, and the services would otherwise crash confusingly later. Leftovers
# from this project are stopped automatically; anything else gets a clear
# message naming the program in the way.

BACKEND_PORT="${KADY_PORT:-8000}"
FRONTEND_PORT="${KADY_FRONTEND_PORT:-3000}"

free_port() {
    local port=$1 label=$2
    command -v lsof &>/dev/null || return 0
    local pids pid cwd cmd
    pids=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | sort -u) || true
    [ -z "$pids" ] && return 0
    for pid in $pids; do
        # If the process was started from inside this project folder, it's a
        # leftover from a previous run — safe to stop.
        cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
        if [ -n "$cwd" ] && [[ "$cwd" == "$PWD"* ]]; then
            echo "  Stopping a leftover Kady process on port $port (PID $pid)..."
            kill "$pid" 2>/dev/null || true
            for _ in 1 2 3 4 5; do
                kill -0 "$pid" 2>/dev/null || break
                sleep 1
            done
            kill -9 "$pid" 2>/dev/null || true
        else
            cmd=$(ps -o comm= -p "$pid" 2>/dev/null || true)
            echo
            echo "  ✗ Port $port is already in use by: ${cmd:-another program} (PID $pid)."
            echo "    The $label needs this port. Quit that program, then run"
            echo "    ./start.sh again. (Restarting your computer also clears it.)"
            exit 1
        fi
    done
}

free_port "$BACKEND_PORT" "backend"
free_port "$FRONTEND_PORT" "app UI"

# ---- Step 5: Prepare projects + skills ----

echo "Preparing projects (ensures default project, downloads scientific skills from K-Dense)..."
(cd server && npm run prep --silent) || echo "  (skills download skipped/failed — continuing)"

echo

# ---- Step 6: Start services ----

echo "Starting services..."
echo

echo "  → Backend on port $BACKEND_PORT (Pi agent, TypeScript)"
(cd server && npm run start) &
BACKEND_PID=$!

echo "  → Frontend on port $FRONTEND_PORT (Next.js UI)"
(cd web && npm run dev -- -p "$FRONTEND_PORT") &
FRONTEND_PID=$!

cleanup() {
    # Ignore the signal we're about to send to our own process group.
    trap '' INT TERM
    echo
    echo "Shutting down..."
    # Kill the whole process group — the services and every child they
    # spawned — so nothing is left holding the ports for the next start.
    # Fall back to the direct PIDs if we're not the group leader.
    if ! kill -- -$$ 2>/dev/null; then
        command -v pkill &>/dev/null && {
            pkill -TERM -P "$BACKEND_PID" 2>/dev/null || true
            pkill -TERM -P "$FRONTEND_PID" 2>/dev/null || true
            [ -n "$ARCHON_PID" ] && pkill -TERM -P "$ARCHON_PID" 2>/dev/null || true
        }
        # ARCHON_PID is only set when start.sh launched the sidecar itself; a
        # reused (already-running) Archon is intentionally left alone.
        kill "$BACKEND_PID" "$FRONTEND_PID" ${ARCHON_PID:+"$ARCHON_PID"} 2>/dev/null || true
    fi
    wait 2>/dev/null || true
    exit "${1:-0}"
}
trap cleanup INT TERM

# Wait until a service actually answers before declaring success. Any HTTP
# response counts — we only care that it's up and listening.
wait_for() {
    local url=$1 pid=$2 label=$3 timeout=$4
    command -v curl &>/dev/null || { sleep 3; return 0; }
    local i=0
    while [ "$i" -lt "$timeout" ]; do
        if ! kill -0 "$pid" 2>/dev/null; then
            echo
            echo "  ✗ The $label stopped unexpectedly while starting."
            echo "    Scroll up for its error message, then run ./start.sh again."
            echo "    If you're stuck, report the error at"
            echo "    https://github.com/K-Dense-AI/k-dense-byok/issues"
            cleanup 1
        fi
        if curl -s -o /dev/null --max-time 2 "$url"; then
            return 0
        fi
        sleep 1
        i=$((i + 1))
    done
    echo "  ⚠ The $label is taking longer than expected — it may still be starting."
    return 0
}

echo
echo "Waiting for services to come up (the first run can take a minute)..."
wait_for "http://localhost:$BACKEND_PORT/" "$BACKEND_PID" "backend" 120
wait_for "http://localhost:$FRONTEND_PORT/" "$FRONTEND_PID" "app UI" 180

# ---- Step 7: Pipeline Builder (Archon) sidecar ----
# Optional companion service. It's launched last and is entirely non-fatal:
# any failure here prints a warning and leaves Kady itself running. A clean
# reimport that drops an Archon checkout next to this repo stands it up
# automatically; if the checkout is absent, this whole block is skipped.

ARCHON_PORT="${ARCHON_PORT:-3091}"
# Default to the sibling checkout (../Archon relative to this repo); override
# with ARCHON_DIR. PWD is the repo root here (we cd'd to it at the top).
ARCHON_DIR="${ARCHON_DIR:-$PWD/../Archon}"
ARCHON_HEALTH_URL="http://127.0.0.1:$ARCHON_PORT/api/health"

# archon_health_ok: succeeds only when the URL answers with an "ok" status.
# Used both to decide whether to reuse an existing instance and to poll our own.
archon_health_ok() {
    command -v curl &>/dev/null || return 1
    curl -s --max-time 2 "$ARCHON_HEALTH_URL" 2>/dev/null | grep -q '"status":[[:space:]]*"ok"'
}

echo
if [ ! -d "$ARCHON_DIR" ]; then
    echo "  → Pipeline Builder (Archon) not found at $ARCHON_DIR — skipping (set ARCHON_DIR to enable)."
elif ! command -v bun &>/dev/null; then
    # The sidecar is a bun project; without bun we can't build or run it.
    echo "  ⚠ Pipeline Builder (Archon) found but 'bun' is not installed — skipping the sidecar."
    echo "    Install bun (https://bun.sh) to enable it, then run ./start.sh again."
elif archon_health_ok; then
    # Something already healthy on this port — reuse it, don't duplicate or kill it.
    echo "  → Pipeline Builder (Archon) already running on :$ARCHON_PORT — reusing it."
else
    echo "  → Pipeline Builder (Archon) on port $ARCHON_PORT (building if needed)..."

    # One-time build, marker-guarded so repeat starts are fast. The rebrand
    # overlay is applied once, just before the first web build, so the built
    # assets carry the K-Dense branding.
    if [ ! -f "$ARCHON_DIR/.archon-web-built" ]; then
        REBRAND_SCRIPT="$PWD/server/seed/archon-rebrand/apply-rebrand.sh"
        if [ -f "$REBRAND_SCRIPT" ]; then
            echo "    Applying K-Dense rebrand overlay..."
            sh "$REBRAND_SCRIPT" "$ARCHON_DIR" || echo "    ⚠ Rebrand overlay failed — continuing with stock branding."
        else
            echo "    ⚠ Rebrand overlay script not found at $REBRAND_SCRIPT — building with stock branding."
        fi
        echo "    Installing Archon packages and building the web bundle (first run only)..."
        if (cd "$ARCHON_DIR" && bun install && bun run build:web); then
            : > "$ARCHON_DIR/.archon-web-built"
        else
            echo "  ⚠ Pipeline Builder (Archon) build failed — skipping the sidecar (Kady is unaffected)."
        fi
    fi

    # Only launch if the build marker exists (i.e. the build above, or a prior
    # run, succeeded). Otherwise we'd start a server with no web bundle.
    if [ -f "$ARCHON_DIR/.archon-web-built" ]; then
        # CLAUDECODE is unset so the embedded agent doesn't think it's nested
        # inside Claude Code; PORT/HOST pin it to a loopback sidecar on our port.
        (
            cd "$ARCHON_DIR" && \
            unset CLAUDECODE && \
            ARCHON_SUPPRESS_NESTED_CLAUDE_WARNING=1 \
            PORT="$ARCHON_PORT" \
            HOST=127.0.0.1 \
            DEFAULT_AI_ASSISTANT=pi \
            OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
            bun run start
        ) &
        ARCHON_PID=$!

        # Poll the health endpoint for up to ~30s. Non-fatal: a slow or failed
        # start just prints a warning — it never aborts the script.
        if command -v curl &>/dev/null; then
            archon_i=0
            until archon_health_ok; do
                if ! kill -0 "$ARCHON_PID" 2>/dev/null; then
                    echo "  ⚠ Pipeline Builder (Archon) exited during startup — see the log above (Kady is unaffected)."
                    ARCHON_PID=""
                    break
                fi
                archon_i=$((archon_i + 1))
                if [ "$archon_i" -ge 30 ]; then
                    echo "  ⚠ Pipeline Builder (Archon) didn't report healthy within ~30s — it may still be starting."
                    break
                fi
                sleep 1
            done
            archon_health_ok && echo "  Pipeline Builder (Archon) ready on :$ARCHON_PORT"
        else
            echo "  → Pipeline Builder (Archon) launched on :$ARCHON_PORT (curl unavailable — skipping health check)."
        fi
    fi
fi

echo
echo "============================================"
echo "  All services running!"
echo "  UI: http://localhost:$FRONTEND_PORT"
echo "  Press Ctrl+C to stop everything"
echo "============================================"

if command -v open &>/dev/null; then
    open "http://localhost:$FRONTEND_PORT"
elif command -v xdg-open &>/dev/null; then
    xdg-open "http://localhost:$FRONTEND_PORT" &>/dev/null || true
fi

wait
