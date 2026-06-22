#!/bin/sh
# apply-rebrand.sh — Rebrand a live Archon clone to the K-Dense "Pipeline Builder".
#
# Reproducible overlay: copies the K-Dense logo + favicon into the Archon web
# package and rewrites the brand wordmarks / nav labels / page title in place.
#
# Usage:   sh apply-rebrand.sh [ARCHON_DIR]
#          ARCHON_DIR defaults to /Users/DanBot/Archon
#
# IDEMPOTENT: every edit greps for the already-applied state first and skips if
# present, so re-running is a no-op. It only ever rewrites the original Archon
# strings; it never touches already-rebranded markup.

set -eu

ARCHON_DIR="${1:-/Users/DanBot/Archon}"
OVERLAY_DIR="$(cd "$(dirname "$0")" && pwd)"

WEB="$ARCHON_DIR/packages/web"
TOPNAV="$WEB/src/components/layout/TopNav.tsx"
SIDEBAR="$WEB/src/components/layout/Sidebar.tsx"
PROJECTRAIL="$WEB/src/experiments/console/components/ProjectRail.tsx"
INDEX_HTML="$WEB/index.html"
PUBLIC_DIR="$WEB/public"

# --- preflight: fail fast if the clone or any target is missing -------------
for f in "$TOPNAV" "$SIDEBAR" "$PROJECTRAIL" "$INDEX_HTML"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: expected file not found: $f" >&2
    echo "Is '$ARCHON_DIR' a valid Archon clone?" >&2
    exit 1
  fi
done
if [ ! -d "$PUBLIC_DIR" ]; then
  echo "ERROR: web public dir not found: $PUBLIC_DIR" >&2
  exit 1
fi

echo "Rebranding Archon at: $ARCHON_DIR"
echo "Overlay source:       $OVERLAY_DIR"

# --- (0) assets: favicon + logo into packages/web/public -------------------
# Always copy (cheap, and keeps the served assets in sync with the overlay).
cp "$OVERLAY_DIR/favicon.png"     "$PUBLIC_DIR/favicon.png"
cp "$OVERLAY_DIR/kdense-logo.png" "$PUBLIC_DIR/kdense-logo.png"
echo "  [assets] copied favicon.png + kdense-logo.png into $PUBLIC_DIR"

# --- (1) TopNav.tsx --------------------------------------------------------
# 1a. nav label 'Workflows' -> 'Pipelines' (only the label, leave route paths)
if grep -q "label: 'Workflows'" "$TOPNAV"; then
  perl -0pi -e "s/label: 'Workflows'/label: 'Pipelines'/g" "$TOPNAV"
  echo "  [TopNav] nav label 'Workflows' -> 'Pipelines'"
else
  echo "  [TopNav] nav label already 'Pipelines' (skip)"
fi

# 1b. aria-label '... workflows running' -> '... pipelines running'
if grep -q '${runningCount} workflows running' "$TOPNAV"; then
  perl -0pi -e 's/\$\{runningCount\} workflows running/\${runningCount} pipelines running/g' "$TOPNAV"
  echo "  [TopNav] aria-label 'workflows running' -> 'pipelines running'"
else
  echo "  [TopNav] aria-label already 'pipelines running' (skip)"
fi

# 1c. brand: the "A" letter tile + "Archon" wordmark -> k-dense logo img +
#     "Pipeline Builder" text. Match the exact original two-line block.
if grep -q '<span className="text-sm font-semibold text-primary-foreground">A</span>' "$TOPNAV"; then
  perl -0pi -e 's{<div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary">\s*<span className="text-sm font-semibold text-primary-foreground">A</span>\s*</div>\s*<span className="text-sm font-semibold text-text-primary">Archon</span>}{<img src="/kdense-logo.png" alt="" aria-hidden="true" className="h-7 w-7 rounded-md object-contain" />\n        <span className="text-sm font-semibold text-text-primary">Pipeline Builder</span>}s' "$TOPNAV"
  echo "  [TopNav] brand 'A' + 'Archon' -> k-dense logo + 'Pipeline Builder'"
else
  echo "  [TopNav] brand already rebranded (skip)"
fi

# --- (2) Sidebar.tsx -------------------------------------------------------
# brand: "A" tile + "Archon" wordmark -> k-dense logo img + "Pipeline Builder".
if grep -q '<span className="text-sm font-semibold text-primary-foreground">A</span>' "$SIDEBAR"; then
  perl -0pi -e 's{<div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">\s*<span className="text-sm font-semibold text-primary-foreground">A</span>\s*</div>\s*<span className="text-base font-semibold text-text-primary">Archon</span>}{<img src="/kdense-logo.png" alt="" aria-hidden="true" className="h-8 w-8 rounded-lg object-contain" />\n          <span className="text-base font-semibold text-text-primary">Pipeline Builder</span>}s' "$SIDEBAR"
  echo "  [Sidebar] brand 'A' + 'Archon' -> k-dense logo + 'Pipeline Builder'"
else
  echo "  [Sidebar] brand already rebranded (skip)"
fi

# --- (3) ProjectRail.tsx ---------------------------------------------------
# brand: existing favicon <img> + "Archon" wordmark -> k-dense logo + "Pipeline Builder".
# The img already points at /favicon.png (now the k-dense icon), so only the
# src and the wordmark text need to change. Match the "Archon" brand-text span.
if grep -q '<span className="brand-text text-base font-semibold tracking-tight">Archon</span>' "$PROJECTRAIL"; then
  perl -0pi -e 's{src="/favicon\.png"}{src="/kdense-logo.png"}g' "$PROJECTRAIL"
  perl -0pi -e 's{<span className="brand-text text-base font-semibold tracking-tight">Archon</span>}{<span className="brand-text text-base font-semibold tracking-tight">Pipeline Builder</span>}g' "$PROJECTRAIL"
  echo "  [ProjectRail] brand img src -> /kdense-logo.png, 'Archon' -> 'Pipeline Builder'"
else
  echo "  [ProjectRail] brand already rebranded (skip)"
fi

# --- (4) index.html --------------------------------------------------------
# <title>Archon</title> -> <title>K-Dense Pipeline Builder</title>
if grep -q '<title>Archon</title>' "$INDEX_HTML"; then
  perl -0pi -e 's{<title>Archon</title>}{<title>K-Dense Pipeline Builder</title>}g' "$INDEX_HTML"
  echo "  [index.html] <title> -> 'K-Dense Pipeline Builder'"
else
  echo "  [index.html] <title> already 'K-Dense Pipeline Builder' (skip)"
fi

echo "Rebrand complete."
