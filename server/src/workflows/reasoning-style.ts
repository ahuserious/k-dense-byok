import {
  INFRANODUS_NOT_CONFIGURED_MESSAGE,
  infranodusConfigured,
} from "../integrations/infranodus.ts";
import type { WorkflowNode } from "./schema.ts";

export const REASONING_STYLE_NOT_CONFIGURED_CODE = "WORKFLOW_INTEGRATION_NOT_CONFIGURED";

export const DEFAULT_SCIENTIST_PERSONAS = [
  "genomics",
  "statistician",
  "theorist",
  "experimentalist",
] as const;

export interface ReasoningStyleSelection {
  kind: "reasoning-style";
  mode: "auto" | "manual" | "infranodus";
  source: "mimeographs" | "authored" | "infranodus";
  personalityRefs: string[];
  style?: string;
}

export function selectReasoningStylePersonas(
  node: Extract<WorkflowNode, { kind: "reasoning-style" }>,
  environment: NodeJS.ProcessEnv = process.env,
): ReasoningStyleSelection {
  if (node.mode === "infranodus" && !infranodusConfigured(environment)) {
    throw Object.assign(new Error(INFRANODUS_NOT_CONFIGURED_MESSAGE), {
      code: REASONING_STYLE_NOT_CONFIGURED_CODE,
    });
  }

  if (node.mode === "manual") {
    const refs = node.personalityRefs ?? [];
    if (refs.length === 0) {
      throw Object.assign(
        new Error("Manual reasoning-style requires at least one personalityRef."),
        { code: "WORKFLOW_NODE_INVALID_CONTEXT" },
      );
    }
    return {
      kind: "reasoning-style",
      mode: "manual",
      source: "authored",
      personalityRefs: refs.slice(0, 32),
      ...(node.style ? { style: node.style } : {}),
    };
  }

  if (node.mode === "infranodus") {
    const refs = node.personalityRefs && node.personalityRefs.length > 0
      ? node.personalityRefs
      : [...DEFAULT_SCIENTIST_PERSONAS];
    return {
      kind: "reasoning-style",
      mode: "infranodus",
      source: "infranodus",
      personalityRefs: refs.slice(0, 32),
      ...(node.style ? { style: node.style } : {}),
    };
  }

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
