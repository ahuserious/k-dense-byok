import { getMcpTools } from "../agent/mcp.ts";
import {
  INFRANODUS_NOT_CONFIGURED_MESSAGE,
  INFRANODUS_TOOL_PREFIX,
  infranodusConfigured,
} from "../integrations/infranodus.ts";
import type { ProjectPaths } from "../projects.ts";
import type { WorkflowNode } from "./schema.ts";

export const REASONING_STYLE_NOT_CONFIGURED_CODE = "WORKFLOW_INTEGRATION_NOT_CONFIGURED";

export const INFRANODUS_TOOLS_UNAVAILABLE_MESSAGE =
  "InfraNodus is configured but no map tools are available. Connect InfraNodus in Settings ▸ Connectors and retry.";

export const INFRANODUS_MAP_EMPTY_MESSAGE =
  "InfraNodus returned no personas from the map. The council roster cannot be selected.";

export const INFRANODUS_MAP_TOPIC_REQUIRED_MESSAGE =
  "InfraNodus mode needs a map name or topic in style or personalityRefs.";

export const DEFAULT_SCIENTIST_PERSONAS = [
  "genomics",
  "statistician",
  "theorist",
  "experimentalist",
] as const;

const PERSONALITY_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

/**
 * Discovered-name preference only. F12 does not hardcode the upstream list;
 * if none of these are advertised the mode fails closed instead of guessing.
 */
const PREFERRED_MAP_TOOLS = [
  "analyze_existing_graph_by_name",
  "generate_knowledge_graph",
  "generate_topical_clusters",
  "list_graphs",
] as const;

export interface ReasoningStyleSelection {
  kind: "reasoning-style";
  mode: "auto" | "manual" | "infranodus";
  source: "mimeographs" | "authored" | "infranodus";
  personalityRefs: string[];
  style?: string;
}

export interface InfranodusMapQuery {
  listTools(): Promise<string[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export function bareInfranodusToolName(name: string): string {
  return name.startsWith(INFRANODUS_TOOL_PREFIX)
    ? name.slice(INFRANODUS_TOOL_PREFIX.length)
    : name;
}

export function pickInfranodusMapTool(toolNames: readonly string[]): string | undefined {
  const available = new Map(
    toolNames.map((name) => [bareInfranodusToolName(name), name] as const),
  );
  for (const preferred of PREFERRED_MAP_TOOLS) {
    const found = available.get(preferred);
    if (found) return found;
  }
  return undefined;
}

export function personasFromInfranodusPayload(payload: unknown): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8 || refs.length >= 32) return;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (
        trimmed.length >= 1 &&
        trimmed.length <= 256 &&
        PERSONALITY_REF_RE.test(trimmed) &&
        !seen.has(trimmed)
      ) {
        seen.add(trimmed);
        refs.push(trimmed);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const preferredKeys = [
      "mainConcepts",
      "mainTopicalClusters",
      "topInfluentialNodes",
      "concepts",
      "clusters",
      "nodes",
      "name",
      "title",
      "id",
    ];
    for (const key of preferredKeys) {
      if (key in record) visit(record[key], depth + 1);
    }
    for (const [key, nested] of Object.entries(record)) {
      if (preferredKeys.includes(key)) continue;
      visit(nested, depth + 1);
    }
  };
  visit(payload, 0);
  return refs.slice(0, 32);
}

export async function infranodusMapQueryFromMcp(
  projectId: string,
  paths: ProjectPaths,
): Promise<InfranodusMapQuery> {
  const tools = await getMcpTools(projectId, paths);
  const prefixed = tools.filter((tool) => tool.name.startsWith(INFRANODUS_TOOL_PREFIX));
  return {
    listTools: async () => prefixed.map((tool) => tool.name),
    callTool: async (name, args) => {
      const tool = prefixed.find((candidate) => candidate.name === name);
      if (!tool) {
        throw Object.assign(new Error(INFRANODUS_TOOLS_UNAVAILABLE_MESSAGE), {
          code: REASONING_STYLE_NOT_CONFIGURED_CODE,
        });
      }
      const execute = tool.execute as unknown as (
        toolCallId: string,
        params: unknown,
        signal: AbortSignal | undefined,
        onUpdate: undefined,
        ctx: { cwd: string },
      ) => Promise<{ content?: unknown; isError?: boolean }>;
      const result = await execute(
        "reasoning-style-infranodus",
        args,
        undefined,
        undefined,
        { cwd: paths.sandbox },
      );
      if (result.isError) {
        throw Object.assign(new Error(INFRANODUS_MAP_EMPTY_MESSAGE), {
          code: REASONING_STYLE_NOT_CONFIGURED_CODE,
        });
      }
      return result.content ?? result;
    },
  };
}

function integrationError(message: string): Error {
  return Object.assign(new Error(message), {
    code: REASONING_STYLE_NOT_CONFIGURED_CODE,
  });
}

function contextError(message: string): Error {
  return Object.assign(new Error(message), {
    code: "WORKFLOW_NODE_INVALID_CONTEXT",
  });
}

function infranodusQueryArgs(
  node: Extract<WorkflowNode, { kind: "reasoning-style" }>,
  toolName: string,
): Record<string, unknown> {
  const graphName = node.style?.trim() || node.personalityRefs?.[0]?.trim() || "";
  const topic = [node.style, ...(node.personalityRefs ?? [])]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join("\n");
  const bare = bareInfranodusToolName(toolName);
  if (bare === "analyze_existing_graph_by_name" || bare === "list_graphs") {
    return graphName ? { graphName } : {};
  }
  if (bare === "generate_knowledge_graph" || bare === "generate_topical_clusters") {
    return { text: topic };
  }
  return topic ? { text: topic, graphName } : {};
}

export async function selectReasoningStylePersonas(
  node: Extract<WorkflowNode, { kind: "reasoning-style" }>,
  environment: NodeJS.ProcessEnv = process.env,
  query?: InfranodusMapQuery,
): Promise<ReasoningStyleSelection> {
  switch (node.mode) {
    case "manual": {
      const refs = node.personalityRefs ?? [];
      if (refs.length === 0) {
        throw contextError("Manual reasoning-style requires at least one personalityRef.");
      }
      return {
        kind: "reasoning-style",
        mode: "manual",
        source: "authored",
        personalityRefs: refs.slice(0, 32),
        ...(node.style ? { style: node.style } : {}),
      };
    }
    case "auto": {
      const authored = node.settings?.deliberation?.mimeographs?.personalityRefs ?? [];
      const refs = authored.length > 0 ? authored : [...DEFAULT_SCIENTIST_PERSONAS];
      return {
        kind: "reasoning-style",
        mode: "auto",
        source: "mimeographs",
        personalityRefs: refs.slice(0, node.settings?.deliberation?.bestOfNPersonalityCount ?? 4),
        ...(node.style ? { style: node.style } : {}),
      };
    }
    case "infranodus": {
      if (!infranodusConfigured(environment)) {
        throw integrationError(INFRANODUS_NOT_CONFIGURED_MESSAGE);
      }
      if (!query) {
        throw integrationError(INFRANODUS_TOOLS_UNAVAILABLE_MESSAGE);
      }
      const hasTopic = [node.style, ...(node.personalityRefs ?? [])]
        .some((part) => typeof part === "string" && part.trim().length > 0);
      if (!hasTopic) {
        throw contextError(INFRANODUS_MAP_TOPIC_REQUIRED_MESSAGE);
      }
      const toolNames = await query.listTools();
      const infranodusTools = toolNames.filter((name) =>
        name.startsWith(INFRANODUS_TOOL_PREFIX) ||
        PREFERRED_MAP_TOOLS.includes(name as (typeof PREFERRED_MAP_TOOLS)[number])
      );
      if (infranodusTools.length === 0) {
        throw integrationError(INFRANODUS_TOOLS_UNAVAILABLE_MESSAGE);
      }
      const toolName = pickInfranodusMapTool(infranodusTools);
      if (!toolName) {
        throw integrationError(INFRANODUS_TOOLS_UNAVAILABLE_MESSAGE);
      }
      const payload = await query.callTool(toolName, infranodusQueryArgs(node, toolName));
      const refs = personasFromInfranodusPayload(payload);
      if (refs.length === 0) {
        throw integrationError(INFRANODUS_MAP_EMPTY_MESSAGE);
      }
      return {
        kind: "reasoning-style",
        mode: "infranodus",
        source: "infranodus",
        personalityRefs: refs.slice(0, 32),
        ...(node.style ? { style: node.style } : {}),
      };
    }
    default: {
      const _exhaustive: never = node.mode;
      throw contextError(`Unhandled reasoning-style mode ${String(_exhaustive)}.`);
    }
  }
}
