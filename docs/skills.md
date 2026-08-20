# F11 scientific workflow skills

Kady ships seven workflow-oriented Pi skills in addition to its catalogue.
They are copied into every project by the existing committed-skill seeder and
appear in Settings ▸ Skills. New chat tabs and new workflow node executions
load enabled skills; live sessions keep the resources they started with.

## Skills

- `autoresearch-graph-architect` — turns a research objective into a bounded
  typed DAG, validates it, and saves it through the workflow store. Includes a
  validated example graph.
- `autoresearch-squared` — reads live RunState and durable events for one run.
  Interactive mode asks the user; autonomous mode requires a 1–20 evaluation
  bound. Monitoring and run cancellation are separate controls.
- `prompt-elevation-to-dag` — entry point into F5's single prompt-elevation
  engine. It is visibly unavailable until that interface lands and never
  generates a parallel substitute.
- `workflow-supervisor` — configures F14's shared durability watcher through its
  API, using F1 preset ids. It owns no watcher, store, escalation path, or
  defaults.
- `lean4-prover` — authors and operates the existing `lean4` node and points to
  F4's one trusted proof renderer/API.
- `create-scientific-agent` — creates a real project specialist through the
  Agents API or selects an installed reusable personality as a council head.
- `infranodus-ontology-creator` — creates ontologies through F12's registered
  MCP connector using live-discovered `mcp__infranodus__<tool>` names.

Every skill states its concrete endpoints, procedure, example, bounds, and
failure behavior. Loader/effect tests live in:

- `server/test/seed-skills-f11.test.ts`
- `server/test/skill-curator.test.ts`
- `server/test/skill-curator-api.test.ts`

## Curating a saved workflow

Open Settings ▸ Specialists ▸ **Curate skills into workflow nodes**.

1. Select a saved typed workflow and node.
2. Choose `manual`, `auto-manual`, or `auto`.
3. Select enabled skills. The UI shows whether each ref is already attached to
   the saved revision.
4. If the pinned reusable personality library is available, select council
   heads (“mimeographs”).
5. Save.

The server:

- optionally delegates source installation to the existing staged installer;
- enforces 64 skill refs and 32 personality refs;
- uses the workflow store's expected-revision write;
- validates NodeSpec v1;
- reads the saved revision back.

Runtime execution resolves the saved node settings and delegates those exact
skill refs to Pi. Project skills shadow same-named global skills, matching Pi's
loader.

## Autoresearch² monitor

Open Settings ▸ Specialists ▸ **Monitor a live autoresearch run**.

- Interactive mode performs one pass and accepts a user direction.
- Autonomous mode stops at the chosen evaluation count or terminal state.
- **Stop monitoring** ends polling only.
- **Stop run** uses the existing workflow cancel path.

The monitor is attached to the authoritative RunState and event stream. On this
build critique rows are not persisted into RunState because its frozen v1
contract has no such event channel; the UI states this explicitly.

## Workflow supervisor

Open Settings ▸ Specialists ▸ **Configure the workflow supervisor**.

This component is a view over F14's `/durability` endpoints. If those endpoints
are absent it is disabled with a reason. When available:

- model selections are F1 preset ids;
- signal controls come from the server's observability catalogue;
- unobservable controls are disabled with their reason;
- stop authority uses the shared policy and endpoint.

## Creating a scientific specialist

Settings ▸ Specialists ▸ **Create scientific agent** pre-fills a read-only,
evidence-grounded specialist definition. Choose a safe name, narrow the role,
and save. The existing Agents API writes a real project definition that appears
in the roster and is available to new subagent runs.

Council heads are selected separately from the pinned personality library in
the curator. A project specialist is not silently copied into that library.

## Failure states

- Missing/disabled skill: install or enable it before attaching.
- Workflow revision conflict: reload; no unconditional overwrite is offered.
- Personality library unavailable: specialist creation remains available, but
  manual council-head selection is disabled.
- F5/F14/F1/F4 interface absent: affected controls are disabled or the skill
  reports the specific missing integration. No duplicate implementation is
  started.
- InfraNodus unconfigured/disabled: no MCP tool is advertised and the skill
  reaches nothing.
