import crypto from "node:crypto";
import { parseDocument } from "yaml";
import {
  MAX_WORKFLOW_NODES,
  type ModelRequest,
  type WorkflowGraphDocument,
  type WorkflowNode,
} from "./schema.ts";
import { validateWorkflowGraphDocument } from "./validate.ts";

/*
 * This translator is intentionally independent of the former runtime. It
 * consumes only user-supplied metadata from the documented YAML surface.
 */

export const MAX_LEGACY_ARCHON_WORKFLOW_BYTES = 512 * 1024;

const WORKFLOW_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const SUBSCRIPTION_PROVIDERS = new Set([
  "anthropic",
  "github-copilot",
  "openai-codex",
  "xai",
]);
const ROOT_FIELDS = new Set(["name", "description", "provider", "interactive", "nodes"]);
const PORTABLE_NODE_FIELDS = new Set(["id", "prompt", "model", "depends_on"]);

export type LegacyArchonImportIssueSeverity = "warning" | "blocker";

export interface LegacyArchonImportIssue {
  severity: LegacyArchonImportIssueSeverity;
  code: string;
  path: string;
  message: string;
}

export interface LegacyArchonImportPreview {
  sourceFormat: "archon-workflow-yaml/v1";
  sourceSha256: string;
  graph: WorkflowGraphDocument | null;
  warnings: LegacyArchonImportIssue[];
  blockers: LegacyArchonImportIssue[];
  legacyRuns: {
    mode: "archive-only";
    resumable: false;
    reason: string;
  };
}

export type LegacyArchonImportErrorCode =
  | "INVALID_IMPORT_REQUEST"
  | "INVALID_LEGACY_YAML"
  | "LEGACY_SOURCE_TOO_LARGE";

export class LegacyArchonImportError extends Error {
  constructor(
    readonly code: LegacyArchonImportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LegacyArchonImportError";
  }
}

type ImportReasoning = Extract<
  ModelRequest["requested"],
  { source: "fixed" }
>["reasoning"];

export interface PreviewLegacyArchonWorkflowOptions {
  source: string;
  workflowId: string;
  reasoning: ImportReasoning;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function issue(
  severity: LegacyArchonImportIssueSeverity,
  code: string,
  path: string,
  message: string,
): LegacyArchonImportIssue {
  return { severity, code, path, message };
}

function parseLegacyYaml(source: string): unknown {
  try {
    const document = parseDocument(source, {
      strict: true,
      uniqueKeys: true,
    });
    if (document.errors.length > 0) {
      throw new Error(document.errors[0]?.message ?? "YAML parse failed.");
    }
    if (document.warnings.length > 0) {
      throw new Error(document.warnings[0]?.message ?? "YAML produced a parser warning.");
    }
    // Legacy workflow aliases are unnecessary and can amplify a small import
    // into an unexpectedly large object. A value of zero rejects every alias.
    return document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw new LegacyArchonImportError(
      "INVALID_LEGACY_YAML",
      `Legacy workflow YAML is invalid or uses unsupported aliases: ${
        error instanceof Error ? error.message : "parse failed"
      }`,
    );
  }
}

function authKindForProvider(
  provider: string,
): "api-key" | "oauth" | "local" | "custom" | null {
  if (provider === "openrouter") return "api-key";
  if (provider === "ollama") return "local";
  if (provider === "openai-compatible") return "custom";
  if (SUBSCRIPTION_PROVIDERS.has(provider)) return "oauth";
  return null;
}

function exactLegacyModel(
  rawModel: unknown,
  reasoning: ImportReasoning,
  path: string,
  blockers: LegacyArchonImportIssue[],
): ModelRequest | null {
  if (typeof rawModel !== "string" || rawModel.length < 3 || rawModel.length > 320) {
    blockers.push(issue(
      "blocker",
      "missing-exact-model",
      path,
      "Each portable legacy agent needs an explicit provider/model reference.",
    ));
    return null;
  }
  const separator = rawModel.indexOf("/");
  if (separator <= 0 || separator === rawModel.length - 1) {
    blockers.push(issue(
      "blocker",
      "invalid-model-reference",
      path,
      "Legacy model references must use provider/model syntax.",
    ));
    return null;
  }
  const provider = rawModel.slice(0, separator);
  const model = rawModel.slice(separator + 1);
  const authKind = authKindForProvider(provider);
  if (!authKind) {
    blockers.push(issue(
      "blocker",
      "unsupported-model-provider",
      path,
      `Provider ${provider} has no exact Kady workflow auth mapping.`,
    ));
    return null;
  }
  if (provider === "openrouter" && model === "openrouter/fusion") {
    blockers.push(issue(
      "blocker",
      "compound-model-needs-fusion-node",
      path,
      "openrouter/fusion must be configured as a typed Fusion node, not imported as a simple agent model.",
    ));
    return null;
  }
  return {
    requested: {
      source: "fixed",
      provider,
      model,
      auth: { kind: authKind },
      reasoning,
    },
    resolution: { mode: "exact" },
  };
}

function titleForNodeId(nodeId: string): string {
  return nodeId
    .split(/[-_]+/g)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ")
    .slice(0, 256);
}

function translatePrompt(
  prompt: string,
  nodeId: string,
  dependencies: readonly string[],
  warnings: LegacyArchonImportIssue[],
  blockers: LegacyArchonImportIssue[],
): string {
  let translated = prompt;
  if (/\$ARGUMENTS\b/.test(translated)) {
    translated = translated.replaceAll(
      /\$ARGUMENTS\b/g,
      "[Kady run goal and variables from the verified run context]",
    );
    warnings.push(issue(
      "warning",
      "run-input-placeholder-translated",
      `/nodes/${nodeId}/prompt`,
      "$ARGUMENTS was translated to Kady's explicit run-context reference.",
    ));
  }

  translated = translated.replace(
    /\$([a-z][a-z0-9_-]{0,63})\.output\b/g,
    (placeholder, sourceNodeId: string) => {
      if (!dependencies.includes(sourceNodeId)) {
        blockers.push(issue(
          "blocker",
          "non-inbound-output-reference",
          `/nodes/${nodeId}/prompt`,
          `${placeholder} is not an immediate dependency and cannot be translated to Kady's verified inbound record.`,
        ));
        return placeholder;
      }
      warnings.push(issue(
        "warning",
        "inbound-output-placeholder-translated",
        `/nodes/${nodeId}/prompt`,
        `${placeholder} was translated to Kady's verified inbound record for ${sourceNodeId}.`,
      ));
      return `[verified inbound output from node ${sourceNodeId}]`;
    },
  );

  const unresolved = translated.match(
    /\$[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)?/g,
  );
  for (const placeholder of new Set(unresolved ?? [])) {
    blockers.push(issue(
      "blocker",
      "unsupported-legacy-placeholder",
      `/nodes/${nodeId}/prompt`,
      `${placeholder} has no Kady DAG context equivalent.`,
    ));
  }
  return translated;
}

function parseDependencies(
  value: unknown,
  nodeId: string,
  blockers: LegacyArchonImportIssue[],
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    blockers.push(issue(
      "blocker",
      "invalid-dependency-list",
      `/nodes/${nodeId}/depends_on`,
      "depends_on must be a list of node ids.",
    ));
    return [];
  }
  const dependencies = [...new Set(value as string[])];
  if (dependencies.length !== value.length) {
    blockers.push(issue(
      "blocker",
      "duplicate-dependency",
      `/nodes/${nodeId}/depends_on`,
      "Duplicate legacy dependencies are not portable.",
    ));
  }
  if (dependencies.length > 1) {
    blockers.push(issue(
      "blocker",
      "unsupported-all-dependency-join",
      `/nodes/${nodeId}/depends_on`,
      "Legacy multi-dependency nodes wait for every parent, while schema 1.0 Kady merges are any-ready. Translate this join manually.",
    ));
  }
  return dependencies;
}

function legacyRunBoundary(): LegacyArchonImportPreview["legacyRuns"] {
  return {
    mode: "archive-only",
    resumable: false,
    reason:
      "Legacy Kady run rows are a lossy Console mirror; they do not contain the immutable graph snapshot, sequenced node events, leases, or model-resolution receipts required for a Kady DAG resume.",
  };
}

export function previewLegacyArchonWorkflow(
  options: PreviewLegacyArchonWorkflowOptions,
): LegacyArchonImportPreview {
  if (typeof options.source !== "string") {
    throw new LegacyArchonImportError(
      "INVALID_IMPORT_REQUEST",
      "source must be a YAML string.",
    );
  }
  if (Buffer.byteLength(options.source, "utf8") > MAX_LEGACY_ARCHON_WORKFLOW_BYTES) {
    throw new LegacyArchonImportError(
      "LEGACY_SOURCE_TOO_LARGE",
      `Legacy workflow YAML exceeds ${MAX_LEGACY_ARCHON_WORKFLOW_BYTES} bytes.`,
    );
  }
  if (!WORKFLOW_ID_RE.test(options.workflowId)) {
    throw new LegacyArchonImportError(
      "INVALID_IMPORT_REQUEST",
      "workflowId must match ^[a-z][a-z0-9_-]{0,63}$.",
    );
  }

  const sourceSha256 = crypto.createHash("sha256").update(options.source).digest("hex");
  const parsed = parseLegacyYaml(options.source);
  const warnings: LegacyArchonImportIssue[] = [];
  const blockers: LegacyArchonImportIssue[] = [];
  const baseResult = {
    sourceFormat: "archon-workflow-yaml/v1" as const,
    sourceSha256,
    warnings,
    blockers,
    legacyRuns: legacyRunBoundary(),
  };

  if (!isRecord(parsed)) {
    blockers.push(issue(
      "blocker",
      "invalid-document-root",
      "/",
      "A legacy workflow must be a YAML mapping.",
    ));
    return { ...baseResult, graph: null };
  }
  for (const key of Object.keys(parsed)) {
    if (!ROOT_FIELDS.has(key)) {
      blockers.push(issue(
        "blocker",
        "unsupported-root-field",
        `/${key}`,
        `Legacy root field ${key} has no schema 1.0 translation.`,
      ));
    }
  }
  if (parsed.provider !== "pi") {
    blockers.push(issue(
      "blocker",
      "unsupported-legacy-runtime",
      "/provider",
      "Only legacy provider: pi workflows can be translated to Pi (Kady).",
    ));
  } else {
    warnings.push(issue(
      "warning",
      "runtime-owned-by-kady",
      "/provider",
      "The legacy Pi runtime marker maps to Pi (Kady); the Archon sidecar is not retained.",
    ));
  }
  if (parsed.interactive === true) {
    blockers.push(issue(
      "blocker",
      "unsupported-global-interactive-mode",
      "/interactive",
      "Legacy interactive workflows pause between stages, but Kady schema 1.0 has no equivalent global human gate.",
    ));
  } else if (parsed.interactive === undefined) {
    blockers.push(issue(
      "blocker",
      "missing-interactive-flag",
      "/interactive",
      "Set interactive explicitly to false before translation; Kady does not infer the legacy runtime default.",
    ));
  } else if (parsed.interactive !== false) {
    blockers.push(issue(
      "blocker",
      "invalid-interactive-flag",
      "/interactive",
      "interactive must be true or false.",
    ));
  }
  if (typeof parsed.name !== "string" || parsed.name.trim().length === 0) {
    blockers.push(issue("blocker", "missing-name", "/name", "Workflow name is required."));
  }
  if (parsed.description !== undefined && typeof parsed.description !== "string") {
    blockers.push(issue(
      "blocker",
      "invalid-description",
      "/description",
      "Workflow description must be a string.",
    ));
  }
  if (!Array.isArray(parsed.nodes) || parsed.nodes.length === 0) {
    blockers.push(issue(
      "blocker",
      "missing-nodes",
      "/nodes",
      "A legacy workflow must contain at least one node.",
    ));
    return { ...baseResult, graph: null };
  }
  if (parsed.nodes.length > MAX_WORKFLOW_NODES) {
    blockers.push(issue(
      "blocker",
      "too-many-nodes",
      "/nodes",
      `A Kady workflow may contain at most ${MAX_WORKFLOW_NODES} nodes.`,
    ));
    return { ...baseResult, graph: null };
  }

  const nodeIds = new Set<string>();
  const dependenciesByNode = new Map<string, string[]>();
  const candidateNodes: WorkflowNode[] = [];
  for (const [index, rawNode] of parsed.nodes.entries()) {
    const nodePath = `/nodes/${index}`;
    if (!isRecord(rawNode)) {
      blockers.push(issue(
        "blocker",
        "invalid-node",
        nodePath,
        "Each legacy node must be a YAML mapping.",
      ));
      continue;
    }
    const nodeId = typeof rawNode.id === "string" ? rawNode.id : `invalid-node-${index + 1}`;
    if (!WORKFLOW_ID_RE.test(nodeId)) {
      blockers.push(issue(
        "blocker",
        "invalid-node-id",
        `${nodePath}/id`,
        "Legacy node ids must match ^[a-z][a-z0-9_-]{0,63}$.",
      ));
    } else if (nodeIds.has(nodeId)) {
      blockers.push(issue(
        "blocker",
        "duplicate-node-id",
        `${nodePath}/id`,
        `Node id ${nodeId} is duplicated.`,
      ));
    }
    nodeIds.add(nodeId);
    const unsupportedFields = Object.keys(rawNode).filter(
      (key) => !PORTABLE_NODE_FIELDS.has(key),
    );
    for (const field of unsupportedFields) {
      blockers.push(issue(
        "blocker",
        "unsupported-node-field",
        `${nodePath}/${field}`,
        `Legacy node field ${field} changes execution semantics and needs manual translation.`,
      ));
    }
    const dependencies = parseDependencies(rawNode.depends_on, nodeId, blockers);
    dependenciesByNode.set(nodeId, dependencies);
    if (typeof rawNode.prompt !== "string" || rawNode.prompt.trim().length === 0) {
      blockers.push(issue(
        "blocker",
        "missing-agent-prompt",
        `${nodePath}/prompt`,
        "Only legacy prompt nodes are automatically portable.",
      ));
      continue;
    }
    const model = exactLegacyModel(
      rawNode.model,
      options.reasoning,
      `${nodePath}/model`,
      blockers,
    );
    if (!model || !WORKFLOW_ID_RE.test(nodeId)) continue;
    candidateNodes.push({
      id: nodeId,
      name: titleForNodeId(nodeId),
      kind: "agent",
      terminal: false,
      workspace: { isolation: "read-only", writePaths: [] },
      position: {
        x: 80 + (index % 3) * 320,
        y: 80 + Math.floor(index / 3) * 240,
      },
      prompt: translatePrompt(
        rawNode.prompt,
        nodeId,
        dependencies,
        warnings,
        blockers,
      ),
      model,
    });
  }

  for (const [nodeId, dependencies] of dependenciesByNode) {
    for (const dependency of dependencies) {
      if (!nodeIds.has(dependency)) {
        blockers.push(issue(
          "blocker",
          "unknown-dependency",
          `/nodes/${nodeId}/depends_on`,
          `Node ${nodeId} depends on unknown node ${dependency}.`,
        ));
      }
    }
  }
  const rootIds = [...dependenciesByNode]
    .filter(([, dependencies]) => dependencies.length === 0)
    .map(([nodeId]) => nodeId);
  if (rootIds.length !== 1) {
    blockers.push(issue(
      "blocker",
      "ambiguous-entry-node",
      "/nodes",
      `Kady workflows need one entry node; this legacy workflow has ${rootIds.length}.`,
    ));
  }

  if (blockers.length > 0) return { ...baseResult, graph: null };

  let nextEdgeNumber = 1;
  const edges = [...dependenciesByNode].flatMap(([nodeId, dependencies]) =>
    dependencies.map((dependency) => ({
      id: `edge-${nextEdgeNumber++}`,
      from: dependency,
      to: nodeId,
      condition: "always" as const,
    })),
  );
  const nodesWithTerminal = candidateNodes.map((node) => ({
    ...node,
    terminal: !edges.some((edge) => edge.from === node.id),
  }));
  const modelCallCount = Math.max(1, nodesWithTerminal.length);
  const graphCandidate: WorkflowGraphDocument = {
    schemaVersion: "1.0",
    id: options.workflowId,
    name: (parsed.name as string).trim(),
    ...(typeof parsed.description === "string" && parsed.description.trim()
      ? { description: parsed.description.trim() }
      : {}),
    entryNodeId: rootIds[0]!,
    limits: {
      maxIterations: modelCallCount,
      maxModelCalls: modelCallCount,
      maxParallelism: Math.min(4, modelCallCount),
      maxSubagents: Math.min(4, modelCallCount),
      timeoutMs: 600_000,
      maxTokens: Math.min(2_000_000, 100_000 * modelCallCount),
      // Legacy definitions had no Kady-owned spend envelope. Keep paid model
      // execution closed until the user reviews and edits this preview.
      maxCostUsd: 0,
      maxRetries: 0,
    },
    rescue: { enabled: false, maxAttempts: 0, triggers: [] },
    evidence: {
      enabled: false,
      minimumIndependentSources: 0,
      requireArtifactReferences: false,
      onUnsupportedOutput: "fail",
    },
    artifacts: [],
    nodes: nodesWithTerminal,
    edges,
  };
  const validation = validateWorkflowGraphDocument(graphCandidate);
  if (!validation.ok) {
    blockers.push(...validation.issues.map((validationIssue) => issue(
      "blocker",
      `translated-${validationIssue.code}`,
      validationIssue.path,
      validationIssue.message,
    )));
    return { ...baseResult, graph: null };
  }
  warnings.push(issue(
    "warning",
    "review-required-zero-spend-cap",
    "/limits/maxCostUsd",
    "The preview sets maxCostUsd to 0 because legacy workflows had no Kady-owned spend envelope. Review every model and limit before saving.",
  ));
  warnings.push(issue(
    "warning",
    "read-only-workspaces",
    "/nodes",
    "Imported prompt nodes use read-only workspaces; legacy write/tool permissions are never inferred.",
  ));
  return { ...baseResult, graph: validation.document };
}
