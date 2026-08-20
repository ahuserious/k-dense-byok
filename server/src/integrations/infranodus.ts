/**
 * InfraNodus connector (matrix row 48), registered through the EXISTING MCP stack.
 *
 * There is no new MCP client here, no new transport, no new config file and no
 * new dial code. server/src/agent/mcp.ts already dials stdio and streamable-HTTP
 * MCP servers, caches clients per project, reconnects on config change, and wraps
 * every advertised tool as `mcp__<server>__<tool>`. This module contributes one
 * declaration plus a write through the existing `writeMcpConfig()`.
 *
 * Transport choice: stdio (`npx -y infranodus-mcp-server`) with
 * INFRANODUS_API_KEY in `env`. That is the shape both the official repo
 * (github.com/infranodus/mcp-server-infranodus) and the vendor docs
 * (infranodus.com/mcp) publish verbatim, it uses a static API key this bridge
 * can actually carry, and — the point for the fail-closed egress rule — it names
 * no host at all, so an unregistered connector cannot contact anything. The
 * remote https://mcp.infranodus.com endpoint is documented as OAuth2, which this
 * bridge does not implement; a user who wants it can still add it by hand.
 *
 * Tool names are deliberately NOT hardcoded. The upstream inventory could not be
 * verified without a real API key, and an invented tool name is worse than an
 * honest empty list. The real list is discovered at dial time by the existing
 * POST /mcp/test route.
 */
import type { McpServerConfig } from "../agent/mcp.ts";

/** The token variable NAME. Its value is forwarded, never read out or logged. */
export const INFRANODUS_API_KEY_ENV_VAR = "INFRANODUS_API_KEY";

/** The key under `mcpServers`, and therefore the `mcp__<name>__` tool prefix. */
export const INFRANODUS_MCP_SERVER_NAME = "infranodus";

export const INFRANODUS_MCP_PACKAGE = "infranodus-mcp-server";

export const INFRANODUS_TOOL_PREFIX = `mcp__${INFRANODUS_MCP_SERVER_NAME}__`;

export const INFRANODUS_NOT_CONFIGURED_MESSAGE =
  `InfraNodus is not configured. Set ${INFRANODUS_API_KEY_ENV_VAR} to connect.`;

export function infranodusConfigured(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const token = environment[INFRANODUS_API_KEY_ENV_VAR];
  return Boolean(token && token.trim());
}

/**
 * The mcp.json entry agent/mcp.ts dials. Returns null when unconfigured, which
 * is the caller's signal to write nothing at all — an entry carrying an empty
 * key would be a connector that looks registered and reaches nothing.
 */
export function infranodusMcpConfig(
  environment: NodeJS.ProcessEnv = process.env,
): McpServerConfig | null {
  const token = environment[INFRANODUS_API_KEY_ENV_VAR]?.trim();
  if (!token) return null;
  return {
    command: "npx",
    args: ["-y", INFRANODUS_MCP_PACKAGE],
    env: { [INFRANODUS_API_KEY_ENV_VAR]: token },
  };
}
