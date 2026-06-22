# Pi SDK Development Guide

This guide supports real development with `@earendil-works/pi-coding-agent`. It is intentionally organized by decisions an integrator has to make.

## Package And Runtime Model

The SDK is a Node/TypeScript integration surface for embedding Pi's coding-agent runtime inside another process. It gives direct access to sessions, resources, tools, models, settings, auth, and events.

Use the SDK when the host app is TypeScript or JavaScript and wants direct object-level integration. Use RPC when the host app is another language or needs process isolation.

The most important entry points are:

- `createAgentSession()` for one active session.
- `createAgentSessionRuntime()` and `AgentSessionRuntime` for apps that replace sessions.
- `createAgentSessionServices()` plus `createAgentSessionFromServices()` for apps that want to build cwd-bound services first.
- `DefaultResourceLoader` for extensions, skills, prompts, themes, context files, and system prompt overrides.
- `AuthStorage`, `ModelRegistry`, `SessionManager`, and `SettingsManager` for host-owned runtime state.
- `defineTool()` for custom tools.
- `InteractiveMode`, `runPrintMode`, and `runRpcMode` when the host wants to reuse Pi's built-in run modes on top of an SDK-created runtime.

## Choosing The Session Entry Point

Use `createAgentSession()` when:

- The app has a single active session.
- It can create the session once for one `cwd`.
- It does not need resume/fork/import/switch-session orchestration.

Use `AgentSessionRuntime` when:

- The app supports new sessions.
- The app resumes or switches existing JSONL sessions.
- The app forks from an earlier message.
- The app imports session JSONL.
- The active session cwd can change.

Use the service split when:

- You need to create resource loader, auth, model registry, and settings for a target cwd first.
- You need diagnostics before deciding whether to create the session.
- You need a runtime factory for later session replacement.

## Session Lifecycle

An `AgentSession` owns the active agent, resource loader, session manager, settings manager, model registry, tools, event listeners, prompt queue, and compaction/retry state.

Common operations:

- `session.subscribe(listener)` returns an unsubscribe function.
- `session.prompt(text, options?)` sends a user prompt.
- `session.steer(text)` queues steering while streaming.
- `session.followUp(text)` queues a follow-up after the current run.
- `session.abort()` cancels current work.
- `session.compact()` manually compacts context.
- `session.setActiveToolsByName(names)` changes active tools for the next turn.
- `session.reload()` reloads resources.
- `session.dispose()` removes listeners and disconnects from the underlying agent.

When using `AgentSessionRuntime`, do not hold a stale `runtime.session` after session replacement. Runtime replacement methods can swap the active `AgentSession`, so re-subscribe to the current session. Use `runtime.setRebindSession()` if the host needs a centralized rebind hook.

## Prompting And Streaming

Subscribe before prompting when streaming matters.

Important event patterns:

- `message_update` with `assistantMessageEvent.type === "text_delta"` streams assistant text.
- `turn_start` and `turn_end` frame each model turn.
- `tool_execution_start`, `tool_execution_update`, and `tool_execution_end` track tool activity.
- `queue_update` reports steering and follow-up queues.
- `compaction_start` and `compaction_end` report context compaction.
- `auto_retry_start` and `auto_retry_end` report retry behavior.

If the session is already streaming, `prompt()` requires `streamingBehavior: "steer"` or `"followUp"`. For clearer host code, call `session.steer()` or `session.followUp()` directly.

## Resource Loading

Use `DefaultResourceLoader` when the host wants Pi's normal resource discovery. It loads resources from the working directory, agent directory, configured packages, additional paths, and extension-discovered paths.

Common constructor inputs:

- `cwd`: project root for project-local discovery.
- `agentDir`: global Pi agent config directory.
- `settingsManager`: use the same settings manager as the session when you create one manually.
- `additionalExtensionPaths`, `additionalSkillPaths`, `additionalPromptTemplatePaths`, `additionalThemePaths`.
- `extensionFactories` for in-process extensions.
- `noExtensions`, `noSkills`, `noPromptTemplates`, `noThemes`, `noContextFiles`.
- `systemPrompt`, `appendSystemPrompt`, or override callbacks.

Discovery behavior from source and docs:

- Project context files include `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, and `CLAUDE.MD` found while walking from `cwd` up to the filesystem root, plus a global context file from `agentDir`.
- Project prompts are loaded from `<cwd>/.pi/prompts/`.
- Project extensions are loaded from `<cwd>/.pi/extensions/`.
- Project skills can come from `.pi/skills/`, `.agents/skills/`, configured paths, packages, and extension-discovered paths.
- Global settings, auth, models, prompts, extensions, skills, themes, and sessions are rooted under `agentDir`.
- `settings.json` package sources can contribute extensions, skills, prompts, and themes.

Always call `await loader.reload()` before passing the loader into `createAgentSession()`.

Override hooks let the host modify discovered resources:

- `extensionsOverride`
- `skillsOverride`
- `promptsOverride`
- `themesOverride`
- `agentsFilesOverride`
- `systemPromptOverride`
- `appendSystemPromptOverride`

Use override hooks to add virtual resources, filter resources, or inject host-owned context without writing files.

## Skills

Skills are loaded as structured metadata and formatted into the system prompt. Use skills when you want reusable instructions that should be discoverable by the model or invokable through skill commands.

Pi's source validates skill frontmatter more strictly than the minimal `skill-creator` validator. The `name` should match the parent directory name, use lowercase letters/digits/hyphens, avoid leading/trailing/consecutive hyphens, and stay within 64 characters. The `description` is required and should stay within 1024 characters.

Current package shapes can require this `Skill` structure:

- `name`
- `description`
- `filePath`
- `baseDir`
- `sourceInfo`
- `disableModelInvocation`

Use `createSyntheticSourceInfo()` for virtual or SDK-injected skills. If the installed package type differs, adapt to local `.d.ts` rather than older snippets.

Prefer `skillsOverride` when:

- Adding one virtual skill.
- Filtering loaded skills.
- Keeping only skills related to a capability.
- Combining SDK-injected skills with project/global discovery.

Prefer `additionalSkillPaths` when the skill already exists on disk.

If you are creating a skill intended for Pi, keep the directory name and frontmatter `name` aligned. For this skill package, the directory is `pi-coding-agent-sdk`, so the frontmatter name is also `pi-coding-agent-sdk`.

## Prompt Templates And Context Files

Use prompt templates for reusable prompt commands with arguments. A `PromptTemplate` can include:

- `name`
- `description`
- `argumentHint`
- `content`
- `sourceInfo`
- `filePath`

Use `promptsOverride` to add virtual templates. Use `additionalPromptTemplatePaths` to load file-backed templates.

Use context files when project instructions should be included as loaded context, similar to `AGENTS.md`. Use `agentsFilesOverride` to inject virtual context files.

Prompt template content supports positional arguments such as `$1`, `$2`, all-argument forms `$@` and `$ARGUMENTS`, and bash-style slices like `${@:2}` or `${@:2:3}`. Substitution is one pass over the template body; inserted argument values are not recursively substituted.

## Tools

The `tools` option is an allowlist of tool names in current package shapes. Built-in names include:

- `read`
- `bash`
- `edit`
- `write`
- `grep`
- `find`
- `ls`

For read-only flows, prefer:

```typescript
tools: ["read", "grep", "find", "ls"]
```

For custom tools:

- Define the tool with `defineTool()`.
- Put it in `customTools`.
- If `tools` is present, include the custom tool name in the allowlist.
- Include useful `promptSnippet` or `promptGuidelines` if the tool should be visible in the default prompt guidance.

Use tool factories such as `createReadTool()` only when the local type surface expects raw `AgentTool` instances or when building custom-cwd tool sets. For `createAgentSession()` allowlists, use names unless local types say otherwise.

`noTools: "all"` starts with no tools enabled. `noTools: "builtin"` disables the default built-ins while keeping extension/custom tools available unless an explicit allowlist narrows them.

## Extensions

Use extensions when you need more than one custom tool or when the host wants lifecycle hooks, commands, resource discovery, UI integration, provider modifications, or session event hooks.

Extension capabilities include:

- Register LLM-callable tools.
- Handle lifecycle events.
- Register commands and keybindings.
- Discover additional resource paths.
- Inject or modify context.
- Register providers or model configuration.
- Interact with interactive UI where available.

Use a plain `customTools` array for simple, host-owned tools. Use extensions for multi-feature integrations.

Extension factories can be passed directly to `DefaultResourceLoader` through `extensionFactories`. File-backed extensions can be added with `additionalExtensionPaths` or loaded from standard project/global locations. For hot-reload behavior in normal Pi usage, prefer auto-discovered extension locations over one-off CLI paths.

## Auth And Models

`AuthStorage` owns credentials and can be file-backed or in-memory.

Credential priority in current types:

1. Runtime API key override.
2. Stored API key.
3. Stored OAuth token, with refresh.
4. Environment variable.
5. Fallback resolver for custom providers.

Use `authStorage.setRuntimeApiKey(provider, key)` for temporary keys that should not be persisted.

`ModelRegistry` owns built-in models, custom models, dynamic provider registration, and auth resolution. Use `ModelRegistry.create(authStorage, modelsJsonPath?)` for file-backed models. Use `ModelRegistry.inMemory(authStorage)` for tests and examples.

When selecting a model explicitly, validate it exists in the registry or through `@earendil-works/pi-ai` before passing it to `createAgentSession()`.

For dynamic providers, extensions can register providers during resource loading. `createAgentSessionServices()` applies pending provider registrations to the `ModelRegistry` and returns diagnostics for registration errors.

## Settings

Use `SettingsManager.inMemory()` for deterministic examples and tests. Use `SettingsManager.create(cwd, agentDir)` for real app settings.

Common settings include:

- default provider/model/thinking level
- compaction
- retry
- steering/follow-up mode
- shell path and command prefix
- package resource sources
- skill commands
- terminal and image handling
- custom session directory

If file-backed settings are modified during a run, call `await settingsManager.flush()` before process exit or test assertions that depend on written settings.

## Sessions And Persistence

Use `SessionManager.inMemory(cwd?)` for examples, tests, and short-lived automation.

Use `SessionManager.create(cwd, sessionDir?)` for persisted JSONL sessions.

Use `SessionManager.continueRecent(cwd, sessionDir?)` to resume the latest session for a cwd.

Use `SessionManager.open(path, sessionDir?, cwdOverride?)` to open a specific session file.

Use `SessionManager.forkFrom(sourcePath, targetCwd, sessionDir?)` to create a new session in a target cwd from another session.

The session model is append-only and tree-shaped. Branching changes the leaf pointer; it does not rewrite earlier entries.

For replacement flows, `AgentSessionRuntime` tears down the current session, creates or opens the target `SessionManager`, recreates cwd-bound services, then applies the new `AgentSession`. Replacement methods can be cancelled by extension events. `fork(entryId, { position: "before" })` requires a user-message entry and can return selected text. `fork(entryId, { position: "at" })` clones through the chosen entry.

`importFromJsonl(inputPath, cwdOverride?)` copies the JSONL into the active session directory when needed, opens it, asserts the cwd exists, and then replaces runtime state.

## Full-Control Mode

Use a custom `ResourceLoader` only when the host wants no normal discovery or needs complete control over extensions, skills, prompt templates, themes, context files, and the system prompt. A custom loader must implement every method in the `ResourceLoader` interface, including `extendResources()` and `reload()`.

When normal discovery is acceptable, prefer `DefaultResourceLoader` with override hooks. It is less brittle because it preserves package resources, extension-discovered resources, diagnostics, and future loader behavior.

## Built-In Run Modes

The SDK also exports run-mode helpers over a runtime:

- `InteractiveMode` for Pi's full TUI.
- `runPrintMode()` for single-shot print workflows.
- `runRpcMode()` for JSON-RPC subprocess integration.

Prefer these when the host wants Pi's existing interaction model. Prefer direct `AgentSession` handling when the host owns its own UI or protocol.

## Cleanup

For plain sessions:

- Keep the unsubscribe function returned by `session.subscribe()`.
- Call the unsubscribe function when the listener is no longer needed.
- Call `session.dispose()` when the host is done with the session.

For runtimes:

- Rebind after replacement.
- Unsubscribe old session listeners.
- Call `await runtime.dispose()` when done.

Avoid presenting `session.shutdown()` as public `AgentSession` cleanup unless the installed type surface includes it. In current types, `shutdown()` exists on extension context, while `AgentSession` exposes `dispose()`.

## Debugging Checklist

When SDK code fails:

1. Run `npm view @earendil-works/pi-coding-agent version exports types`.
2. Inspect installed `.d.ts` files.
3. Confirm the project is ESM if using top-level `await`.
4. Confirm `tools` is a string allowlist in the installed version.
5. Confirm virtual `Skill` and `PromptTemplate` objects include the required metadata.
6. Confirm `DefaultResourceLoader` got `cwd` and `agentDir`.
7. Confirm `await loader.reload()` ran before session creation.
8. Confirm custom tool names are included in `tools` when an allowlist is present.
9. Confirm no secrets are hardcoded in code or docs.
10. Compile with `tsc --noEmit` before claiming the code is working.
