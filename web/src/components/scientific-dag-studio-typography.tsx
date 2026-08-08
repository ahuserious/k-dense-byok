import type { ComponentProps } from "react";

import { ScientificDagStudioSection } from "./scientific-dag-studio-section";

export function TypographySection(props: ComponentProps<"section">) {
  return (
    <ScientificDagStudioSection
      eyebrow="01 / Type roles"
      title="Typography"
      {...props}
    >
      <div className="scientific-dag-studio-type-grid">
        <div className="scientific-dag-studio-type scientific-dag-studio-type--hero">
          <span>Display / --fhero</span>
          <strong>Scientific Pipelines</strong>
        </div>
        <div className="scientific-dag-studio-type scientific-dag-studio-type--nav">
          <span>Navigation / --fnav</span>
          <strong>Designer · Runs · Evidence</strong>
        </div>
        <div className="scientific-dag-studio-type scientific-dag-studio-type--cta">
          <span>CTA + code / --fcta</span>
          <strong>RUN_VALIDATED_GRAPH()</strong>
        </div>
        <div className="scientific-dag-studio-type scientific-dag-studio-type--figure">
          <span>Figures / --ffig</span>
          <strong>Figure 1. Adaptive workflow topology</strong>
        </div>
        <div className="scientific-dag-studio-type scientific-dag-studio-type--annotation">
          <span>Annotations / --fann</span>
          <strong>n = 24 · confidence 0.94</strong>
        </div>
      </div>
    </ScientificDagStudioSection>
  );
}
