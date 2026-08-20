# F6 narrow follow-up — enable saved workflow references after F5

Status: prepared, deliberately not applied. Current integration `51f0b7d` has no
F5 palette interface and no `workflow-ref` node kind. The visible control stays
disabled with that exact reason.

Once F5 publishes `interfaces/F5-palette-mapping.md` and its schema/store code
lands, the F6 follow-up is confined to two existing F6 files:

1. `web/src/components/pipeline/saved-workflow-palette.tsx`
   - add `canAddReference`, `cannotAddReferenceReason`, and
     `onAddReference(workflowId)` props;
   - enable the existing **as reference** button only when
     `canAddReference === true`;
   - retain a visible reason whenever it is false.
2. `web/src/components/dag-builder-surface.tsx`
   - read the selected saved definition;
   - append exactly the F5-published node shape (expected from the approved
     request to be `{kind:"workflow-ref", workflowId, expectedRevision}`);
   - never flatten the source graph on this path; and
   - save through the existing conditional definition write.

The follow-up test is one live item: insert a reference, edit the referenced
workflow, create a run of the parent, and assert the run manifest expands the
new referenced revision (or refuses an `expectedRevision` mismatch). Merely
seeing the node in saved JSON is not Gate B.

No speculative property is added before F5. The server schema is closed, so a
guessed field would be rejected and a live-looking control would repeat the
accepted-then-discarded defect this wave exists to stop.
