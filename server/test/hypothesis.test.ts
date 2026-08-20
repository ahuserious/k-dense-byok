import { describe, expect, it } from "vitest";
import { buildHypothesisPairs, hypothesisReportMarkdown } from "../src/workflows/hypothesis.ts";

describe("hypothesis pairs", () => {
  it("emits matched H1/H0 pairs and a terminal report artifact body", () => {
    const pairs = buildHypothesisPairs("Drug X lowers Y", 2);
    expect(pairs).toHaveLength(2);
    expect(pairs[0]?.h1).toContain("H1-1");
    expect(pairs[0]?.h0).toContain("H0-1");
    const report = hypothesisReportMarkdown(
      "Drug X lowers Y",
      pairs,
      ["H1 is better supported.", "H0 remains plausible."],
      "The first pair is supported; the second is not.",
    );
    expect(report).toContain("# Hypothesis analysis");
    expect(report).toContain("## Terminal analysis");
    expect(report).toContain("H1-1");
    expect(report).toContain("H0-2");
  });
});
