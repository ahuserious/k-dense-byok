# ADR F11 — substantive workflow skills and existing-store curation

Status: accepted for the F11 lane  
Base: `51f0b7d2d292093c71603504cbe159371930fffd`

## Context

Feature Wave F requires seven scientific workflow skills plus a curator. The
typed runtime already owns skill discovery, installation, NodeSpec skill
references, the workflow store, immutable run state, personality staffing,
InfraNodus MCP wrapping, Lean execution, cancellation, lateral pass, and
durability contracts. Duplicating any of those would create divergent authority.

## Decisions

### The seven skills are committed resources, not nominal labels

Each named directory contains a concrete Pi `SKILL.md` with real endpoints,
node kinds, examples, bounds, and failure behavior. The graph architect ships a
complete JSON graph that the test suite validates and saves.

`seedProjectSkills` remains the only committed-skill seeding path. Tests require
all seven names to be enabled and returned by both `listProjectSkills` and Pi's
`DefaultResourceLoader`; they also require the formatted runtime skill prompt to
contain every name.

### The curator extends the existing Skills route

`registerSkillCuratorRoutes` is called by `registerSkillRoutes`. No new top-level
registration is needed.

Optional source installation delegates to `installStagedSkills`, which already
uses the staged review token and `installSkillTree`. The curator then saves
through `workflowStore.saveDefinitionWithIntent` with an expected revision and
reads the saved revision back. It owns no installer or workflow store.

The two existing caps are enforced before a write:

- `settings.skills.list`: 64 unique references
- `settings.deliberation.mimeographs.personalityRefs`: 32 unique references

### “Mimeographs” maps to the existing personality library

The term means the existing reusable personality/agent-definition library:
`settings.deliberation.mimeographs` plus the server-owned personality store.
Manual curation selects only refs present in the installed pinned snapshot. The
curator sets `bestOfNPersonalityCount` to the selected count so validation and
runtime staffing agree.

A project specialist and a council personality remain different trust
boundaries. `create-scientific-agent` saves specialists through the existing
Agents API. It selects council heads from existing personality refs; it does
not copy agent files into the immutable personality store.

### Autoresearch² attaches without changing RunState v1

The adapter reads the authoritative `WorkflowStore` RunState and event page.
Interactive mode is one user-directed evaluation. Autonomous mode requires a
numeric 1–20 evaluation bound. The UI provides separate **Stop monitoring** and
existing **Stop run** controls.

RunState v1 has no critique/evaluation event or annotation channel. F11 does not
mislabel `gate_evaluated`/`evidence_checked`, and does not change the frozen
contract. Every response carries `persistedToRunState: false` and a reason.

Document-first Team B follow-up:

1. Decide whether critique/evaluation belongs in the authoritative run stream
   or a contract-defined adjacent journal.
2. Update `docs/contracts/RUNSTATE-V1.md` first.
3. Add the emitter, validator, reducer/projection, replay behavior, and UI
   consumer in one Team B-owned change.
4. Replace only F11's explicit persistence-disabled seam after that lands.

### Prompt elevation remains one engine

F5's interface is absent on the integration base. The
`skill-curator-prompt-elevation.ts` adapter is intentionally disabled. The
skill checks that capability and refuses to generate a substitute graph.

Narrow F5 follow-up: change only the adapter to expose and call the endpoint
published by `F5-elevate-to-dag.md`, then add one effect test proving the skill,
chat affordance, and node resolve to the same endpoint. No elevation algorithm
belongs in F11.

### Workflow supervision is a second view, never a second watcher

`WorkflowSupervisorSettings` calls F14's published
`GET/PUT /durability/settings` and `GET /durability/signals`. It has no
persistent state or defaults. Because F14 is absent at this base, it renders a
disabled control with the 404 reason.

Model policy stores F1 preset ids. The component may receive F8's already-loaded
preset options or query `/model-presets`; absence disables preset selection. No
provider/model id is hardcoded.

### Lean and InfraNodus reuse their single integrations

- `lean4-prover` authors `kind: "lean4"` and refers to F4's one proof client and
  renderer. F11 adds no proof renderer, receipt parser, or artifact route.
- `infranodus-ontology-creator` uses only dynamically discovered
  `mcp__infranodus__<tool>` definitions from F12. F11 adds no host, client,
  credential check, or tool inventory.

## Consequences

- The F11 UI is reachable immediately from Settings ▸ Specialists without
  editing F8-owned `settings-dialog.tsx`.
- F8 can mount the exported supervisor component in its final Settings layout
  through the published interface.
- Current integration honestly leaves RunState critique persistence, F5 prompt
  elevation, and F14/F1/F4 runtime surfaces disabled or partial until their
  owning lanes land.
