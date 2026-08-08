import type { ComponentProps } from "react";

import { ScientificDagStudioSection } from "./scientific-dag-studio-section";

const SWATCHES = [
  ["Canvas", "#090b0d", "var(--studio-canvas)"],
  ["Surface", "#0c0f12", "var(--studio-surface)"],
  ["Line", "#1c2126", "var(--studio-line)"],
  ["Text", "#eef2f4", "var(--studio-text)"],
  ["Cyan", "#2fd4ec", "var(--studio-accent)"],
  ["Blue", "#1f7fd1", "var(--studio-blue)"],
  ["Highlight", "#ffe14d", "var(--studio-highlight)"],
] as const;

export function PaletteSection(props: ComponentProps<"section">) {
  return (
    <ScientificDagStudioSection
      eyebrow="02 / Brand system"
      title="Palette"
      {...props}
    >
      <div className="scientific-dag-studio-swatch-grid">
        {SWATCHES.map(([name, hex, color]) => (
          <div className="scientific-dag-studio-swatch" key={name}>
            <span aria-hidden="true" style={{ backgroundColor: color }} />
            <strong>{name}</strong>
            <code>{hex}</code>
          </div>
        ))}
      </div>
    </ScientificDagStudioSection>
  );
}
