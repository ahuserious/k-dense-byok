# CanvasUI license and attribution

`Liquid.tsx` was installed from the CanvasUI shadcn registry component
`@canvas-ui/liquid-react` using the registry configured in `web/components.json`.

- Source site: <https://canvasui.dev>
- Registry documentation: <https://canvasui.dev/docs/installation>
- Source repository: <https://github.com/DavidHDev/canvas-ui>
- Retrieved: 2026-08-08, per `docs/design/sources.md`
- Installation command: `npx shadcn@latest add @canvas-ui/liquid-react`
- Author/copyright: David H Dev
- License: MIT + Commons Clause

## MIT License

Copyright (c) David H Dev

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## “Commons Clause” License Condition v1.0

The Software is provided to you by the Licensor under the License, as defined
below, subject to the following condition.

Without limiting other conditions in the License, the grant of rights under
the License will not include, and the License does not grant to you, the right
to Sell the Software.

For purposes of the foregoing, “Sell” means practicing any or all of the rights
granted to you under the License to provide to third parties, for a fee or
other consideration (including without limitation fees for hosting or
consulting/ support services related to the Software), a product or service
whose value derives, entirely or substantially, from the functionality of the
Software. Any license notice or attribution required by the License must also
include this Commons Clause License Condition notice.

Software: CanvasUI

License: MIT License

Licensor: David H Dev

The vendored source contains a marked local patch that defers its failed-WebGL
state update to a microtask so it complies with `react-hooks/set-state-in-effect`
without changing its regular-HTML fallback behavior.
