// danbot-byok — web/src/lib/typed-canvas-adapter.fixture.ts
//
// The client/server graph-hash parity fixture.
//
// Three independent canonicalizers must agree on `graphSha256`:
//   1. the browser's  — web/src/lib/typed-canvas-adapter.ts
//   2. the route's    — server/src/api/dag-workflows-validate.ts
//   3. the store's    — server/src/workflows/store.ts (private `canonicalize`)
//
// Each is pinned against the constant below from its own side, so a drift in
// any one of them fails a test rather than silently minting a different
// identity for the same workflow. Keep this module IMPORT-FREE: the server's
// vitest resolves it directly from the web tree and cannot follow the `@/`
// path alias.
//
// The document is already NORMALIZED (rescue defaults present, `artifacts`
// present, every edge carrying an explicit `condition`, `candidateCount`
// resolved), because normalization is what the server hashes. It deliberately
// exercises the additive optional fields — document/node `provenance`, node
// `meta.compositeOf`, `settings.harness`, and per-node `position` — so a
// canonicalizer that skipped one of them would not match.
//
// If you change the document, recompute the digest; do not hand-edit it.

export const GRAPH_HASH_PARITY_DOCUMENT = {
  schemaVersion: "1.0",
  id: "hash-parity-workflow",
  name: "Hash parity workflow",
  description: "Pins the browser, validate-route, and store canonicalizers together.",
  entryNodeId: "research",
  defaultModel: {
    requested: {
      source: "kady-current",
      auth: { kind: "kady-current" },
      reasoning: "high",
    },
    resolution: { mode: "exact" },
  },
  limits: {
    maxIterations: 12,
    maxModelCalls: 12,
    maxParallelism: 1,
    maxSubagents: 1,
    timeoutMs: 60_000,
    maxTokens: 20_000,
    maxCostUsd: 0,
    maxRetries: 1,
  },
  rescue: {
    enabled: true,
    maxAttempts: 2,
    triggers: [
      "failure",
      "stalled",
      "unsupported-output",
      "pre-compaction",
      "post-compaction",
    ],
  },
  evidence: {
    enabled: false,
    minimumIndependentSources: 0,
    requireArtifactReferences: false,
    onUnsupportedOutput: "fail",
  },
  artifacts: [],
  provenance: {
    source: "library-template",
    id: "reproducible-data-analysis",
    sha256: "8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92",
  },
  nodes: [
    {
      id: "research",
      name: "Review Provided Context",
      description: "Inventory user-provided material before analysis planning.",
      kind: "research-until-goal",
      terminal: false,
      workspace: { isolation: "read-only", writePaths: [] },
      position: { x: 80, y: 120 },
      goal: "Inventory the provided material and name what is missing.",
      completionCriteria: ["Available evidence and gaps are explicit."],
      limits: { maxIterations: 6, maxModelCalls: 7 },
      settings: { harness: "codex" },
    },
    {
      id: "report",
      name: "Report Analysis Plan",
      kind: "agent",
      terminal: true,
      workspace: { isolation: "read-only", writePaths: [] },
      position: { x: 400, y: 120 },
      prompt: "Report the bounded analysis plan and its limitations.",
      meta: {
        compositeOf: {
          kind: "dag-workflow",
          sourceId: "reporting-tail",
          label: "Reporting tail",
        },
      },
      provenance: { source: "dag-workflow", id: "reporting-tail" },
    },
  ],
  edges: [{ id: "research-to-report", from: "research", to: "report", condition: "always" }],
} as const;

/** SHA-256 of the canonical JSON of the document above. */
export const GRAPH_HASH_PARITY_SHA256 =
  "a037d175a745542a3b538df28c42d184ead0c5426c31d48dc57c1c28c2067387";
