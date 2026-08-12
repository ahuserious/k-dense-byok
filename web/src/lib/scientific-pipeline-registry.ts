"use client";

import type {
  DagWorkflowDefinitionSummary,
  WorkflowGraphDocument,
} from "@/lib/dag-workflows";
import { apiFetch } from "@/lib/projects";

export type ScientificPipelineEngine = "typed" | "vendored";

export const PIPELINE_ENGINE_REQUEST_TIMEOUT_MS = 5_000;

export interface TypedWorkflowRegistrySource {
  engine: "typed";
  sourceId: string;
  workflowId: string;
  summary: DagWorkflowDefinitionSummary;
  graph?: WorkflowGraphDocument;
}

export interface VendoredWorkflowRegistrySource {
  engine: "vendored";
  sourceId: string;
  /** Exact engine identifier. Never normalize this value before routing. */
  workflowId: string;
  /** Exact engine codebase registration used for every edit read/write. */
  codebaseId: string;
  workflowName: string;
  displayName: string;
  origin?: string;
  filename?: string;
  description: string;
  workflow: Record<string, unknown>;
}

export interface VendoredPipelineEditTarget {
  workflowId: string;
  codebaseId: string;
}

export interface ScientificPipelineRoutingAmbiguity {
  engine: ScientificPipelineEngine;
  sourceIds: string[];
  identifiers: string[];
  message: string;
}

export interface VendoredWorkflowRoutingState {
  routable: boolean;
  projectScopeVerified: true;
  blockedReason?: string;
}

export interface ScientificPipelineRegistryEntry {
  id: string;
  normalizedName: string;
  structureHash: string;
  name: string;
  description: string;
  typed?: TypedWorkflowRegistrySource;
  vendored?: VendoredWorkflowRegistrySource;
  vendoredRouting?: VendoredWorkflowRoutingState;
  routingAmbiguities?: ScientificPipelineRoutingAmbiguity[];
}

type RegistrySource = TypedWorkflowRegistrySource | VendoredWorkflowRegistrySource;

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function normalizeWorkflowName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function normalizedNodeId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.normalize("NFKC").trim()
    : undefined;
}

function topologyProjection(workflow: Record<string, unknown>): {
  nodes: string[];
  edges: string[];
} | undefined {
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : undefined;
  if (!nodes) return undefined;

  const nodeIds = new Set<string>();
  const edges = new Set<string>();
  for (const candidate of nodes) {
    const node = recordOf(candidate);
    const nodeId = normalizedNodeId(node?.id);
    if (!nodeId) continue;
    nodeIds.add(nodeId);
    if (Array.isArray(node?.depends_on)) {
      for (const dependency of node.depends_on) {
        const dependencyId = normalizedNodeId(dependency);
        if (dependencyId) edges.add(`${dependencyId}\u0000${nodeId}`);
      }
    }
  }

  if (Array.isArray(workflow.edges)) {
    for (const candidate of workflow.edges) {
      const edge = recordOf(candidate);
      const from = normalizedNodeId(edge?.from ?? edge?.source);
      const to = normalizedNodeId(edge?.to ?? edge?.target);
      if (from && to) edges.add(`${from}\u0000${to}`);
    }
  }

  if (nodeIds.size === 0) return undefined;
  return {
    nodes: [...nodeIds].sort(),
    edges: [...edges].sort(),
  };
}

function stableHash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
  }
  return `${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
}

export function workflowStructureHash(workflow: Record<string, unknown>): string | null {
  const topology = topologyProjection(workflow);
  return topology ? `topology-v1-${stableHash(JSON.stringify(topology))}` : null;
}

export function typedWorkflowRegistrySource(
  summary: DagWorkflowDefinitionSummary,
  graph?: WorkflowGraphDocument,
): TypedWorkflowRegistrySource {
  return {
    engine: "typed",
    sourceId: `typed:${encodeURIComponent(summary.id)}`,
    workflowId: summary.id,
    summary,
    ...(graph ? { graph } : {}),
  };
}

export function vendoredWorkflowRegistrySource(
  workflow: Record<string, unknown>,
  identity: { codebaseId: string; origin?: string; filename?: string; workflowId?: string },
): VendoredWorkflowRegistrySource | null {
  const workflowName = typeof workflow.name === "string" ? workflow.name : "";
  const displayName = workflowName.trim().replace(/\s+/g, " ");
  if (!displayName) return null;
  const description = typeof workflow.description === "string"
    ? workflow.description.split("\n")[0] ?? ""
    : "";
  const workflowId = identity.workflowId ?? identity.filename ?? workflowName;
  const identityParts = [encodeURIComponent(workflowId)];
  if (identity.origin !== undefined) {
    identityParts.push(`origin=${encodeURIComponent(identity.origin)}`);
  }
  if (identity.filename !== undefined) {
    identityParts.push(`filename=${encodeURIComponent(identity.filename)}`);
  }
  return {
    engine: "vendored",
    sourceId: `vendored:${identityParts.join(":")}`,
    workflowId,
    codebaseId: identity.codebaseId,
    workflowName,
    displayName,
    ...(identity.origin !== undefined ? { origin: identity.origin } : {}),
    ...(identity.filename !== undefined ? { filename: identity.filename } : {}),
    description,
    workflow,
  };
}

function sourceName(source: RegistrySource): string {
  return source.engine === "typed" ? source.summary.name : source.displayName;
}

function sourceDescription(source: RegistrySource): string {
  return source.engine === "typed"
    ? source.summary.description ?? ""
    : source.description;
}

function sourceStructureHash(source: RegistrySource): string {
  const structuralHash = source.engine === "typed" && source.graph
    ? workflowStructureHash(source.graph as unknown as Record<string, unknown>)
    : source.engine === "vendored"
      ? workflowStructureHash(source.workflow)
      : null;
  if (structuralHash) return structuralHash;
  return source.engine === "typed"
    ? `typed-graph-${source.summary.graphSha256}`
    : `vendored-source-${stableHash(JSON.stringify(source.workflow))}`;
}

function sourceRouteIdentifier(source: RegistrySource): string {
  return source.workflowId;
}

function flagDuplicateEngineRouteIdentifiers(
  entries: Map<string, ScientificPipelineRegistryEntry>,
  engine: ScientificPipelineEngine,
): void {
  const matchingEntries = [...entries.values()].filter((entry) =>
    engine === "typed" ? entry.typed !== undefined : entry.vendored !== undefined
  );
  const routes = matchingEntries.map((entry) =>
    engine === "typed" ? entry.typed! : entry.vendored!
  );
  const identifiers = routes.map(sourceRouteIdentifier);
  const duplicateIdentifiers = new Set(
    identifiers.filter((identifier, index) => identifiers.indexOf(identifier) !== index),
  );
  for (const entry of matchingEntries) {
    entry.routingAmbiguities = entry.routingAmbiguities?.filter(
      (candidate) => candidate.engine !== engine,
    );
    if (entry.routingAmbiguities?.length === 0) delete entry.routingAmbiguities;
    if (engine === "vendored") {
      entry.vendoredRouting = {
        routable: true,
        projectScopeVerified: true,
      };
    }
  }
  if (duplicateIdentifiers.size === 0) return;

  const ambiguousEntries = matchingEntries.filter((entry) => {
    const route = engine === "typed" ? entry.typed! : entry.vendored!;
    return duplicateIdentifiers.has(sourceRouteIdentifier(route));
  });
  const ambiguousRoutes = ambiguousEntries.map((entry) =>
    engine === "typed" ? entry.typed! : entry.vendored!
  );
  const sourceIds = ambiguousRoutes.map((route) => route.sourceId);
  const ambiguousIdentifiers = ambiguousRoutes.map(sourceRouteIdentifier);
  const ambiguity: ScientificPipelineRoutingAmbiguity = {
    engine,
    sourceIds,
    identifiers: ambiguousIdentifiers,
    message: `Ambiguous ${engine} routes share a duplicate stable identifier: ${[...duplicateIdentifiers].map((identifier) => JSON.stringify(identifier)).join(", ")}.`,
  };
  for (const entry of ambiguousEntries) {
    entry.routingAmbiguities = [...(entry.routingAmbiguities ?? []), ambiguity];
    if (engine === "vendored") {
      entry.vendoredRouting = {
        routable: false,
        projectScopeVerified: true,
        blockedReason: ambiguity.message,
      };
    }
  }
}

export function buildScientificPipelineRegistry(
  typedSources: TypedWorkflowRegistrySource[],
  vendoredSources: VendoredWorkflowRegistrySource[],
): ScientificPipelineRegistryEntry[] {
  const entries = new Map<string, ScientificPipelineRegistryEntry>();
  const sourceOccurrences = new Map<string, number>();

  for (const source of [...typedSources, ...vendoredSources]) {
    const normalizedName = normalizeWorkflowName(sourceName(source));
    const structureHash = sourceStructureHash(source);
    const sharedId = `workflow:${encodeURIComponent(normalizedName)}:${structureHash}`;
    let id = sharedId;
    let current = entries.get(id);
    const occupiedRoute = source.engine === "typed" ? current?.typed : current?.vendored;
    const occurrenceKey = `${sharedId}\u0000${source.engine}\u0000${source.sourceId}`;
    const occurrence = sourceOccurrences.get(occurrenceKey) ?? 0;
    sourceOccurrences.set(occurrenceKey, occurrence + 1);
    if (source.engine === "typed" && occupiedRoute?.sourceId === source.sourceId) continue;
    if (occupiedRoute) {
      // Same-engine records remain independently addressable. Cross-engine
      // aliases may share a row, but presentation dedup must never discard a
      // second runnable backing record from the same engine.
      id = `${sharedId}:${source.sourceId}${occurrence > 0 ? `:occurrence-${occurrence}` : ""}`;
      current = entries.get(id);
    }
    const next: ScientificPipelineRegistryEntry = current ?? {
      id,
      normalizedName,
      structureHash,
      name: sourceName(source),
      description: sourceDescription(source),
    };
    if (source.engine === "typed") {
      next.typed = source;
      next.name = source.summary.name;
      next.description = source.summary.description ?? next.description;
    } else {
      next.vendored = source;
      next.vendoredRouting = {
        routable: true,
        projectScopeVerified: true,
      };
      if (!next.description) next.description = source.description;
    }
    entries.set(id, next);
    flagDuplicateEngineRouteIdentifiers(entries, source.engine);
  }

  return [...entries.values()].sort((left, right) =>
    left.normalizedName.localeCompare(right.normalizedName) ||
    left.structureHash.localeCompare(right.structureHash)
  );
}

export function workflowRouteForEngine(
  entry: ScientificPipelineRegistryEntry,
  engine: "typed",
): TypedWorkflowRegistrySource;
export function workflowRouteForEngine(
  entry: ScientificPipelineRegistryEntry,
  engine: "vendored",
): VendoredWorkflowRegistrySource;
export function workflowRouteForEngine(
  entry: ScientificPipelineRegistryEntry,
  engine: ScientificPipelineEngine,
): RegistrySource {
  const route = engine === "typed" ? entry.typed : entry.vendored;
  if (!route) {
    throw new Error(`Workflow ${entry.id} has no ${engine} backing route.`);
  }
  if (engine === "vendored" && entry.vendoredRouting?.routable === false) {
    throw new Error(
      entry.vendoredRouting.blockedReason ?? "Vendored workflow route is not safe to resolve.",
    );
  }
  return route;
}

async function pipelineEngineRequest(
  path: string,
  projectId: string,
  operation: string,
  timeoutMs = PIPELINE_ENGINE_REQUEST_TIMEOUT_MS,
): Promise<{ response: Response; body: unknown }> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutFailure = new Promise<{ response: Response; body: unknown }>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error(`${operation} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      apiFetch(path, { signal: controller.signal }, projectId).then(async (response) => ({
        response,
        body: response.ok ? await response.json() as unknown : null,
      })),
      timeoutFailure,
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export async function vendoredPipelineEngineHealth(
  projectId: string,
  timeoutMs = PIPELINE_ENGINE_REQUEST_TIMEOUT_MS,
): Promise<boolean> {
  const { response, body } = await pipelineEngineRequest(
    "/pipelines/health",
    projectId,
    "Vendored workflow health check",
    timeoutMs,
  );
  if (!response.ok) {
    throw new Error(`Vendored workflow health check failed (${response.status}).`);
  }
  return recordOf(body)?.healthy === true;
}

export async function listVendoredWorkflowRegistrySources(
  projectId: string,
  timeoutMs = PIPELINE_ENGINE_REQUEST_TIMEOUT_MS,
): Promise<VendoredWorkflowRegistrySource[]> {
  const { response, body } = await pipelineEngineRequest(
    "/pipelines",
    projectId,
    "Vendored workflow list",
    timeoutMs,
  );
  if (!response.ok) {
    throw new Error(`Vendored workflow list failed (${response.status}).`);
  }
  const workflows = recordOf(body)?.workflows;
  if (!Array.isArray(workflows)) return [];
  return workflows.flatMap((candidate) => {
    const candidateRecord = recordOf(candidate);
    const workflow = recordOf(candidateRecord?.workflow);
    const origin = candidateRecord?.source ?? workflow?.origin;
    const filename = candidateRecord?.filename ?? workflow?.filename;
    const workflowId = candidateRecord?.workflowId;
    const codebaseId = candidateRecord?.codebaseId;
    if (typeof codebaseId !== "string" || codebaseId.length === 0) return [];
    const source = workflow ? vendoredWorkflowRegistrySource(workflow, {
      codebaseId,
      ...(typeof origin === "string" ? { origin } : {}),
      ...(typeof filename === "string" ? { filename } : {}),
      ...(typeof workflowId === "string" ? { workflowId } : {}),
    }) : null;
    return source ? [source] : [];
  });
}
