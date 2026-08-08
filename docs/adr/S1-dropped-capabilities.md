# S1 dropped-capability decision

## Status

Accepted for the S1 consolidation lane on 2026-08-08.

## Context

The workspace exposed two separate list tabs and a Builder toggle between the typed workflow editor and the vendored visual pipeline builder. The requested product shape has one `Scientific Pipelines` list tab and one `Builder` tab containing only the vendored visual builder plus its chat rail.

## Decision

The typed visual graph editor and its `DAG Builder agent` panel are intentionally removed. Typed definitions remain discoverable, creatable from blank or scientific templates, runnable with saved-revision/session/goal/budget safeguards, and fully inspectable from the consolidated `Scientific Pipelines` tab. Opening a typed definition now shows the complete stored definition as read-only JSON with a download affordance rather than routing to the removed editor.

No other list capability is intentionally dropped. The vendored list retains health, refresh, empty/offline handling, Edit, Run, and Open builder. The typed list retains loading/error/empty handling, revision/schema/graph metadata, definition read/open, validation, template selection, creation, save-then-open, and safeguarded Run admission through the existing typed runtime.

The two backing stores deliberately remain separate engines:

- Vendored pipelines continue to use the vendored engine's health, list, run, edit, and builder routes.
- Typed definitions continue to use Kady's project-scoped typed workflow definition API.

This lane unifies navigation and presentation only. It does not merge identifiers, persistence, runtime execution, or storage between the engines.
