# S10 template-precondition integration

S10 owns the prompt-analysis template metadata and the pure admission validator.
The merge orchestrator owns the runtime schema and API seams below. Do not copy
the validation logic into the server: import
`validateScientificWorkflowTemplatePreconditions` from
`web/src/data/dag-workflow-templates/types.ts` so client and server decisions
remain identical.

Merge-time edit anchors:

- Schema — `server/src/workflows/schema.ts`: in `WorkflowGraphDocumentSchema`, immediately after `artifacts`, add `preconditions: Type.Optional(ScientificWorkflowPreconditionsSchema)`.
- Admission — `server/src/api/dag-workflows.ts`: in `POST /dag-workflows/:workflowId/runs`, validate persisted preconditions immediately before `const manifest = workflowStore.createRun(currentProjectId(), {`.
- Typed-run UI — `web/src/components/dag-workflows-panel.tsx`: immediately before `aria-label="Typed workflow run goal"`, render required variables/files and validate them before launch.

## 1. Persist one graph field

**Anchored edit:** in `server/src/workflows/schema.ts`, inside
`WorkflowGraphDocumentSchema` immediately after its `artifacts` property, add
exactly one graph-schema field:

```ts
preconditions: Type.Optional(ScientificWorkflowPreconditionsSchema),
```

The nested value is:

```ts
{
  requiredInputs: Array<{ key: string; label: string }>;
  requiredFiles: Array<{ key: string; label: string; minimumCount: number }>;
  requiredCapabilities: Array<"prompt-analysis" | "read-uploaded-files">;
}
```

Use bounded non-empty strings, unique `key` values, `minimumCount >= 1`, and
`additionalProperties: false`. Mirror the optional `preconditions` property on
the web `WorkflowGraphDocument` type. After both schemas accept the field,
`createDagWorkflowTemplateGraph` must copy the three arrays from its matched
`SCIENTIFIC_WORKFLOW_TEMPLATES` entry into `graph.preconditions`. The three
legacy/native templates have no persisted preconditions until separately
migrated.

## 2. Reject before `createRun`

**Anchored edit:** in `server/src/api/dag-workflows.ts`, inside
`POST /dag-workflows/:workflowId/runs`, insert the admission check immediately
before `const manifest = workflowStore.createRun(currentProjectId(), {`:

1. Read the saved definition with `workflowStore.readDefinition(projectId,
   workflowId)` and use `definition.graph.preconditions` when present.
2. Enumerate regular files below `resolvePaths(projectId).uploadDir`
   (`sandbox/user_data`) without following symlinks. These are the
   tool-observed readable upload references supplied as `files`; never accept a
   model-authored filename or source-count claim as an upload receipt.
3. Call the S10 export exactly as follows:

```ts
const issues = validateScientificWorkflowTemplatePreconditions(
  definition.graph.preconditions,
  {
    goal: body.input?.goal,
    variables: body.input?.variables,
    files: observedUploadPaths,
    capabilities: ["prompt-analysis", "read-uploaded-files"],
  },
);
```

4. If `issues.length > 0`, return HTTP `422` with
   `code: "WORKFLOW_PRECONDITION_FAILED"`, a bounded `detail`, and the structured
   `issues`. Do not call `workflowStore.createRun`, reserve budget, append run
   files, or start the controller on this path.

This ordering is the admission contract: empty goals, absent required uploads,
and missing required variables fail before any run state exists.

## 3. Render required inputs in the typed-run panel

**Anchored edit:** in `web/src/components/dag-workflows-panel.tsx`, immediately
before the control with `aria-label="Typed workflow run goal"`, render the
selected definition's `graph.preconditions.requiredInputs` and
`graph.preconditions.requiredFiles`, collect required variables into
`input.variables`, and block submission with the shared validator when any
displayed requirement is absent.

## 4. Post-integration tests

`server/test/dag-workflow-templates.test.ts` contains the skipped suite
`POST-INTEGRATION(S10)`. At merge,
the cases are already wired through Fastify `app.inject`; remove only the
suite's `.skip` after the graph field and route check land. They assert HTTP
`422`, `WORKFLOW_PRECONDITION_FAILED`, and that no run was created. Keep the
Tier A metadata/client tests enabled throughout.
