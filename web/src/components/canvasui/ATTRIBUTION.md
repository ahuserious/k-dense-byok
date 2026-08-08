# CanvasUI attribution

`Liquid.tsx` was installed from the CanvasUI shadcn registry component
`@canvas-ui/liquid-react` using the registry configured in `web/components.json`.

- Registry documentation: <https://canvasui.dev/docs/installation>
- Installation command: `npx shadcn@latest add @canvas-ui/liquid-react`
- License: [MIT License](https://spdx.org/licenses/MIT.html)

The vendored source contains a marked local patch that defers its failed-WebGL
state update to a microtask so it complies with `react-hooks/set-state-in-effect`
without changing its regular-HTML fallback behavior.
