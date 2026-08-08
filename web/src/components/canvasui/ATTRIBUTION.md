# CanvasUI attribution

`Liquid.tsx` was installed from the CanvasUI shadcn registry component
`@canvas-ui/liquid-react` using the registry configured in `web/components.json`.

- Registry documentation: <https://canvasui.dev/docs/installation>
- Installation command: `npx shadcn@latest add @canvas-ui/liquid-react`
- Author/copyright: David H Dev
- Source: <https://github.com/DavidHDev/canvas-ui>
- License: MIT + Commons Clause

The license permits use in personal and commercial applications. Its Commons
Clause restriction prohibits reselling or redistributing the CanvasUI
components themselves, whether alone, bundled, or ported. This repository uses
the vendored component as part of an application and does not redistribute it
as a component product.

The vendored source contains a marked local patch that defers its failed-WebGL
state update to a microtask so it complies with `react-hooks/set-state-in-effect`
without changing its regular-HTML fallback behavior.
