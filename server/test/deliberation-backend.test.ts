// danbot-byok — deliberation-backend.test.ts
//
// Proves per-agent deliberation-backend selection (checklist 95 + 77): the
// `deliberationBackend` field round-trips through the agent .md frontmatter, and the
// writer derives the effective model/tools so pi-subagents (which doesn't know the
// field) still enacts the choice — fusion-direct pins Fusion, council-tool adds the
// `council` tool.

import { describe, it, expect } from "vitest";
import {
  applyDeliberationBackend,
  parseAgentMarkdown,
  serializeAgentMarkdown,
  type AgentFilePatch,
} from "../src/agent/agent-files.ts";

const base = (over: Partial<AgentFilePatch>): AgentFilePatch => ({
  description: "d",
  systemPrompt: "p",
  ...over,
});

describe("deliberation backend", () => {
  it("round-trips through parse/serialize (item 95)", () => {
    const md = serializeAgentMarkdown({
      name: "x",
      ...base({ deliberationBackend: "council-tool" }),
    });
    expect(md).toContain("deliberationBackend: council-tool");
    expect(parseAgentMarkdown(md, "x", "project").deliberationBackend).toBe("council-tool");
  });

  it("fusion-direct pins the Fusion model", () => {
    const out = applyDeliberationBackend(
      base({ model: "anthropic/claude-opus-4.7", deliberationBackend: "fusion-direct" }),
    );
    expect(out.model).toBe("openrouter/openrouter/fusion");
  });

  it("council-tool adds the council tool to the allowlist (item 77)", () => {
    const out = applyDeliberationBackend(
      base({ tools: "read, bash", deliberationBackend: "council-tool" }),
    );
    expect(out.tools).toContain("council");
    expect(out.tools).toContain("read");
  });

  it("council-tool does not duplicate an already-present council tool", () => {
    const out = applyDeliberationBackend(
      base({ tools: "read, council", deliberationBackend: "council-tool" }),
    );
    expect((out.tools?.match(/council/g) ?? []).length).toBe(1);
  });

  it("none leaves model/tools untouched", () => {
    const patch = base({ model: "m", tools: "read", deliberationBackend: "none" });
    expect(applyDeliberationBackend(patch)).toEqual(patch);
  });

  it("an unknown frontmatter value parses to undefined", () => {
    const parsed = parseAgentMarkdown(
      "---\nname: x\ndeliberationBackend: bogus\n---\nbody",
      "x",
      "project",
    );
    expect(parsed.deliberationBackend).toBeUndefined();
  });
});
