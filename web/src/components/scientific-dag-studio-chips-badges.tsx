import type { ComponentProps } from "react";

import { ScientificDagStudioSection } from "./scientific-dag-studio-section";

export function ChipsBadgesSection(props: ComponentProps<"section">) {
  return (
    <ScientificDagStudioSection
      eyebrow="04 / Compact status"
      title="Chips and badges"
      {...props}
    >
      <div className="scientific-dag-studio-chip-row">
        <span className="scientific-dag-studio-chip">VERIFIED</span>
        <span className="scientific-dag-studio-chip scientific-dag-studio-chip--blue">
          SUPERVISED
        </span>
        <span className="scientific-dag-studio-chip scientific-dag-studio-chip--highlight">
          REVIEW
        </span>
        <span className="scientific-dag-studio-chip scientific-dag-studio-chip--muted">
          DRAFT
        </span>
        <span className="scientific-dag-studio-badge">12 STEPS</span>
        <span className="scientific-dag-studio-badge">$0.84 COMMITTED</span>
      </div>
    </ScientificDagStudioSection>
  );
}
