import { describe, expect, it } from "vitest";
import { validateFormattedOutput } from "../src/workflows/formatted-output.ts";

describe("formatted-output style validation", () => {
  it("accepts only output that satisfies the authored style", () => {
    expect(validateFormattedOutput("json", "{\"ok\":true}").ok).toBe(true);
    expect(validateFormattedOutput("json", "not json").ok).toBe(false);
    expect(validateFormattedOutput("markdown", "# Title\nBody").ok).toBe(true);
    expect(validateFormattedOutput("markdown", "no heading").ok).toBe(false);
    expect(validateFormattedOutput("methods", "## Methods\nWe measured X.").ok).toBe(true);
    expect(validateFormattedOutput("methods", "## Results\nWe measured X.").ok).toBe(false);
    expect(validateFormattedOutput("latex", "\\section{Methods}").ok).toBe(true);
    expect(validateFormattedOutput("latex", "plain text").ok).toBe(false);
  });
});
