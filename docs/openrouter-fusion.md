# OpenRouter Fusion

> **Tombstone (2026-08-20, lane F3).** Earlier revisions of this page listed
> GPT-5.5 fusion panels and numeric DRACO percents. Those predecessor-panel
> scores are **not transferable**. Shipped built-ins are GPT-5.6 Sol Pro
> refresh panels. Every shipped note is `DRACO: unmeasured`. No percent score
> is carried. The live table is `web/src/lib/fusion-presets.ts`
> (`DEFAULT_FUSION_CONFIGS`). This file is not F3-owned on dest; see
> `s11/wave-f/requests/f3-handoff.md`.

> **Fork addition.** This fork adds **OpenRouter Fusion** presets to the model picker: instead of one model answering, a *panel* of models deliberates on your prompt in parallel and a *judge* model synthesizes a single answer. It's [OpenRouter's Fusion router](https://openrouter.ai/blog/announcements/fusion-beats-frontier/) wired into Kady's single-agent run loop, with combined pricing shown in the picker. DRACO remains **unmeasured** for every shipped preset.

## What you get

Open the model picker and you'll see an **Openrouter Fusion** section at the top. Each entry is a named *preset* — a panel of analysis models plus an Opus 4.8 judge — with its combined input/output price. Predecessor DRACO percents are not shown.

| Preset | Panel (analysis models) | DRACO |
|---|---|---|
| Fable 5 + GPT-5.6 Sol Pro | `claude-fable-5`, `gpt-5.6-sol-pro` | unmeasured |
| Opus 4.8 + GPT-5.6 Sol Pro + Gemini 3.1 Pro | `claude-opus-4.8`, `gpt-5.6-sol-pro`, `gemini-3.1-pro-preview` | unmeasured |
| Opus 4.8 + GPT-5.6 Sol Pro | `claude-opus-4.8`, `gpt-5.6-sol-pro` | unmeasured |
| Opus 4.8 + Opus 4.8 | `claude-opus-4.8` ×2 | unmeasured |
| Gemini 3.5 Flash + Kimi K2.6 + DeepSeek V4 Pro | `gemini-3.5-flash`, `kimi-k2.6`, `deepseek-v4-pro` | unmeasured |
| Exaflop | `gpt-5.6-sol-pro`, `gemini-3.1-pro-preview`, `claude-fable-5` | unmeasured |

All presets are judged by **Opus 4.8** at `xhigh` reasoning, temperature 1, `max_tool_calls` 16. Pick one and send a message — every message on a Fusion preset runs the panel and returns the synthesized answer.

## When to use it

Fusion fits the **judgment** half of research — interpretation, literature synthesis, methodology critique, "is this conclusion supported?", cross-checking claims — where multiple independent models plus a synthesizer materially cut single-model error. It is **not** for agentic data work: a Fusion turn has **no local file/bash tools** (see caveats), so use a normal model to read your dataset or run code.

## How it works

A Fusion run threads from the picker to a real `openrouter/fusion` request and back, in four steps.

### 1. Presets (frontend)

Presets are defined in `web/src/lib/fusion-presets.ts` as `DEFAULT_FUSION_CONFIGS` — each a `{ id, name, note, config }` where `config` is the serialized Fusion request body. Every shipped `note` matches `/DRACO: unmeasured/`. `loadFusionConfigs()` reads the user's saved presets from `localStorage` (key `fusionConfigs`), falling back to the built-ins; a `FUSION_DEFAULTS_VERSION` bump re-seeds new/updated built-ins while preserving user-added presets.

`web/src/lib/use-models.ts` turns each preset into a synthetic picker entry with id `fusion/<presetId>`, provider `"Openrouter Fusion"`, the preset's DRACO `note` (unmeasured), and a **combined price = each panel model's catalogue price once, plus the judge's twice** (so a two-Opus panel correctly shows double Opus pricing, and the judge is counted for both the analysis call and the final answer).

### 2. The run request (frontend → server)

When a `fusion/*` model is selected, `web/src/lib/use-agent.ts` includes the preset's `fusionConfig` in the `POST /sessions/:id/run` body alongside `message` and `model` (see `web/src/components/chat-tab.tsx`).

### 3. Model resolution + tool disable (server `/run` handler)

`server/src/api/sessions.ts` detects a `fusion/`-prefixed model and, for that turn:

- resolves it via `resolveModel(model, registry, fusionConfig)` → `buildFusionModel()` (`server/src/agent/models.ts`), which builds an `openrouter/fusion` Pi `Model` **priced at the panel sum plus 2× the judge** (it refuses to run a $0-priced fusion model, so the spend cap always accrues);
- stashes the `fusionConfig` for the session (`setFusionConfig`);
- **empties Pi's local tool registry** with `session.setActiveToolsByName([])`, restored in a `finally` so non-fusion runs are unaffected.

That last step is load-bearing: Pi executes a model's returned tool calls by name-matching against its **in-memory tool registry**, *not* the request body — so disabling tools on the wire alone wouldn't stop the agent from looping on `read`/`bash`. Emptying the registry forces the turn to resolve to the single fused answer.

### 4. Body rewrite (Pi extension)

`server/src/agent/fusion-bridge.ts` registers a `before_provider_request` extension that rewrites the outgoing chat/completions body into OpenRouter's fusion-router form when a `fusionConfig` is stashed:

```jsonc
{
  "model": "openrouter/fusion",
  "tool_choice": "required",                         // force the single injected fusion tool
  "models": ["openrouter/fusion", "<judge>"],        // request-level fallback if routing fails
  "plugins": [{
    "id": "fusion",
    "preset": "general-high",                        // or "general-budget"
    "analysis_models": ["...panel..."],
    "model": "<judge>",                              // synthesizer
    "max_tool_calls": 16,
    "reasoning": { "effort": "xhigh" },              // reasoning + temperature live INSIDE the plugin
    "temperature": 1
  }]
}
```

Reasoning and temperature are placed **inside the plugin** (a top-level `reasoning_effort` collides with Pi's own `reasoning.effort` and 400s). OpenRouter runs the panel server-side (each panel model with web search/fetch), the judge synthesizes, and the result streams back through Pi's normal SSE path.

## Pricing & the spend cap

Pi computes session cost from the resolved `Model.cost`, so the synthetic `openrouter/fusion` model carries the **panel sum plus 2× the judge** and a Fusion run accrues against the project `spendLimitUsd` like any other. The judge is counted twice because OpenRouter runs "N panel calls + 1 judge call in addition to your normal request", and under the `openrouter/fusion` alias the judge [also writes the final answer](https://openrouter.ai/docs/guides/features/plugins/fusion) — so a 3-model preset costs roughly [4–5× a single completion](https://openrouter.ai/docs/guides/routing/routers/fusion-router), not 3×. The catalogue lookup (`catalogueEntryFor` in `models.ts`) also strips OpenRouter reasoning-effort suffixes (`-xhigh`/`-high`/…) so suffixed ids price as their base model instead of $0 — without that, the cap would be blind to them. The displayed cost is an **estimate** from `web/src/data/models.json`; OpenRouter's actual multi-model bill may differ.

## Managing presets (Settings → Fusion)

The **Fusion** tab in Settings lists your presets and an **Add Fusion config +** control that expands a form to paste a Fusion request body (see the [OpenRouter Fusion docs](https://openrouter.ai/docs/guides/features/plugins/fusion)). Presets are stored in `localStorage`; built-ins refresh on a version bump while your custom presets are kept.

## Caveats

- **No local tools during a Fusion turn.** File reading, bash, and edits are disabled for the turn (the panel uses server-side web search only). Use a normal model for agentic/data tasks.
- **Every message fuses** — a Fusion preset runs the full panel even for a trivial prompt, so it costs real money per message. Don't use it for chit-chat.
- **Not deterministic** — multiple models + sampling; not exactly reproducible.
- **Panel sources aren't surfaced** — the panel's web searches run server-side at OpenRouter and aren't shown in Kady.
- **Cost is an estimate** (catalogue pricing, panel + 2× judge), not OpenRouter's exact post-hoc bill.
- **DRACO is unmeasured** for every shipped built-in after the GPT-5.6 Sol Pro refresh. Do not restore numeric percents.

## Key files

- `web/src/lib/fusion-presets.ts` — preset definitions, versioned migration, pricing helper
- `web/src/lib/use-models.ts` — synthetic `fusion/*` picker entries + combined pricing
- `web/src/components/settings-dialog.tsx` — the Settings → Fusion management UI
- `server/src/api/sessions.ts` — fusion detection, config stash, tool-registry disable
- `server/src/agent/fusion-bridge.ts` — the `before_provider_request` body rewrite
- `server/src/agent/models.ts` — `buildFusionModel` (panel + 2× judge pricing) + `catalogueEntryFor`
