# The integration registry

One place declares a first-class integration: `server/src/integrations/registry.ts`.

An integration declaration states its id, its display name, the **environment variable NAMES** it
needs, how "configured" is computed (presence of those names in the process environment — never their
values), what it reaches when configured, and what it reaches when it is not. Nothing in the registry
reads, logs, or returns a credential value.

Declared today: **InfraNodus**, **Hugging Face**, **Modal**.

## The fail-closed rule

An unconfigured integration **reaches nothing**. There is no default host, no fallback endpoint, and
no probe on page load. This is not a style preference — it is the standing rule after three defects
where an unconfigured integration silently contacted something (`RAINDROP_BASE_URL`,
`OPENAI_COMPATIBLE_BASE_URL`, `OLLAMA_BASE_URL`).

Concretely, for each of the three:

| Integration | Variables | Unconfigured behaviour |
|---|---|---|
| InfraNodus | `INFRANODUS_API_KEY` | No `mcpServers` entry is written, so no MCP client is built and no run sees an InfraNodus tool. |
| Hugging Face | `HF_TOKEN` | A model search throws before a request is constructed. Zero outbound requests. |
| Modal | `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET` | Job submission and the CLI path both refuse without spawning or dialing anything. |

In the UI, that state is a **disabled control with the reason visible** — never a live-looking control
over a value that cannot bind.

## Where the variables go

The repository-root `.env`. Modal's pair is additionally managed from Settings ▸ API keys.
`INFRANODUS_API_KEY` and `HF_TOKEN` are not in that dialog yet; Settings ▸ Connectors names them and
reports whether they are set.

## Where it appears

**Settings ▸ Connectors**, below the connector list, as "Known integrations"
(`web/src/components/integrations/integrations-section.tsx`, mounted from `connectors-panel.tsx`).
Each row shows the status in words, what it reaches in its current state, the variable names and
whether each is set, and — for integrations with a local binary — whether that binary was found.

## The routes

Served by `server/src/api/integrations.ts`, registered from `registerMcpRoutes()` in
`server/src/api/mcp.ts`.

### `GET /integrations`

```json
{
  "integrations": [
    {
      "id": "infranodus",
      "displayName": "InfraNodus",
      "summary": "Knowledge-graph and text-network analysis, exposed to a run as MCP tools.",
      "kind": "mcp",
      "configured": false,
      "missingEnvVars": ["INFRANODUS_API_KEY"],
      "envVars": [
        { "name": "INFRANODUS_API_KEY", "purpose": "…", "present": false }
      ],
      "reaches": "Nothing. No connector entry is written, so no run sees an InfraNodus tool and no request leaves this machine.",
      "notConfiguredReason": "InfraNodus is not configured. Set INFRANODUS_API_KEY to connect.",
      "mcp": {
        "serverName": "infranodus",
        "toolPrefix": "mcp__infranodus__",
        "registered": false,
        "enabled": false,
        "toolDiscovery": "on-connect"
      }
    }
  ]
}
```

`configured` means every required variable NAME is set. For MCP-backed integrations, `mcp.registered`
additionally means the entry exists in **this project's** `mcp.json`, i.e. a run would actually see
its tools. A caller that needs the tools available must check `mcp.registered`, not `configured`.

### `POST /integrations/:id/register`

Writes a known MCP connector's entry through the existing `writeMcpConfig()`. Idempotent, and it
preserves every other connector. `503 { code: "NOT_CONFIGURED", envVar, detail }` when unconfigured —
and in that case nothing is written. `404` for an integration that is not MCP-backed.

### `GET /integrations/huggingface/models?search=&limit=`

`200 { models: [{ id, pipelineTag, libraryName, gated, downloads, likes }] }`.
`503 { code: "NOT_CONFIGURED", envVar: "HF_TOKEN", detail }` — with zero outbound requests.
`400` for an empty search, `502` for an upstream failure.

### `GET /integrations/modal/cli`

`200 { cli: { binary, found, path, version }, profile }`. `profile` is `null` unless Modal is
configured **and** the binary was found, so an unconfigured install spawns nothing.

## Adding an integration

Add a declaration to `INTEGRATIONS` in `registry.ts`. Say what it reaches in both states in plain
language — those strings are rendered verbatim to the user, so a vague one becomes a vague UI. If the
integration is MCP-backed, add its id to `REGISTRABLE_MCP_INTEGRATIONS` in
`server/src/api/integrations.ts` and give it a module that builds its `mcpServers` entry, returning
`null` when unconfigured.

Do **not** add a second credential path to a service that already has one.
