/**
 * InfraNodus connector (matrix row 48), registered through the EXISTING MCP stack.
 *
 * There is no new MCP client here, no new transport, no new config file and no
 * new dial code. server/src/agent/mcp.ts already dials stdio and streamable-HTTP
 * MCP servers, caches clients per project, reconnects on config change, and wraps
 * every advertised tool as `mcp__<server>__<tool>`. This module contributes one
 * declaration plus a write through the existing `writeMcpConfig()`.
 *
 * Transport choice: stdio (`npx -y infranodus-mcp-server`). The official repo
 * (github.com/infranodus/mcp-server-infranodus) and the vendor docs
 * (infranodus.com/mcp) show the same command with INFRANODUS_API_KEY in the
 * child's environment. This bridge does **not** copy that value into
 * sandbox/.pi/mcp.json — the file is not a secret store, and the MCP child
 * already inherits the backend process environment via StdioClientTransport
 * (`env: { ...process.env, ...config.env }` in agent/mcp.ts). The file names
 * the command only. An unregistered connector still names no host, so it
 * cannot contact anything. The remote https://mcp.infranodus.com endpoint is
 * documented as OAuth2, which this bridge does not implement; a user who
 * wants it can still add it by hand.
 *
 * Tool names are deliberately NOT hardcoded. The upstream inventory could not be
 * verified without a real API key, and an invented tool name is worse than an
 * honest empty list. The real list is discovered at dial time by the existing
 * POST /mcp/test route.
 */
import type { McpServerConfig, StdioServerConfig } from "../agent/mcp.ts";

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
 *
 * The returned object has no `env` map. The API key stays in process env and
 * the stdio child inherits it. Putting the value on disk would write a secret
 * into the sandbox.
 */
export function infranodusMcpConfig(
  environment: NodeJS.ProcessEnv = process.env,
): McpServerConfig | null {
  const token = environment[INFRANODUS_API_KEY_ENV_VAR]?.trim();
  if (!token) return null;
  return {
    command: "npx",
    args: ["-y", INFRANODUS_MCP_PACKAGE],
  };
}

/**
 * Drop INFRANODUS_API_KEY from a server map in place. Returns true when the
 * map changed, so the caller can persist the cleaned file. Other env keys on
 * the same entry are kept.
 */
export function stripInfranodusApiKeyFromServers(
  servers: Record<string, McpServerConfig>,
): boolean {
  const entry = servers[INFRANODUS_MCP_SERVER_NAME];
  if (!entry || !("command" in entry) || !entry.env) return false;
  if (!(INFRANODUS_API_KEY_ENV_VAR in entry.env)) return false;
  const restEnv = { ...entry.env };
  delete restEnv[INFRANODUS_API_KEY_ENV_VAR];
  const next: StdioServerConfig = {
    command: entry.command,
    ...(entry.args ? { args: entry.args } : {}),
  };
  if (Object.keys(restEnv).length > 0) {
    next.env = restEnv;
  }
  servers[INFRANODUS_MCP_SERVER_NAME] = next;
  return true;
}
