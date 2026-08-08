# S9 design sources (gathered by the orchestrator, 2026-08-08 — the lane sandbox has no network)

## 1. CanvasUI (canvasui.dev/docs/installation, fetched 2026-08-08)
- shadcn-registry component library: `npx shadcn@latest add @canvas-ui/liquid-react` (React package).
- Requires React 19 (our web app is React 19.2.3 — compatible). shadcn init first if absent.
- CLI installs components into `components/canvasui/`; import as `@/components/canvasui/<Name>`.
- Components use the experimental html-in-canvas API: dev needs Chrome flag `chrome://flags/#canvas-draw-element`; production needs an origin-trial token; components DEGRADE GRACEFULLY to regular HTML in unsupported browsers — acceptable default posture for us (no flag required of users).
- Usage pattern: wrap content, optional props, e.g. `<Liquid rainbow style={{height:480}}>…</Liquid>`.
- Docs state no font/theming requirements — fonts come from the other two sources.

## 2. HyperFrequency deck (local: /Users/DanBot/HyperFrequency/hyperfrequency-deck/, readable from the lane)
- Fonts (Nerd Font patched, TTFs in `nerd-fonts/`): "0xProto Nerd Font", "FiraCode Nerd Font", "Terminess Nerd Font", "Tinos Nerd Font", "AnonymicePro Nerd Font" (Bold/Italic variants shipped).
- The deck maps fonts to ROLE VARIABLES: --fhero, --fnav, --fcta, --ffig, --fann (hero/nav/cta/figure/annotation) — adopt the same role-token pattern for the studio.
- Brand palette assets: `brand-kit/palette/` (read for color tokens), `brand-kit/logos/`.
- Upstream font licenses: 0xProto/FiraCode/Terminus(Terminess) are SIL OFL; Tinos is Apache-2.0 — vendoring TTFs into web/public/fonts with a LICENSES note is permitted.

## 3. Raindrop slip (local: /Users/DanBot/raindrop-slim/, readable from the lane)
- Font stack: 'Space Mono', monospace (primary mono accent) and Inter, ui-sans-serif, system-ui, -apple-system (sans body), with ui-monospace/SFMono-Regular/Menlo fallbacks.

## Citation rule (gate G7): every CanvasUI symbol used in the diff must appear here; extend this file when adding one.
