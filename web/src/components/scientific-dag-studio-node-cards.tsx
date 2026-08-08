import type { ComponentProps } from "react";

import { ScientificDagStudioSection } from "./scientific-dag-studio-section";

export function NodeCardsSection(props: ComponentProps<"section">) {
  return (
    <ScientificDagStudioSection
      eyebrow="03 / Workflow objects"
      title="Node cards"
      {...props}
    >
      <div className="scientific-dag-studio-node-grid">
        <article className="scientific-dag-studio-node-card scientific-dag-studio-node-card--active">
          <header>
            <span>MODEL</span>
            <strong>Literature synthesis</strong>
          </header>
          <p>Collects evidence, resolves conflicts, and emits a cited brief.</p>
          <footer>
            <span className="scientific-dag-studio-chip">RUNNING</span>
            <code>openai-codex/gpt-5.4</code>
          </footer>
        </article>
        <article className="scientific-dag-studio-node-card">
          <header>
            <span>COMPUTE</span>
            <strong>Differential analysis</strong>
          </header>
          <p>Executes the pinned environment after evidence-gate approval.</p>
          <footer>
            <span className="scientific-dag-studio-chip scientific-dag-studio-chip--muted">
              QUEUED
            </span>
            <code>modal / L4</code>
          </footer>
        </article>
      </div>
    </ScientificDagStudioSection>
  );
}
