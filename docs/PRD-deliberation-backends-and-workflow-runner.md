All paths confirmed. Writing the PRD.

# K-Dense BYOK ("Kady") — Deliberation Backends, Native Workflow Runner, and Agent/Workflow Builders: PRD + Implementation Plan

This PRD specifies eight coordinated workstreams that extend K-Dense BYOK ("Kady") — a local, BYOK AI research-assistant app (TypeScript/Fastify server on :8000 running a single flat Pi coding-agent; Next.js 16 / React 19 web on :3000; models routed directly to OpenRouter or local Ollama) — with: (1) finished, **cost-accurate** OpenRouter Fusion (direct) support that closes the silent `$0`-fallback spend-cap hole; (2) an **AI Council** deliberation tool backed by The AI Counsel sidecar; (3) **adoption of Archon** (the TS/Bun DAG engine, pinned **v0.4.1, MIT**) as the **Pipelines** workflow subsystem — run as a localhost sidecar that drives Pi via the *same* `@earendil-works` SDK Kady embeds, with a Kady-side bridge that prices Archon's run events into the existing cost ledger; (4) a unifying **deliberation-backend** abstraction (`fusion-direct | council-tool | none`) selectable **per agent and per workflow**; (5) K-Dense's **Karpathy** and **agentic data scientist** agents ported as editable project agents; (6) **Mimeograph** integration as a skill/agent source; and (7–8) an **interactive Agent Builder UI** and an **Archon-style Workflow Builder UI**. The single load-bearing risk threaded through every workstream is cost-accounting correctness: unknown/variable-priced models currently resolve to `{cost: $0}` and silently disable project spend caps, and several new surfaces (Fusion, Council, per-node workflow runs) multiply that risk.

---

## Goals & Non-Goals

### Goals
- **G1.** Finish Track-1 OpenRouter Fusion (direct) with **accurate cost accounting** so a `openrouter/fusion` turn never records `$0` and project `spendLimitUsd` still trips.
- **G2.** Add an **AI Council** deliberation capability with **out-of-process cost capture** into the existing ledger.
- **G3.** **Adopt Archon** (pinned v0.4.1, MIT) as the **Pipelines** DAG workflow engine + visual builder — run it as a localhost sidecar with Pi configured for OpenRouter, and bridge its run events into Kady's JSONL cost ledger + `spendLimitUsd` (post-hoc). Node types come from Archon (`prompt/bash/loop/approval/script/command/cancel`).
- **G4.** Provide one **deliberation-backend abstraction** (`fusion-direct | council-tool | none`) selectable **per agent** (agent `.md` frontmatter) and **per workflow node** (workflow schema), with consistent UI.
- **G5.** Port K-Dense's **Karpathy** and **agentic data scientist** agents as **editable project agents** (not read-only builtins, not `SUBAGENT_TYPES`), wired to the deliberation-backend picker.
- **G6.** Integrate **Mimeograph** (at minimum the pre-built `mimeographs` collection, which supplies the Karpathy *skill*) through the existing skills-seeding seam.
- **G7.** Build an **interactive Agent Builder UI** and an **Archon-style Workflow Builder UI**.

### Non-Goals
- **N1. Do NOT redesign `/effort`.** It maps to `thinkingLevel` and is left exactly as-is. Workflow nodes reuse the existing `effort → thinkingLevel` path; no new effort semantics.
- **N2. Do NOT run a Postgres/server DB for Archon.** Use Archon's **default SQLite file** (`~/.archon/archon.db`) as Archon-private state only — never enable the `--profile with-db` Postgres path, and never treat Archon's DB as a second source of truth Kady writes to. *(The original "no DB at all" goal is relaxed by the adopt-Archon decision; a local SQLite **file** preserves its intent — no DB server, no migrations Kady owns.)*
- **N3. Do NOT build the Council as a sidecar *if a cleaner native-only option existed* — but research shows it does not.** The AI Counsel is a Python FastAPI service that cannot be made native without reimplementing its 3-stage deliberation engine in TypeScript. Therefore the Council *backend* is a sidecar service that our TS server only HTTP-calls; **no Python enters `server/`**. This is the one accepted Python reintroduction (see Cross-cutting concerns) and is an explicit user decision (Open Decisions).
- **N4. RESOLVED — ADOPT Archon (Open Decision A).** Kady runs Archon v0.4.1 as a localhost sidecar and uses its engine + visual builder. Kady does **not** fork Archon's core, does **not** build its own DAG runner, and does **not** rebuild the DAG editor. Kady *does* add a thin HTTP/SSE bridge (drive runs, reconcile cost, proxy CRUD) and surfaces Archon's builder (iframe/link-out). See Workstreams C & H.
- **N5. Do NOT vendor the Python K-Dense agent packages** (`karpathy`, `agentic-data-scientist`) or replicate their Google-ADK multi-agent process trees. Port their **prompts/personas** into `.md` agent files; reuse the existing `subagent` tool as the `delegate_task` analogue.
- **N6. Do NOT replace the existing "Workflows" prompt-template launcher.** The new DAG runner is a distinct feature; the naming collision is resolved by renaming the new feature (see Workstream C).

---

## Corrections to the prior plan ("Augment")

These are blunt corrections; propagate the corrected facts, not the originals.

1. **Archon is NOT a Python/FastAPI/Supabase/pgvector RAG + MCP task-manager.** That is the **archived v1** (`archive/v1-task-management-rag`). Live `main` (pushed 2026-06-15, MIT, ~22.5k★) is a **TypeScript/Bun YAML workflow engine** ("GitHub Actions for AI coding"). On the language/architecture axis Augment's "TS/Bun YAML workflow engine that supports Pi" was actually *right*; the stale "Python/Supabase" web consensus describes the dead v1. **Pin all Archon references to current `main`/archon.diy.** **Confirmed via archon.diy/getting-started/ai-assistants:** Pi is a first-class community provider (`assistants.pi` block in `.archon/config.yaml`, ~20 LLM backends, creds from `~/.pi/agent/auth.json` + env) — so the *adopt-Archon* path is technically real (Open Decision A).
2. **Archon counts were wrong.** Real numbers: **17** default workflows (not 19) and **7** store tables (not 12). Do not propagate 19/12.
3. **Fusion cost handling — two corrections.** (a) The claim that you must send `usage:{include:true}` to read billed cost is **outdated/wrong**: OpenRouter usage accounting is now **always on** (that param + `stream_options:{include_usage:true}` are deprecated/no-effect). (b) More importantly, the *Pi SDK as vendored never reads response cost at all* — `parseChunkUsage()` builds usage from token counts and calls `calculateCost(model, usage)` from local `model.cost`; it never reads `usage.cost`/`cost_details`. And Fusion's per-token price is the **`-1` "variable pricing" sentinel**, so token-math can never be correct. Net: you cannot fix Fusion cost by "computing it"; you must capture OpenRouter's authoritative billed cost or apply a conservative estimate (Workstream A).
4. **The AI Council successor repo slug was wrong.** It is **`jacob-bd/the-ai-counsel`** (MIT, v0.10.3, 2026-06-18, actively maintained), the successor to the **deprecated** `jacob-bd/llm-council-plus` (v0.7.0 final). The separately-named **`blueman82/ai-counsel` is a different author's unrelated project and is now unresolvable (404)** — not a viable target. Also a *favorable* correction: The AI Counsel has **rich first-class cost reporting** (`cost_report` with token splits, per-model/per-stage breakdown, `pricing_confidence`, `cost_status`), which de-risks ledger integration.
5. **"Mimeograph" is NOT a report/manuscript generator** and does not touch the LaTeX/deliverable flow. It is **two MIT repos**: `K-Dense-AI/mimeo` (a Python CLI that *generates* expert agent-skills) and `K-Dense-AI/mimeographs` (a collection of **80+ pre-generated** Agent-Skills-standard folders, including **Andrej Karpathy**). It plugs into the **skills/agents** seam, not the report seam.
6. **The two halves of "add Karpathy + agentic data scientist" come from different sources.** The "Karpathy" *persona* is satisfied by the `mimeographs` collection (Karpathy is in it) and/or by porting `K-Dense-AI/karpathy`'s `instructions.yaml` persona; the "agentic data scientist" comes from `K-Dense-AI/agentic-data-scientist`'s markdown prompts. Neither should be added as a `SUBAGENT_TYPES` entry (that struct can't carry a per-agent model and would break per-agent backend selection).

---

## Glossary

- **OpenRouter Fusion (`openrouter/fusion`)** — A first-party OpenRouter *router meta-model* (context 1,000,000). Per request it runs a **panel** of up to 8 models in parallel (web-search enabled) plus a **judge** model that synthesizes. Bills N panel + 1 judge completions **in addition** to the outer request (~4–5× a single completion at the default 3-model panel, up to ~9×). OpenRouter reports its pricing as the **`-1` variable-pricing sentinel**; no static per-token price is valid. In Kady the ref `openrouter/openrouter/fusion` already routes to it via `resolveModel`.
- **AI Council** — A multi-model *deliberation service*, **The AI Counsel** (`jacob-bd/the-ai-counsel`): a 3-stage pipeline (independent answers → anonymized peer-review/ranking → chairman synthesis), an optional iterative-debate loop, and a separate Advisors persona mode. Python FastAPI + React, exposes REST `POST /api/ask` (with `cost_report`) on :8001 and an MCP server (10 action-based tools). In Kady it is a **sidecar service** invoked by a native Pi tool.
- **Archon (real definition)** — `github.com/coleam00/Archon`, current `main`: a **TypeScript/Bun YAML DAG workflow engine** for AI coding agents (node types Command/Prompt/Bash/Script/Loop/Approval/Cancel; `depends_on` + `trigger_rule`; Kahn-layer execution; loop `{until, max_iterations, until_bash, interactive}`; approval `{message, on_reject{max_attempts}}`; run states `pending|running|completed|failed|cancelled|paused`, resumable = `failed|paused`). MIT, pinned **v0.4.1**. **Adopted as a localhost sidecar dependency** (Open Decision A) — Kady drives it over HTTP/SSE and surfaces its visual builder; notably it already embeds the same `@earendil-works` Pi SDK Kady uses.
- **Native workflow runner** — The new **in-process, file-backed** DAG executor inside `server/` that borrows Archon's *concepts* (trimmed schema) and drives Kady's real seams: per-node `session.prompt()`, per-node cost rows in `costs.jsonl`, SSE per-node lifecycle events, per-node + per-run budget checks, and pause/resume for approval gates.
- **K-Dense agents** — `K-Dense-AI/karpathy` ("agentic ML engineer", persona in `instructions.yaml`) and `K-Dense-AI/agentic-data-scientist` (9-role plan→code→review→reflect→summarize DAG, prompts in `prompts/base/*.md`). Both upstream are Python Google-ADK apps; in Kady they become **editable project agent `.md` files** (Karpathy) and a **seed example workflow** (data scientist).
- **Mimeograph** — `K-Dense-AI/mimeo` (Python CLI that generates expert agent-skills) and `K-Dense-AI/mimeographs` (80+ pre-built MIT skill folders, each `SKILL.md`/`AGENTS.md` + `references/` + `avatar.png`). Plugs into Kady's existing skills-seeding seam (`server/src/agent/skills.ts`).
- **Deliberation backend** — The Kady abstraction this PRD introduces: a per-agent / per-node setting with three modes — **`fusion-direct`** (set model ref to `openrouter/openrouter/fusion`), **`council-tool`** (expose/invoke the native Council tool), **`none`** (plain model, default).

---

## Architecture overview

### The unifying model: a "deliberation backend" selectable per agent and per workflow

A **deliberation backend** is a small enum, `'fusion-direct' | 'council-tool' | 'none'`, attached to two places:

1. **Per agent** — a new optional frontmatter key `deliberationBackend` in `sandbox/.pi/agents/<name>.md` (owned by `server/src/agent/agent-files.ts`).
2. **Per workflow (Pipeline) node** — Archon nodes have **no freeform metadata field** (confirmed from its `dag-node.ts` zod schema), so `deliberationBackend` is **not** a literal node key. It is expressed through the node's **`model`/alias**: Workstream C defines Archon model **aliases** `fusion-direct` and `council-tool`; selecting a backend in the builder writes the matching alias into the node's `model`. *(See Workstream C for the fusion-expert and Council-via-MCP caveats inside Archon nodes.)*

The enum **does not introduce a new model-routing code path**. It is a *writer/derivation* over existing seams:

| Backend | What it actually does | Existing seam it rides |
|---|---|---|
| `none` (default) | Use the configured `model` (or inherit session/default). | `resolveModel(model, registry)` in `server/src/agent/models.ts` — unchanged. |
| `fusion-direct` | Force `model = "openrouter/openrouter/fusion"`. | `resolveModel` **already routes** this ref to Fusion today. Cost path fixed in Workstream A. |
| `council-tool` | Ensure the native `council` tool is in the agent/node tool allowlist and the model is the configured plain model (Council is invoked *as a tool*, not as a model). | Native ToolDefinition registered in `session-registry.ts` like `interview` (Workstream B); per-subagent gating via the `--tools` allowlist (`pi-args.ts`). |

**Why this stays simple:** `fusion-direct` is "write a known model ref"; `council-tool` is "include a known tool name in the allowlist + ledger its out-of-process spend." No package-level frontmatter change is needed because both express through existing keys (`model`, `tools`); `deliberationBackend` is a *host-side convenience field* that the UI and writers derive from. If we add it to `KNOWN_KEYS` it is host-validated; if not, it still round-trips via the `extra` map (zero-parse). We will add it to `KNOWN_KEYS` for validation.

**Two execution domains (important).** The table above is exact for **Kady's own sessions** (chat + agents — Workstreams A/B/D). Inside **Archon Pipeline nodes** the same intents route differently, because Archon's Pi is a *separate in-process runtime*: `fusion-direct` ⇒ node `model: openrouter/fusion` (OpenRouter's native Fusion auto-panel — Kady's β expert-picker does **not** apply inside Archon nodes); `council-tool` ⇒ Kady's Council exposed to Archon's Pi via **MCP** (or a model alias) rather than as Kady's native tool. The Builder writes these as the node's `model`/alias, not a `deliberationBackend` field.

### How it threads end-to-end

- **Model resolution:** all backends terminate at `resolveModel(ref, getModelRegistry())`. The `$0`-fallback for unknown/variable-priced refs is the central risk; Workstream A hardens it so `fusion-direct` (and any unknown ref) cannot silently disable budgets.
- **Cost ledger:** every AI execution — a chat run, a workflow `prompt`/`loop` node, a Council call — records a row in `projects/<id>/sandbox/.kady/runs/<sessionId>/costs.jsonl` via `recordRun`/`recordSubagentRun` (`server/src/cost/ledger.ts`). The `CostEntry.role` union (`'agent'|'subagent'`) is **widened** to add `'workflow'` and `'council'` labels.
- **SSE:** every execution streams through the existing `reply.hijack()` + `toClientFrame()` machinery (`server/src/api/sessions.ts`, `server/src/agent/events.ts`); workflow runs additionally tag frames with `nodeId`.
- **Budget:** `isBudgetExceeded(projectId)` is checked before each run, **before each workflow node, and before each loop iteration**.

### Mermaid: turn / workflow flow

```mermaid
flowchart TD
    subgraph Client["web/ (Next.js)"]
      A1[Agent Builder UI<br/>deliberationBackend picker]
      W1[Workflow Builder UI<br/>DAG editor + node backend]
      C1[Chat / Workflow run<br/>SSE consumer use-agent.ts]
    end

    A1 -->|PUT /agents/:name| AG[server/src/api/agents.ts]
    AG --> AF[agent-files.ts<br/>.pi/agents/*.md + deliberationBackend]

    C1 -->|POST /sessions/:id/run SSE| SR[sessions.ts run handler<br/>Kady Pi session]
    SR -->|fusion-direct / council-tool / none| LED[ledger.ts recordRun<br/>role: agent | subagent | council]

    W1 -->|edit in iframe| ARCHUI[Archon Builder UI<br/>@archon/web ReactFlow]
    ARCHUI -->|PUT /api/workflows/:name| ARCH[(Archon sidecar :309x<br/>Hono + SQLite ~/.archon)]

    C1 -->|POST /pipelines/:id/run| PXY[server/src/api/pipelines.ts<br/>Kady proxy]
    PXY -->|POST /api/workflows/:name/run| ARCH
    ARCH -->|in-process Pi, same SDK + OpenRouter| PINODE{per-node model/alias}
    PINODE -->|fusion-direct alias| FUS[model = openrouter/fusion]
    PINODE -->|council-tool alias| CT[Council via MCP]
    PINODE -->|none| PLAIN[plain model]

    ARCH -->|SSE /api/stream/__dashboard__<br/>turn_end token usage| CB[cost-bridge.ts<br/>price tokens by Kady model]
    CB --> LEDW[ledger.ts recordRun<br/>role: workflow + nodeId]
    LEDW -->|post-hoc| BUD[spendLimitUsd halts NEXT node]
    CB -->|per-node frames| C1
    ARCH -->|approval gate| PXY
```

---

## Workstreams

Ordered by dependency. Workstream A is gated by **Phase 0** (verify whether Pi surfaces the OpenRouter success-path generation id) — see Phasing.

---

### (a) Finalize OpenRouter Fusion (direct) + accurate cost accounting

**Design.** Fusion already routes (`resolveModel('openrouter/openrouter/fusion', registry)` → OpenRouter Fusion endpoint; frontend picker + `models.json` entry exist on the fusion worktree). The job is **cost correctness**. Because (i) Pi as vendored never reads `usage.cost`/`cost_details` from a successful completion (verified: `parseChunkUsage` → `calculateCost(model, usage)` from local `model.cost`), and (ii) Fusion's per-token price is the `-1` sentinel, **token math is structurally incapable of pricing Fusion**. The catalogue already carries an unused `isFusion: true` boolean per entry — the hook exists in data but `loadCatalogue` ignores it.

Two mechanisms, picked by Phase 0:
- **(2a) PREFERRED — post-run reconciliation.** Capture the OpenRouter generation id from the successful Fusion run, then read authoritative billed cost from OpenRouter's generation/credits API and write **that** into the ledger, overriding the `$0` computed value. **Blocked unless** Pi surfaces the success-path generation id (today it exposes raw provider metadata only on the *error* path). Phase 0 verifies this in the vendored `pi-ai` source.
- **(2b) FALLBACK — conservative estimate/floor.** If 2a is not reachable, gate Fusion behind an explicit, configurable per-call cost (e.g. `panelSize+1` multiplier over a reference model's price, or a flat per-call USD floor), flagged as `estimate`. **Never record `$0` for a Fusion turn.**

**Ref-resolution correctness (mustFix — the cost fix is void without it).** The canonical `fusion-direct` ref is `openrouter/openrouter/fusion`: `resolveModel`/`stripOpenRouter` strip **one** `openrouter/` (the provider-routing prefix), leaving `openrouter/fusion` — OpenRouter's real vendor/model slug — as the API `model.id`. **Bug:** `loadCatalogue` keys every entry by `stripOpenRouter(id)`, so the `openrouter/fusion` catalogue entry (the only `isFusion:true` row, `models.json` L186) is stored under key **`fusion`**, while `buildOpenRouterModel(orId)` looks it up by the un-stripped `orId` (`openrouter/fusion`) → **MISS** → `isFusion`/pricing lost → `$0` — the exact opposite of G1. **Fix:** make the lookup symmetric with the keying — `loadCatalogue().get(stripOpenRouter(orId))` (keep `id: orId`, so the API slug stays `openrouter/fusion`). Add a unit test asserting `resolveModel('openrouter/openrouter/fusion', registry)` resolves to an entry whose catalogue row has `isFusion:true` (the existing Phase-1 test only asserts `loadCatalogue` *populates* `isFusion`, not that the writer's ref *hits* it). *(The ledger records the **resolved** slug `openrouter/fusion` — Appendix C — which is intentionally different from the **input** ref `openrouter/openrouter/fusion`; not a contradiction.)*

**In-flight frontend `fusion/<id>` configs (firsthand grounding — supersedes the research's "just select `openrouter/fusion`" assumption).** The uncommitted Track-1 work (`web/src/lib/use-models.ts`) does **not** simply select `openrouter/fusion`. It reads user-defined **Fusion configs** from `localStorage["fusionConfigs"]` (each `= {experts: string[], reasoning_effort}`), renders them as synthetic models with ref **`fusion/<configId>`**, and estimates price by **summing the experts' per-1M rates** (`totalPrompt`/`totalCompletion`). Two breakages: (i) `resolveModel` has **no `fusion/` branch**, so a `fusion/<id>` ref strips to `fusion/<id>`, misses the catalogue (`$0`), and sends an **invalid** id to OpenRouter; (ii) the `fusionConfig` (experts/reasoning) is **never transmitted** to the backend — only the bare ref is. This is the concrete reason the in-UI Fusion results were poor. **Decision (Open Decision B) → CHOSEN: (β).** Add a backend `fusion/` resolution branch that loads the named config, expands `experts`/`reasoning_effort` into the OpenRouter Fusion request, and uses the already-computed summed-expert price as the conservative **2b** estimate (keeps the half-built expert-picker UX). Concretely: (1) the run request transmits the selected `fusion/<id>` ref **and** its `fusionConfig` (experts + reasoning) — `use-models.ts` already holds it, but only the bare ref is sent today, so `RunBody`/the picker must forward the config; (2) `resolveModel` gains a `fusion/` branch that builds the Fusion `Model` with `id` = OpenRouter's Fusion slug (`openrouter/fusion`), `isFusion:true`, and `cost` seeded from the summed-expert estimate; (3) the expert list + reasoning are passed to OpenRouter as Fusion request params (panel/plugin config — confirm the exact param names against OpenRouter's Fusion API in Phase 0). The summed-expert price is the natural 2b floor; if mechanism 2a (billed-cost reconciliation) is reachable it overrides the estimate.

**Data-model / schema changes.**
- `CatalogueEntry` (in `server/src/agent/models.ts`): add `isFusion: boolean` (read `m.isFusion` in `loadCatalogue`, default `false`).
- New config (env or project setting) for 2b: `FUSION_COST_MULTIPLIER` (default e.g. `5`) and/or `FUSION_COST_FLOOR_USD`, plus a `FUSION_COST_REFERENCE_MODEL` ref.
- `CostEntry` gains no schema field for Fusion specifically; a Fusion-estimate row is a normal row with a flag in a new optional field `costStatus?: 'billed' | 'estimated'` (additive; readers default to `'billed'`).

**Files to MODIFY.**
- `server/src/agent/models.ts` — `loadCatalogue` reads `isFusion`; `buildOpenRouterModel` must **not** trust per-token cost when `isFusion`. Treat a `$0`/sentinel resolution as a *cost-handling branch*, not a free pass.
- `server/src/cost/ledger.ts` — add optional `costStatus` to `CostEntry`/`recordRun`; ensure Fusion estimate rows are not skipped by the "0 tokens AND 0 cost" filter.
- `server/src/api/sessions.ts` — wire the Fusion cost into the existing `finally` ledger path (no new endpoint).
- `web/src/data/models.json` + `scripts/update-models.py` (fusion worktree, uncommitted) — keep `isFusion:true`; ensure the `-1` sentinel cannot silently coerce a *future* model to `$0` (only `isFusion` entries get the special path).
- `web/src/lib/use-models.ts` — fix the `[]`-dep `useMemo` so it listens for `fusion-configs-changed` (so newly created Fusion configs appear without reload). *(This is a correctness fix needed before Fusion is selectable in builders.)*

**API endpoints.** None new. Fusion cost rides the existing `POST /sessions/:id/run` (and, later, workflow node runs) ledger path. *(2a only:)* a server-side call to OpenRouter's generation API keyed on the captured generation id.

**Frontend/UI.** Fusion rows already render (red dot, "OR Fusion", sorted to top) in `model-selector.tsx`. Surface `costStatus: 'estimated'` visibly in the cost pill (`session-cost-pill.tsx`) so users know a Fusion turn is an estimate under 2b.

**Cost & budget integration.** This *is* the budget integration. After 2a/2b, a Fusion turn always accrues `> $0`, so `getSessionStats().cost` advances and `spendLimitUsd` trips. **Fail-safe policy (Open Decision):** when a project has `spendLimitUsd` set and only the inexact 2b estimate is available, decide block-vs-warn.

**Edge cases & failure modes.**
- Generation id unreachable on success path → fall back to 2b (do not silently record `$0`).
- A non-Fusion model also reporting `-1` → must be dropped/handled by the non-Fusion negative-pricing path (already `continue`s in `update-models.py`); `isFusion` must drive cost handling, not be cosmetic.
- OpenRouter changing default panel size → any hardcoded 2b multiplier drifts; prefer 2a; treat 2b as a guardrail, not truth.
- Cache token fields are `0` on the synthesized Fusion model; do not attempt cache-aware token math for Fusion.

**Test plan.**
- Unit: `loadCatalogue` populates `isFusion`; `buildOpenRouterModel` returns the Fusion cost branch; a Fusion run never produces a `$0` ledger row.
- Integration: with a low `spendLimitUsd`, a sequence of Fusion turns trips `isBudgetExceeded`.
- Phase-0 gate: a test/inspection asserting whether the success-path generation id is reachable in vendored `pi-ai`.

---

### (b) AI Council tool (native tool, not MCP) + out-of-process cost capture

**Design & decision.** **Use Option B: a native Pi `ToolDefinition` (`server/src/agent/council.ts`) that HTTP-calls a running The AI Counsel backend**, mirroring `server/src/agent/interview.ts`. **Justification over MCP (Option A — register `http://host:8001/mcp/sse` in `.pi/mcp.json`):** the MCP tool result is opaque to our ledger, so we'd lose `cost_report` unless we *also* called REST — i.e. MCP gives tools but not clean spend capture. Native lets us (1) read `cost_report` and ledger it, (2) enforce `isBudgetExceeded` pre-checks like `subagent-bridge.ts`, (3) normalize the synthesized answer, and (4) map progress to our SSE. MCP is a **zero-code stopgap only**.

The Council **backend stays a sidecar** (Python FastAPI/uv, its own process/container). **No Python in `server/`.**

**Data-model / schema changes.**
- Native ToolDefinition `councilTool` with typebox params: `{ question, mode: 'council'|'advisors', execution_mode: 'chat_only'|'chat_ranking'|'full', models?: string[], chairman_model?: string, web_search?: boolean }`. `executionMode: 'sequential'` (blocking, like interview).
- New env: `COUNCIL_API_BASE` (default `http://localhost:8001`).
- `CostEntry.role` widened to include `'council'`.

**Files to ADD.** `server/src/agent/council.ts` (the tool + a module-level pending map + `resolveCouncil`/`pendingCouncilFor`/`validateCouncilAnswer` if an inline approval/progress UI is desired, mirroring interview).

**Files to MODIFY.**
- `server/src/agent/session-registry.ts` — `build()` lines ~102–117: push `councilTool` into `customTools` **and** add `'council'` to the `tools` name array (both, or the tool is inert).
- `server/src/cost/ledger.ts` — widen `role` union; bucket `'council'` in `sessionCostSummary`'s `agentUsd/subagentUsd` split (don't let it silently fall into `agentUsd`).
- `server/src/agent/subagent-bridge.ts` — optional: if Council should be budget-gated/ledgered at the extension layer (clone the `subagent` branch keyed on `toolName==='council'`).
- *(Optional inline UI):* `server/src/api/sessions.ts` — add `POST /sessions/:id/council/:toolCallId` + `GET /sessions/:id/council` mirroring the interview routes.

**API endpoints (outbound, to sidecar).** `POST ${COUNCIL_API_BASE}/api/ask` body `AskRequest = {content, models?, chairman_model?, web_search:boolean, execution_mode:'chat_only'|'chat_ranking'|'full', documents?}`; response includes `conversation_id`, the answer (`response`/`responses`/`stage3`), and **`cost_report`** `{currency, total_cost, input_tokens, output_tokens, total_tokens, ..., cost_status, has_unknown_costs, by_model[], by_stage[]}`. Optional live progress: `GET /api/conversations/{id}/progress`.

**Frontend/UI.** Council is selected via the deliberation-backend picker (Workstream D). When `council-tool` is chosen, the agent/node tool allowlist includes `council`. If the inline progress/approval UI is built, clone `web/src/components/interview-form.tsx` → `council-form.tsx`, dispatched on `toolName==='council'` from the `tool_start` frame.

**Cost & budget integration (load-bearing).** In `execute()`, **before** the call: `isBudgetExceeded(projectId)`. **After** the call: `recordSubagentRun(projectId, sessionId, 'the-ai-counsel', { cost: cost_report.total_cost, tokens: { input: cost_report.input_tokens, output: cost_report.output_tokens, cacheRead: 0, total: cost_report.total_tokens } })` (`ledger.ts` was built for exactly this out-of-process case). **Policy on `cost_status==='unknown'`/`has_unknown_costs` (Open Decision):** surface/warn or block — **do not silently record `$0`** (same class of failure as the Fusion `-1` risk). Council bills its *own* provider keys, so its spend only re-enters our ledger via this capture.

**Edge cases & failure modes.**
- Sidecar down / `COUNCIL_API_BASE` unreachable → tool returns `isError` with a clear message; agent continues; no `$0` ledger row.
- A `full` 3-stage / iterative run is many sequential calls (slow, expensive) → enforce a timeout + abort path; budget caps bound it.
- `cost_status: 'unknown'` (member model not in pricing catalog) → `total_cost` may be `0`/`None`; apply the chosen policy.
- Sidecar exposed on `0.0.0.0`: `/api/ask` is unauthenticated by default — keep it localhost-bound.
- API churn (25→10 MCP tools; `run_iterative_debate` added v0.7.0) → **pin a version/commit**; the `/api/ask` + `cost_report` contract may shift.

**Test plan.** Unit: tool registers in both arrays; `execute()` maps `cost_report` → `recordSubagentRun`. Integration (with a stub sidecar): a Council call advances the ledger and trips `spendLimitUsd`; an `unknown` cost triggers the chosen policy, never a `$0` row. Failure: sidecar 503 → `isError`, no ledger corruption.

---

### (c) Adopt Archon as the Pipelines workflow engine (sidecar) + cost-reconciliation bridge

**Decision (Open Decision A) → ADOPT Archon, not build-native.** The user wants Archon's visual builder; the decisive enabler is that **Archon already depends on the same Pi fork Kady embeds** (`@earendil-works/pi-coding-agent@^0.79.1` + `pi-ai@^0.79.1`), running Pi **in-process** with native OpenRouter routing. So Pipelines get the DAG engine, 17 bundled workflows, loop/approval semantics, worktree isolation, and the builder (Workstream H) without reimplementation. **Pin Archon v0.4.1 (MIT)**; re-resolve the tag's commit SHA and re-verify `dev`-sourced schema/route details against it.

**Naming.** Archon calls these "Workflows"; Kady already has a prompt-template "Workflows" launcher (`web/src/components/workflows-panel.tsx`, zero DAG code). Surface Archon's feature in Kady as **"Pipelines"** to disambiguate; enforce that label everywhere.

**Topology.** Run Archon as a **localhost sidecar** beside Kady's Fastify (:8000) and Next.js (:3000). **Pin Archon's `PORT` off :3000** (Archon defaults to 3000 or 3090 depending on path) — e.g. `ARCHON_PORT=3091`, `ARCHON_BASE_URL=http://127.0.0.1:3091`. Use Archon's **default SQLite** state (`~/.archon/archon.db`, a local file — never the `--profile with-db` Postgres path). Keep it localhost-bound; do not enable the `auth-service`/cloud profiles.

**Pi / OpenRouter config (the easy win).** Set `~/.archon/config.yaml` `assistants.pi.model` to an OpenRouter id and inject `OPENROUTER_API_KEY` (process env, or per-codebase via `PUT /api/codebases/{id}/env` for project-scoped BYOK — Pi env-var-priority-per-request gives clean per-project keys). **VERIFY** the full `assistants.pi` key set (`enableExtensions`/`extensionFlags`/`env`) against the pinned v0.4.1 config schema (the original proposal exposed only `model` in v1).

**Codebase registration.** Register each Kady project's sandbox as an Archon **codebase** (`POST /api/codebases`, `default_cwd = projects/<id>/sandbox`, `ai_assistant_type = pi`), done in `server/src/prep.ts` per project. **Caveat (Phase-0 VERIFY):** Archon's per-run **git-worktree isolation assumes a git repo** — confirm `sandbox/` is git-initialized or that Archon has a non-git/host-cwd mode; if required, `git init` the sandbox in prep.

**Per-node deliberation backend — the modeling constraint.** Archon nodes have **NO freeform metadata/env field** (confirmed from `packages/workflows/src/schemas/dag-node.ts`); nodes carry per-node `model`, `provider`, `effort`, `allowed_tools`, `denied_tools`, `thinking`. So `deliberationBackend` is expressed through `model`/**alias** (Open Decision A.1):
- `fusion-direct` → node `model: openrouter/fusion` (Archon's Pi routes via OpenRouter natively). **Limitation:** uses OpenRouter's *native* Fusion auto-panel; Kady's β expert-picker (Workstream A) is a Kady-session feature and does **not** apply inside Archon nodes. Define an Archon model **alias** `fusion-direct` (`PATCH /api/config/aliases`) for friendly authoring.
- `council-tool` → expose Kady's Council (Workstream B) to Archon's Pi as an **MCP server** the node can call. **VERIFY Pi+MCP support inside Archon**; fall back to a `council` alias / dedicated deliberation node.
- `none` → plain node `model`.

**Cost reconciliation (the #1 risk).** Archon runs Pi **out-of-process**, so Kady's `getSessionStats()` snapshot does **not** see Pipeline spend, and Archon's per-run USD figure is only *confirmed* to reach PostHog telemetry — **UNVERIFIED** whether `GET /api/workflows/runs/{runId}` or its events carry `cost_usd`. **Design the bridge to NOT depend on an Archon USD figure:** subscribe to Archon SSE (`GET /api/stream/__dashboard__`) and/or poll `GET /api/workflows/runs/{runId}`, read **token counts** from `turn_end`/`agent_end` events, and **price them with Kady's own cost model** (the same `resolveModel`-driven pricing the ledger already uses), writing `role:'workflow'` rows with `nodeId`. **Consequence — budget enforcement is post-hoc** (Kady learns spend *after* a node runs); `spendLimitUsd` halts the *next* node/run, not one mid-flight. A per-pipeline/per-node `maxBudgetUsd` checked between nodes is the mitigation. **Phase-0 gates this** (confirm token/cost is readable + the exact event shape).

**Data-model / schema changes.** None inside Archon (use its schema as-is). Kady side: `CostEntry.role` widened to include `'workflow'`; add a `nodeId` field; a small per-project codebase-id map (Kady project → Archon codebase id).

**Files to ADD (Kady side — a thin bridge, not an engine).**
- `server/src/agent/archon/client.ts` — typed HTTP/SSE client for Archon's Hono REST (`ARCHON_BASE_URL`): workflow CRUD, run lifecycle, approvals, `GET /api/providers/pi/models`, config/aliases.
- `server/src/agent/archon/cost-bridge.ts` — subscribe to Archon run events, price tokens via Kady's cost model, write `role:'workflow'` rows, enforce post-hoc `spendLimitUsd` + `maxBudgetUsd`.
- `server/src/api/pipelines.ts` — Kady routes that **proxy** Archon CRUD/run/approve so the web app stays same-origin and project-scoped (inject the project's codebase id + BYOK env).

**Files to MODIFY.**
- `server/src/index.ts` — register the `/pipelines` proxy routes.
- `server/src/cost/ledger.ts` — widen `role` to include `'workflow'`; add `nodeId`; bucket the new role in `sessionCostSummary`.
- `server/src/prep.ts` — ensure `sandbox/` is a git repo (worktree requirement) and auto-register/refresh the Archon codebase per project.
- `start.sh` + `.env.example` — launch/health-check the Archon sidecar (pinned port, SQLite, localhost) alongside backend + frontend; document `ARCHON_PORT`/`ARCHON_BASE_URL`; surface `OPENROUTER_API_KEY` to Archon.

**API endpoints (Kady proxy → Archon).** `GET/PUT/DELETE /pipelines[/:name]` → Archon `/api/workflows/...`; `POST /pipelines/:name/validate`; `POST /pipelines/:name/run` (SSE relay of `/api/stream/__dashboard__`, filtered to the run); `POST /pipelines/runs/:runId/{cancel,resume,abandon,approve,reject}`.

**Frontend/UI.** New top-level **"Pipelines"** view (Workstream H): edit in Archon's builder (iframe), **run + monitor + budget natively in Kady** off the proxied SSE.

**Cost & budget integration.** Per-node `role:'workflow'` rows priced by Kady; post-hoc `spendLimitUsd` + optional `maxBudgetUsd` ceiling between nodes; never record `$0` (Workstream A's pricing hardening applies).

**Edge cases & failure modes.**
- **Sidecar down** → Pipelines view degrades with a clear setup error; chat/agents unaffected.
- **Port collision** with Next.js :3000 → pin `ARCHON_PORT`.
- **Non-git sandbox** → worktree creation fails; `git init` in prep (Phase-0 verify).
- **Cost signal absent** in run API *and* events → blocks accurate budgeting; Phase-0 gate must catch this (worst case: instrument tokens from the Pi SDK Archon uses).
- **Two credential stores** (Kady + Archon) → inject the same OpenRouter key; keep both localhost; never echo values.
- **`dev` vs `main` drift** → pin v0.4.1 and re-verify schema/routes.

**Test plan.** Phase-0: assert token/cost readable from `GET /api/workflows/runs/{runId}` or SSE events; assert worktree works on the sandbox. Integration: Kady creates a 3-node pipeline via the proxy, runs it, the cost-bridge writes `role:'workflow'` rows that advance project spend and trip `spendLimitUsd` on the next node; an approval gate pauses and resumes via the proxy; sidecar-down degrades cleanly.

---

### (d) Per-agent & per-workflow deliberation-backend selection (the shared abstraction)

**Design.** One enum (`'fusion-direct'|'council-tool'|'none'`) wired into both the agent `.md` schema and the workflow node schema, with consistent UI and consistent *derivation* (see Architecture). The host main session does **not** enforce per-agent tool allowlists (it loads the full tool universe), so for the **main session** a `fusion-direct` vs `council-tool` choice must be enforced in **app code** (write the model ref; ensure/gate the council tool inside `execute()`), not by the frontmatter `tools` field. For **subagents**, the `--tools` allowlist *is* the enforcement (`pi-args.ts`).

**Main-session gating mechanism (the load-bearing point for ask 8 on the host session).** The `council` ToolDefinition is **always** registered on the main session (it lives in the static `customTools` array), so per-agent selection must gate it **at call time**, not at registration. At run start, `POST /sessions/:id/run` stamps the active agent's `deliberationBackend` into the request scope (`scope.ts` `AsyncLocalStorage`) and/or the live session's metadata; `council.execute()` reads it first and returns an `isError` no-op ("AI Council is not enabled for the active agent") unless it is `council-tool`. Symmetrically, `fusion-direct` on the main session is enforced by writing `model='openrouter/openrouter/fusion'` into the run before `session.prompt()`. (Subagents need none of this — their `--tools` allowlist and per-agent `model` already isolate them.)

**Data-model / schema changes.**
- `agent-files.ts`: add `deliberationBackend?: 'fusion-direct'|'council-tool'|'none'` to `AgentFile`/`AgentFilePatch`; add `'deliberationBackend'` to `KNOWN_KEYS` (so it's host-validated and not pushed to `extra`); `parseAgentMarkdown`/`serializeAgentMarkdown` read/emit it.
- `api/agents.ts` `patchFromBody`: validate `body.deliberationBackend` against the enum (string error on mismatch), mirroring `systemPromptMode`/`thinking` validation.
- Workflow node: `deliberationBackend?` (Workstream C).
- Derivation rules (shared util): `fusion-direct` ⇒ write `model='openrouter/openrouter/fusion'`; `council-tool` ⇒ ensure `'council'` ∈ tool allowlist; `none` ⇒ no override.

**Files to MODIFY.** `server/src/agent/agent-files.ts`, `server/src/api/agents.ts`, the new workflow schema owner, plus UI (Workstreams G/H). Optionally `server/src/agent/subagents.ts` + `agent-files.ts` `rosterMarkdown` if seeded personas should carry a default backend (otherwise default `none`).

**API endpoints.** Reuse `GET/PUT/DELETE /agents`, `POST /agents/restore-defaults`; the PUT body gains `deliberationBackend`. Workflow CRUD from Workstream C.

**Frontend/UI.** A single shared `<DeliberationBackendPicker>` (radio/segmented: Default / Fusion (direct) / AI Council) used by both the Agent Builder and the Workflow node editor. When `fusion-direct` is chosen, the model selector may be hidden/locked to Fusion; when `council-tool`, the model selector picks the *plain* model the Council tool's caller runs on, and the `council` tool is auto-added to the allowlist.

**Cost & budget integration.** Inherits A (Fusion) and B (Council) cost paths. **Gotcha:** a `fusion-direct` agent/node pointed at `openrouter/openrouter/fusion` must have the Fusion cost path (A) or it silently bypasses `spendLimitUsd`.

**Edge cases & failure modes.**
- Two independent frontmatter parsers (host narrow `KNOWN_KEYS` vs `pi-subagents` wide superset). `deliberationBackend` is invisible to the package unless expressed through existing keys — which is exactly why the derivation writes `model`/`tools` (the package *does* honor those). The host field is a UI/validation convenience.
- `subagent` in a `council-tool` agent's tool list flips `fanoutAuthorized`; omit it if the agent shouldn't spawn subagents.
- Live sessions keep the tool set/agent config they started with; edits affect only new chat tabs / future subagent runs.

**Test plan.** Unit: `deliberationBackend` round-trips through parse/serialize; `patchFromBody` rejects invalid values; derivation writes the correct `model`/`tools`. Integration: an agent set to `fusion-direct` runs against Fusion and accrues cost; one set to `council-tool` exposes `council` and ledgers its spend; a subagent with a `council`-excluding allowlist cannot call it.

---

### (e) K-Dense "Karpathy" + "agentic data scientist" agents

**Design & exact form.** **Both are AgentFile-format project agents, NOT `SUBAGENT_TYPES` entries, NOT read-only builtins** (so they're editable in the Agent Builder and can carry a per-agent `deliberationBackend`). Do **not** vendor/shell the Python packages or replicate their 9–13 child-agent process trees; port the **personas/prompts** and use the existing `subagent` tool as the `delegate_task` analogue. Pin upstream to a commit and record the source SHA for auditable re-syncs.

- **Karpathy → `karpathy.md`.** systemPrompt = port of `karpathy/instructions.yaml` `main_agent` (verbatim opening line: *"You are Karpathy: an agentic Machine Learning Engineer focused on designing, running, and improving state-of-the-art ML experiments…"* + the uv/sandbox/skills `common_instructions`). Frontmatter: `description: "Agentic ML engineer: data prep, model design, training, eval, deployment"`; `inheritSkills: true` (depends on the pytorch/transformers/scikit-learn skills already seeded by `skills.ts`); `inheritProjectContext: true`; `tools: read, write, edit, bash, grep, find, ls, subagent` (it **must** have `bash`+`write` to actually train; `subagent` is its `delegate_task` analogue — do **not** recreate its ~13 experts). `systemPromptMode: append`. **Default model: leave UNSET** (Karpathy upstream hard-requires a user-set `AGENT_MODEL`; there is no baked-in default) so it inherits the session/picker; the per-agent picker (`deliberationBackend`) is the override seam. **Drop the "Infra & Modal Operator" capability** — Kady has no Modal/compute-offload integration.
- **Agentic data scientist → `data-scientist.md` (agent) + a seed Pipeline (workflow).** Agent: systemPrompt = condensed port of `prompts/base/{global_preamble, plan_maker, coding_base}.md`; `description: "End-to-end data scientist: plan -> code -> review -> reflect -> summarize"`; `inheritSkills:true`; `inheritProjectContext:true`; `tools: read, write, edit, bash, grep, find, ls, subagent, interview`; model unset/picker-driven. **Plus** its real value: lift the 9 prompt roles (`plan_maker → plan_reviewer → plan_parser → stage_orchestrator → coding/review/criteria/reflect loop → summary`) as the **seed example Pipeline** for Workstream C — each `.md` prompt becomes a `prompt` node; `criteria_checker`/`stage_reflector` become `loop`/`approval` nodes. *(The Pipeline half depends on Workstream C existing.)* Do **not** carry over its dual-key Anthropic-direct coding lane — route everything through OpenRouter via `resolveModel`.

**Data-model / schema changes.** None new beyond Workstream D's `deliberationBackend`. These are ordinary `.md` agent files (+ one workflow file).

**Files to ADD.** `karpathy.md` and `data-scientist.md` seeded into `sandbox/.pi/agents/` (via the existing `.seeded` marker path in `seedAgentFiles`); one seed Pipeline under Archon's `.archon/workflows/` (the data-scientist's plan→code→review→reflect→summary roles as Archon nodes). A `NOTICE` or inline attribution crediting K-Dense AI for the ported `instructions.yaml`/prompts.

**Files to MODIFY.** `server/src/agent/agent-files.ts` — extend `seedAgentFiles` to write these two files (seeded as **project** agents so they're editable). *(No `subagents.ts` change; they are not `SUBAGENT_TYPES`.)*

**API endpoints.** None new — they appear via `GET /agents` and are edited via `PUT /agents/:name`.

**Frontend/UI.** They show up in the Agent Builder list like any project agent; the data-scientist seed Pipeline shows up in the Pipelines builder.

**Cost & budget integration.** These are long-running, expensive agents; they amplify the `$0`-fallback risk if pointed at an unknown/Fusion model. **Workstream A must land before shipping multi-hour ML agents.** Subagent (delegated) spend is invisible to `getSessionStats` and must be re-ledgered via `subagent-bridge.ts` (already handled for the `subagent` tool).

**Edge cases & failure modes.** Karpathy is inert without `bash`+`write` and real Python/uv compute (note: compute is user-provided; no Modal). The "Gemini 3.5 Flash" default in some summaries is paraphrase — upstream states an OpenRouter default; treat the precise version as unverified and pick a cheap OpenRouter ref for the data-scientist's planning lane if pinning one.

**Test plan.** Seeding writes both files; deleting one and re-seeding respects the `.seeded` marker; each agent parses with the ported persona and correct tools; `deliberationBackend` is settable; the data-scientist seed Pipeline loads and validates.

---

### (f) Mimeograph integration

**Design.** Treat Mimeograph as a **skill/agent source**, not a server module or report generator. Two layers; **Layer A is recommended and cheap**, Layer B is optional and heavier.

- **Layer A (recommended) — vendor the pre-built `mimeographs` collection.** This covers deliverable #6 *and* supplies the Karpathy *skill* (deliverable #5's Karpathy half). `server/src/agent/skills.ts` already shallow-clones one repo into `sandbox/.pi/skills/`; **generalize `seedProjectSkills` to seed from a LIST of `(repo, subpath, branch)` sources** and add `K-Dense-AI/mimeographs` as a second source. `copySkillDirs` requires `SKILL.md` per folder and won't clobber existing dirs, so mimeograph folders drop in unchanged. **Ambiguity to resolve at wiring time:** the `mimeographs` repo's internal layout (root-level skill folders vs a `skills/` subdir) was **not** directly verified — confirm the actual `subpath` when wiring. **Also:** some mimeographs may ship **`AGENTS.md` only (no `SKILL.md`)**; `copySkillDirs` *skips* those — handle by either preferring `SKILL.md` on copy, or converting `AGENTS.md` → a project agent file (`AGENTS.md` body → `systemPrompt`, `systemPromptMode:'append'`, `inheritSkills:true`).
- **Layer B (optional) — wrap the `mimeo` CLI as a native Pi tool** (typebox params `{name, format:'skill'|'agents'|'both', maxSources, deepResearch, model}`; `execute()` shells `uv run mimeo` into a temp dir, copies the produced folder into `paths.skillsDir`). **Cost gap:** `mimeo` bills `PARALLEL_API_KEY` + `OPENROUTER_API_KEY` **outside** OpenRouter's per-session usage, so its spend is **not** captured by the ledger and bypasses `spendLimitUsd` — flag explicitly; needs an out-of-band cost note or manual cap. Also adds a **Python + uv** runtime dependency to the otherwise pure-TS server and two new secrets. The default distillation model is a Gemini model **via OpenRouter** (an API model id — it does **not** reintroduce the removed Gemini CLI), but override it to match project model policy. Disable the avatar step (`--no-avatar`) in automated paths.

**Data-model / schema changes.** None for Layer A (skills are plain folders). Layer B adds the tool params above.

**Files to MODIFY (Layer A).** `server/src/agent/skills.ts` — generalize `seedProjectSkills`/`cloneCatalogue`/`copySkillDirs` to multi-source; add the `mimeographs` source. **Files to ADD (Layer B, optional):** `server/src/agent/mimeo.ts` native tool + registration in `session-registry.ts`.

**API endpoints.** None for Layer A (skills appear via `listProjectSkills`). Layer B rides the tool surface.

**Frontend/UI.** A mimeograph is just another selectable skill (and, if converted, an agent) — no special-casing in the builders.

**Cost & budget integration.** Layer A: none (static content). Layer B: **uncaptured external spend** — explicit gap; default to *not* building Layer B unless the user accepts the cost-accounting and Python-runtime tradeoffs.

**Edge cases & failure modes.** Name ambiguity (generator vs collection); persona/likeness of real named people (Karpathy etc.) shipping as built-ins is a publicity/accuracy call for the user even under MIT; `AGENTS.md`-only folders silently dropped by `copySkillDirs`.

**Test plan.** Layer A: multi-source seeding clones both repos; Karpathy mimeograph appears in `listProjectSkills`; an `AGENTS.md`-only folder is handled (not silently dropped). Layer B (if built): a `mimeo` invocation lands a folder in `skillsDir`; cost-gap note is surfaced.

---

### (g) Interactive Agent Builder UI

**Design.** Extend the existing per-agent editor (`web/src/components/subagents-panel.tsx`, already a form with name/model/thinking/tools/inherit switches/systemPrompt) into a richer builder, or add a sibling panel. Mount as a Settings tab (`settings-dialog.tsx`, alongside the existing `agents`/`fusion` triggers). Reuse `formFromAgent`/`EMPTY_FORM`/`AgentFormState`.

**Data-model / schema changes.** Frontend `AgentFile`/`AgentPatch` (`web/src/lib/agents.ts`) gains `deliberationBackend?`. `extra` already carries unmodeled frontmatter unchanged.

**Files to MODIFY.** `web/src/components/subagents-panel.tsx` (swap the **free-text** model `<Input>` for `<ModelSelector>` from `model-selector.tsx`; add `<DeliberationBackendPicker>`); `web/src/lib/agents.ts` (add `deliberationBackend` to types); `web/src/components/settings-dialog.tsx` (tab mount). **Files to ADD:** `web/src/components/deliberation-backend-picker.tsx` (shared with Workstream H).

**API endpoints.** Existing `GET/PUT/DELETE /agents`, `POST /agents/restore-defaults` (project-scoped via `apiFetch` `X-Project-Id`); PUT body gains `deliberationBackend`.

**Frontend/UI.** Per-agent: name, description, **`<ModelSelector>`** (replacing free-text), thinking buttons, tools allowlist, inherit switches, `systemPromptMode`, systemPrompt textarea, and the **deliberation-backend picker**. List project agents (editable) + builtins (read-only, "View"/"Customize"→copy to project). "Restore defaults" re-seeds (now including Karpathy/data-scientist from Workstream E).

**Cost & budget integration.** Verify the chosen model id is one `resolveModel` can route server-side; **local `fusion/<id>` client-synthesized ids may not resolve server-side** — prefer the canonical `openrouter/openrouter/fusion` (set by `deliberationBackend='fusion-direct'`).

**Edge cases & failure modes.** `SettingsDialog` mounts all Radix `TabsContent` eagerly — keep the panel's effects light or lazy-mount. Reset/refetch on `kady:project-changed`. Free-text model today is unvalidated; the picker is the fix.

**Test plan.** Edit→save→reload round-trips `deliberationBackend` and a Fusion model id; invalid model id is rejected (server validation); switching projects refetches.

---

### (h) Surface Archon's Workflow ("Pipelines") Builder UI

**Design.** Archon already ships a visual drag-and-drop DAG builder (React + `@xyflow/react`/ReactFlow: `WorkflowBuilder.tsx`, `WorkflowCanvas.tsx`, `NodeInspector.tsx`, live `YamlCodeView.tsx`), served as part of `@archon/web` on Archon's port — with loop + approval node support. **There is NO documented embed-as-component path** (it's a route in Archon's SPA, not a published component library). **So Kady does not rebuild a DAG editor; it surfaces Archon's and keeps run/monitor/budget native.**

**Surfacing options (Open Decision A.2):**
- **(i) iframe (recommended v1):** embed Archon's builder route in a Kady "Pipelines" top-level view via `<iframe src="${ARCHON_BASE_URL}/...builder">` (VERIFY the exact route in `@archon/web`'s router). Fastest; Archon owns the editor UX. Caveats: cross-origin theme mismatch, session/auth passing, `postMessage` if Kady needs edit→run callbacks.
- **(ii) link-out:** an "Open Pipeline Builder" button opens Archon's app in a new tab. Simplest; least integrated.
- **(iii) reimplement later:** only if a standalone builder component is ever published (not at v0.4.1).

**Run + monitor in Kady (native).** Regardless of where *editing* happens, Kady presents the **execution view natively** by consuming Archon's SSE (`/api/stream/__dashboard__`) through the Kady proxy (Workstream C): per-node states (`pending/running/completed/failed/paused`), **Kady-priced** per-node cost + running total, and approval prompts (clone the interview-form interaction model) driven via the proxy (`/approve|reject`). **So: edit in Archon's builder (iframe), run + monitor + budget in Kady.**

**Deliberation backend in the builder.** Since nodes have no `deliberationBackend` field, the choice is the node's **`model`/alias** (the `fusion-direct`/`council-tool` Archon aliases from Workstream C). With the iframe builder the user picks the alias in Archon's NodeInspector; a Kady-native inspector is only needed under option (iii).

**Files to ADD.** `web/src/lib/pipelines.ts` (client for Kady's `/pipelines` proxy); a native run-view component consuming proxied SSE. **No DAG-editor code in Kady for v1.**

**Files to MODIFY.** `web/src/app/page.tsx` (new "Pipelines" view: builder iframe + native run view); `web/src/components/chat-tabs-bar.tsx` (new pill, next to "Workflows").

**API endpoints.** Consumes Workstream C's Kady `/pipelines` proxy (CRUD + run SSE + cancel/resume/approve/reject) — which in turn calls Archon's REST/SSE.

**Cost & budget integration.** Surface Kady-priced per-node cost + workflow total; show the post-hoc budget halt clearly; flag `estimated` (Fusion) node costs.

**Edge cases & failure modes.** iframe theme/auth mismatch; Archon sidecar down → show setup help instead of a broken frame; enforce "Pipelines" naming everywhere; approval pauses live in Archon's run-state, so a dropped SSE reconnects via `GET /api/workflows/runs/{runId}`.

**Test plan.** Open the Pipelines view → Archon builder loads (iframe); create + save a pipeline there; it appears in Kady's list via the proxy; run it from Kady; the native run view streams per-node SSE + Kady-priced cost; an approval gate pauses and resumes through the proxy; sidecar-down shows setup help.

---

## Phasing / Milestones

**Phase 0 — Cost-accuracy gate (BLOCKS everything that depends on Fusion budgeting).**
Verify in the vendored `@earendil-works/pi-ai` source whether Pi surfaces the **success-path OpenRouter generation id** (today raw provider metadata is exposed only on the *error* path; `parseChunkUsage` drops everything but tokens).
- **Exit criteria:** A written determination: **2a reachable** (generation id available → post-run reconciliation) **or 2a blocked** (→ adopt 2b conservative estimate, and decide whether to patch/PR `pi-ai` or wrap the Fusion call outside Pi). No Fusion-dependent budgeting work starts until this is decided.

**Phase 1 — Fusion cost correctness (Workstream A).**
- **Exit criteria:** `isFusion` read in `loadCatalogue`; a Fusion turn **never** records `$0`; a low `spendLimitUsd` trips after Fusion turns; `costStatus` surfaced in the cost pill; `use-models.ts` listens for `fusion-configs-changed`.

**Phase 2 — Deliberation-backend abstraction + Agent Builder (Workstreams D + G).**
- **Exit criteria:** `deliberationBackend` round-trips in agent `.md`; `patchFromBody` validates it; Agent Builder uses `<ModelSelector>` + `<DeliberationBackendPicker>`; `fusion-direct` agent accrues cost.

**Phase 3 — AI Council tool + sidecar (Workstream B).**
- **Exit criteria:** Native `council` tool registered; Council call ledgers `cost_report` via `recordSubagentRun`; `unknown`-cost policy enforced (never `$0`); sidecar version pinned; localhost-bound.

**Phase 4 — Adopt Archon sidecar + cost bridge (Workstream C).** *(Phase 4a gate: verify token/cost is readable from Archon's run API or SSE events, and whether worktree execution requires a git sandbox — before building the bridge.)*
- **Exit criteria:** Archon v0.4.1 runs as a pinned-port localhost sidecar (SQLite + Pi/OpenRouter); Kady proxies workflow CRUD + run + approve; the cost-bridge prices Archon run events into `role:'workflow'` `costs.jsonl` rows and enforces post-hoc `spendLimitUsd`; per-project codebase auto-registration; "Pipelines" naming enforced.

**Phase 5 — K-Dense agents (Workstream E).**
- **Exit criteria:** `karpathy.md` + `data-scientist.md` seeded as editable project agents with correct tools/personas; data-scientist seed Pipeline loads; attribution added. *(Depends on Phase 1 for cost safety, Phase 4 for the seed Pipeline.)*

**Phase 6 — Mimeograph Layer A (Workstream F).**
- **Exit criteria:** Multi-source skills seeding; `mimeographs` (incl. Karpathy) appear in `listProjectSkills`; `AGENTS.md`-only folders handled. *(Layer B deferred pending Open Decisions.)*

**Phase 7 — Surface Archon's Pipelines Builder (Workstream H).**
- **Exit criteria:** Kady "Pipelines" view surfaces Archon's ReactFlow builder (iframe/link-out); pipelines created there appear via the Kady proxy; Kady's native run view streams per-node SSE + Kady-priced cost and drives approvals.

---

## Cross-cutting concerns

- **Budgets (the spine).** Every AI execution must accrue `> $0` when it spends real tokens. For **Kady's own runs** (chat/agents/Council), `isBudgetExceeded(projectId)` is checked **before** each run and loop iteration (pre-emptive). For **Pipelines**, spend happens inside the Archon sidecar, so Kady reconciles it **post-hoc** — pricing tokens from Archon run events with its own cost model — and `spendLimitUsd` halts the *next* node/run rather than pre-empting one mid-flight (a per-pipeline/per-node `maxBudgetUsd` ceiling between nodes is the mitigation). The `$0`-fallback in `resolveModel` is the systemic failure mode; Workstream A hardens it and Fusion/Council/Pipeline surfaces each get explicit "never record `$0`" handling. `CostEntry.role` is widened to `'agent'|'subagent'|'workflow'|'council'`; `sessionCostSummary` must bucket the new roles (an unhandled role silently lands in `agentUsd`).
- **Security / BYOK credentials.** Honor `~/.claude/CLAUDE.md` §8: never read/log/echo credentials. The Council sidecar and (optional) `mimeo` introduce **second credential stores** (Council's plaintext `data/settings.json`; `mimeo`'s `PARALLEL_API_KEY`/`OPENROUTER_API_KEY`) — two rotation points, two attack surfaces. Keep the Council backend **localhost-bound** (`/api/ask` is unauthenticated by default). Surface only credential *names*; never extract values.
- **Python reintroduction tradeoff.** The Pi migration deliberately removed almost all Python. Two new surfaces reintroduce it **as sidecars/CLIs, never inside `server/`**: the **Council** backend (FastAPI/uv, required for the Council deliberation engine — accepted) and **`mimeo` Layer B** (Python+uv CLI — optional, deferred). The `server/` codebase stays pure TS/Node; the dependency is a separate process/container the user must run.
- **Backward compatibility.** All schema additions are **additive optional fields** (`deliberationBackend`, `costStatus`, `nodeId`, new `role` values). Existing agent `.md` files, existing sessions, and the existing "Workflows" template launcher are untouched. Live sessions keep the tool set/agent config they started with — edits affect only new chat tabs / future runs. The new role values must be handled in `sessionCostSummary` so historical `costs.jsonl` rows (only `agent`/`subagent`) still sum correctly.

---

## Risks & Open Decisions

**Genuine user decisions surfaced by research:**

**A. Workflow engine — RESOLVED → ADOPT Archon** (user decision: adopt for the visual builder UI). Decisive enabler: Archon already depends on the **same Pi fork Kady embeds** (`@earendil-works/pi-coding-agent@^0.79.1`), running Pi in-process with native OpenRouter routing. Kady runs Archon v0.4.1 as a localhost sidecar (Workstream C) and surfaces its ReactFlow builder (Workstream H). The adoption created cascaded sub-decisions, several gated on Phase-0 verification:

- **A.1 — Per-node deliberation backend (Archon nodes have no metadata field).** Express via the node's `model`/alias: define Archon model **aliases** `fusion-direct` (→ `openrouter/fusion`) and `council-tool` (→ Council via MCP). *Decision:* aliases (recommended, no Archon fork) vs encode raw `model`/`effort` per node vs fork the node schema to add `metadata`. **Note the loss:** Kady's β Fusion expert-picker does not apply inside Archon nodes (only in Kady sessions).
- **A.2 — Builder surfacing.** iframe Archon's builder route inside Kady's "Pipelines" view (recommended v1) vs link-out vs reimplement (only if a standalone builder component is ever published — not at v0.4.1).
- **A.3 — Cost signal (the #1 risk, Phase-0 gate).** VERIFY whether `GET /api/workflows/runs/{runId}` or the SSE events expose per-node token/cost. Design assumes **NOT**, and prices tokens from `turn_end` events with Kady's own model. If even tokens are absent, accurate Pipeline budgeting is blocked.
- **A.4 — Sidecar deployment.** Pin Archon `PORT` off Kady's `:3000` (Archon defaults to 3000/3090); use default SQLite (`~/.archon/archon.db`); localhost-bound; inject the shared `OPENROUTER_API_KEY` (process env or per-codebase). Bundle in `start.sh` vs require the user to run it.
- **A.5 — Worktree/git requirement (Phase-0 gate).** Archon's per-run isolation uses git worktrees — VERIFY `projects/<id>/sandbox/` must be a git repo (or find a non-git mode); if required, `git init` the sandbox in `prep.ts`.
- **A.6 — Behavioral change:** Pipeline budget enforcement is **post-hoc** (spend reconciled after a node runs), unlike Kady's pre-emptive in-session `isBudgetExceeded`. Accept, or add a per-pipeline `maxBudgetUsd` ceiling checked between nodes.

**B. Fusion config model — RESOLVED → (β) keep the expert-picker.** The backend gains a `fusion/` resolution branch that loads the named localStorage config, expands `experts`/`reasoning_effort` into the OpenRouter Fusion request, and uses the summed-expert price as the conservative 2b estimate. The half-built per-config expert UX is kept and wired through, not discarded.

1. **Fusion cost mechanism (gated by Phase 0).** 2a post-run reconciliation (accurate; needs generation-id capture, possibly a `pi-ai` patch or out-of-Pi Fusion wrapper) vs 2b conservative estimate/floor (simpler, always trips the cap, inexact). If 2b: what formula — panel-size multiplier over a reference model, or a flat per-call USD floor?
2. **Fail-safe vs fail-open for Fusion under uncertainty.** When `spendLimitUsd` is set but only the inexact 2b estimate is available, block Fusion or warn-and-proceed?
3. **Accept the Council Python sidecar?** It cannot be native without reimplementing its engine. Run-as-sidecar (recommended) vs thin-Council-only vs skip Council.
4. **Council deployment & keys.** Bundle The AI Counsel into the product docker-compose vs treat as an external dependency the user starts. Share our OpenRouter key into Council's plaintext `settings.json` (single source, but plaintext) vs let Council hold its own keys (two rotation points). Pin which version/commit (API churned: 25→10 MCP tools; `run_iterative_debate` added v0.7.0).
5. **Council `cost_status: 'unknown'` policy.** Block, warn-and-proceed, or record an estimate — directly affects whether spend caps stay enforceable.
6. **Council modes to expose.** Just `council_deliberate(full)` (+ optional `web_search`), or also Advisors persona-debate and `run_iterative_debate` (more params, more cost).
7. **Fusion vs Council overlap.** Both are deliberation surfaces. Keep them distinct backends (recommended, the `deliberationBackend` enum already does this) or unify? Keep distinct.
8. **Pipelines node-type scope for v1.** Ship only `prompt/bash/loop/approval` (the user's minimum) or also `script`(bun/uv)/`command`/`cancel` now?
9. **Loop exit policy.** Prefer deterministic `until_bash`, the brittle string `until` signal, or require **both**? (Reliability vs authoring friction.)
10. **Durable workflow resume.** Persist paused/approval run-state to a `.kady/runs/` file (survives restart, recommended) vs in-process-only (lost on restart, simpler).
11. **`$nodeId.output.field` syntax.** Reuse Archon's verbatim (familiarity) vs a Kady-native templating; and whether to require nodes to declare `output_format` for reliable `structuredOutput`.
12. **K-Dense agents: builtin vs project.** Recommended **project** agents (editable, so the per-agent picker works) vs read-only builtins. Default model **unset** (inherit/picker) vs pin Karpathy to a strong coding model and the data-scientist's planning to a cheap OpenRouter model. Port the data-scientist as agent-only, seed-Pipeline-only, or **both** (recommended). Drop Karpathy's Modal/compute capability for v1 (recommended — no Kady integration)?
13. **Mimeograph ambiguity (UNRESOLVED).** (a) Vendor the **collection** (Layer A, recommended) only, or also build the **`mimeo` generator** (Layer B, adds Python/uv + uncaptured external spend)? (b) **Unverified:** the `mimeographs` repo's internal layout (root folders vs `skills/` subdir) — confirm the `subpath` at wiring time. (c) Ship all 80+ mimeographs or a curated subset? (d) Surface a mimeograph as an activatable **skill** or as a selectable **agent** (mapping `AGENTS.md`→`systemPrompt`)? (e) Persona/likeness of shipping named-real-person agents — acceptable, or gate/label?
14. **`mimeo` Layer B cost policy (if built).** Its Parallel + OpenRouter spend bypasses the session ledger and `spendLimitUsd` — what out-of-band cap/note?

**Standing risks (not user-decided, must be mitigated in code):** the `$0`-fallback disabling spend caps (mitigate everywhere); brittle loop `until` string-match (prefer `until_bash`); SSE socket leaks after `reply.hijack()` (always `raw.end()`); AsyncLocalStorage scope loss on detached node execution (capture `projectId` explicitly); per-node `provider`/`model` validation at workflow-load time; stale "Archon = Python v1" docs misleading future contributors (pin to `main`).

---

## Appendix — concrete example artifacts

### A. Sample Pipeline (workflow) YAML — Archon `.archon/workflows/data-science-demo.yaml`

> **Adopt-Archon note:** this file lives in **Archon's** `.archon/workflows/` and uses Archon's node schema. The `deliberationBackend:` lines below are **conceptual** — Archon nodes have **no metadata field**, so in practice each becomes the node's **`model:`** (an alias: `fusion-direct` → `openrouter/fusion`, `council-tool` → Council-via-MCP). Shown as `deliberationBackend:` here only for readability; the builder writes `model:`.

```yaml
id: data-science-demo
nodes:
  - id: plan
    prompt: "Read the dataset at ./sandbox/data and propose a 3-stage analysis plan. End with a JSON block {\"plan\": [...]}."
    model: openrouter/openrouter/auto        # plain model
    deliberationBackend: none
    effort: medium
    context: fresh
    output_format: json

  - id: review_plan
    depends_on: [plan]
    trigger_rule: all_success
    deliberationBackend: council-tool          # deliberate the plan via AI Council
    prompt: "Critique this plan for statistical validity: $plan.output.plan. Approve or revise."
    effort: high

  - id: implement
    depends_on: [review_plan]
    loop:
      prompt: "Implement the next stage. Run it. If all stages pass, print COMPLETE."
      until: "COMPLETE"
      until_bash: "test -f ./sandbox/.kady/stage_done"   # preferred deterministic exit
      max_iterations: 8
      fresh_context: false
    deliberationBackend: fusion-direct          # heavy synthesis via OpenRouter Fusion
    maxBudgetUsd: 5.00

  - id: human_gate
    depends_on: [implement]
    approval:
      message: "Review the generated results before the summary is written."
      on_reject:
        prompt: "Address the reviewer's objections, then re-run the final stage."
        max_attempts: 3

  - id: summarize
    depends_on: [human_gate]
    trigger_rule: all_success
    prompt: "Write a concise summary of the analysis and findings."
    deliberationBackend: none
```

### B. Sample agent `.md` with `deliberationBackend` — `sandbox/.pi/agents/karpathy.md`

```markdown
---
name: karpathy
description: "Agentic ML engineer: data prep, model design, training, eval, deployment"
model:                                  # UNSET -> inherits session/picker (upstream has no default)
thinking: high
tools: read, write, edit, bash, grep, find, ls, subagent
systemPromptMode: append
inheritProjectContext: true
inheritSkills: true
deliberationBackend: none               # user may switch to fusion-direct or council-tool in the builder
---
You are Karpathy: an agentic Machine Learning Engineer focused on designing, running,
and improving state-of-the-art ML experiments. Your primary goal is to take the user's
high-level intent and turn it into concrete ML work: data preparation, model design,
training, evaluation, and deployment/serving.

Use the Python environment in the `sandbox` directory. Manage dependencies with `uv`
inside `sandbox`. Always use available Skills when relevant. Be resource-aware before
you start coding.

<!-- Persona ported from K-Dense-AI/karpathy karpathy/instructions.yaml (main_agent),
     MIT (c) 2025 K-Dense Inc. Source SHA: <pin-at-port-time>. -->
```

*Notes:* with `deliberationBackend: fusion-direct`, the writer sets `model: openrouter/openrouter/fusion`. With `council-tool`, the writer ensures `council` is in `tools` (here it would become `read, write, edit, bash, grep, find, ls, subagent, council`). On the host main session, `fusion-direct` vs `council-tool` is enforced in app code (the frontmatter `tools` allowlist is only enforced for subagents).

### C. New `costs.jsonl` role labels (and a Fusion estimate row)

`projects/<id>/sandbox/.kady/runs/<sessionId>/costs.jsonl` — `CostEntry.role` is widened from `'agent'|'subagent'` to `'agent'|'subagent'|'workflow'|'council'`; `nodeId` and `costStatus` are additive optional fields.

```jsonl
{"entryId":"a1b2c3d4e5f60718","ts":1750000000,"sessionId":"sess_main","role":"agent","model":"openrouter/anthropic/claude-opus-4.8","promptTokens":1200,"completionTokens":800,"totalTokens":2000,"cachedTokens":0,"costUsd":0.042,"costStatus":"billed"}
{"entryId":"b2c3d4e5f6071829","ts":1750000050,"sessionId":"sess_main","role":"council","model":"the-ai-counsel","promptTokens":9000,"completionTokens":3000,"totalTokens":12000,"cachedTokens":0,"costUsd":0.310,"costStatus":"billed"}
{"entryId":"c3d4e5f607182930","ts":1750000100,"sessionId":"sess_wf_demo","role":"workflow","nodeId":"implement","model":"openrouter/fusion","promptTokens":4000,"completionTokens":2200,"totalTokens":6200,"cachedTokens":0,"costUsd":0.190,"costStatus":"estimated"}
```

The third row is a **Fusion** node under fallback mechanism **2b**: `costStatus:"estimated"` (never `$0`), so `getSessionStats()` / `projectCostSummary` advance and `spendLimitUsd` can trip. Rows with `role:"workflow"`/`"council"` must be bucketed in `sessionCostSummary` (else they silently land in `agentUsd`). `bash` and `approval` nodes write **no** cost row.