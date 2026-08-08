import { describe, expect, it } from "vitest";

import {
  isScientificDagStudioEnabled,
  STUDIO_CSS_VARIABLES,
} from "./studio-design-tokens";

describe("studio design tokens", () => {
  it("keeps the studio disabled unless it is explicitly enabled", () => {
    expect(isScientificDagStudioEnabled(undefined)).toBe(false);
    expect(isScientificDagStudioEnabled("0")).toBe(false);
    expect(isScientificDagStudioEnabled("false")).toBe(false);
    expect(isScientificDagStudioEnabled("1")).toBe(true);
    expect(isScientificDagStudioEnabled("TRUE")).toBe(true);
  });

  it("snapshots the role and palette contract", () => {
    expect(STUDIO_CSS_VARIABLES).toMatchInlineSnapshot(`
      {
        "--fann": "'Terminess Nerd Font', 'Space Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
        "--fcta": "'FiraCode Nerd Font', 'Space Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
        "--ffig": "'Tinos Nerd Font', Tinos, Georgia, 'Times New Roman', ui-serif, serif",
        "--fhero": "'0xProto Nerd Font', Inter, ui-sans-serif, system-ui, -apple-system, sans-serif",
        "--fnav": "Inter, ui-sans-serif, system-ui, -apple-system, sans-serif",
        "--studio-accent": "#2fd4ec",
        "--studio-accent-bright": "#8af0fb",
        "--studio-accent-deep": "#1595b8",
        "--studio-backdrop": "#050607",
        "--studio-blue": "#1f7fd1",
        "--studio-blue-bright": "#7fc4f0",
        "--studio-canvas": "#090b0d",
        "--studio-font-code": "'FiraCode Nerd Font', 'Space Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
        "--studio-highlight": "#ffe14d",
        "--studio-line": "#1c2126",
        "--studio-line-strong": "#2a3138",
        "--studio-surface": "#0c0f12",
        "--studio-text": "#eef2f4",
        "--studio-text-dim": "#7f8e96",
        "--studio-text-faint": "#46525a",
        "--studio-text-muted": "#aebcc3",
      }
    `);
  });
});
