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
#        claude.large  -> { model claude-opus-4-8[1m], effort max }
#        pi.large      -> { model openrouter/anthropic/claude-opus-4.8, effort xhigh }
#        pi.small/medium/large model refs -> openrouter/anthropic/... (route Pi
#        via OpenRouter with the K-Dense catalogue). The `effort` on the large
#        tier is the DEFAULT reasoning effort Archon reads for each assistant —
#        there is NO per-assistant `assistants.<x>.effort` field (the config
#        parsers read only `model`). tier-defaults.json is imported directly by
#        model-validation.ts and compiled into the bundle by `bun run build:web`
#        — it is NOT part of the `.archon/*/defaults/` scan, so
#        `bun run generate:bundled` is NOT required for this file.
#   3. ~/.archon/config.yaml (ARCHON_HOME/config.yaml)
#        assistants.claude.model -> claude-opus-4-8[1m]
#        assistants.pi.model     -> openrouter/anthropic/claude-opus-4.8
#        tiers.large -> { provider claude, model claude-opus-4-8[1m], effort max }
#        (all seeded only if the key is absent; existing aliases:/tiers: and any
#        user-customized model/tier are preserved.)
#
# EFFORT NOTE (xhigh vs max): the authoritative effort is 'xhigh', but Archon's
# Claude effort vocabulary is {low, medium, high, max} — 'xhigh' is INVALID for
# Claude (rejected on write, dropped on run). Claude's top valid effort is
# 'max'; Pi maps 'max' -> 'xhigh' natively. So Claude tiers get effort 'max' and
# Pi tiers get effort 'xhigh'. See the CLAUDE_TIER_EFFORT block below.
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

# Default reasoning-effort per assistant.
#
# IMPORTANT — Archon reads a DEFAULT reasoning effort ONLY at the tier/alias
# level (tier-defaults.json `effort` + config `tiers:`/`aliases:` `effort`,
# routed at run time by routePresetEffort() in
# packages/workflows/src/model-validation.ts). There is NO per-assistant
# default-effort field: parseClaudeConfig / parsePiConfig read only `model`,
# and SAFE_ASSISTANT_FIELDS in packages/core/src/config/config-loader.ts is
# ['model'] for both claude and pi. So `assistants.claude.effort` /
# `assistants.pi.effort` would be SILENTLY DROPPED. We therefore set the
# default effort on the `large` tier, which is the seam Archon actually reads.
#
# 'xhigh' caveat — the requested authoritative effort is 'xhigh', but Claude's
# effort vocabulary (CLAUDE_EFFORTS in model-validation.ts; effortLevelSchema
# in schemas/dag-node.ts) is {low, medium, high, max} — it does NOT include
# 'xhigh'. The write path (isEffortValidForProvider) REJECTS a claude tier with
# effort 'xhigh', and the run path (routePresetEffort -> null) DROPS it with a
# warning. Claude's top valid effort is 'max', which Pi maps to 'xhigh' anyway
# (normalizeToThinkingLevel: 'max' -> 'xhigh'). So:
#   - Claude tier effort = 'max'   (Claude's top; the valid stand-in for xhigh)
#   - Pi tier effort     = 'xhigh'  (Pi's native ThinkingLevel; xhigh is valid)
CLAUDE_TIER_EFFORT="max"
PI_TIER_EFFORT="xhigh"

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

# --- (2b) tier-defaults.json: default reasoning effort on the large tier -----
# This is the level Archon ACTUALLY reads a default effort (see the
# CLAUDE_TIER_EFFORT / PI_TIER_EFFORT comment block above). We add `effort` to
# the claude.large and pi.large entries in place, only if not already present.
# Both edits are scoped to their own provider block and guarded so re-runs are
# no-ops. Python (json) is used for a structural, key-precise edit that can't
# accidentally touch another provider's identical model string.
if command -v python3 >/dev/null 2>&1; then
  TIER_DEFAULTS="$TIER_DEFAULTS" \
  CLAUDE_TIER_EFFORT="$CLAUDE_TIER_EFFORT" \
  PI_TIER_EFFORT="$PI_TIER_EFFORT" \
  python3 - <<'PY'
import json, os, sys

path = os.environ["TIER_DEFAULTS"]
claude_effort = os.environ["CLAUDE_TIER_EFFORT"]
pi_effort = os.environ["PI_TIER_EFFORT"]

with open(path) as f:
    data = json.load(f)

changed = False
for provider, effort in (("claude", claude_effort), ("pi", pi_effort)):
    large = data.get(provider, {}).get("large")
    if not isinstance(large, dict):
        print(f"  [tier-defaults] {provider}.large missing or malformed — skip effort")
        continue
    if large.get("effort") == effort:
        print(f"  [tier-defaults] {provider}.large.effort already {effort!r} (skip)")
        continue
    large["effort"] = effort
    changed = True
    print(f"  [tier-defaults] {provider}.large.effort -> {effort}")

if changed:
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    print(f"  [tier-defaults] wrote {path}")
else:
    print("  [tier-defaults] effort already applied (no changes)")
PY
else
  echo "  WARN [tier-defaults] python3 not found — large-tier effort NOT set "\
       "(set claude.large.effort=$CLAUDE_TIER_EFFORT / pi.large.effort=$PI_TIER_EFFORT by hand)" >&2
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
  CLAUDE_TIER_EFFORT="$CLAUDE_TIER_EFFORT" \
  python3 - <<'PY'
import os, sys
try:
    import yaml
except ImportError:
    print("  [config.yaml] pyyaml not installed — skipping config seeding "
          "(set assistants.claude.model / assistants.pi.model + tiers.large by hand)")
    sys.exit(0)

path = os.environ["CONFIG_YAML"]
claude_model = os.environ["CLAUDE_MODEL"]
pi_model = os.environ["PI_MODEL"]
claude_tier_effort = os.environ["CLAUDE_TIER_EFFORT"]

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
# assistants.<agent>.model — seeded only if ABSENT (never clobbers a user's
# customized model on re-run; this is the script's documented contract). On a
# clean clone (no config.yaml) this writes the K-Dense defaults.
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

# tiers.large — the install-level seam that carries the DEFAULT Claude effort
# (assistants.<agent>.effort is NOT read by Archon — see the script header).
# 'xhigh' is invalid for Claude (CLAUDE_EFFORTS = {low,medium,high,max}); the
# valid stand-in is 'max'. Seeded only if `tiers.large` is ABSENT so a user's
# own large-tier override is preserved on re-run.
tiers = data.get("tiers")
if not isinstance(tiers, dict):
    tiers = {}
if "large" in tiers:
    print("  [config.yaml] tiers.large already set (skip)")
else:
    tiers["large"] = {
        "provider": "claude",
        "model": claude_model,
        "effort": claude_tier_effort,
    }
    data["tiers"] = tiers
    changed = True
    print(f"  [config.yaml] tiers.large -> provider=claude model={claude_model} "
          f"effort={claude_tier_effort}")

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
