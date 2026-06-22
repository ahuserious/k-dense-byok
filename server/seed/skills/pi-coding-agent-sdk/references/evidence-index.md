# Evidence Index

This skill is based on current docs, the upstream source tree, installed package types, and compile/runtime checks. Treat this file as the audit trail for the guidance.

## Upstream Documentation Reviewed

- `/tmp/pi-source/packages/coding-agent/docs/sdk.md`
  - SDK purpose, quick start, `createAgentSession`, `AgentSession`, runtime sessions, prompt queueing, events, directories, model/auth, system prompt, tools, skills, context files, prompt templates, sessions, settings, resource loader, run modes, RPC alternative, exports.
- `/tmp/pi-source/packages/coding-agent/docs/extensions.md`
  - Extension capabilities, extension locations, imports, factory shape, events, UI context, commands, tools, state management, mode behavior.
- `/tmp/pi-source/packages/coding-agent/examples/sdk/README.md`
  - Example inventory and documented run command.

## Upstream Examples Reviewed

- `01-minimal.ts`
- `02-custom-model.ts`
- `03-custom-prompt.ts`
- `04-skills.ts`
- `05-tools.ts`
- `06-extensions.ts`
- `07-context-files.ts`
- `08-prompt-templates.ts`
- `09-api-keys-and-oauth.ts`
- `10-settings.ts`
- `11-sessions.ts`
- `12-full-control.ts`
- `13-session-runtime.ts`

## Source Files Reviewed

- `/tmp/pi-source/packages/coding-agent/src/core/sdk.ts`
  - `CreateAgentSessionOptions`, default cwd/agentDir/auth/model/settings/session/resourceLoader behavior, tool allowlist handling, default active tool names, model restoration/fallback, session construction.
- `/tmp/pi-source/packages/coding-agent/src/core/agent-session.ts`
  - event subscription, prompt options, queueing, active tools, model/thinking controls, compaction, retry, bash execution, session stats, export, cleanup.
- `/tmp/pi-source/packages/coding-agent/src/core/agent-session-runtime.ts`
  - runtime replacement lifecycle, `newSession`, `switchSession`, `fork`, `importFromJsonl`, `setRebindSession`, `dispose`.
- `/tmp/pi-source/packages/coding-agent/src/core/agent-session-services.ts`
  - cwd-bound service creation, extension provider registration diagnostics, session creation from services.
- `/tmp/pi-source/packages/coding-agent/src/core/resource-loader.ts`
  - resource discovery, override hooks, context file discovery, extension-discovered resources, loader reload behavior.
- `/tmp/pi-source/packages/coding-agent/src/core/skills.ts`
  - skill frontmatter validation, name/directory alignment, discovery rules, `Skill` structure.
- `/tmp/pi-source/packages/coding-agent/src/core/prompt-templates.ts`
  - prompt template structure and argument substitution semantics.
- `/tmp/pi-source/packages/coding-agent/src/core/extensions/types.ts`
  - extension contexts, UI API, command context, events, `ToolDefinition`, `defineTool`.
- `/tmp/pi-source/packages/coding-agent/src/core/auth-storage.ts`
  - auth storage backends, runtime overrides, credential priority, OAuth refresh locking, fallback resolver.
- `/tmp/pi-source/packages/coding-agent/src/core/model-registry.ts`
  - model lookup, available models, provider registration, provider auth status.
- `/tmp/pi-source/packages/coding-agent/src/core/settings-manager.ts`
  - settings schema, global/project merge, in-memory storage, file storage, flush and error draining.
- `/tmp/pi-source/packages/coding-agent/src/core/source-info.ts`
  - `SourceInfo` and `createSyntheticSourceInfo()`.
- `/tmp/pi-source/packages/coding-agent/src/core/tools/index.ts`
  - built-in tool names and exported tool factories.

## Installed Package Types Reviewed

Temporary package project:

```text
/tmp/pi-sdk-check
```

Installed versions:

```text
@earendil-works/pi-coding-agent@0.74.0
@earendil-works/pi-ai@0.74.0
typebox@1.1.38
typescript@6.0.3
```

Installed type files inspected:

- `node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts`
- `dist/core/sdk.d.ts`
- `dist/core/agent-session.d.ts`
- `dist/core/agent-session-runtime.d.ts`
- `dist/core/agent-session-services.d.ts`
- `dist/core/resource-loader.d.ts`
- `dist/core/skills.d.ts`
- `dist/core/prompt-templates.d.ts`
- `dist/core/extensions/types.d.ts`
- `dist/core/auth-storage.d.ts`
- `dist/core/model-registry.d.ts`
- `dist/core/settings-manager.d.ts`
- `dist/core/source-info.d.ts`
- `dist/core/tools/index.d.ts`

## Compile-Checked Recipes

The following temporary files were written under `/tmp/pi-sdk-check` and compiled with `npx tsc --noEmit`:

- `minimal.ts`
- `skill-injection.ts`
- `tools.ts`
- `runtime.ts`
- `prompts-context.ts`
- `auth-settings.ts`
- `system-prompt.ts`
- `inline-extension.ts`
- `full-control.ts`
- `load-current-skill.ts`

The same scripts were run with `npx tsx <file>` far enough to create and dispose sessions without sending LLM prompts.

`load-current-skill.ts` loaded the checked-out skill directory through Pi's own `loadSkillsFromDir()` and returned the current skill name with no diagnostics.

## Skill Package Validation

Local validation commands:

```bash
python3 .agents/skills/skill-creator/scripts/quick_validate.py skills/pi-coding-agent-sdk
python3 -m json.tool evals/evals.json
rg -n "[^\\x00-\\x7F]" skills/pi-coding-agent-sdk evals/evals.json
npx skills add ./ --list
python3 -m scripts.run_eval --eval-set evals/trigger-evals.json --skill-path skills/pi-coding-agent-sdk --num-workers 2 --timeout 25 --runs-per-query 3 --trigger-threshold 0.5 --verbose
```

Trigger evaluation note: `skill-creator` trigger eval is stochastic. The best 3-run sample after description optimization passed 7/8 checks: all four negative examples had `0/3` triggers, while three of four positive examples crossed the 0.5 threshold. The remaining positive case triggered `1/3`. This was treated as a useful warning, not as a replacement for the stronger package/type/source validation above.

After renaming the skill to `pi-coding-agent-sdk`, a follow-up trigger eval returned `0/3` for every positive case. A direct `claude -p` probe in the same environment then failed with `You've hit your limit`, while `run_eval.py` suppresses child-process stderr and records failed child runs as `False`. Treat that post-rename trigger sample as inconclusive quota noise, not a validated trigger regression.

Codex smoke tests were run after installing the clean staged skill package into the project-level Codex skill directory with:

```bash
npx skills add /tmp/pi-coding-agent-sdk-clean2/pi-coding-agent-sdk --agent codex --skill pi-coding-agent-sdk -y
codex exec --json --ephemeral --sandbox read-only -C /Users/yikzero/Code/pi-coding-agent-sdk "<positive smoke prompt>"
codex exec --json --ephemeral --sandbox read-only -C /Users/yikzero/Code/pi-coding-agent-sdk "<negative smoke prompt>"
```

The positive smoke prompt asked whether a skill applied for a TypeScript `@earendil-works/pi-coding-agent` integration using `AgentSessionRuntime` and streaming events. Codex selected `pi-coding-agent-sdk` and read `.agents/skills/pi-coding-agent-sdk/SKILL.md`.

The negative smoke prompt asked about translating a paragraph into Japanese. Codex returned `skill_used: false` because the skill is for SDK development and excludes unrelated translation.

Final packaging used a clean staging directory containing only `SKILL.md` and `references/`, then ran:

```bash
python3 -m scripts.package_skill /tmp/pi-coding-agent-sdk-package-v2/pi-coding-agent-sdk /tmp/pi-coding-agent-sdk-package-v2-dist
unzip -l /tmp/pi-coding-agent-sdk-package-v2-dist/pi-coding-agent-sdk.skill
```

The resulting archive contained exactly five files: `SKILL.md` plus the four `references/` files. It did not include `.git`, `.agents`, `evals/`, or generated cache files.

## Publishing Evidence

Context7 returned `/vercel-labs/skills` and `/websites/skills_sh` as the relevant skills CLI and skill.sh docs.

The current `skills` CLI help shows no `publish` command. It supports `skills add <source>`, where the source can be a GitHub repo, URL, git URL, or local path. The `skills init` output says publishing is done by pushing to a GitHub repo and installing with `npx skills add <owner>/<repo>`, or by hosting `SKILL.md` and installing by URL.

The skill.sh FAQ says leaderboard listing happens automatically from anonymous telemetry when users install with `npx skills add <owner/repo>`.
