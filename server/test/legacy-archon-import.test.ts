import { describe, expect, it } from "vitest";
import {
  LegacyArchonImportError,
  previewLegacyArchonWorkflow,
} from "../src/workflows/legacy-archon-import.ts";

function preview(source: string) {
  return previewLegacyArchonWorkflow({
    source,
    workflowId: "imported-analysis",
    reasoning: "medium",
  });
}

describe("legacy Archon workflow preview", () => {
  it("translates the portable prompt-only subset without writing or inferring spend", () => {
    const result = preview(`
name: Portable analysis
description: A synthetic two-stage example.
provider: pi
interactive: false
nodes:
  - id: collect
    prompt: "Inspect the explicit request: $ARGUMENTS"
    model: ollama/qwen3:8b
  - id: report
    prompt: "Summarize $collect.output"
    depends_on: [collect]
    model: openrouter/example/model
`);

    expect(result.blockers).toEqual([]);
    expect(result.graph).toMatchObject({
      schemaVersion: "1.0",
      id: "imported-analysis",
      entryNodeId: "collect",
      limits: { maxModelCalls: 2, maxCostUsd: 0, maxRetries: 0 },
      rescue: { enabled: false, maxAttempts: 0 },
      evidence: { enabled: false },
      nodes: [
        {
          id: "collect",
          kind: "agent",
          terminal: false,
          model: {
            requested: {
              provider: "ollama",
              model: "qwen3:8b",
              auth: { kind: "local" },
              reasoning: "medium",
            },
          },
        },
        {
          id: "report",
          kind: "agent",
          terminal: true,
          model: {
            requested: {
              provider: "openrouter",
              model: "example/model",
              auth: { kind: "api-key" },
              reasoning: "medium",
            },
          },
        },
      ],
      edges: [{ from: "collect", to: "report", condition: "always" }],
    });
    expect(result.graph?.nodes[0]).toMatchObject({
      workspace: { isolation: "read-only", writePaths: [] },
    });
    expect(result.graph?.nodes[0]).toHaveProperty(
      "prompt",
      "Inspect the explicit request: [Kady run goal and variables from the verified run context]",
    );
    expect(result.graph?.nodes[1]).toHaveProperty(
      "prompt",
      "Summarize [verified inbound output from node collect]",
    );
    expect(result.warnings.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      "runtime-owned-by-kady",
      "run-input-placeholder-translated",
      "inbound-output-placeholder-translated",
      "review-required-zero-spend-cap",
      "read-only-workspaces",
    ]));
    expect(result.legacyRuns).toMatchObject({ mode: "archive-only", resumable: false });
  });

  it("blocks legacy semantics that schema 1.0 cannot preserve exactly", () => {
    const result = preview(`
name: Needs manual translation
provider: pi
interactive: true
nodes:
  - id: left
    prompt: Do bounded work.
    model: ollama/local-a
  - id: right
    prompt: Do other bounded work.
    model: ollama/local-b
  - id: join
    depends_on: [left, right]
    loop:
      prompt: Repeat until a marker appears.
      until: DONE
      max_iterations: 3
    skills: [synthetic-skill]
    model: ollama/local-c
`);

    expect(result.graph).toBeNull();
    expect(result.blockers.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      "unsupported-global-interactive-mode",
      "unsupported-all-dependency-join",
      "unsupported-node-field",
      "missing-agent-prompt",
      "ambiguous-entry-node",
    ]));
  });

  it("fails closed on aliases and unknown provider ownership", () => {
    expect(() => preview(`
name: &shared Alias source
description: *shared
provider: pi
nodes:
  - id: start
    prompt: Run once.
    model: ollama/local
`)).toThrowError(LegacyArchonImportError);

    const unknown = preview(`
name: Unknown provider
provider: pi
interactive: false
nodes:
  - id: start
    prompt: Run once.
    model: mystery/model
`);
    expect(unknown.graph).toBeNull();
    expect(unknown.blockers).toContainEqual(expect.objectContaining({
      code: "unsupported-model-provider",
      path: "/nodes/0/model",
    }));

    const implicitInteraction = preview(`
name: Missing interaction policy
provider: pi
nodes:
  - id: start
    prompt: Run once.
    model: ollama/local
`);
    expect(implicitInteraction.graph).toBeNull();
    expect(implicitInteraction.blockers).toContainEqual(expect.objectContaining({
      code: "missing-interactive-flag",
      path: "/interactive",
    }));
  });
});
