/**
 * The one place a first-class integration is DECLARED.
 *
 * Before this module, an integration was whatever its own code happened to do,
 * and "is it configured?" was recomputed at each call site. The registry states,
 * once per integration: its id, its display name, the environment variable NAMES
 * it needs, how "configured" is computed (presence of those NAMES in the process
 * environment — never their values), what it reaches when configured, and what
 * it reaches when it is not.
 *
 * `IntegrationStatus` is a published interface: matrix row 6 (lane F1) and row 35
 * (lane F5) build against it. See wave-f/interfaces/F12-*.md.
 *
 * Fail-closed egress (#44 / #57 / #64): an unconfigured integration reaches
 * nothing, and `describeIntegration` reports that in words the panel renders
 * verbatim. Nothing here probes a network on read.
 */
import type { ProjectPaths } from "../projects.ts";
import { readMcpConfig, readMcpDisabled } from "../agent/mcp.ts";
import {
  MODAL_NOT_CONFIGURED_MESSAGE,
  MODAL_TOKEN_ENV_VARS,
  missingModalEnvVars,
} from "../modal/credentials.ts";
import { MODAL_CLI_BINARY, probeModalCli } from "./modal-cli.ts";
import {
  HUGGING_FACE_CLI_BINARY,
  HUGGING_FACE_NOT_CONFIGURED_MESSAGE,
  HUGGING_FACE_TOKEN_ENV_VAR,
  probeHuggingFaceCli,
} from "./huggingface.ts";
import {
  INFRANODUS_API_KEY_ENV_VAR,
  INFRANODUS_MCP_SERVER_NAME,
  INFRANODUS_NOT_CONFIGURED_MESSAGE,
  INFRANODUS_TOOL_PREFIX,
} from "./infranodus.ts";

export const INTEGRATION_IDS = ["infranodus", "huggingface", "modal"] as const;
export type IntegrationId = (typeof INTEGRATION_IDS)[number];

export interface IntegrationEnvVarDeclaration {
  /** The variable NAME. This module never reads a value into a return type. */
  name: string;
  purpose: string;
}

export interface IntegrationDefinition {
  id: IntegrationId;
  displayName: string;
  summary: string;
  kind: "mcp" | "http" | "compute";
  envVars: readonly IntegrationEnvVarDeclaration[];
  /** What it reaches once every declared variable is present. */
  reachesWhenConfigured: string;
  /** What it reaches while any declared variable is absent. Always "nothing". */
  reachesWhenUnconfigured: string;
  /** The user-facing sentence shown next to the disabled control. */
  notConfiguredMessage: string;
  /** MCP-backed integrations only. */
  mcpServerName?: string;
  mcpToolPrefix?: string;
  /** Integrations that additionally report a local binary's presence. */
  cliBinary?: string;
}

export const INTEGRATIONS: readonly IntegrationDefinition[] = [
  {
    id: "infranodus",
    displayName: "InfraNodus",
    summary:
      "Knowledge-graph and text-network analysis, exposed to a run as MCP tools.",
    kind: "mcp",
    envVars: [
      {
        name: INFRANODUS_API_KEY_ENV_VAR,
        purpose: "InfraNodus API key, forwarded to the MCP server process.",
      },
    ],
    reachesWhenConfigured:
      `Runs the ${INFRANODUS_MCP_SERVER_NAME} MCP server locally and exposes its tools as ` +
      `${INFRANODUS_TOOL_PREFIX}<tool>. The tool list is discovered when the server connects.`,
    reachesWhenUnconfigured:
      "Nothing. No connector entry is written, so no run sees an InfraNodus tool and no request leaves this machine.",
    notConfiguredMessage: INFRANODUS_NOT_CONFIGURED_MESSAGE,
    mcpServerName: INFRANODUS_MCP_SERVER_NAME,
    mcpToolPrefix: INFRANODUS_TOOL_PREFIX,
  },
  {
    id: "huggingface",
    displayName: "Hugging Face",
    summary: "Search Hugging Face models by name, for the Modal preset's model chooser.",
    kind: "http",
    envVars: [
      {
        name: HUGGING_FACE_TOKEN_ENV_VAR,
        purpose: "Hugging Face access token, sent as a bearer header on model queries.",
      },
    ],
    reachesWhenConfigured: "Queries huggingface.co for model metadata when a search is run.",
    reachesWhenUnconfigured:
      "Nothing. A model search fails closed before a request is constructed.",
    notConfiguredMessage: HUGGING_FACE_NOT_CONFIGURED_MESSAGE,
    cliBinary: HUGGING_FACE_CLI_BINARY,
  },
  {
    id: "modal",
    displayName: "Modal",
    summary:
      "Remote CPU/GPU compute. Jobs already run through the built-in Modal integration; the CLI adds local installation and workspace details.",
    kind: "compute",
    envVars: [
      { name: MODAL_TOKEN_ENV_VARS[0], purpose: "Modal token id. Set in Settings ▸ API keys." },
      { name: MODAL_TOKEN_ENV_VARS[1], purpose: "Modal token secret. Set in Settings ▸ API keys." },
    ],
    reachesWhenConfigured:
      "Submits and monitors Modal jobs through the built-in integration. The CLI additionally reads the local installation and the active workspace.",
    reachesWhenUnconfigured: "Nothing. Job submission and the CLI path both fail closed.",
    notConfiguredMessage: MODAL_NOT_CONFIGURED_MESSAGE,
    cliBinary: MODAL_CLI_BINARY,
  },
];

export interface IntegrationEnvVarStatus extends IntegrationEnvVarDeclaration {
  /** Whether the NAME is set. The value is never included. */
  present: boolean;
}

export interface IntegrationMcpStatus {
  serverName: string;
  toolPrefix: string;
  /** The entry exists in this project's mcp.json, so a run would dial it. */
  registered: boolean;
  /** Registered and not sitting in mcp-disabled.json. */
  enabled: boolean;
  toolDiscovery: "on-connect";
}

export interface IntegrationCliStatus {
  binary: string;
  found: boolean;
  path: string | null;
  version: string | null;
}

export interface IntegrationStatus {
  id: IntegrationId;
  displayName: string;
  summary: string;
  kind: IntegrationDefinition["kind"];
  configured: boolean;
  /** NAMES of the absent variables. Never values. */
  missingEnvVars: string[];
  envVars: IntegrationEnvVarStatus[];
  /** What it reaches in its CURRENT state, configured or not. */
  reaches: string;
  notConfiguredReason: string | null;
  mcp?: IntegrationMcpStatus;
  cli?: IntegrationCliStatus;
}

export interface DescribeIntegrationDeps {
  environment?: NodeJS.ProcessEnv;
  /** Omitted when the caller has no project scope; MCP registration then reads false. */
  paths?: ProjectPaths;
  /** Injectable so a test never spawns a real binary. */
  probeCli?: (binary: string) => IntegrationCliStatus;
}

function defaultProbeCli(binary: string): IntegrationCliStatus {
  if (binary === MODAL_CLI_BINARY) {
    const probe = probeModalCli();
    return { binary, found: probe.found, path: probe.path, version: probe.version };
  }
  if (binary === HUGGING_FACE_CLI_BINARY) {
    const probe = probeHuggingFaceCli();
    return { binary, found: probe.found, path: probe.path, version: null };
  }
  return { binary, found: false, path: null, version: null };
}

function isPresent(environment: NodeJS.ProcessEnv, name: string): boolean {
  const value = environment[name];
  return Boolean(value && value.trim());
}

/**
 * The wire shape for one integration. Modal's `configured` deliberately reuses
 * `missingModalEnvVars` rather than recomputing the pair test, so there is one
 * statement of the Modal credential contract in the process.
 */
export function describeIntegration(
  definition: IntegrationDefinition,
  deps: DescribeIntegrationDeps = {},
): IntegrationStatus {
  const environment = deps.environment ?? process.env;
  const envVars: IntegrationEnvVarStatus[] = definition.envVars.map((declaration) => ({
    ...declaration,
    present: isPresent(environment, declaration.name),
  }));
  const missingEnvVars =
    definition.id === "modal"
      ? missingModalEnvVars(environment)
      : envVars.filter((entry) => !entry.present).map((entry) => entry.name);
  const configured = missingEnvVars.length === 0;

  const status: IntegrationStatus = {
    id: definition.id,
    displayName: definition.displayName,
    summary: definition.summary,
    kind: definition.kind,
    configured,
    missingEnvVars,
    envVars,
    reaches: configured
      ? definition.reachesWhenConfigured
      : definition.reachesWhenUnconfigured,
    notConfiguredReason: configured ? null : definition.notConfiguredMessage,
  };

  if (definition.mcpServerName && definition.mcpToolPrefix) {
    let registered = false;
    let disabled = false;
    if (deps.paths) {
      registered = definition.mcpServerName in readMcpConfig(deps.paths);
      disabled = definition.mcpServerName in readMcpDisabled(deps.paths);
    }
    status.mcp = {
      serverName: definition.mcpServerName,
      toolPrefix: definition.mcpToolPrefix,
      registered,
      enabled: registered && !disabled,
      toolDiscovery: "on-connect",
    };
  }

  if (definition.cliBinary) {
    const probe = deps.probeCli ?? defaultProbeCli;
    status.cli = probe(definition.cliBinary);
  }

  return status;
}

export function listIntegrationStatuses(
  deps: DescribeIntegrationDeps = {},
): IntegrationStatus[] {
  return INTEGRATIONS.map((definition) => describeIntegration(definition, deps));
}

export function findIntegration(id: string): IntegrationDefinition | null {
  return INTEGRATIONS.find((definition) => definition.id === id) ?? null;
}
