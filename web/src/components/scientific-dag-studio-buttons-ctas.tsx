import type { ComponentProps } from "react";

import { ScientificDagStudioSection } from "./scientific-dag-studio-section";

export function ButtonsCtasSection(props: ComponentProps<"section">) {
  return (
    <ScientificDagStudioSection
      eyebrow="05 / Actions"
      title="Buttons and CTAs"
      {...props}
    >
      <div className="scientific-dag-studio-action-row">
        <button className="scientific-dag-studio-button" type="button">
          Run graph
        </button>
        <button
          className="scientific-dag-studio-button scientific-dag-studio-button--secondary"
          type="button"
        >
          Validate
        </button>
        <button
          className="scientific-dag-studio-button scientific-dag-studio-button--quiet"
          type="button"
        >
          Save draft
        </button>
        <button className="scientific-dag-studio-button" disabled type="button">
          Awaiting graph
        </button>
      </div>
    </ScientificDagStudioSection>
  );
}
