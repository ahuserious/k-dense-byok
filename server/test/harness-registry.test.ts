/**
 * The registry is the single table every other harness spelling derives from.
 * These are the pins that make "adding a harness is one row" true rather than
 * aspirational: the TypeBox union, the supervisor wire tuple and the resolved
 * NodeSpec type are all checked against it here, so a literal added to one and
 * not the others fails the suite instead of shipping (#55's defect class).
 */
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import {
  WORKFLOW_HARNESS_IDS,
  WORKFLOW_HARNESS_REGISTRY,
  WorkflowHarnessDispatchError,
  isWorkflowHarnessId,
  selectWorkflowHarnessAdapter,
  workflowHarnessDefinition,
  workflowHarnessExecutables,
  type WorkflowHarnessId,
} from "../src/workflows/harness-registry.ts";
import { NodeSpecV1Schema, WorkflowSettingsV1Schema } from "../src/workflows/schema.ts";
import { PromptOptimizationNodeSchema } from "../src/workflows/prompt-opt-schema.ts";

function promptOptimizationModel(id: string) {
  return {
    requested: {
      source: "fixed" as const,
      provider: "openrouter",
      model: id,
      auth: { kind: "api-key" as const },
      reasoning: "high" as const,
    },
    resolution: { mode: "exact" as const },
  };
}

/** A prompt-optimization node the schema accepts, carrying one harness. */
function promptOptimizationNode(harness: string): unknown {
  return {
    id: "optimize-prompt",
    name: "Optimize target prompt",
    kind: "prompt-optimization",
    terminal: true,
    workspace: { isolation: "read-only", writePaths: [] },
    settings: { version: 1, harness },
    originalPrompt: "Summarize the experiment.",
    objective: "Make the request precise and explicit about evidence.",
    artifactId: "prompt-artifact",
    iterations: 2,
    fusionDeliberation: {
      enabled: false,
      council: {
        members: [
          { id: "methods", role: "Methods reviewer", model: promptOptimizationModel("model-a") },
          { id: "critic", role: "Adversarial reviewer", model: promptOptimizationModel("model-b") },
        ],
        chair: promptOptimizationModel("model-chair"),
        rounds: 1,
        preserveMinorityReports: true,
      },
      fusion: {
        mode: "kady-panel",
        members: [
          { id: "writer", role: "Prompt writer", model: promptOptimizationModel("model-a") },
          { id: "judge", role: "Prompt critic", model: promptOptimizationModel("model-b") },
        ],
        synthesizer: promptOptimizationModel("model-synthesizer"),
        rounds: 1,
      },
      preserveMinorityReports: true,
    },
  };
}

const NEVER_INSTALLED = (): string | null => null;
const ALWAYS_INSTALLED = (command: string): string | null => `/opt/kady/bin/${command}`;

describe("workflow harness registry", () => {
  it("carries exactly the eight contract literals, each with a row", () => {
    expect([...WORKFLOW_HARNESS_IDS]).toEqual([
      "pi",
      "claude-code",
      "codex",
      "opencode",
      "copilot",
      "deepseek",
      "grok-cli",
      "oh-my-pi",
    ]);
    expect(WORKFLOW_HARNESS_REGISTRY.map((definition) => definition.id))
      .toEqual([...WORKFLOW_HARNESS_IDS]);
    for (const id of WORKFLOW_HARNESS_IDS) {
      const definition = workflowHarnessDefinition(id);
      expect(definition.label.length).toBeGreaterThan(0);
      expect(definition.summary.length).toBeGreaterThan(0);
      expect(definition.executables.length).toBeGreaterThan(0);
    }
  });

  it("is the source the frozen TypeBox union agrees with", () => {
    for (const id of WORKFLOW_HARNESS_IDS) {
      expect(Value.Check(NodeSpecV1Schema, { harness: id })).toBe(true);
      expect(Value.Check(WorkflowSettingsV1Schema, { defaultHarness: id })).toBe(true);
    }
    expect(Value.Check(NodeSpecV1Schema, { harness: "gpt-cli" })).toBe(false);
    expect(Value.Check(WorkflowSettingsV1Schema, { defaultHarness: "gpt-cli" }))
      .toBe(false);
  });

  /**
   * The fifth spelling. `prompt-opt-schema.ts` carried its own five-literal
   * harness union, so a prompt-optimization node declaring `deepseek`,
   * `grok-cli` or `oh-my-pi` was rejected at schema validation while every
   * other node kind accepted it — and no gate caught it: `freeze-check.py`
   * reads only `schema.ts`, and the parity case above pins only
   * `NodeSpecV1Schema` / `WorkflowSettingsV1Schema`. It is a derivation now
   * (`harness-schema.ts`), and this is the pin that keeps it one.
   */
  it("is the source the prompt-optimization node's own union agrees with", () => {
    for (const id of WORKFLOW_HARNESS_IDS) {
      expect(
        Value.Check(PromptOptimizationNodeSchema, promptOptimizationNode(id)),
        `prompt-optimization node rejected harness "${id}"`,
      ).toBe(true);
    }
    expect(Value.Check(PromptOptimizationNodeSchema, promptOptimizationNode("gpt-cli")))
      .toBe(false);
  });

  it("recognises its own ids and nothing else", () => {
    expect(isWorkflowHarnessId("grok-cli")).toBe(true);
    expect(isWorkflowHarnessId("deepseek")).toBe(true);
    expect(isWorkflowHarnessId("oh-my-pi")).toBe(true);
    expect(isWorkflowHarnessId("gpt-cli")).toBe(false);
    expect(isWorkflowHarnessId(7)).toBe(false);
  });

  it("selects the pi adapter without probing PATH for it", () => {
    let probes = 0;
    const selection = selectWorkflowHarnessAdapter("pi", {
      findExecutable: () => {
        probes += 1;
        return null;
      },
    });
    expect(selection.adapter).toBe("pi-delegation");
    expect(probes).toBe(0);
  });

  it("selects the claude-code relay when its binary resolves", () => {
    const selection = selectWorkflowHarnessAdapter("claude-code", {
      findExecutable: NEVER_INSTALLED,
      resolveManagedExecutable: (definition) => definition.executables[0],
    });
    expect(selection).toEqual({
      harness: "claude-code",
      label: "Claude Code CLI",
      adapter: "claude-code-relay",
      executable: "claude",
    });
  });

  it.each(["deepseek", "grok-cli", "oh-my-pi"] as const)(
    "fails %s closed as NOT_INSTALLED when no candidate is on PATH",
    (harness: WorkflowHarnessId) => {
      let thrown: unknown;
      try {
        selectWorkflowHarnessAdapter(harness, { findExecutable: NEVER_INSTALLED });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(WorkflowHarnessDispatchError);
      const dispatchError = thrown as WorkflowHarnessDispatchError;
      expect(dispatchError.code).toBe("WORKFLOW_HARNESS_NOT_INSTALLED");
      expect(dispatchError.harness).toBe(harness);
      // Names the next action, with the candidate commands.
      expect(dispatchError.message).toContain("Install one of");
      for (const command of workflowHarnessExecutables(harness)) {
        expect(dispatchError.message).toContain(command);
      }
      // #71: no absolute path in the diagnostic.
      expect(dispatchError.message).not.toMatch(/(?:^|\s)\/[^\s]/);
    },
  );

  it.each(["deepseek", "grok-cli", "oh-my-pi", "codex", "opencode", "copilot"] as const)(
    "fails %s closed as NOT_BOUND when installed but adapterless, without leaking its path",
    (harness: WorkflowHarnessId) => {
      let thrown: unknown;
      try {
        selectWorkflowHarnessAdapter(harness, { findExecutable: ALWAYS_INSTALLED });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(WorkflowHarnessDispatchError);
      const dispatchError = thrown as WorkflowHarnessDispatchError;
      expect(dispatchError.code).toBe("WORKFLOW_HARNESS_NOT_BOUND");
      expect(dispatchError.harness).toBe(harness);
      // The message says *that* it resolved; the path it resolved to is the
      // exact class of string #71 found leaking out of 500/502 bodies.
      expect(dispatchError.message).not.toContain("/opt/kady/bin");
      expect(dispatchError.message).toContain("no trusted delegation adapter");
      expect(dispatchError.message).toContain("keep the node on pi");
    },
  );
});
