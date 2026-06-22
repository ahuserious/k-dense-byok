# Version Notes And Mismatches

These notes capture the local verification pass used to make this skill practical for SDK development.

## Verified Package Snapshot

Checked package:

```text
@earendil-works/pi-coding-agent@0.74.0
@earendil-works/pi-ai@0.74.0
typebox@1.1.38
typescript@6.0.3
```

NPM metadata showed:

```text
version = 0.74.0
exports["."].types = ./dist/index.d.ts
exports["."].import = ./dist/index.js
exports["./hooks"].types = ./dist/core/hooks/index.d.ts
```

Validation used a temporary ESM TypeScript project with `module` and `moduleResolution` set to `NodeNext`.

## Commands Used

```bash
npm view @earendil-works/pi-coding-agent version dist-tags exports types main module
npm install @earendil-works/pi-coding-agent@latest @earendil-works/pi-ai@latest typescript@latest typebox@latest @types/node@latest
npx tsc --noEmit
npx tsx minimal.ts
npx tsx skill-injection.ts
npx tsx tools.ts
npx tsx runtime.ts
npx tsx prompts-context.ts
npx tsx auth-settings.ts
npx tsx system-prompt.ts
npx tsx inline-extension.ts
npx tsx full-control.ts
```

The runtime scripts created and disposed sessions without sending LLM prompts. Some runs emitted Node's experimental SQLite warning; that did not affect type or session creation validation.

## Current Type Facts

From installed `.d.ts` files:

- `CreateAgentSessionOptions.tools?: string[]`
- `CreateAgentSessionOptions.customTools?: ToolDefinition[]`
- `CreateAgentSessionOptions.noTools?: "all" | "builtin"`
- `DefaultResourceLoaderOptions` requires `cwd` and `agentDir`.
- `Skill` has `name`, `description`, `filePath`, `baseDir`, `sourceInfo`, and `disableModelInvocation`.
- `PromptTemplate` has `name`, `description`, optional `argumentHint`, `content`, `sourceInfo`, and `filePath`.
- `AgentSession.subscribe()` returns an unsubscribe function.
- `AgentSession.dispose()` is the plain session cleanup method.
- `AgentSessionRuntime.dispose()` is async.
- `AgentSessionRuntime` replacement methods emit session shutdown/start events around replacement and then apply the new session/services.
- `AuthStorage` supports `create()`, `inMemory()`, `setRuntimeApiKey()`, `setFallbackResolver()`, `login()`, `logout()`, and `getApiKey()`.
- `ModelRegistry` supports `create()`, `inMemory()`, `getAll()`, `getAvailable()`, `find()`, `registerProvider()`, and provider auth helpers.
- Tool factories such as `createReadTool()`, `createBashTool()`, `createCodingTools()`, and `createReadOnlyTools()` are exported.
- `SettingsManager` loads and merges global and project settings, queues persistence writes, exposes `flush()`, and exposes `drainErrors()` for app-level reporting.
- `loadProjectContextFiles()` looks for `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, and `CLAUDE.MD`.

## Known Doc Or Example Mismatches

Some docs or generated documentation snippets may show:

```typescript
tools: [readTool, bashTool]
```

Current installed types prefer:

```typescript
tools: ["read", "bash"]
```

Some snippets may show:

```typescript
const customSkill = {
  name: "my-skill",
  description: "Custom instructions",
  filePath: "/path/to/SKILL.md",
  baseDir: "/path/to",
  source: "custom",
};
```

Current installed `Skill` type can require:

```typescript
const customSkill = {
  name: "my-skill",
  description: "Custom instructions",
  filePath: "/path/to/SKILL.md",
  baseDir: "/path/to",
  sourceInfo: createSyntheticSourceInfo("/path/to/SKILL.md", {
    source: "sdk",
    scope: "temporary",
    origin: "top-level",
    baseDir: "/path/to",
  }),
  disableModelInvocation: false,
};
```

Some snippets may imply `DefaultResourceLoader` can be created without options. Current installed types require at least:

```typescript
new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: getAgentDir(),
});
```

Some generated docs may mention `session.shutdown()`. Current `AgentSession` exposes `dispose()`. `shutdown()` exists in extension contexts, not as the plain public cleanup method in the checked package.

Some snippets may use `AuthStorage.setApiKey()`. Current checked types use `setRuntimeApiKey()` for non-persisted runtime overrides or `set(provider, { type: "api_key", key })` for stored credentials.

## How To Handle Drift

When the user's local package disagrees with this skill:

1. Trust the user's installed `.d.ts` files first.
2. Update code to local types.
3. Mention the version difference explicitly.
4. Prefer a small compile-checked recipe over a broad answer.
5. Avoid copying examples from docs without reconciling them against installed types.
