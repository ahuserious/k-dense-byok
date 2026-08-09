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
- `server/src/workflows/runner.ts` — anchor: inside the object passed to `executeNode(...)`, immediately before the exact line `        signal,`
  - `        ...(node.kind === "prompt-optimization" ? { writeDurableEvent: ({ eventId, ...event }: WorkflowRunEventInput) => { writer.append("prompt-optimization-event", [node.id, attempt, eventId], event); } } : {}),`

The wrapper delegates every synthetic council/fusion iteration to the existing
`WorkflowNodeExecutor`; it does not implement a second provider runtime. The
outer prompt node has no direct provider slot: each checksummed iteration runs
as a normal synthetic council/fusion execution with its own resolved slots. The
wrapper fails before node work unless the runner injects the durable event writer
above; waiting/resumed events therefore share the runner lease and event sequence.

## D. Durable interview API and console surface

- `server/src/index.ts` — anchor: with the other route-module imports
  - `import { registerPromptOptimizationInterviewRoutes } from "./workflows/prompt-opt-interview-api.ts";`
- `server/src/index.ts` — anchor: immediately before the exact line `  await registerPipelineRoutes(app);`
  - `  await registerPromptOptimizationInterviewRoutes(app);`
- `web/src/components/dag-workflow-console.tsx` — anchor: immediately after the `HelperAgentChat` import
  - `import { PromptOptimizationConsoleSurface } from "@/components/prompt-opt-console";`
- `web/src/components/dag-workflow-console.tsx` — anchor: immediately after `<RunDiagnostics diagnostics={diagnostics} />`
  - `              <PromptOptimizationConsoleSurface projectId={projectId} runId={selectedRun.manifest.id} nodes={selectedRun.manifest.graph.nodes} runStatus={selectedRun.state.status} />`

## E. NodeSpec v1 enforcement-table additions

- `docs/contracts/NODESPEC-V1.md` — anchor: enforcement table, immediately after the `reasoningEffort` row
  - `| Prompt optimization node \`interviewUser\` | BOUND — attempt-aware run+node state hashes the question set, reuses matching answered state across retries, durably writes valid run_waiting/run_resumed transitions, and folds answers into every iteration |`
- `docs/contracts/NODESPEC-V1.md` — anchor: immediately after the preceding S6 row
  - `| Prompt optimization node \`fusionDeliberation.enabled\` | BOUND — false dispatches typed council deliberation; true requires and dispatches the typed Fusion configuration |`
- `docs/contracts/NODESPEC-V1.md` — anchor: immediately after the preceding S6 row
  - `| Prompt optimization cumulative envelope | BOUND — one deadline, token cap, and cost cap spans interview plus every iteration; each synthetic deliberation receives only its remaining bounded share and inherits resolved NodeSpec/rescue/evidence policy |`
- `docs/contracts/NODESPEC-V1.md` — anchor: immediately after the preceding S6 row
  - `| Prompt optimization evidence policy | FAIL-CLOSED(S6) — node overrides or enabled workflow evidence are rejected before provider calls pending full evaluator support |`
- `docs/contracts/NODESPEC-V1.md` — anchor: immediately after the preceding S6 row
  - `| Prompt optimization \`artifactId\` / artifact v1 | BOUND — the host atomically writes the exact graph-declared owned path and returns a checksummed runner-normalized receipt containing original prompt, iterations, winner, rationale, and cumulative usage |`

No pre-existing `FAIL-CLOSED(S6)` row exists at contract freeze `03f9eb3`; the
merge adds the BOUND rows above plus the explicit evidence-policy fail-closed row.
