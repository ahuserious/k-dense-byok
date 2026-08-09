# S6 prompt-optimization merge seam

Apply these lines only after S6 and S5 are present in the integration worktree.
The S6 test imports remain direct and do not depend on these edits.

## A. Typed schema union

- `server/src/workflows/schema.ts` — anchor: immediately after `import { Type, type Static } from "typebox";`
  - `import { PromptOptimizationNodeSchema } from "./prompt-opt-schema.ts";`
- `server/src/workflows/schema.ts` — anchor: inside `export const WorkflowNodeSchema = Type.Union([`, immediately after `FusionNodeSchema,`
  - `  PromptOptimizationNodeSchema,`

## B. Semantic validation dispatch

- `server/src/workflows/validate.ts` — anchor: with the other workflow imports at the top of the file
  - `import { promptOptimizationNodeDemand, validatePromptOptimizationNode } from "./prompt-opt-node.ts";`
- `server/src/workflows/validate.ts` — anchor: inside `validateNode(...)`'s `switch (node.kind)`, immediately before `case "best-of-n":`
  - `    case "prompt-optimization": validatePromptOptimizationNode(node, nodePath, document, issues); break;`
- `server/src/workflows/validate.ts` — anchor: inside `deriveWorkflowNodeDemand(...)`'s `switch (node.kind)`, immediately before `case "best-of-n":`
  - `    case "prompt-optimization": ({ minimumModelCalls, maximumModelCalls, maximumIterations, preferredParallelism } = promptOptimizationNodeDemand(node)); break;`
- `server/src/workflows/validate.ts` — anchor: inside `nodeHasModelOrEvidenceEvaluatorSlot(...)`'s `switch (node.kind)`, immediately before `case "best-of-n":`
  - `    case "prompt-optimization": return true;`

## C. Executor registration

- `server/src/workflows/service.ts` — anchor: with the workflow executor imports
  - `import { withPromptOptimizationNodeExecutor } from "./prompt-opt-node.ts";`
- `server/src/workflows/service.ts` — anchor: replace the existing single line `const nodeExecutorFactory = options.nodeExecutorFactory ?? createKadyWorkflowNodeExecutor;`
  - `  const nodeExecutorFactory = options.nodeExecutorFactory ?? ((executorOptions) => withPromptOptimizationNodeExecutor(createKadyWorkflowNodeExecutor(executorOptions)));`
- `server/src/workflows/run-state.ts` — anchor: inside `workflowModelCallSlotsForNode(...)`'s `switch (node.kind)`, immediately before `case "best-of-n":`
  - `    case "prompt-optimization": return [];`

The wrapper delegates every synthetic council/fusion iteration to the existing
`WorkflowNodeExecutor`; it does not implement a second provider runtime. The
outer prompt node has no direct provider slot: each checksummed iteration runs
as a normal synthetic council/fusion execution with its own resolved slots.

## D. NodeSpec v1 enforcement-table additions

- `docs/contracts/NODESPEC-V1.md` — anchor: enforcement table, immediately after the `reasoningEffort` row
  - `| Prompt optimization node \`interviewUser\` | BOUND — INTERVIEW-USER pauses before deliberation, uses the originating main-session structured interview, and folds answers into every iteration |`
- `docs/contracts/NODESPEC-V1.md` — anchor: immediately after the preceding S6 row
  - `| Prompt optimization node \`fusionDeliberation.enabled\` | BOUND — false dispatches typed council deliberation; true requires and dispatches the typed Fusion configuration |`
- `docs/contracts/NODESPEC-V1.md` — anchor: immediately after the preceding S6 row
  - `| Prompt optimization artifact v1 | BOUND — runtime-owned JSON records original prompt, iterations, winning prompt, and rationale; node_succeeded output surfaces its checksummed reference |`

No pre-existing `FAIL-CLOSED(S6)` row exists at contract freeze `03f9eb3`, so
the merge adds these BOUND rows and flips no existing row.
