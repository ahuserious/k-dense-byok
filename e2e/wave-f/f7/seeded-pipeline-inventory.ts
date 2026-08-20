/**
 * The seeded pipelines, declared once.
 *
 * Playwright cannot import `server/src/workflows/seed-pipelines.ts` without
 * pulling the whole server dependency graph into the browser-test process, so
 * this module declares what the seeds are and
 * `server/test/seed-pipelines.test.ts` pins every field of it against what the
 * real loader actually produces. If a seed changes and this file does not, the
 * server suite fails — the e2e fixture cannot silently drift from the product.
 */

export interface SeededPipeline {
  /** Workflow id, which is also the seed file name without its extension. */
  readonly id: string;
  /** Display name, as it appears in the Scientific Pipelines registry. */
  readonly name: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
  /** The id of the node the run starts at. */
  readonly entryNodeId: string;
  /** A phrase from the stored description a user can read in the UI. */
  readonly descriptionPhrase: string;
  /**
   * Node ids in the order the durable runner executes them, for the pipelines
   * the server suite runs end to end. `null` where the pipeline is not run.
   */
  readonly executionOrder: readonly string[] | null;
}

export const SEEDED_PIPELINES: readonly SeededPipeline[] = [
  {
    id: "composed-research-pipeline",
    name: "Composed Research Pipeline",
    nodeCount: 24,
    edgeCount: 23,
    entryNodeId: "plan",
    descriptionPhrase: "three independent adversarial verification passes",
    executionOrder: null,
  },
  {
    id: "data-scientist",
    name: "Data Scientist",
    nodeCount: 5,
    edgeCount: 4,
    entryNodeId: "plan",
    descriptionPhrase: "This runtime has no human approval gate",
    executionOrder: ["plan", "code", "review", "reflect", "summarize"],
  },
  {
    id: "research-starter",
    name: "Research Starter",
    nodeCount: 3,
    edgeCount: 2,
    entryNodeId: "scope",
    descriptionPhrase: "A gentle starting point for a new project",
    executionOrder: ["scope", "research", "writeup"],
  },
];

/** The two skills committed under `server/seed/skills`, both F7-relevant. */
export const COMMITTED_SKILLS = ["scientific-dag-studio", "scientific-pipelines"] as const;
