#!/bin/sh
# apply-debrand.sh — De-brand the embedded Pipeline Builder (Archon) for the
# K-Dense embed and apply a full k-dense color-theme match.
#
# Reproducible overlay: runs against a live Archon clone (after apply-rebrand.sh
# has set the wordmarks/logo) and removes the nav surfaces that don't belong in
# the embed, then injects a committed CSS theme override so a clean clone
# reproduces the de-brand.
#
# Usage:   sh apply-debrand.sh [ARCHON_DIR]
#          ARCHON_DIR defaults to /Users/DanBot/Archon
#
# IDEMPOTENT: every edit greps for the already-applied state first and skips if
# present, so re-running is a no-op. It only ever rewrites the original markup.
#
# What this script does:
#   (1) Remove the "Try the new console UI" Link from TopNav (target /console is
#       now Kady's Agent Console tab).
#   (2) Remove the "Chat" nav tab from the legacy nav (chat stays reachable when
#       Archon is opened standalone/fullscreen — the route is NOT touched).
#   (3) Remove the "Workflows / + New workflow" header row on the list page.
#   (4) Remove the version chip / "update available" string from TopNav.
#   (5) Remove the "Settings" nav tab (settings now live in Kady).
#   (6) Copy kdense-theme.css into Archon's web src and import it LAST in
#       main.tsx (after index.css) so the k-dense grayscale palette wins for the
#       console (/console) AND the legacy/builder surfaces.
#   (7) Seed `defaultAssistant: pi` into ~/.archon/config.yaml so the embedded
#       chatbot defaults to Pi (k-dense-byok pi-coding-agent) while claude-code
#       remains a selectable option. (DEFAULT_AI_ASSISTANT=pi in start.sh is the
#       env fallback; this makes it explicit at the config seam.)

set -eu

ARCHON_DIR="${1:-/Users/DanBot/Archon}"
OVERLAY_DIR="$(cd "$(dirname "$0")" && pwd)"

WEB="$ARCHON_DIR/packages/web"
TOPNAV="$WEB/src/components/layout/TopNav.tsx"
WORKFLOWS_PAGE="$WEB/src/routes/WorkflowsPage.tsx"
MAIN_TSX="$WEB/src/main.tsx"
CONSOLE_THEME="$WEB/src/experiments/console/theme.css"
LAYOUT_TSX="$WEB/src/components/layout/Layout.tsx"

# ARCHON_HOME mirrors Archon's own resolution (default ~/.archon).
ARCHON_HOME="${ARCHON_HOME:-$HOME/.archon}"
CONFIG_YAML="$ARCHON_HOME/config.yaml"

# --- preflight: fail fast if the clone or any target is missing -------------
for f in "$TOPNAV" "$WORKFLOWS_PAGE" "$MAIN_TSX" "$CONSOLE_THEME" "$LAYOUT_TSX"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: expected file not found: $f" >&2
    echo "Is '$ARCHON_DIR' a valid Archon clone (and is the overlay intact)?" >&2
    exit 1
  fi
done

echo "De-branding Archon at: $ARCHON_DIR"
echo "Overlay source:        $OVERLAY_DIR"

# --- (1) TopNav: remove the "Try the new console UI" Link -------------------
# Match the whole <Link to="/console"> ... </Link> CTA block (with its leading
# brand-gradient comment) and delete it. Guard on the inner text.
if grep -q 'Try the new console UI' "$TOPNAV"; then
  perl -0777 -pi -e 's{\n?\s*\{/\* CTA to the experimental console\..*?\*/\}\n\s*<Link\s+to="/console".*?</Link>}{}s' "$TOPNAV"
  if grep -q 'Try the new console UI' "$TOPNAV"; then
    echo "  ERROR [TopNav] /console CTA still present — markup changed; edit by hand" >&2
    exit 1
  fi
  echo "  [TopNav] removed 'Try the new console UI' /console CTA Link"
else
  echo "  [TopNav] /console CTA already removed (skip)"
fi

# --- (2) TopNav: remove the "Chat" nav tab ----------------------------------
# Delete the tabs[] entry. The route in App.tsx is untouched, so /legacy/chat
# stays reachable when Archon runs standalone.
if grep -q "icon: MessageSquare, label: 'Chat'" "$TOPNAV"; then
  perl -0777 -pi -e "s{\n\s*\{ to: '/legacy/chat', end: false, icon: MessageSquare, label: 'Chat' \},}{}s" "$TOPNAV"
  if grep -q "icon: MessageSquare, label: 'Chat'" "$TOPNAV"; then
    echo "  ERROR [TopNav] Chat tab still present — markup changed; edit by hand" >&2
    exit 1
  fi
  echo "  [TopNav] removed the 'Chat' nav tab (route preserved)"
else
  echo "  [TopNav] 'Chat' nav tab already removed (skip)"
fi

# 2b. Drop the now-unused MessageSquare import (the brand logo Link uses an
# <img>, not the icon). Remove it from the lucide-react import only when its
# sole remaining occurrence is that import line — i.e. no JSX/value usage and no
# other text reference outside the import. Counting all matches and comparing to
# the matches on the import line keeps this precise (avoids the import line's own
# "MessageSquare," matching a "still used" pattern).
if grep -q 'LayoutDashboard, MessageSquare, Workflow' "$TOPNAV"; then
  total_msgsq=$(grep -c 'MessageSquare' "$TOPNAV")
  import_msgsq=$(grep -c "from 'lucide-react'" "$TOPNAV")
  if [ "$total_msgsq" = "$import_msgsq" ]; then
    perl -0pi -e 's{LayoutDashboard, MessageSquare, Workflow}{LayoutDashboard, Workflow}' "$TOPNAV"
    echo "  [TopNav] dropped now-unused MessageSquare import"
  else
    echo "  [TopNav] MessageSquare still used elsewhere — import left intact (skip)"
  fi
else
  echo "  [TopNav] MessageSquare import already clean (skip)"
fi

# --- (5) TopNav: remove the "Settings" nav tab ------------------------------
# (Done before the version-chip edit; both touch TopNav but distinct anchors.)
if grep -q "icon: Settings, label: 'Settings'" "$TOPNAV"; then
  perl -0777 -pi -e "s{\n\s*\{ to: '/legacy/settings', end: false, icon: Settings, label: 'Settings' \},}{}s" "$TOPNAV"
  if grep -q "icon: Settings, label: 'Settings'" "$TOPNAV"; then
    echo "  ERROR [TopNav] Settings tab still present — markup changed; edit by hand" >&2
    exit 1
  fi
  echo "  [TopNav] removed the 'Settings' nav tab"
else
  echo "  [TopNav] 'Settings' nav tab already removed (skip)"
fi

# 5b. Drop the now-unused Settings import. Settings is only used by the tab
# entry; once removed, the lucide-react import is orphaned.
if grep -q 'Workflow, Settings, LogOut' "$TOPNAV"; then
  perl -0pi -e 's{Workflow, Settings, LogOut}{Workflow, LogOut}' "$TOPNAV"
  echo "  [TopNav] dropped now-unused Settings import"
else
  echo "  [TopNav] Settings import already clean (skip)"
fi

# --- (4) TopNav: remove the version chip / update-available string ----------
# Delete the <span> that renders v{VITE_APP_VERSION} (+ the update-available
# link). Guard on VITE_APP_VERSION.
if grep -q 'VITE_APP_VERSION' "$TOPNAV"; then
  perl -0777 -pi -e 's{\n\s*<span className="text-xs text-text-secondary">\s*v\{import\.meta\.env\.VITE_APP_VERSION as string\}.*?</span>}{}s' "$TOPNAV"
  if grep -q 'VITE_APP_VERSION' "$TOPNAV"; then
    echo "  ERROR [TopNav] version chip still present — markup changed; edit by hand" >&2
    exit 1
  fi
  echo "  [TopNav] removed the version chip / update-available string"
else
  echo "  [TopNav] version chip already removed (skip)"
fi

# 4b. The version chip was the ONLY consumer of the updateCheck query +
# getUpdateCheck import. Remove both so the embed doesn't poll GitHub for
# updates and lint stays clean (Archon enforces --max-warnings 0).
if grep -q 'getUpdateCheck' "$TOPNAV"; then
  # Remove the useQuery block that defines updateCheck.
  perl -0777 -pi -e 's{\n\s*const \{ data: updateCheck \} = useQuery\(\{.*?\}\);}{}s' "$TOPNAV"
  # Drop getUpdateCheck from the @/lib/api import (it is the middle of three).
  perl -0pi -e 's{listDashboardRuns, getUpdateCheck, getAuthStatus}{listDashboardRuns, getAuthStatus}' "$TOPNAV"
  if grep -q 'getUpdateCheck' "$TOPNAV"; then
    echo "  ERROR [TopNav] getUpdateCheck still referenced — edit by hand" >&2
    exit 1
  fi
  echo "  [TopNav] removed orphaned updateCheck query + getUpdateCheck import"
else
  echo "  [TopNav] updateCheck query / getUpdateCheck import already clean (skip)"
fi

# --- (3) WorkflowsPage: remove the "Workflows / + New workflow" header row --
# Delete the whole header <div> (title + New-workflow Link). The page keeps the
# <WorkflowList /> body below it.
if grep -q 'New Workflow\|New pipeline' "$WORKFLOWS_PAGE"; then
  perl -0777 -pi -e 's{\n\s*<div className="flex items-center justify-between px-4 pt-4 pb-2">.*?</div>}{}s' "$WORKFLOWS_PAGE"
  if grep -q 'New Workflow\|New pipeline' "$WORKFLOWS_PAGE"; then
    echo "  ERROR [WorkflowsPage] header row still present — markup changed; edit by hand" >&2
    exit 1
  fi
  echo "  [WorkflowsPage] removed 'Workflows / + New workflow' header row"
else
  echo "  [WorkflowsPage] header row already removed (skip)"
fi

# 3b. Drop the now-orphaned imports. After the header row is gone, Link and Plus
# are both unused (WorkflowList is the only remaining import in use).
if grep -q "import { Link } from 'react-router';" "$WORKFLOWS_PAGE"; then
  perl -0pi -e "s{import \{ Link \} from 'react-router';\n}{}" "$WORKFLOWS_PAGE"
  echo "  [WorkflowsPage] dropped now-unused Link import"
else
  echo "  [WorkflowsPage] Link import already clean (skip)"
fi
if grep -q "import { Plus } from 'lucide-react';" "$WORKFLOWS_PAGE"; then
  perl -0pi -e "s{import \{ Plus \} from 'lucide-react';\n}{}" "$WORKFLOWS_PAGE"
  echo "  [WorkflowsPage] dropped now-unused Plus import"
else
  echo "  [WorkflowsPage] Plus import already clean (skip)"
fi

# --- (6) theme: keep Archon's own colors, just remove the purple --------------
# Revert any legacy full-neutral override (older overlay versions copied + imported
# kdense-theme.css). We no longer fully re-theme Archon — only de-purple it.
if grep -q "import './kdense-theme.css';" "$MAIN_TSX"; then
  perl -0pi -e "s{\nimport './kdense-theme.css';}{}" "$MAIN_TSX"
  echo "  [theme] removed legacy kdense-theme.css import from main.tsx"
fi
rm -f "$WEB/src/kdense-theme.css"

# De-purple the console theme: repoint brand magenta (hue 330) + violet (hue 305)
# to blue (hue 245), leaving Archon's structure intact. Idempotent — guarded on the
# magenta hue still being present.
if grep -q '0.295 330' "$CONSOLE_THEME"; then
  perl -0pi -e 's{--brand-magenta: oklch\(0\.64 0\.295 330\);}{--brand-magenta: oklch(0.66 0.17 245);}' "$CONSOLE_THEME"
  perl -0pi -e 's{--brand-magenta-2: oklch\(0\.72 0\.26 335\);}{--brand-magenta-2: oklch(0.72 0.16 245);}' "$CONSOLE_THEME"
  perl -0pi -e 's{--brand-violet: oklch\(0\.56 0\.215 305\);}{--brand-violet: oklch(0.62 0.16 245);}' "$CONSOLE_THEME"
  perl -0pi -e 's{--accent-hover: oklch\(0\.7 0\.28 330\);}{--accent-hover: oklch(0.7 0.17 245);}' "$CONSOLE_THEME"
  perl -0pi -e 's{oklch\(0\.64 0\.295 330 / 0\.3\)}{oklch(0.66 0.17 245 / 0.3)}g' "$CONSOLE_THEME"
  perl -0pi -e 's{oklch\(0\.64 0\.295 330 / 0\.14\)}{oklch(0.66 0.17 245 / 0.14)}g' "$CONSOLE_THEME"
  perl -0pi -e 's{oklch\(0\.64 0\.295 330 / 0\.18\)}{oklch(0.66 0.17 245 / 0.18)}g' "$CONSOLE_THEME"
  perl -0pi -e 's{oklch\(0\.56 0\.215 305 / 0\.12\)}{oklch(0.62 0.16 245 / 0.12)}g' "$CONSOLE_THEME"
  echo "  [theme] de-purpled console theme.css (magenta/violet -> blue)"
else
  echo "  [theme] console theme already de-purpled (skip)"
fi

# --- (6b) Layout: remove the top nav row so the embedded canvas is full-bleed --
if grep -q '<TopNav />' "$LAYOUT_TSX"; then
  perl -0pi -e "s{import \{ TopNav \} from './TopNav';\n}{}" "$LAYOUT_TSX"
  perl -0pi -e 's{\n\s*<TopNav />}{}' "$LAYOUT_TSX"
  echo "  [Layout] removed the TopNav row (embedded canvas is full-bleed)"
else
  echo "  [Layout] TopNav row already removed (skip)"
fi

# --- (7) config.yaml: default conversational assistant = pi -----------------
# The K-Dense embed's default conversational assistant MUST be pi. Archon's
# config-loader treats an explicit `defaultAssistant` in ~/.archon/config.yaml as
# higher precedence than the DEFAULT_AI_ASSISTANT=pi env var in start.sh — so a
# leftover stock `defaultAssistant: claude` would silently win and keep claude as
# the default. We therefore set `defaultAssistant: pi` when the key is ABSENT or
# is the stock value `claude` (the value this requirement supersedes), and leave
# any OTHER explicit value (e.g. a deliberate `codex`) untouched. claude-code
# stays selectable in the model picker — this only sets the DEFAULT.
if command -v python3 >/dev/null 2>&1; then
  mkdir -p "$ARCHON_HOME"
  CONFIG_YAML="$CONFIG_YAML" python3 - <<'PY'
import os, sys
try:
    import yaml
except ImportError:
    print("  [config.yaml] pyyaml not installed — skipping defaultAssistant "
          "seeding (set `defaultAssistant: pi` by hand; env fallback still applies)")
    sys.exit(0)

path = os.environ["CONFIG_YAML"]

data = {}
if os.path.exists(path):
    with open(path) as f:
        loaded = yaml.safe_load(f)
    if isinstance(loaded, dict):
        data = loaded
    elif loaded is not None:
        print(f"  [config.yaml] top-level is not a mapping ({type(loaded).__name__}) "
              "— refusing to edit; set `defaultAssistant: pi` by hand")
        sys.exit(0)

current = data.get("defaultAssistant")
if current == "pi":
    print("  [config.yaml] defaultAssistant already 'pi' — skip")
elif current is not None and current != "claude":
    # A deliberate non-stock pick (e.g. 'codex') — preserve it, but warn so the
    # embed-default mismatch is visible rather than silently kept as claude.
    print(f"  [config.yaml] defaultAssistant is {current!r} (not stock 'claude') "
          "— preserved; set it to 'pi' by hand if the embed should default to Pi")
else:
    # Absent, or stock 'claude' which this requirement supersedes -> pi.
    prev = "absent" if current is None else "'claude' (stock)"
    data["defaultAssistant"] = "pi"
    with open(path, "w") as f:
        yaml.safe_dump(data, f, default_flow_style=False, sort_keys=False)
    print(f"  [config.yaml] defaultAssistant {prev} -> pi (wrote {path})")
PY
else
  echo "  [config.yaml] python3 not found — skipping defaultAssistant seeding "\
       "(set \`defaultAssistant: pi\` by hand; env DEFAULT_AI_ASSISTANT=pi still applies)" >&2
fi

echo "De-brand complete."
