# S2a vendored-engine egress manifest

## Decision

The vendored engine serves the standalone local product without analytics,
upstream update polling, boot-time remote diagnostics, or remotely hosted web
assets. Egress that belongs to an optional integration remains default-off
behind explicit operator configuration. Provider, OAuth, and Git operations
remain reachable only from an explicit user action.

The required local surfaces (`/api/health`, workflow CRUD/run, same-origin REST,
SSE, and the builder UI) are not external egress and remain unchanged.

## Manifest

| # | Egress point | Trigger before S2a | Disposition | Reason / gate |
|---:|---|---|---|---|
| 1 | `packages/paths/src/telemetry.ts`: analytics SDK and ingest transport | First capture call | Removed | Replaced by typed local no-op compatibility functions; no client, endpoint, identifier, cache, or network transport remains. |
| 2 | `packages/server/src/index.ts`: startup/deployment-shape analytics event | Every server boot | Removed | Boot capture and deployment-shape collection were deleted. |
| 3 | `packages/server/src/index.ts`: daily analytics heartbeat | Every 24 hours while running | Removed | Timer and shutdown flush were deleted. Remaining instrumentation call sites resolve to the local no-op shim. |
| 4 | `packages/paths/src/update-check.ts` via `/api/update-check` | Opening the System panel in a bundled binary | Removed | Compatibility endpoint now returns the local current-version/no-update response and never reads a cache or contacts an upstream release service. |
| 5 | `packages/web/index.html`: Inter / JetBrains Mono remote stylesheet and preconnects | Builder page load | Removed | Uses system sans-serif and monospace stacks. |
| 6 | `packages/web/src/experiments/console/theme.css`: Geist remote stylesheet | Console route load | Removed | Uses system font stacks. |
| 7 | `packages/server/src/index.ts`: `gh auth status` diagnostic behind `gh_auth.status_ok` | Every server boot | Gated off | Runs only when `ARCHON_ENABLE_GH_AUTH_PROBE=1`; unset, empty, and all other values are no-op. The CLI may otherwise contact GitHub. |
| 8 | Slack Socket Mode/API adapter | Server boot with both Slack tokens configured | Gated off | Existing default-off gate requires explicit `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`. |
| 9 | Discord gateway/API adapter | Server boot with a Discord token configured | Gated off | Existing default-off gate requires explicit `DISCORD_BOT_TOKEN`. |
| 10 | GitHub REST/App adapter | Server boot with a complete PAT or App configuration | Gated off | Existing default-off gate requires explicit credentials plus webhook configuration. |
| 11 | Gitea REST adapter | Server boot with URL, token, and webhook secret configured | Gated off | Existing default-off gate requires all three operator-supplied values. |
| 12 | GitLab REST adapter | Server boot with token and webhook secret configured | Gated off | Existing default-off gate requires both operator-supplied values; custom URL remains operator-selected. |
| 13 | PostgreSQL connection | Server boot with `DATABASE_URL` configured | Gated off | SQLite is the local default; remote database use requires explicit operator configuration. |
| 14 | OpenAI subscription OAuth endpoints | User selects Connect and completes the flow | Retained | Explicit user-initiated credential action; required only for the selected provider. |
| 15 | GitHub App device-flow endpoints | User selects Connect and completes the flow | Retained | Explicit user-initiated identity action. |
| 16 | AI provider SDK/CLI endpoints | User sends a chat turn or runs a workflow using that provider | Retained | Explicit user-initiated product action; model execution cannot be fulfilled locally for a remote provider. |
| 17 | Git clone/fetch/push and forge operations | User registers a remote codebase or invokes a workflow/forge action | Retained | Explicit user-initiated repository action. No background update/version operation uses this path. |

Counts: **17 found; 6 removed; 7 gated off by default; 4 retained for explicit user-initiated actions.**

## Static enforcement

`server/test/guards/vendor-egress.test.ts` scans the complete vendored tree for
analytics SDK names, known analytics ingest hosts, the removed upstream release
endpoint, and remote font/CDN hosts. It also scans first-party source for direct
`fetch`, `WebSocket`, and `EventSource` use (including EventSource package
imports), Node HTTP(S) imports and request/get calls, network-SDK client
construction, and curl/wget subprocess commands.

`server/test/guards/vendor-egress.manifest.json` is the machine-readable
companion to this ADR. Coverage is keyed by exact relative path and capability,
with an expected occurrence count so adding another call in an already reviewed
file still fails the guard. Every entry records its disposition, ADR reference,
and reason. Marker exceptions use the same path-specific manifest; none are
currently required after the orchestrator refreshed the vendor lockfile.

The current call-site inventory contains **23 occurrences across 17
path/capability entries**:

| Disposition | Path/capability entries | Occurrences | Scope |
|---|---:|---:|---|
| Required local | 9 | 11 | Relative/same-origin builder, console API, and SSE calls. |
| Gated off by default | 6 | 9 | Slack, Discord, GitHub, Gitea, and GitLab clients behind explicit operator configuration. |
| Retained explicit | 2 | 3 | OpenAI OAuth and GitHub device-flow calls initiated by Connect/provider use. |

There are no reviewed exceptions for raw WebSockets, EventSource package
imports, Node HTTP(S) clients, or network subprocess commands. The three
reviewed EventSource paths are required local SSE consumers. Mutation-style
fixture tests prove an unknown fetch, WebSocket, EventSource, SDK client, or
curl command is rejected without committing an actual violation to the vendor
tree.

## Reviewed non-egress URL literals

Documentation links, example repository URLs, SVG namespace declarations, and
binary-install instructions are inert strings. Same-origin browser REST/SSE
calls and loopback development URLs serve the local product. They are not
external background egress and are intentionally outside the denylist.
