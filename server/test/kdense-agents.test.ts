// danbot-byok — kdense-agents.test.ts
// Proves the K-Dense persona agents (checklist 98): both ship, round-trip cleanly through
// the agent .md format, carry usable tool allowlists, and read as the intended personas.

import { describe, it, expect } from "vitest";
import { KDENSE_AGENTS } from "../src/agent/kdense-agents.ts";
import { parseAgentMarkdown, serializeAgentMarkdown } from "../src/agent/agent-files.ts";

describe("K-Dense persona agents", () => {
  it("ships exactly karpathy + data-scientist + background-rescue", () => {
    expect(KDENSE_AGENTS.map((a) => a.name).sort()).toEqual([
      "background-rescue",
      "data-scientist",
      "karpathy",
    ]);
  });

  for (const agent of KDENSE_AGENTS) {
    it(`${agent.name} round-trips through the agent .md format with tools`, () => {
      const parsed = parseAgentMarkdown(serializeAgentMarkdown(agent), agent.name, "project");
      expect(parsed.name).toBe(agent.name);
      expect(parsed.source).toBe("project"); // editable, not a read-only builtin
      // Every persona ships a usable tool allowlist that survives the round-trip;
      // `read` is the common denominator (background-rescue is read-only by design).
      expect(parsed.tools).toContain("read");
      expect(parsed.systemPrompt.length).toBeGreaterThan(100);
    });
  }

  it("karpathy reads as an agentic ML engineer", () => {
    const karpathy = KDENSE_AGENTS.find((a) => a.name === "karpathy")!;
    expect(karpathy.systemPrompt).toMatch(/Karpathy/);
    expect(karpathy.systemPrompt.toLowerCase()).toMatch(/machine learning/);
  });

  it("data-scientist follows plan -> code -> review -> reflect -> summarize", () => {
    const ds = KDENSE_AGENTS.find((a) => a.name === "data-scientist")!;
    for (const stage of ["PLAN", "CODE", "REVIEW", "REFLECT", "SUMMARIZE"]) {
      expect(ds.systemPrompt).toContain(stage);
    }
  });
});
