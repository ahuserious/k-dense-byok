import type {
  EvidencePolicy,
  ModelRequest,
  WorkflowGraphDocument,
  WorkflowNode,
} from "./schema.ts";

export const WORKFLOW_EVIDENCE_POLICY_SLOT_ID = "evidence-policy-evaluator";
export const MAX_WORKFLOW_EVIDENCE_SOURCES = 32;
const MAX_SOURCE_TEXT_LENGTH = 512;

export interface WorkflowEvidenceSourceCatalogEntry {
  id: string;
  origin: string;
  text: string;
}

type EvidenceGraphContext = Pick<
  WorkflowGraphDocument,
  "defaultModel" | "evidence"
>;

type InboundEvidence = {
  fromNodeId: string;
  output?: unknown;
};

const EVIDENCE_FIELD_RE = /(?:^|[-_])(artifact|citation|doi|evidence|reference|source|support|url)s?(?:$|[-_])/i;

export function effectiveWorkflowEvidencePolicy(
  graph: EvidenceGraphContext,
  node: WorkflowNode,
): EvidencePolicy {
  return node.evidence ?? graph.evidence;
}

export function workflowEvidencePolicyEvaluator(
  graph: EvidenceGraphContext,
  node: WorkflowNode,
): ModelRequest | undefined {
  return node.evidence?.evaluator ?? graph.evidence.evaluator ?? graph.defaultModel;
}

export function workflowEvidenceGateEvaluator(
  graph: EvidenceGraphContext,
  node: Extract<WorkflowNode, { kind: "evidence-gate" }>,
): ModelRequest | undefined {
  return node.evaluator ?? node.evidence?.evaluator ?? graph.evidence.evaluator ??
    graph.defaultModel;
}

export function requiresWorkflowEvidencePolicyEvaluation(
  graph: EvidenceGraphContext,
  node: WorkflowNode,
): boolean {
  return node.kind !== "evidence-gate" && effectiveWorkflowEvidencePolicy(graph, node).enabled;
}

function compactSourceText(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, MAX_SOURCE_TEXT_LENGTH);
}

/**
 * Build the only source identifiers a model-assisted policy evaluator may cite.
 * The catalog is derived from evidence-labelled fields in the bounded node
 * output and verified inbound records; evaluator-authored identifiers are never
 * accepted as new evidence.
 */
export function buildWorkflowEvidenceSourceCatalog(
  output: unknown,
  inbound: readonly InboundEvidence[],
): WorkflowEvidenceSourceCatalogEntry[] {
  const entries: WorkflowEvidenceSourceCatalogEntry[] = [];
  const seenText = new Set<string>();

  const add = (origin: string, value: string): void => {
    if (entries.length >= MAX_WORKFLOW_EVIDENCE_SOURCES) return;
    const text = compactSourceText(value);
    if (!text || seenText.has(text)) return;
    seenText.add(text);
    entries.push({
      id: `source-${String(entries.length + 1).padStart(3, "0")}`,
      origin: origin.slice(0, 256),
      text,
    });
  };

  const visit = (
    value: unknown,
    origin: string,
    evidenceContext: boolean,
    ancestors: Set<object>,
  ): void => {
    if (entries.length >= MAX_WORKFLOW_EVIDENCE_SOURCES || value === null) return;
    if (typeof value === "string") {
      if (evidenceContext) add(origin, value);
      return;
    }
    if (typeof value !== "object") return;
    if (ancestors.has(value)) return;
    ancestors.add(value);
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        visit(value[index], `${origin}/${index}`, evidenceContext, ancestors);
      }
    } else {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        visit(
          child,
          `${origin}/${key}`,
          evidenceContext || EVIDENCE_FIELD_RE.test(key),
          ancestors,
        );
      }
    }
    ancestors.delete(value);
  };

  visit(output, "output", false, new Set<object>());
  for (const item of inbound) {
    visit(item.output, `inbound/${item.fromNodeId}`, false, new Set<object>());
  }
  return entries;
}

export function normalizeWorkflowEvidenceSourceIds(
  value: unknown,
  catalog: readonly WorkflowEvidenceSourceCatalogEntry[],
): string[] | null {
  if (
    !Array.isArray(value) ||
    value.length > MAX_WORKFLOW_EVIDENCE_SOURCES ||
    value.some((item) => typeof item !== "string")
  ) {
    return null;
  }
  const allowed = new Set(catalog.map((entry) => entry.id));
  const unique = [...new Set(value as string[])];
  return unique.every((id) => allowed.has(id)) ? unique : null;
}
