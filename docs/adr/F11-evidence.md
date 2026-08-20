# F11 evidence — skills curator / autoresearch

Date: 2026-08-20
Lane: F11, rows 41–47 and 51
Clone: `/Users/DanBot/Documents/ChatGPT/sds-lane-f11`
Branch: `feat/wave-f-f11-skills-curator`
Base: `33a13ea222f64d05248e34f99c7e5dc9d5eea202` (dest `feat/sds-wave-f-cursor-local`, F2+F8 merged)
Product tip: `07e05684d29308a44b8c123afcae8dfb31d4bb65`
This evidence file: `d1bf30c` and later commits on the same branch
Commits on dest: `d289c99` (feat), `07e0568` (dest-index probe)
This file is **not** an independent review PASS.
Supersedes the stale packet that named tip `54c9bd0` / base `51f0b7d`.

## Mimeographs terminology

“Mimeographs” means the existing reusable personality/agent-definition library:
`settings.deliberation.mimeographs.personalityRefs` (max 32) plus the
server-owned personality store. F11 writes those existing fields. It does not
invent a second library.

## Local verification (this tip)

| Gate | Result |
|---|---|
| dest merge-base | `33a13ea` — this is the only remaining Wave F lane replayed onto current dest |
| ownership vs dest | claimed PASS on the rebase (33 changed paths at `d289c99`/`07e0568`) |
| prompt-elevation | fail-closed: dest `index.ts` has not registered `POST /elevate-to-dag`; skill tells the agent not to build a parallel elevator |
| F14 durability settings | fail-closed: dest has not registered `GET/PUT /durability/settings` |
| F4 Lean routes / renderer | absent on dest; F11 adds no second renderer |
| Pi / Codex / Grok OAuth | unresolved / fail-closed. Not invented. |
| 18-gate battery | **not run** |
| independent review | **not run; must not be treated as PASS** |
| live Playwright on this close | **not re-run** (prior resume claimed 3/3 on 13501/18501/13511; those numbers belong to the stale `54c9bd0` packet until re-earned on `07e0568`) |

Ports: do not bind `:18000`. Secret values were not read.

## Anti-NT-1 grep table

Unchanged from the skills committed on this tip. `scientific-dag-studio` was
not edited.

| skill dir | terms that matter |
|---|---|
| autoresearch-graph-architect | rescue / validate / revision / Failure handling |
| autoresearch-squared | maxEvaluations / Stop monitoring / persistedToRunState / failed |
| prompt-elevation-to-dag | parallel elevator / available / Failure handling |
| workflow-supervisor | durability / presetId / stop / failed |
| lean4-prover | lean4 / ARTIFACT_UNTRUSTED / failed / proof |
| create-scientific-agent | PUT /agents / mimeographs / source: "project" |
| infranodus-ontology-creator | mcp__infranodus__ / INFRANODUS_API_KEY / unconfigured |

## Token / contrast / keyboard

- New F11 UI files add no raw hex/rgb/hsl literals.
- Gate D cannot be claimed PASS for dark title contrast (prior remasure 4.11 < 4.5).
- Keyboard: Settings tabs and specialist `<summary>` rows are in tab order.
  Focus ring uses `outline-foreground` at full opacity (`F11_FOCUS_SCOPE`).

## U / B / D per row (this tip)

### 41 — autoresearch graph architect

| Gate | Status | Evidence |
|---|---|---|
| U | locally present, not review PASS | Skill in Settings ▸ Skills. Curator can attach it. Re-earn live e2e on `07e0568` before citing U numbers from `54c9bd0`. |
| B | partial | Example graph validates and saves (`seed-skills-f11.test.ts`). Curator write + Pi loader + `resolveS4NodeExecutionBindings` (`skill-curator.test.ts`). No live model call that authors a new graph. |
| D | NOT DONE | Dark title remasure 4.11 < 4.5. |

### 42 — Autoresearch²

| Gate | Status | Evidence |
|---|---|---|
| U | locally present, not review PASS | Settings ▸ Specialists ▸ Monitor. |
| B | partial / persistence NOT DONE | Reads authoritative RunState/events. Bounds 1–20. Every response has `persistedToRunState: false`. RunState v1 has no critique channel. |
| D | NOT DONE | Same dark-title gap. |

### 43 — prompt elevation to DAG

| Gate | Status | Evidence |
|---|---|---|
| U | honest-disabled | Dest `33a13ea` has not registered `POST /elevate-to-dag`. Adapter stays disabled. No third elevator. |
| B | NOT DONE | `F5-elevate-to-dag` interface is F5's. F11 does not implement elevation. |
| D | NOT DONE | Same dark-title gap. |

### 44 — workflow supervisor

| Gate | Status | Evidence |
|---|---|---|
| U | honest-disabled | Dest has not registered F14 durability routes. Disabled with reason. One watcher only — F11 does not add a second. |
| B | NOT DONE on this dest tip | Component test proves preset-id PUT through the F14 adapter when the endpoint exists. |
| D | NOT DONE | Same dark-title gap. |

### 45 — lean4 prover

| Gate | Status | Evidence |
|---|---|---|
| U | discoverability only | Skill in Settings ▸ Skills. |
| B | partial | Skill is delegated on a real `kind: "lean4"` node. No second F4 renderer. F4 routes are absent on dest `33a13ea`. |
| D | NOT DONE | Same dark-title gap. |

### 46 — create-scientific-agent

| Gate | Status | Evidence |
|---|---|---|
| U | locally present, not review PASS | “Create scientific agent” in Settings ▸ Specialists. |
| B | locally present, not review PASS | Existing Agents API. Council heads stay existing mimeograph refs. |
| D | NOT DONE | Same dark-title gap. |

### 47 — InfraNodus ontology creator

| Gate | Status | Evidence |
|---|---|---|
| U | discoverability only | Skill in Settings ▸ Skills. |
| B | partial | Unconfigured F12 connector fails closed (`NOT_CONFIGURED`, env var name only). No second InfraNodus client. |
| D | NOT DONE | Same dark-title gap. |

### 51 — skill curator

| Gate | Status | Evidence |
|---|---|---|
| U | locally present, not review PASS | Settings ▸ Specialists ▸ Curate skills. |
| B | locally present, not review PASS | `installStagedSkills` optional path; `workflowStore.saveDefinitionWithIntent`; caps 64/32. |
| D | NOT DONE | Same dark-title gap. |

## What remains unfinished

1. Independent adversarial review (required; this file does not PASS it).
2. F5 elevation API — row 43 stays disabled until dest registers it.
3. F14 durability routes — row 44 stays disabled until dest registers them.
4. RunState critique persistence — Team B document-first contract change.
5. Dark title contrast ≥ 4.5:1.
6. Re-earn live F11 Playwright and targeted vitest counts on `07e0568` before citing the stale `54c9bd0` numbers.
7. Merge only after F1/F4/F5/F7/F12/F14. F11 is last.
