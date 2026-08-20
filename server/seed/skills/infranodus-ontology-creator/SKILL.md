---
name: infranodus-ontology-creator
description: >-
  Create an ontology or knowledge graph through Kady's registered InfraNodus MCP
  connector, using only dynamically discovered mcp__infranodus__<tool> tools;
  fail closed when the connector is unconfigured, disabled, or lacks a suitable
  tool.
argument-hint: "[domain, corpus, or research question]"
---

# InfraNodus ontology creator

Use F12's one InfraNodus reach path: the existing MCP stack. Do not add an HTTP
client, host, API-key check, token store, watcher, or hardcoded tool inventory.

## Readiness check

Read:

```text
GET /integrations
```

Find `id: "infranodus"` and require all of:

- `configured: true`
- `mcp.registered: true`
- `mcp.disabled: false`
- `mcp.enabled: true`
- `mcp.toolPrefix === "mcp__infranodus__"`

If any condition fails, stop with the returned `notConfiguredReason` or a
message telling the user to enable/register the connector in
Settings ▸ Connectors.

When `INFRANODUS_API_KEY` is absent, registration reaches nothing and advertises
no tools. Name the variable only; never request, read, or print its value.

## Discover, do not invent, tools

The runtime wraps every tool the connected server advertises as:

```text
mcp__infranodus__<sanitized-tool-name>
```

Inspect the tools available in the active session. Candidate vendor names may
include ontology, knowledge-graph, text-analysis, clustering, and content-gap
operations, but availability and parameters come from the live MCP schema.

Never call a candidate name merely because it appeared in documentation. If no
discovered tool can create an ontology, report that exact capability gap.

## Procedure

1. Ask for the ontology's purpose and consumer:
   reasoning-style selection, literature mapping, data annotation, hypothesis
   generation, or another use.
2. Define the input corpus and its provenance. Do not send private files or
   unpublished text without explicit permission.
3. Define desired concepts, relation semantics, granularity, exclusions, and
   output format.
4. Check connector readiness and inspect the live tool schemas.
5. Select the smallest suitable `mcp__infranodus__...` tool.
6. Show the operation and source scope before the external call.
7. Call the discovered tool with only fields its schema declares.
8. Validate the result locally:
   - nodes/concepts have stable non-empty identifiers;
   - relations name both endpoints;
   - duplicate aliases are reported;
   - orphan concepts are explicit;
   - provenance identifies the source corpus and MCP tool;
   - output does not include a credential value.
9. Save the result as a normal sandbox artifact only when the user asked for a
   file.
10. For a reasoning-style consumer, return the artifact reference and a bounded
    list of candidate perspectives. Do not silently switch a workflow's style.

## Worked invocation plan

Goal: derive an ontology for council reasoning styles from a set of abstracts.

1. Read `/integrations`; confirm the connector is enabled.
2. Inspect tools beginning `mcp__infranodus__`.
3. Choose the discovered tool whose schema says it creates an ontology or
   knowledge graph from text.
4. Supply only the selected abstract text, requested granularity, and output
   options declared by that schema.
5. Save the normalized returned graph to
   `artifacts/ontologies/<topic>.json`.
6. Report the exact wrapped tool name and the artifact path.

The literal wrapped tool after the prefix is intentionally absent from this
example because it must come from live discovery.

## Output contract

Return:

- connector state and exact wrapped tool name
- input scope and provenance
- concept count and relation count
- ontology artifact path, if saved
- validation warnings
- candidate reasoning perspectives derived from the graph
- limitations, including omitted or inaccessible source material

## Failure handling

- Not configured: no call; show the named environment variable and Settings
  path.
- Configured but not registered: tell the user to connect it; do not assume the
  MCP client exists.
- Disabled: tell the user to enable the existing entry. Do not register a
  duplicate entry into the enabled store.
- MCP connection/list-tools failure: report unavailable and make no external
  call.
- No suitable discovered tool: report the tool inventory/capability mismatch;
  do not invent a name.
- Tool schema mismatch: stop before calling and show the missing/invalid field.
- External call failure: preserve the error as an external failure; do not
  write a fabricated ontology.
- Malformed graph: save nothing unless the user explicitly asks to retain the
  raw response for diagnosis.
