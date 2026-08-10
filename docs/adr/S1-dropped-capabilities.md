# S1 dropped-capability decision

## Status

Accepted for the S1 consolidation lane on 2026-08-08. The identifier and list-presentation boundary is superseded by S1b on 2026-08-10 as described below.

## Context

The workspace exposed two separate list tabs and a Builder toggle between the typed workflow editor and the vendored visual pipeline builder. The requested product shape has one `Scientific Pipelines` list tab and one `Builder` tab containing only the vendored visual builder plus its chat rail.

## Decision

The typed visual graph editor and its `DAG Builder agent` panel are intentionally removed. Typed definitions remain discoverable, creatable from blank or scientific templates, runnable with saved-revision/session/goal/budget safeguards, and fully inspectable from the consolidated `Scientific Pipelines` tab. Opening a typed definition now shows the complete stored definition as read-only JSON with a download affordance rather than routing to the removed editor.

No other list capability is intentionally dropped. The unified registry retains vendored health, refresh, empty/offline handling, Edit, Run, and Open builder. It also retains typed loading/error/empty handling, revision/schema/graph metadata, definition read/open, validation, template selection, creation, save-then-open, and safeguarded Run admission through the existing typed runtime.

Vendored Run now submits directly to the structured `/pipelines/:name/run` route. Its progress is no longer displayed in a newly-created Kady chat because that chat has no structured bridge to the vendored engine's conversation stream; retaining the natural-language chat dispatch would make engine selection ambiguous. The unified row instead shows the returned dispatch receipt and status inline. The current vendored response reports an acceptance status but no workflow `runId`, so the UI labels the client-generated conversation/dispatch id honestly rather than presenting it as an engine run id.

S1 applies client-side spend-limit guards in both the page dispatch callback and the consolidated panel, and it renders a vendored response as successful only when the documented body explicitly reports `accepted: true` with a valid status. These are mitigations, not authoritative accounting. S4 owns backend vendored admission, reservation, engine `runId`, and reconciliation in `server/src/api/pipelines.ts`. S2 owns HTTP failure rejection in `web/src/lib/pipelines.ts`; until that client checks `res.ok`, S1's strict body validation catches ordinary error JSON but cannot distinguish a non-2xx response whose body incorrectly imitates the success contract.

The two backing stores deliberately remain separate engines:

- Vendored pipelines continue to use the vendored engine's health, list, run, edit, and builder routes.
- Typed definitions continue to use Kady's project-scoped typed workflow definition API.

## S1b supersession: shared registry identity

S1b supersedes the earlier statement that presentation and identifiers remain separate. Scientific Pipelines now renders one registry list. Every backing record keeps a stable engine-scoped source identifier (`typed:<workflow-id>` or `vendored:<workflow-name>`), while the registry derives a shared identifier from the normalized workflow name plus a deterministic topology hash. Topology hashing canonicalizes sorted node identifiers and edges, including vendored `depends_on` relationships. Entries deduplicate only when both normalized name and topology hash match; a name match alone never hides a structurally distinct workflow.

A deduplicated row retains both backing routes. Typed details and Run continue through the project-scoped `/dag-workflows` runtime, while vendored Edit, Run, health, refresh, and builder actions continue through the existing pipeline engine routes. Persistence, runtime execution, and storage are still not merged. This is additive presentation deduplication: no runnable backing record is removed or made unreachable.
