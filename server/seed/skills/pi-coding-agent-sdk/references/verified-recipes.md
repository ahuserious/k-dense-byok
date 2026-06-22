# Verified SDK Recipes

These recipes were type-checked with `tsc --noEmit` against `@earendil-works/pi-coding-agent@0.74.0`, `@earendil-works/pi-ai@0.74.0`, TypeScript 6.0.3, and NodeNext module resolution. They also ran far enough to create and dispose sessions without sending LLM prompts.

Use them as starting points, then re-check against the user's installed package.

## Minimal In-Memory Session

```typescript
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
});

const unsubscribe = session.subscribe((event) => {
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent.type === "text_delta"
  ) {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await session.prompt("What files are in the current directory?");

unsubscribe();
session.dispose();
```

## Read-Only Analysis Session

```typescript
import {
  createAgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const { session } = await createAgentSession({
  tools: ["read", "grep", "find", "ls"],
  sessionManager: SessionManager.inMemory(process.cwd()),
});

await session.prompt("Review this repository for likely bugs.");
session.dispose();
```

## Custom Tool With Allowlist

```typescript
import {
  createAgentSession,
  defineTool,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const statusTool = defineTool({
  name: "status",
  label: "Status",
  description: "Get process uptime",
  parameters: Type.Object({}),
  execute: async () => ({
    content: [{ type: "text", text: `Uptime: ${process.uptime()}s` }],
    details: {},
  }),
});

const { session } = await createAgentSession({
  tools: ["read", "bash", "status"],
  customTools: [statusTool],
  sessionManager: SessionManager.inMemory(),
});

session.dispose();
```

## SDK-Injected Skill

```typescript
import {
  createAgentSession,
  createSyntheticSourceInfo,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type Skill,
} from "@earendil-works/pi-coding-agent";

const customSkill: Skill = {
  name: "my-skill",
  description: "Custom project instructions",
  filePath: "/virtual/SKILL.md",
  baseDir: "/virtual",
  sourceInfo: createSyntheticSourceInfo("/virtual/SKILL.md", {
    source: "sdk",
    scope: "temporary",
    origin: "top-level",
    baseDir: "/virtual",
  }),
  disableModelInvocation: false,
};

const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  skillsOverride: (current) => ({
    skills: [...current.skills, customSkill],
    diagnostics: current.diagnostics,
  }),
});

await loader.reload();

const { session } = await createAgentSession({
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(),
});

session.dispose();
```

## Filter Skills While Adding One

```typescript
const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  skillsOverride: (current) => ({
    skills: [
      ...current.skills.filter(
        (skill) => skill.name.includes("browser") || skill.name.includes("search"),
      ),
      customSkill,
    ],
    diagnostics: current.diagnostics,
  }),
});
```

## Virtual Prompt Template And Context File

```typescript
import {
  createAgentSession,
  createSyntheticSourceInfo,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type PromptTemplate,
} from "@earendil-works/pi-coding-agent";

const deployPrompt: PromptTemplate = {
  name: "deploy",
  description: "Plan a deployment",
  argumentHint: "<environment>",
  content: "Plan a deployment to $1. Include build, test, and rollback checks.",
  filePath: "/virtual/prompts/deploy.md",
  sourceInfo: createSyntheticSourceInfo("/virtual/prompts/deploy.md", {
    source: "sdk",
    scope: "temporary",
    origin: "top-level",
    baseDir: "/virtual/prompts",
  }),
};

const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  promptsOverride: (current) => ({
    prompts: [...current.prompts, deployPrompt],
    diagnostics: current.diagnostics,
  }),
  agentsFilesOverride: (current) => ({
    agentsFiles: [
      ...current.agentsFiles,
      {
        path: "/virtual/AGENTS.md",
        content: "# Project Guidelines\n\n- Be concise.\n",
      },
    ],
  }),
});

await loader.reload();

const { session } = await createAgentSession({
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(process.cwd()),
});

session.dispose();
```

## System Prompt Override

```typescript
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  systemPromptOverride: () => "You are a concise coding assistant.",
  appendSystemPromptOverride: () => [],
});

await loader.reload();

const { session } = await createAgentSession({
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(process.cwd()),
});

session.dispose();
```

Use `appendSystemPromptOverride` when you want to preserve existing append prompts and add to them. Return an empty array when replacing the base prompt and intentionally suppressing appended prompt fragments.

## Inline Extension Factory

```typescript
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  extensionFactories: [
    (pi) => {
      pi.on("agent_start", () => {
        console.log("agent starting");
      });
    },
  ],
});

await loader.reload();

const { session } = await createAgentSession({
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(process.cwd()),
});

session.dispose();
```

Use inline extension factories for host-owned behavior. Use file-backed extensions for reusable or hot-reloadable integrations.

## Runtime For Session Replacement Flows

```typescript
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const createRuntime: CreateAgentSessionRuntimeFactory = async ({
  cwd,
  agentDir,
  sessionManager,
  sessionStartEvent,
}) => {
  const services = await createAgentSessionServices({ cwd, agentDir });
  return {
    ...(await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
    })),
    services,
    diagnostics: services.diagnostics,
  };
};

const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  sessionManager: SessionManager.inMemory(process.cwd()),
});

const unsubscribe = runtime.session.subscribe((event) => {
  if (event.type === "message_update") {
    // Render or forward the event.
  }
});

unsubscribe();
await runtime.dispose();
```

For real apps, use `runtime.setRebindSession()` to re-attach event listeners or UI bindings after `newSession()`, `switchSession()`, `fork()`, or `importFromJsonl()`.

## Full-Control ResourceLoader

```typescript
import {
  createAgentSession,
  createExtensionRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const cwd = process.cwd();

const resourceLoader: ResourceLoader = {
  getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => "You are a minimal assistant.",
  getAppendSystemPrompt: () => [],
  extendResources: () => {},
  reload: async () => {},
};

const { session } = await createAgentSession({
  cwd,
  agentDir: "/tmp/pi-sdk-check-agent",
  resourceLoader,
  tools: ["read", "bash"],
  sessionManager: SessionManager.inMemory(cwd),
  settingsManager: SettingsManager.inMemory(),
});

session.dispose();
```

Use this pattern only when the host intentionally disables normal discovery. Otherwise prefer `DefaultResourceLoader` with overrides.

## In-Memory Auth And Settings

```typescript
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const authStorage = AuthStorage.inMemory();
if (process.env.ANTHROPIC_API_KEY) {
  authStorage.setRuntimeApiKey("anthropic", process.env.ANTHROPIC_API_KEY);
}

const settingsManager = SettingsManager.inMemory({
  compaction: { enabled: false },
  retry: { enabled: true, maxRetries: 2 },
});

const modelRegistry = ModelRegistry.inMemory(authStorage);

const { session } = await createAgentSession({
  authStorage,
  modelRegistry,
  settingsManager,
  sessionManager: SessionManager.inMemory(process.cwd()),
});

session.dispose();
```

## Prompt Queue Handling

```typescript
if (session.isStreaming) {
  await session.followUp("After you finish, summarize the files you changed.");
} else {
  await session.prompt("Implement the requested change.");
}
```

When using `prompt()` during streaming, pass a queue behavior:

```typescript
await session.prompt("Adjust the current approach.", {
  streamingBehavior: "steer",
});
```
