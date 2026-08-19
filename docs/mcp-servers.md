# Connecting external tools (MCP servers)

Out of the box, Kady can read and write files, run code, and delegate to [sub-agents](./sub-agents.md). **MCP servers** let you give it more abilities - searching the web, querying a database, reading your reference manager, controlling lab software, and so on.

MCP ([Model Context Protocol](https://modelcontextprotocol.io)) is an open standard for connecting AI assistants to external tools. Many services publish an MCP server, and there are hundreds of community-built ones. When you connect one, every tool it provides shows up in Kady's toolbox automatically.

## Adding a server

Open **Settings (gear icon) → MCP servers** and click *Add server*. There are two kinds:

### Remote (HTTP)

A server hosted somewhere on the internet. You need its URL and, usually, an access token from your account on that service.

- **Name**: anything you like, e.g. `linear`
- **Server URL**: e.g. `https://mcp.example.com/mcp`
- **Bearer token**: the access token, if the service requires one

#### Example: Parallel Search

To add optional web search and URL fetching through Parallel Search MCP, use:

- **Name**: `parallel-search`
- **Server URL**: `https://search.parallel.ai/mcp`
- **Bearer token**: leave blank

The default endpoint requires no account or API key. After you test and save it, its `web_search` and `web_fetch` tools are available in new chat tabs.

### Local (command)

A small program that runs on your own computer when needed. These are typically published as npm packages and need no hosting.

- **Command**: usually `npx`
- **Arguments**: e.g. `-y @modelcontextprotocol/server-github`
- **Environment variables**: any keys the server needs, one per line, e.g. `GITHUB_TOKEN=ghp_…`

Click **Test connection** before saving - it dials the server and lists the tools it offers, so you catch a typo'd URL or token immediately.

## Using the tools

Nothing special required. Once a server is saved, its tools are available to Kady in **new chat tabs** in that project. Ask naturally - "search our GitHub issues for failed CI runs" - and Kady picks the right tool.

## Good to know

- **Per project.** Each project has its own server list, stored in the project at `sandbox/.pi/mcp.json`. Tokens stay on your machine.
- **A broken server never blocks you.** If a server is down or misconfigured, Kady starts without it (you'll see a warning in the backend logs) and everything else works normally.
- **Changes apply to new chat tabs.** Already-open tabs keep the toolset they started with.
- **Sub-agents don't see MCP tools yet.** Tools from MCP servers are currently available to Kady itself but not to the sub-agents it spawns. This is on the roadmap.
- **Trust matters.** A local (command) server is a program running on your computer with your permissions, and a remote server receives whatever Kady sends it. Only connect servers you trust.

## Known integrations

Below the server list, **Settings → Connectors** shows a **Known integrations** section: services this
build already knows how to configure, so you do not have to look up a package name or an endpoint.

Each row tells you:

- whether it is **configured** — that is, whether the environment variables it needs are set;
- **what it reaches** in its current state, in plain words;
- the **names** of the variables it needs, and whether each one is set. Only names are ever shown;
  a value never leaves your `.env` file;
- for services with a command-line tool, whether that tool was **found on this machine**.

An integration that is not configured **reaches nothing**. There is no default endpoint and no
connection is attempted. Its *Connect* button is disabled and states the reason.

### InfraNodus

[InfraNodus](https://infranodus.com) builds knowledge graphs from text and finds the gaps in them.

1. Put `INFRANODUS_API_KEY=…` in the repository's `.env` file and restart the backend.
2. Open **Settings → Connectors**, find InfraNodus under *Known integrations*, click **Connect**.

That writes the standard local (command) entry for you — `npx -y infranodus-mcp-server` with your key
in its environment — into this project's server list, exactly as if you had typed it by hand. Its
tools then appear to Kady as `mcp__infranodus__<tool>` in new chat tabs.

The tool list is **discovered when the server connects**, not hardcoded here. Use *Test connection* on
the connector row to see the tools your version of the server actually offers.

InfraNodus also publishes a remote endpoint at `https://mcp.infranodus.com`. It authenticates with
OAuth2, which Kady's connector form does not support, so *Connect* uses the local command form. You
can still add the remote URL by hand under *Add server → Remote (HTTP)* if you have a bearer token for
it.

### Hugging Face

Set `HF_TOKEN=…` in `.env` to let Kady search the [Hugging Face](https://huggingface.co) model
catalogue by name. Without it, no request is made and any model search reports that the variable is
unset.

`HF_TOKEN` is the name Hugging Face's own tooling uses; do not use `HUGGINGFACE_API_KEY`.

The `huggingface-cli` program is reported as found or not found for your information. Model search
does **not** need it and works without it.

### Modal

Modal is configured in **Settings → API keys** (see [Durable Modal compute](./modal-compute.md)) — the
row here reports that same state and does not ask for the credentials a second time.
