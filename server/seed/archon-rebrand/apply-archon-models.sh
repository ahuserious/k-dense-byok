#!/bin/sh
# apply-archon-models.sh — Reproducible model overlay for a live Archon clone.
#
# Adds the Claude-Code models (Opus 4.8 1M default + Fable 5) to the console
# model picker, points the Claude `large` tier at Opus 4.8 1M, and routes Pi
# (the community provider) through OpenRouter using K-Dense / Kady's catalogue
# so a clean clone reproduces the exact model wiring K-Dense ships with.
#
# Usage:   sh apply-archon-models.sh [ARCHON_DIR]
#          ARCHON_DIR defaults to /Users/DanBot/Archon
#
# IDEMPOTENT: every edit greps for the already-applied state first and skips if
# present, so re-running is a no-op. The config.yaml seeding only sets keys that
# are ABSENT and preserves everything else (including any existing aliases:/tiers:
# blocks). Re-running never overwrites a user-customised model.
#
# AUTHORITATIVE model ids (from the environment, do not change):
#   Opus 4.8 1M           = claude-opus-4-8[1m]
#   Fable 5               = claude-fable-5
#   Pi/OpenRouter default = openrouter/anthropic/claude-opus-4.8
#
# What this script touches:
#   1. packages/web/src/experiments/console/lib/model-options.ts
#        CLAUDE_MODEL_OPTIONS — prepend Opus 4.8 1M (default) + Fable 5.
#   2. packages/workflows/src/defaults/tier-defaults.json
#        claude.large  -> claude-opus-4-8[1m]
#        pi.small/medium/large -> openrouter/anthropic/... refs (route Pi via
#        OpenRouter with the K-Dense catalogue). tier-defaults.json is imported
#        directly by model-validation.ts (`import ... from './defaults/...json'`)
#        and compiled into the bundle by `bun run build:web` — it is NOT part of
#        the `.archon/*/defaults/` scan, so `bun run generate:bundled` is NOT
#        required for this file. (generate:bundled only refreshes embedded
#        commands/workflows, not this JSON.)
#   3. ~/.archon/config.yaml (ARCHON_HOME/config.yaml)
#        assistants.claude.model -> claude-opus-4-8[1m]
#        assistants.pi.model     -> openrouter/anthropic/claude-opus-4.8
#        (seeded only if absent; existing aliases:/tiers: preserved.)
#
# Pi subagents / project agents (NOTE — no copy performed here):
#   Pi resolves a project's subagents from the per-project `.agents/skills`
#   mirror that prep.ts already writes (sandbox `.pi/agents` -> Archon-resolvable
#   `.agents/skills`). That per-project mirror already covers the 4 infra skills
#   + the scientific skills for every project the builder operates on, so the
#   GLOBAL builder needs NO extra copy step here. This comment documents that the
#   skills resolve via the existing prep.ts mirror; do not duplicate that work.

set -eu

ARCHON_DIR="${1:-/Users/DanBot/Archon}"

WEB="$ARCHON_DIR/packages/web"
MODEL_OPTIONS="$WEB/src/experiments/console/lib/model-options.ts"
TIER_DEFAULTS="$ARCHON_DIR/packages/workflows/src/defaults/tier-defaults.json"

# ARCHON_HOME mirrors Archon's own resolution (default ~/.archon).
ARCHON_HOME="${ARCHON_HOME:-$HOME/.archon}"
CONFIG_YAML="$ARCHON_HOME/config.yaml"

# Authoritative ids — single source of truth for this script.
OPUS_1M="claude-opus-4-8[1m]"
FABLE_5="claude-fable-5"
PI_OPENROUTER_LARGE="openrouter/anthropic/claude-opus-4.8"
PI_OPENROUTER_MEDIUM="openrouter/anthropic/claude-sonnet-4.6"
PI_OPENROUTER_SMALL="openrouter/anthropic/claude-haiku-4.5"

# --- preflight: fail fast if the clone or any source target is missing -------
for f in "$MODEL_OPTIONS" "$TIER_DEFAULTS"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: expected file not found: $f" >&2
    echo "Is '$ARCHON_DIR' a valid Archon clone?" >&2
    exit 1
  fi
done

echo "Applying Archon model overlay at: $ARCHON_DIR"

# --- (1) model-options.ts: prepend Opus 4.8 1M (default) + Fable 5 ----------
# Match the exact original first line of CLAUDE_MODEL_OPTIONS and insert the two
# new entries before it. Grep-guarded on the Opus 4.8 1M value so re-runs skip.
if grep -qF "value: '$OPUS_1M'" "$MODEL_OPTIONS"; then
  echo "  [model-options] Claude models already include Opus 4.8 1M (skip)"
else
  # perl literal-string replace; the bracketed id contains no regex metachars
  # that matter here, but we still avoid interpolation by using \Q..\E.
  perl -0pi -e "s/\Qexport const CLAUDE_MODEL_OPTIONS: readonly ModelOption[] = [\E\n\Q  { value: 'sonnet' },\E/export const CLAUDE_MODEL_OPTIONS: readonly ModelOption[] = [\n  { value: '$OPUS_1M', hint: '1M context \xc2\xb7 default' },\n  { value: '$FABLE_5' },\n  { value: 'sonnet' },/" "$MODEL_OPTIONS"
  if grep -qF "value: '$OPUS_1M'" "$MODEL_OPTIONS"; then
    echo "  [model-options] prepended Opus 4.8 1M (default) + Fable 5 to CLAUDE_MODEL_OPTIONS"
  else
    echo "  ERROR [model-options] anchor not found — CLAUDE_MODEL_OPTIONS shape changed; edit by hand" >&2
    exit 1
  fi
fi

# --- (2) tier-defaults.json: claude.large + pi tiers -----------------------
# claude.large -> Opus 4.8 1M (replaces the removed-from-default 'opus').
if grep -qF "\"model\": \"$OPUS_1M\"" "$TIER_DEFAULTS"; then
  echo "  [tier-defaults] claude.large already Opus 4.8 1M (skip)"
else
  perl -0pi -e 's/("large":\s*\{\s*"model":\s*)"opus"/$1"claude-opus-4-8[1m]"/' "$TIER_DEFAULTS"
  if grep -qF "\"model\": \"$OPUS_1M\"" "$TIER_DEFAULTS"; then
    echo "  [tier-defaults] claude.large -> Opus 4.8 1M"
  else
    echo "  ERROR [tier-defaults] claude.large anchor ('opus') not found — edit by hand" >&2
    exit 1
  fi
fi

# pi tiers -> OpenRouter refs (route Pi through OpenRouter with Kady's catalogue).
# IMPORTANT: scope the rewrite to the "pi": { ... } block ONLY. The "opencode"
# block uses the IDENTICAL "anthropic/claude-*" model strings, and a global
# replace would wrongly route OpenCode through OpenRouter too. We isolate the pi
# block (from "pi": {  to its closing },) and only substitute inside it.
# Guard on the large ref so re-runs skip.
if grep -qF "$PI_OPENROUTER_LARGE" "$TIER_DEFAULTS"; then
  echo "  [tier-defaults] pi tiers already routed through OpenRouter (skip)"
else
  perl -0777 -pi -e '
    s{("pi"\s*:\s*\{.*?\n\s*\})}{
      my $block = $1;
      $block =~ s/"anthropic\/claude-haiku-4-5"/"openrouter\/anthropic\/claude-haiku-4.5"/;
      $block =~ s/"anthropic\/claude-sonnet-4-6"/"openrouter\/anthropic\/claude-sonnet-4.6"/;
      $block =~ s/"anthropic\/claude-opus-4-7"/"openrouter\/anthropic\/claude-opus-4.8"/;
      $block;
    }es' "$TIER_DEFAULTS"
  if grep -qF "$PI_OPENROUTER_LARGE" "$TIER_DEFAULTS"; then
    echo "  [tier-defaults] pi small/medium/large -> openrouter/anthropic/* refs"
  else
    echo "  WARN [tier-defaults] pi anthropic refs not found in expected form — pi tiers left as-is" >&2
  fi
fi

# --- (3) ~/.archon/config.yaml: seed default assistant models --------------
# Seed assistants.claude.model and assistants.pi.model ONLY if those exact keys
# are absent. Done in Python (pyyaml) so existing keys — including any aliases:
# or tiers: blocks — are preserved structurally. No-op when both keys exist.
if command -v python3 >/dev/null 2>&1; then
  mkdir -p "$ARCHON_HOME"
  CONFIG_YAML="$CONFIG_YAML" \
  CLAUDE_MODEL="$OPUS_1M" \
  PI_MODEL="$PI_OPENROUTER_LARGE" \
  python3 - <<'PY'
import os, sys
try:
    import yaml
except ImportError:
    print("  [config.yaml] pyyaml not installed — skipping config seeding "
          "(set assistants.claude.model / assistants.pi.model by hand)")
    sys.exit(0)

path = os.environ["CONFIG_YAML"]
claude_model = os.environ["CLAUDE_MODEL"]
pi_model = os.environ["PI_MODEL"]

data = {}
if os.path.exists(path):
    with open(path) as f:
        loaded = yaml.safe_load(f)
    if isinstance(loaded, dict):
        data = loaded
    elif loaded is not None:
        print(f"  [config.yaml] top-level is not a mapping ({type(loaded).__name__}) "
              "— refusing to edit; set the assistant models by hand")
        sys.exit(0)

assistants = data.get("assistants")
if not isinstance(assistants, dict):
    assistants = {}

changed = False
for agent, model in (("claude", claude_model), ("pi", pi_model)):
    section = assistants.get(agent)
    if not isinstance(section, dict):
        section = {}
    if "model" in section:
        print(f"  [config.yaml] assistants.{agent}.model already set (skip)")
        assistants[agent] = section
        continue
    section["model"] = model
    assistants[agent] = section
    changed = True
    print(f"  [config.yaml] assistants.{agent}.model -> {model}")

if changed:
    data["assistants"] = assistants
    with open(path, "w") as f:
        yaml.safe_dump(data, f, default_flow_style=False, sort_keys=False)
    print(f"  [config.yaml] wrote {path}")
else:
    print("  [config.yaml] no changes needed")
PY
else
  echo "  [config.yaml] python3 not found — skipping config seeding "\
       "(set assistants.claude.model / assistants.pi.model by hand)" >&2
fi

echo "Archon model overlay complete."
