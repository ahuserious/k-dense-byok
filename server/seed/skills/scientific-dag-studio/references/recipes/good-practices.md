# Good practices, anti-patterns, and what goes wrong

Adapted from the upstream pipeline-authoring reference, filtered to what is true
in this app and re-checked against both schemas. Practices that only made sense
with the upstream CLI, its config file, or its chat adapters are gone.

## Good practices

### 1. Deterministic work gets a deterministic node

If the step is "run the test suite", "count the rows", "check the file exists",
do not ask a model to do it. In the vendored dialect that is a `bash:` or
`script:` node. The typed runtime has neither, so in a typed pipeline the
honest move is to make the model *run* the command and report the exact output,
and to say in the prompt that a summary is not acceptable.

### 2. A downstream condition needs structured output upstream

In the vendored dialect, any node whose output a later `when:` reads must
declare `output_format:`. Reading a field is stable; pattern-matching prose is
not. The typed runtime has no `when:` on edges and no `output_format`; it routes
on `success` / `failure` / `evidence-supported`, which is coarser and much
harder to get subtly wrong.

### 3. After a conditional branch, use `none_failed_min_one_success`

The default `all_success` treats a skipped parent as not-succeeded, so a join
after a branch never fires. This is the single most common "my pipeline hangs
after the branch" cause. (Vendored dialect only.)

### 4. If the steps do not share context, they must share artifacts

A fresh-context step remembers nothing. Every fact it needs has to be either in
its prompt or in a file it can read. In the typed runtime *every* node is its own
execution, so this is not an option you turn on — it is always true. Design the
artifact chain before you write the first prompt.

### 5. Cheap models for glue, strong models for substance

Verification, scribe and formatting steps do not need the strongest model. The
planning and synthesis steps do. In the typed runtime this is a per-node `model`
(or `settings.model`) against the document's `defaultModel`.

### 6. Write the description for a stranger

The pipeline `description` is what a researcher reads in the registry to decide
whether this is the workflow they want. Write what it does and what it needs,
not what it is called.

### 7. Validate before you hand it over

Emit the document, then validate it, then show the researcher the result. For a
typed document that is `POST /dag-workflows/validate`; a save through
`PUT /dag-workflows/:id` validates again and refuses an invalid document, so an
unvalidated hand-off just moves the failure later.

### 8. Say what the pipeline cannot do

If the researcher asked for a human approval gate and you are emitting a typed
pipeline, the pipeline does not have one. Say so in the same breath as you hand
it over, and put it in the `description` so the next person sees it too.

## Anti-patterns

**Asking a model to run a deterministic check.** "Tell me whether the tests
pass" invites a plausible answer. "Run `npm test`, paste the last 20 lines, and
report the exit code" does not.

**Pattern-matching free-form output in a condition.** `when: "review.output
contains 'looks good'"` fails the first time the model phrases it differently.

**A step that assumes the previous step's memory in a fresh-context chain.**
It will read as if it worked, because the model will invent the missing context.

**Long flat layers of model nodes.** Ten sequential prompt nodes with no
deterministic checkpoint is ten chances to drift with no place to catch it. Put
a verification pass after each substantive phase — that is what the seeded
`composed-research-pipeline` does.

**Secrets in the document.** A workflow document is stored, listed over HTTP,
and hashed into `graphSha256`. Nothing secret goes in a prompt, a `bash:` body,
or an MCP config path.

**`retry:` on a loop node.** Hard error in the vendored engine.

**A `max_iterations` of 2 on an open-ended loop.** It will stop halfway and
report success.

**An approval node without `interactive: true` at the workflow level.** The gate
never surfaces; the run sits there.

**`maxCostUsd: 0` on a pipeline you meant to run.** Every cap-counted model call
is refused *before dispatch* with "requires a positive pre-dispatch cost
envelope". This is the state every legacy-imported pipeline lands in on purpose.
If you want it runnable, set a real cap and say what you set.

**`maxSubagents: 0` with an agent node.** Validation error: an agent node needs
an execution slot. Note this is separate from whether it may *spawn* subagents,
which is `settings.autonomy: loose`.

## When a run does not do what the document says

1. **Read the run's event stream before anything else.** The typed runtime is
   event-sourced: `run_queued`, `run_started`, `node_started`,
   `model_call_declared`, `model_resolved`, `node_succeeded` / `node_failed`,
   `run_succeeded` / `run_failed`. The first *unexpected* event is the failure;
   everything after it is cascade.
2. **Check the model-resolution receipt**, not the document. The receipt records
   what was actually resolved and whether a fallback was used. A pipeline that
   "ignored the model I set" has usually resolved a fallback.
3. **Check the budget.** A refusal before dispatch looks like a node that never
   ran, because it never did.
4. **Check `settings.skills.mode`.** `manual` gives the node the listed skills
   and nothing else — including none of the project's installed skills.
5. For a stuck or failed run, `references/rescue-playbook.md` is the procedure.
   Read it rather than improvising; it is written against this runtime's actual
   states.
