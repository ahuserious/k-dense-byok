---
name: prompt-elevation-to-dag
description: >-
  Enter Kady's single prompt-to-durable-DAG elevation flow. Use when the user
  asks to elevate a chat prompt or conversation into a saved scientific DAG;
  fail closed when F5's shared elevation API is unavailable instead of
  constructing a competing graph-conversion algorithm.
argument-hint: "[prompt or conversation goal]"
---

# Prompt elevation to DAG

This skill is one entry point into the same capability used by the chat
elevation panel and the `elevate-to-dag` workflow node. It is not an elevation
engine, and it must never become a parallel elevator.

## Capability check

Read:

```text
GET /skills/curator/capabilities
```

Inspect `promptElevation`:

```json
{
  "available": false,
  "interfaceDocument": "wave-f/interfaces/F5-elevate-to-dag.md",
  "endpoint": null,
  "reason": "..."
}
```

If `available` is false:

1. Show `reason` verbatim.
2. Explain that no graph was generated or saved.
3. Offer to preserve the source prompt while the shared engine is unavailable.
4. Stop. Do not fall back to hand-authored conversion under this skill name.

This fail-closed state is expected on builds where F5 has not landed.

## Procedure when the shared engine is available

Only use the endpoint and request/response shape published by
`F5-elevate-to-dag.md`.

1. Collect the exact source:
   - one user prompt, or
   - the explicitly selected conversation turns.
2. Ask for the desired scientific outcome, required inputs, expected artifacts,
   evidence threshold, budget, and where human approval is required.
3. Show the source selection and options before sending them.
4. Call `promptElevation.endpoint` once. Do not pre-transform the prompt into a
   second private graph format.
5. Require the response to identify the canonical typed graph, validation
   result, and save state.
6. If the engine returns a draft, show it as a draft. Saving requires a distinct
   user action through the engine's own save path.
7. Read the saved workflow through `GET /dag-workflows/<workflowId>` and report
   its revision and digest. A local object is not proof of persistence.

## One implementation, three entry points

The following must resolve to the same endpoint and semantics:

- chat: “Elevate workflow to a durable scientific DAG pipeline?”
- workflow node: `kind: "elevate-to-dag"`
- this skill

Never add a second route, model prompt, store, validation schema, or retry loop
for this skill. If any entry point reports a different capability endpoint,
stop and report integration drift.

## Worked disabled case

User: “Turn our discussion into a durable pipeline.”

Capability response: `available: false`.

Answer:

> Prompt elevation is unavailable on this build because the shared F5
> elevation API has not landed. I did not generate or save a substitute graph.
> I can preserve the selected prompt and requirements for the shared flow.

Do not then emit a graph under another heading; that would silently defeat the
guard.

## Failure handling

- Missing interface or null endpoint: disabled; stop without writing.
- Validation failure from the shared engine: show its typed issues and leave the
  draft unsaved.
- Save revision conflict: reload through the shared engine. Never issue an
  unconditional workflow PUT.
- Provider/model unavailable: preserve the draft and show the engine's reason.
  Do not substitute a model.
- Malformed response: treat the elevation as not completed. A plausible graph
  body without a valid envelope is not success.
- Network failure: report that nothing was saved unless a readback proves
  otherwise.
