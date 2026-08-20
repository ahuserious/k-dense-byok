import { createHash } from "node:crypto";
import type { WorkflowEdge, WorkflowGraphDocument, WorkflowNode } from "./schema.ts";

export interface ReferencedWorkflowDefinition {
  id: string;
  revision: number;
  graphSha256: string;
  graph: WorkflowGraphDocument;
}

export class WorkflowRefExpansionError extends Error {
  constructor(
    readonly code: "CYCLE" | "NOT_FOUND" | "REVISION_MISMATCH" | "INVALID_EMBEDDED",
    message: string,
  ) {
    super(message);
    this.name = "WorkflowRefExpansionError";
  }
}

export function namespaceWorkflowNodeId(prefix: string, id: string): string {
  const candidate = `${prefix}__${id}`;
  if (candidate.length <= 64 && /^[a-z][a-z0-9_-]*$/.test(candidate)) return candidate;
  const digest = createHash("sha256").update(`${prefix}:${id}`).digest("hex").slice(0, 12);
  const head = (prefix.match(/^[a-z][a-z0-9_-]{0,7}/)?.[0] ?? "ref").slice(0, 8);
  return `${head}x${digest}`;
}

function terminalsOf(graph: WorkflowGraphDocument): string[] {
  const declared = graph.nodes.filter((node) => node.terminal).map((node) => node.id);
  if (declared.length > 0) return declared;
  const destinations = new Set(graph.edges.map((edge) => edge.to));
  return graph.nodes.filter((node) => !destinations.has(node.id) || node.id === graph.entryNodeId)
    .map((node) => node.id);
}

/**
 * Replace every `workflow-ref` with the referenced graph's nodes, namespaced,
 * stamped with `meta.compositeOf`, and refuse a cycle that reaches the
 * referencing workflow. The executor never sees a leftover `workflow-ref`.
 */
export function expandWorkflowRefs(
  graph: WorkflowGraphDocument,
  readDefinition: (workflowId: string) => ReferencedWorkflowDefinition | null,
  stack: readonly string[] = [graph.id],
): WorkflowGraphDocument {
  const nodes: WorkflowNode[] = [];
  const edges: WorkflowEdge[] = [...graph.edges];
  let entryNodeId = graph.entryNodeId;
  let changed = false;

  for (const node of graph.nodes) {
    if (node.kind !== "workflow-ref") {
      nodes.push(node);
      continue;
    }
    changed = true;
    if (stack.includes(node.workflowId)) {
      throw new WorkflowRefExpansionError(
        "CYCLE",
        `Workflow ${graph.id} references ${node.workflowId}, which is already on the expansion stack.`,
      );
    }
    const referenced = readDefinition(node.workflowId);
    if (!referenced) {
      throw new WorkflowRefExpansionError(
        "NOT_FOUND",
        `Workflow reference ${node.workflowId} does not exist.`,
      );
    }
    if (
      node.expectedRevision !== undefined &&
      node.expectedRevision !== referenced.revision
    ) {
      throw new WorkflowRefExpansionError(
        "REVISION_MISMATCH",
        `Workflow ${node.workflowId} is revision ${referenced.revision}; expected ${node.expectedRevision}.`,
      );
    }

    const embedded = expandWorkflowRefs(referenced.graph, readDefinition, [...stack, node.workflowId]);
    const idMap = new Map<string, string>();
    for (const child of embedded.nodes) {
      idMap.set(child.id, namespaceWorkflowNodeId(node.id, child.id));
    }
    const namespaced = embedded.nodes.map((child) => {
      const namespacedId = idMap.get(child.id)!;
      const existingMeta = "meta" in child && child.meta && typeof child.meta === "object"
        ? child.meta
        : {};
      return {
        ...child,
        id: namespacedId,
        terminal: node.terminal ? child.terminal : false,
        meta: {
          ...existingMeta,
          compositeOf: {
            kind: "workflow-ref",
            sourceId: referenced.id,
            sourceGraphSha256: referenced.graphSha256,
            label: node.name,
          },
        },
      } as WorkflowNode;
    });
    nodes.push(...namespaced);

    const namespacedEntry = idMap.get(embedded.entryNodeId);
    if (!namespacedEntry) {
      throw new WorkflowRefExpansionError(
        "INVALID_EMBEDDED",
        `Referenced workflow ${referenced.id} is missing its entry node after expansion.`,
      );
    }
    if (graph.entryNodeId === node.id) entryNodeId = namespacedEntry;

    for (let index = edges.length - 1; index >= 0; index -= 1) {
      const edge = edges[index];
      if (edge.from !== node.id && edge.to !== node.id) continue;
      edges.splice(index, 1);
      if (edge.to === node.id) {
        edges.push({
          ...edge,
          id: namespaceWorkflowNodeId(edge.id, "in"),
          to: namespacedEntry,
        });
      }
      if (edge.from === node.id) {
        for (const terminalId of terminalsOf(embedded)) {
          const from = idMap.get(terminalId);
          if (!from) continue;
          edges.push({
            ...edge,
            id: namespaceWorkflowNodeId(edge.id, terminalId),
            from,
          });
        }
      }
    }
  }

  if (!changed) return graph;
  return {
    ...graph,
    entryNodeId,
    nodes,
    edges,
  };
}
