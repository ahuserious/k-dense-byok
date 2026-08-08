# S1 dropped-capability decision

## Status

Accepted for the S1 consolidation lane on 2026-08-08.

## Context

The workspace exposed two separate list tabs and a Builder toggle between the typed workflow editor and the vendored visual pipeline builder. The requested product shape has one `Scientific Pipelines` list tab and one `Builder` tab containing only the vendored visual builder plus its chat rail.

## Decision

The typed visual graph editor and its `DAG Builder agent` panel are intentionally removed. Typed definitions remain discoverable, creatable from blank or scientific templates, runnable with saved-revision/session/goal/budget safeguards, and fully inspectable from the consolidated `Scientific Pipelines` tab. Opening a typed definition now shows the complete stored definition as read-only JSON with a download affordance rather than routing to the removed editor.

No other list capability is intentionally dropped. The vendored list retains health, refresh, empty/offline handling, Edit, Run, and Open builder. The typed list retains loading/error/empty handling, revision/schema/graph metadata, definition read/open, validation, template selection, creation, save-then-open, and safeguarded Run admission through the existing typed runtime.

Vendored Run now submits directly to the structured `/pipelines/:name/run` route. Its progress is no longer displayed in a newly-created Kady chat because that chat has no structured bridge to the vendored engine's conversation stream; retaining the natural-language chat dispatch would make engine selection ambiguous. The consolidated list instead shows the returned dispatch receipt and status inline in its vendored section. The current vendored response reports an acceptance status but no workflow `runId`, so the UI labels the client-generated conversation/dispatch id honestly rather than presenting it as an engine run id.

S1 applies client-side spend-limit guards in both the page dispatch callback and the consolidated panel, and it renders a vendored response as successful only when the documented body explicitly reports `accepted: true` with a valid status. These are mitigations, not authoritative accounting. S4 owns backend vendored admission, reservation, engine `runId`, and reconciliation in `server/src/api/pipelines.ts`. S2 owns HTTP failure rejection in `web/src/lib/pipelines.ts`; until that client checks `res.ok`, S1's strict body validation catches ordinary error JSON but cannot distinguish a non-2xx response whose body incorrectly imitates the success contract.

The two backing stores deliberately remain separate engines:

- Vendored pipelines continue to use the vendored engine's health, list, run, edit, and builder routes.
- Typed definitions continue to use Kady's project-scoped typed workflow definition API.

This lane unifies navigation and presentation only. It does not merge identifiers, persistence, runtime execution, or storage between the engines.
