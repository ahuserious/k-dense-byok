/**
 * The audited census of every React `key=` site in `web/src` that the
 * provenance classifier (`react-key-provenance.ts`) does not certify on its own.
 *
 * **Test tooling. Nothing in the application imports this module.**
 *
 * This is a **ratchet, not an exemption list**. Every entry here is a site that
 * unit B50 audited by hand for BF-47 and could not certify syntactically. The
 * classifier certifies 147 of the tree's 274 key sites without help; these are
 * the remaining 127, collapsed to 109 (file, expression) entries.
 *
 * Rules:
 *
 * - **Adding an entry is a regression.** A new key expression that the
 *   classifier cannot certify fails `react-key-provenance.repo.test.ts` until
 *   someone either mints the key through a `…Key()` / `…Identity()` helper,
 *   composes it with a position component, or writes the justification here —
 *   where a reviewer reads it in the diff. That is the whole point: BF-9 was
 *   invisible because nothing forced anyone to write down why a key was
 *   believed unique.
 * - **Removing one is the migration.** An entry whose site no longer exists
 *   fails the guard as stale and must be deleted, so the list shrinks.
 * - **`bucket: "provably-non-unique"` always fails.** It records a key that was
 *   demonstrated to collide; it exists so a regression to a known-bad key is
 *   caught rather than silently re-baselined. B50 left none behind.
 *
 * Bucket meanings (B50's audit, `fix-c1.md`):
 *
 * - `sound` — a uniqueness guarantee was found and cited.
 * - `index-keyed` — a bare loop index: stable per position, wrong under
 *   reordering, insertion in the middle, and deletion.
 * - `undetermined` — uniqueness could not be established either way. This is an
 *   honest bucket (54 of 274 sites); it is not a claim that
 *   the key is broken, and it is not a claim that it is fine.
 * - `provably-non-unique` — a duplicate was reproduced with React's own error.
 */

export type KeyProvenanceBucket =
  | "sound"
  | "index-keyed"
  | "undetermined"
  | "provably-non-unique";

export interface KeyProvenanceBaselineEntry {
  /** Path relative to `web/src`, POSIX separators. */
  readonly file: string;
  /** The key expression's source text, whitespace-collapsed. */
  readonly expression: string;
  /** How many sites in that file carry this exact expression. */
  readonly sites: number;
  readonly bucket: KeyProvenanceBucket;
  /** Why the audit placed it in that bucket. A citation, not a feeling. */
  readonly why: string;
}

export const REACT_KEY_PROVENANCE_BASELINE_V1: readonly KeyProvenanceBaselineEntry[] = [
  {
    file: "components/ai-elements/speech-input.tsx",
    expression: "index",
    sites: 1,
    bucket: "index-keyed",
    why:
      "Bare loop index over a fixed-length literal source; the list cannot reorder, grow in "
      + "the middle, or be filtered.",
  },
  {
    file: "components/chat-tab.tsx",
    expression: "i",
    sites: 1,
    bucket: "index-keyed",
    why:
      "Bare loop index. Whether this list can reorder / grow in the middle / be filtered "
      + "was NOT VERIFIED per site.",
  },
  {
    file: "components/chat-tab.tsx",
    expression: "path",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (bare identifier `path` — neither a minted key nor an "
      + "instance id) and no duplicate could be demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/compute-selector.tsx",
    expression: "count",
    sites: 1,
    bucket: "sound",
    why:
      "S-GEN: source is generated (Array.from({length: N}, (_, index) => index + 1)) — "
      + "values distinct by construction.",
  },
  {
    file: "components/connectors-panel.tsx",
    expression: "name",
    sites: 2,
    bucket: "undetermined",
    why:
      "Not certified by the guard (bare identifier `name` — neither a minted key nor an "
      + "instance id) and no duplicate could be demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/connectors-panel.tsx",
    expression: "opt.value",
    sites: 1,
    bucket: "sound",
    why:
      "S-LIT: source is a static in-repo literal (inline `as const` tuple, values "
      + "\"http\"/\"stdio\"); its projected key values were read and are pairwise distinct.",
  },
  {
    file: "components/console/live-graph-console.tsx",
    expression: "notice",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (bare identifier `notice` — neither a minted key nor an "
      + "instance id) and no duplicate could be demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/console/live-source-rail.tsx",
    expression: "notice",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (bare identifier `notice` — neither a minted key nor an "
      + "instance id) and no duplicate could be demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/console/live-source-rail.tsx",
    expression: "origin",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (bare identifier `origin` — neither a minted key nor an "
      + "instance id) and no duplicate could be demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/console/schedules/schedules-panel.tsx",
    expression: "fire.fire_id",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (property `.fire_id` is a descriptive field, not an "
      + "identity — a name, label, path, type or category can repeat (BF-9's class)) and no "
      + "duplicate could be demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/context-chips.tsx",
    expression: "`file:${path}`",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (composite whose component `path` is not certified: bare "
      + "identifier `path` — neither a minted key nor an instance id) and no duplicate could "
      + "be demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/dag-builder-surface.tsx",
    expression: "`${loadedIdentity ?? \"draft\"}:${selectedEvidenceGateNode.id}`",
    sites: 1,
    bucket: "sound",
    why:
      "S-SINGLE: not a sibling list. The key is a remount hint on a single "
      + "conditionally-rendered element, so no sibling can collide. [B49-reserved file: "
      + "audited, not edited]",
  },
  {
    file: "components/dag-builder-surface.tsx",
    expression: "`${loadedIdentity ?? \"draft\"}:${selectedFusionNode.id}`",
    sites: 1,
    bucket: "sound",
    why:
      "S-SINGLE: not a sibling list. The key is a remount hint on a single "
      + "conditionally-rendered element, so no sibling can collide. [B49-reserved file: "
      + "audited, not edited]",
  },
  {
    file: "components/dag-builder-surface.tsx",
    expression: "`${loadedIdentity ?? \"draft\"}:${selectedKindSpecificNode.id}`",
    sites: 1,
    bucket: "sound",
    why:
      "S-SINGLE: not a sibling list. The key is a remount hint on a single "
      + "conditionally-rendered element, so no sibling can collide. [B49-reserved file: "
      + "audited, not edited]",
  },
  {
    file: "components/dag-builder-surface.tsx",
    expression: "`${loadedIdentity ?? \"draft\"}:${selectedPromptOptimizationNode.id}`",
    sites: 1,
    bucket: "sound",
    why:
      "S-SINGLE: not a sibling list. The key is a remount hint on a single "
      + "conditionally-rendered element, so no sibling can collide. [B49-reserved file: "
      + "audited, not edited]",
  },
  {
    file: "components/dag-builder-surface.tsx",
    expression: "workflowRevisionId(workflow)",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (call to `workflowRevisionId()` — only a `…Key()` / "
      + "`…Identity()` helper is a certified key mint) and no duplicate could be "
      + "demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/dag-workflow-console.tsx",
    expression: "`${event.seq}:${event.eventId}`",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (composite whose component `event.seq` is not certified: "
      + "property `.seq` is a descriptive field, not an identity — a name, label, path, type "
      + "or category can repeat (BF-9's class)) and no duplicate could be demonstrated. "
      + "Honest bucket: Undetermined.",
  },
  {
    file: "components/dag-workflows-panel.tsx",
    expression: "`${selectedDefinition.definition.id}@${selectedDefinition.definition.revision}`",
    sites: 1,
    bucket: "sound",
    why:
      "S-SINGLE: not a sibling list. The key is a remount hint on a single "
      + "conditionally-rendered element, so no sibling can collide.",
  },
  {
    file: "components/dag-workflows-panel.tsx",
    expression: "ambiguity.engine",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (property `.engine` is a descriptive field, not an "
      + "identity — a name, label, path, type or category can repeat (BF-9's class)) and no "
      + "duplicate could be demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/database-selector.tsx",
    expression: "category",
    sites: 1,
    bucket: "sound",
    why:
      "S-MAPKEY: source is Map/object keys (Array.from(grouped.entries()) — Map keys) — "
      + "distinct by construction.",
  },
  {
    file: "components/database-selector.tsx",
    expression: "d",
    sites: 1,
    bucket: "sound",
    why:
      "S-LIT: source is a static in-repo literal (inline `as const` "
      + "[\"all\",\"science\",\"finance\"]); its projected key values were read and are pairwise "
      + "distinct.",
  },
  {
    file: "components/file-preview-panel.tsx",
    expression: "`${activeKey}:${colorCol}:${imgBust}`",
    sites: 1,
    bucket: "sound",
    why:
      "S-SINGLE: not a sibling list. The key is a remount hint on a single "
      + "conditionally-rendered element, so no sibling can collide.",
  },
  {
    file: "components/file-preview-panel.tsx",
    expression: "ci",
    sites: 2,
    bucket: "index-keyed",
    why:
      "Bare loop index. Whether this list can reorder / grow in the middle / be filtered "
      + "was NOT VERIFIED per site.",
  },
  {
    file: "components/file-preview-panel.tsx",
    expression: "col.name",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (property `.name` is a descriptive field, not an identity "
      + "— a name, label, path, type or category can repeat (BF-9's class)) and no duplicate "
      + "could be demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/file-preview-panel.tsx",
    expression: "i",
    sites: 8,
    bucket: "index-keyed",
    why:
      "Bare loop index. Whether this list can reorder / grow in the middle / be filtered "
      + "was NOT VERIFIED per site.",
  },
  {
    file: "components/file-preview-panel.tsx",
    expression: "k",
    sites: 2,
    bucket: "index-keyed",
    why:
      "Bare loop index. Whether this list can reorder / grow in the middle / be filtered "
      + "was NOT VERIFIED per site.",
  },
  {
    file: "components/file-preview-panel.tsx",
    expression: "layer.name",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (property `.name` is a descriptive field, not an identity "
      + "— a name, label, path, type or category can repeat (BF-9's class)) and no duplicate "
      + "could be demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/file-preview-panel.tsx",
    expression: "name",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (bare identifier `name` — neither a minted key nor an "
      + "instance id) and no duplicate could be demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/file-preview-panel.tsx",
    expression: "path",
    sites: 1,
    bucket: "sound",
    why:
      "S-SINGLE: not a sibling list. The key is a remount hint on a single "
      + "conditionally-rendered element, so no sibling can collide.",
  },
  {
    file: "components/file-preview-panel.tsx",
    expression: "ri",
    sites: 2,
    bucket: "index-keyed",
    why:
      "Bare loop index. Whether this list can reorder / grow in the middle / be filtered "
      + "was NOT VERIFIED per site.",
  },
  {
    file: "components/file-preview-panel.tsx",
    expression: "selectedPath",
    sites: 3,
    bucket: "sound",
    why:
      "S-SINGLE: not a sibling list. The key is a remount hint on a single "
      + "conditionally-rendered element, so no sibling can collide.",
  },
  {
    file: "components/file-preview-panel.tsx",
    expression: "tab.path",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (property `.path` is a descriptive field, not an identity "
      + "— a name, label, path, type or category can repeat (BF-9's class)) and no duplicate "
      + "could be demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/helper-agent-chat.tsx",
    expression: "`${props.profile}:${referenceKey(props.contextReference)}`",
    sites: 1,
    bucket: "sound",
    why:
      "S-SINGLE: not a sibling list. The key is a remount hint on a single "
      + "conditionally-rendered element, so no sibling can collide.",
  },
  {
    file: "components/integrations/integrations-section.tsx",
    expression: "envVar.name",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (property `.name` is a descriptive field, not an identity "
      + "— a name, label, path, type or category can repeat (BF-9's class)) and no duplicate "
      + "could be demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/interview-form.tsx",
    expression: "i",
    sites: 4,
    bucket: "index-keyed",
    why:
      "Bare loop index. Whether this list can reorder / grow in the middle / be filtered "
      + "was NOT VERIFIED per site.",
  },
  {
    file: "components/interview-form.tsx",
    expression: "j",
    sites: 1,
    bucket: "index-keyed",
    why:
      "Bare loop index. Whether this list can reorder / grow in the middle / be filtered "
      + "was NOT VERIFIED per site.",
  },
  {
    file: "components/lab-notebook-entry-card.tsx",
    expression: "index",
    sites: 1,
    bucket: "index-keyed",
    why:
      "Bare loop index over a fixed-length literal source; the list cannot reorder, grow in "
      + "the middle, or be filtered.",
  },
  {
    file: "components/lab-notebook-entry-card.tsx",
    expression: "path",
    sites: 2,
    bucket: "undetermined",
    why:
      "Not certified by the guard (bare identifier `path` — neither a minted key nor an "
      + "instance id) and no duplicate could be demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/lab-notebook-entry-card.tsx",
    expression: "tag",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (bare identifier `tag` — neither a minted key nor an "
      + "instance id) and no duplicate could be demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/lab-notebook-header.tsx",
    expression: "option.value",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (property `.value` is a descriptive field, not an "
      + "identity — a name, label, path, type or category can repeat (BF-9's class)) and no "
      + "duplicate could be demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/lab-notebook-header.tsx",
    expression: "tag.label",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (property `.label` is a descriptive field, not an "
      + "identity — a name, label, path, type or category can repeat (BF-9's class)) and no "
      + "duplicate could be demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/lab-notebook-header.tsx",
    expression: "type",
    sites: 1,
    bucket: "sound",
    why:
      "S-LIT: source is a static in-repo literal (ALL_TYPES, lab-notebook-header.tsx — 5 "
      + "distinct NotebookEntryType values); its projected key values were read and are "
      + "pairwise distinct.",
  },
  {
    file: "components/lab-notebook-timeline.tsx",
    expression: "`${scope}:${viewMode}`",
    sites: 1,
    bucket: "sound",
    why:
      "S-SINGLE: not a sibling list. The key is a remount hint on a single "
      + "conditionally-rendered element, so no sibling can collide.",
  },
  {
    file: "components/lab-notebook-timeline.tsx",
    expression: "lane.role",
    sites: 1,
    bucket: "sound",
    why:
      "S-MAPKEY: source is Map/object keys (`lanes` is built from `[...byRole.keys()]`, "
      + "lab-notebook-timeline.tsx:196-215) — distinct by construction.",
  },
  {
    file: "components/lab-notebook-timeline.tsx",
    expression: "phase.type",
    sites: 1,
    bucket: "sound",
    why:
      "S-LIT: source is a static in-repo literal (STORY_PHASES, "
      + "lab-notebook-timeline.tsx:17 — 5 distinct `type` values; `.map` is 1:1 and `.filter` "
      + "only removes); its projected key values were read and are pairwise distinct.",
  },
  {
    file: "components/lab-notebook-view.tsx",
    expression: "type",
    sites: 1,
    bucket: "sound",
    why:
      "S-LIT: source is a static in-repo literal (inline `as const` "
      + "[\"hypothesis\",\"method\",\"observation\",\"decision\"]); its projected key values were "
      + "read and are pairwise distinct.",
  },
  {
    file: "components/latex/latex-editor.tsx",
    expression: "`${b.line}`",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (composite whose component `b.line` is not certified: "
      + "property `.line` is a descriptive field, not an identity — a name, label, path, type "
      + "or category can repeat (BF-9's class)) and no duplicate could be demonstrated. "
      + "Honest bucket: Undetermined.",
  },
  {
    file: "components/latex/latex-toolbar.tsx",
    expression: "s.label",
    sites: 1,
    bucket: "sound",
    why:
      "S-LIT: source is a static in-repo literal (BLOCK_SNIPPETS — 5 distinct labels); its "
      + "projected key values were read and are pairwise distinct.",
  },
  {
    file: "components/latex/log-panel.tsx",
    expression: "f",
    sites: 1,
    bucket: "sound",
    why:
      "S-LIT: source is a static in-repo literal (inline `as const` [\"all\",\"problems\"]); "
      + "its projected key values were read and are pairwise distinct.",
  },
  {
    file: "components/latex/log-panel.tsx",
    expression: "i",
    sites: 1,
    bucket: "index-keyed",
    why:
      "Bare loop index. Whether this list can reorder / grow in the middle / be filtered "
      + "was NOT VERIFIED per site.",
  },
  {
    file: "components/latex/outline-panel.tsx",
    expression: "`${item.line}:${item.title}`",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (composite whose component `item.line` is not certified: "
      + "property `.line` is a descriptive field, not an identity — a name, label, path, type "
      + "or category can repeat (BF-9's class)) and no duplicate could be demonstrated. "
      + "Honest bucket: Undetermined.",
  },
  {
    file: "components/lean4/lean4-proof-artifact.tsx",
    expression: "artifact",
    sites: 1,
    bucket: "sound",
    why:
      "S-LIT: source is a static in-repo literal (inline `as const` [\"proof\",\"log\"]); its "
      + "projected key values were read and are pairwise distinct.",
  },
  {
    file: "components/lean4/lean4-proof-artifact.tsx",
    expression: "artifact.path",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (property `.path` is a descriptive field, not an identity "
      + "— a name, label, path, type or category can repeat (BF-9's class)) and no duplicate "
      + "could be demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/modal-job-detail.tsx",
    expression: "artifact.path",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (property `.path` is a descriptive field, not an identity "
      + "— a name, label, path, type or category can repeat (BF-9's class)) and no duplicate "
      + "could be demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/modal-job-detail.tsx",
    expression: "name",
    sites: 1,
    bucket: "sound",
    why:
      "S-LIT: source is a static in-repo literal (inline `as const` [\"stdout\",\"stderr\"]); "
      + "its projected key values were read and are pairwise distinct.",
  },
  {
    file: "components/modal-job-detail.tsx",
    expression: "phase",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (bare identifier `phase` — neither a minted key nor an "
      + "instance id) and no duplicate could be demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/modal-jobs-panel.tsx",
    expression: "value",
    sites: 1,
    bucket: "sound",
    why:
      "S-LIT: source is a static in-repo literal (MODAL_JOB_STATUSES, lib/modal-jobs.ts:10 "
      + "— 8 distinct values); its projected key values were read and are pairwise distinct.",
  },
  {
    file: "components/model-presets/model-presets-section.tsx",
    expression: "surface",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (bare identifier `surface` — neither a minted key nor an "
      + "instance id) and no duplicate could be demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/model-presets/preset-editor.tsx",
    expression: "effort",
    sites: 1,
    bucket: "sound",
    why:
      "S-LIT: source is a static in-repo literal (REASONING_EFFORTS, "
      + "lib/model-presets.ts:33 — 4 distinct values); its projected key values were read and "
      + "are pairwise distinct.",
  },
  {
    file: "components/model-selector.tsx",
    expression: "tier",
    sites: 1,
    bucket: "sound",
    why:
      "S-MAPKEY: source is Map/object keys (Object.entries(TIER_STYLES)) — distinct by "
      + "construction.",
  },
  {
    file: "components/pdf-viewer/annotation-layer.tsx",
    expression: "i",
    sites: 1,
    bucket: "index-keyed",
    why:
      "Bare loop index. Whether this list can reorder / grow in the middle / be filtered "
      + "was NOT VERIFIED per site.",
  },
  {
    file: "components/pdf-viewer/annotation-sidebar.tsx",
    expression: "page",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (bare identifier `page` — neither a minted key nor an "
      + "instance id) and no duplicate could be demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/pdf-viewer/pdf-viewer.tsx",
    expression: "currentPage",
    sites: 1,
    bucket: "sound",
    why:
      "S-SINGLE: not a sibling list. The key is a remount hint on a single "
      + "conditionally-rendered element, so no sibling can collide.",
  },
  {
    file: "components/pdf-viewer/pdf-viewer.tsx",
    expression: "pageNumber",
    sites: 1,
    bucket: "sound",
    why:
      "S-GEN: source is generated (Array.from({length: numPages}, (_, i) => i + 1)) — "
      + "values distinct by construction.",
  },
  {
    file: "components/pdf-viewer/pdf-viewer.tsx",
    expression: "sync.token",
    sites: 1,
    bucket: "sound",
    why:
      "S-SINGLE: not a sibling list. The key is a remount hint on a single "
      + "conditionally-rendered element, so no sibling can collide.",
  },
  {
    file: "components/persistent-workspace-surfaces.tsx",
    expression: "surfaceView",
    sites: 1,
    bucket: "sound",
    why:
      "S-LIT: source is a static in-repo literal (PERSISTENT_WORKSPACE_SURFACE_VIEWS — 5 "
      + "distinct values); its projected key values were read and are pairwise distinct.",
  },
  {
    file: "components/pipeline/durability-options.tsx",
    expression: "action",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (bare identifier `action` — neither a minted key nor an "
      + "instance id) and no duplicate could be demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/pipeline/durability-options.tsx",
    expression: "candidate",
    sites: 1,
    bucket: "sound",
    why:
      "S-LIT: source is a static in-repo literal (EFFORTS, durability-options.tsx — 4 "
      + "distinct values); its projected key values were read and are pairwise distinct.",
  },
  {
    file: "components/pipeline/durability-timeline.tsx",
    expression: "event.seq",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (property `.seq` is a descriptive field, not an identity "
      + "— a name, label, path, type or category can repeat (BF-9's class)) and no duplicate "
      + "could be demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/project-view.tsx",
    expression: "tag",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (bare identifier `tag` — neither a minted key nor an "
      + "instance id) and no duplicate could be demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/prompt-opt-interview.tsx",
    expression: "label",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (bare identifier `label` — neither a minted key nor an "
      + "instance id) and no duplicate could be demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/provenance-panel.tsx",
    expression: "input.path",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (property `.path` is a descriptive field, not an identity "
      + "— a name, label, path, type or category can repeat (BF-9's class)) and no duplicate "
      + "could be demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/provenance-panel.tsx",
    expression: "output.path",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (property `.path` is a descriptive field, not an identity "
      + "— a name, label, path, type or category can repeat (BF-9's class)) and no duplicate "
      + "could be demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/sandbox-panel.tsx",
    expression: "row.kind === \"node\" ? row.node.path : `create:${row.parentPath}`",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (the true branch is not certified: property `.path` is a "
      + "descriptive field, not an identity — a name, label, path, type or category can "
      + "repeat (BF-9's class)) and no duplicate could be demonstrated. Honest bucket: "
      + "Undetermined.",
  },
  {
    file: "components/scientific-dag-studio-palette.tsx",
    expression: "name",
    sites: 1,
    bucket: "sound",
    why:
      "S-LIT: source is a static in-repo literal (SWATCHES, "
      + "scientific-dag-studio-palette.tsx — 7 distinct names); its projected key values were "
      + "read and are pairwise distinct.",
  },
  {
    file: "components/scientific-result-card.tsx",
    expression: "dimension",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (bare identifier `dimension` — neither a minted key nor "
      + "an instance id) and no duplicate could be demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/scientific-result-card.tsx",
    expression: "heading",
    sites: 1,
    bucket: "sound",
    why:
      "S-LIT: source is a static in-repo literal (inline "
      + "[\"Field\",\"Type\",\"Unit\",\"Missing\",\"Unique\"]); its projected key values were read and "
      + "are pairwise distinct.",
  },
  {
    file: "components/scientific-result-card.tsx",
    expression: "label",
    sites: 1,
    bucket: "sound",
    why:
      "S-LIT: source is a static in-repo literal (`facts`, scientific-result-card.tsx — "
      + "four hard-coded labels (Formula / Molecular weight / Atoms / Bonds), "
      + "`.filter(Boolean)` only removes); its projected key values were read and are "
      + "pairwise distinct.",
  },
  {
    file: "components/scientific-result-card.tsx",
    expression: "rowIndex",
    sites: 1,
    bucket: "index-keyed",
    why:
      "Bare loop index. Whether this list can reorder / grow in the middle / be filtered "
      + "was NOT VERIFIED per site.",
  },
  {
    file: "components/settings-dialog.tsx",
    expression: "opt.value",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (property `.value` is a descriptive field, not an "
      + "identity — a name, label, path, type or category can repeat (BF-9's class)) and no "
      + "duplicate could be demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/skills-panel.tsx",
    expression: "`${p.state}/${p.name}`",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (composite whose component `p.state` is not certified: "
      + "property `.state` is a descriptive field, not an identity — a name, label, path, "
      + "type or category can repeat (BF-9's class)) and no duplicate could be demonstrated. "
      + "Honest bucket: Undetermined.",
  },
  {
    file: "components/skills-panel.tsx",
    expression: "r.name",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (property `.name` is a descriptive field, not an identity "
      + "— a name, label, path, type or category can repeat (BF-9's class)) and no duplicate "
      + "could be demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/skills-panel.tsx",
    expression: "s.name",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (property `.name` is a descriptive field, not an identity "
      + "— a name, label, path, type or category can repeat (BF-9's class)) and no duplicate "
      + "could be demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/skills-panel.tsx",
    expression: "value",
    sites: 1,
    bucket: "sound",
    why:
      "S-LIT: source is a static in-repo literal (inline `as const` tuple, values "
      + "\"project\"/\"global\"); its projected key values were read and are pairwise distinct.",
  },
  {
    file: "components/skills/autoresearch-monitor-panel.tsx",
    expression: "candidate",
    sites: 1,
    bucket: "sound",
    why:
      "S-LIT: source is a static in-repo literal (inline `as const` "
      + "[\"interactive\",\"autonomous\"]); its projected key values were read and are pairwise "
      + "distinct.",
  },
  {
    file: "components/skills/skill-curator-panel.tsx",
    expression: "mode",
    sites: 1,
    bucket: "sound",
    why:
      "S-LIT: source is a static in-repo literal (inline `as const` "
      + "[\"manual\",\"auto-manual\",\"auto\"]); its projected key values were read and are "
      + "pairwise distinct.",
  },
  {
    file: "components/skills/skill-curator-panel.tsx",
    expression: "personality.ref",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (property `.ref` is a descriptive field, not an identity "
      + "— a name, label, path, type or category can repeat (BF-9's class)) and no duplicate "
      + "could be demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/skills/skill-curator-panel.tsx",
    expression: "skill.ref",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (property `.ref` is a descriptive field, not an identity "
      + "— a name, label, path, type or category can repeat (BF-9's class)) and no duplicate "
      + "could be demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/skills/workflow-supervisor-settings.tsx",
    expression: "action",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (bare identifier `action` — neither a minted key nor an "
      + "instance id) and no duplicate could be demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/skills/workflow-supervisor-settings.tsx",
    expression: "effort",
    sites: 1,
    bucket: "sound",
    why:
      "S-LIT: source is a static in-repo literal (inline `as const` "
      + "[\"low\",\"medium\",\"high\",\"xhigh\"]); its projected key values were read and are "
      + "pairwise distinct.",
  },
  {
    file: "components/skills/workflow-supervisor-settings.tsx",
    expression: "field",
    sites: 1,
    bucket: "sound",
    why:
      "S-LIT: source is a static in-repo literal (inline `as const` "
      + "[\"watcherModel\",\"rescueModel\"]); its projected key values were read and are pairwise "
      + "distinct.",
  },
  {
    file: "components/skills/workflow-watchdog-panel.tsx",
    expression: "concern",
    sites: 1,
    bucket: "sound",
    why:
      "S-LIT: source is a static in-repo literal (WATCHDOG_CONCERNS, "
      + "lib/workflow-watchdog.ts:33 — 5 distinct values); its projected key values were read "
      + "and are pairwise distinct.",
  },
  {
    file: "components/subagents-panel.tsx",
    expression: "agent.name",
    sites: 2,
    bucket: "undetermined",
    why:
      "Not certified by the guard (property `.name` is a descriptive field, not an identity "
      + "— a name, label, path, type or category can repeat (BF-9's class)) and no duplicate "
      + "could be demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/subagents-panel.tsx",
    expression: "level || \"default\"",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (left branch of `||` is not certified: bare identifier "
      + "`level` — neither a minted key nor an instance id) and no duplicate could be "
      + "demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/subscription-bar.tsx",
    expression: "entry.entryId ?? idx",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (right branch of `??` is not certified: bare loop index) "
      + "and no duplicate could be demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/viewers/alignment-viewer.tsx",
    expression: "i",
    sites: 1,
    bucket: "index-keyed",
    why:
      "Bare loop index. Whether this list can reorder / grow in the middle / be filtered "
      + "was NOT VERIFIED per site.",
  },
  {
    file: "components/viewers/arraydata-viewer.tsx",
    expression: "c.name",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (property `.name` is a descriptive field, not an identity "
      + "— a name, label, path, type or category can repeat (BF-9's class)) and no duplicate "
      + "could be demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/viewers/arraydata-viewer.tsx",
    expression: "ci",
    sites: 1,
    bucket: "index-keyed",
    why:
      "Bare loop index. Whether this list can reorder / grow in the middle / be filtered "
      + "was NOT VERIFIED per site.",
  },
  {
    file: "components/viewers/arraydata-viewer.tsx",
    expression: "k",
    sites: 1,
    bucket: "index-keyed",
    why:
      "Bare loop index. Whether this list can reorder / grow in the middle / be filtered "
      + "was NOT VERIFIED per site.",
  },
  {
    file: "components/viewers/arraydata-viewer.tsx",
    expression: "name",
    sites: 1,
    bucket: "sound",
    why:
      "S-MAPKEY: source is Map/object keys (Object.entries(summary.dimensions ?? {})) — "
      + "distinct by construction.",
  },
  {
    file: "components/viewers/arraydata-viewer.tsx",
    expression: "ri",
    sites: 1,
    bucket: "index-keyed",
    why:
      "Bare loop index. Whether this list can reorder / grow in the middle / be filtered "
      + "was NOT VERIFIED per site.",
  },
  {
    file: "components/viewers/arraydata-viewer.tsx",
    expression: "v.name",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (property `.name` is a descriptive field, not an identity "
      + "— a name, label, path, type or category can repeat (BF-9's class)) and no duplicate "
      + "could be demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/viewers/imaging-viewer.tsx",
    expression: "a.name",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (property `.name` is a descriptive field, not an identity "
      + "— a name, label, path, type or category can repeat (BF-9's class)) and no duplicate "
      + "could be demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/viewers/imaging-viewer.tsx",
    expression: "k",
    sites: 1,
    bucket: "index-keyed",
    why:
      "Bare loop index. Whether this list can reorder / grow in the middle / be filtered "
      + "was NOT VERIFIED per site.",
  },
  {
    file: "components/viewers/molecule-viewer.tsx",
    expression: "m.index",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (property `.index` is a descriptive field, not an "
      + "identity — a name, label, path, type or category can repeat (BF-9's class)) and no "
      + "duplicate could be demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/workflows-panel.tsx",
    expression: "`${issue.kind}:${issue.key}`",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (composite whose component `issue.kind` is not certified: "
      + "property `.kind` is a descriptive field, not an identity — a name, label, path, type "
      + "or category can repeat (BF-9's class)) and no duplicate could be demonstrated. "
      + "Honest bucket: Undetermined.",
  },
  {
    file: "components/workflows-panel.tsx",
    expression: "path",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (bare identifier `path` — neither a minted key nor an "
      + "instance id) and no duplicate could be demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/workflows-panel.tsx",
    expression: "skill",
    sites: 1,
    bucket: "undetermined",
    why:
      "Not certified by the guard (bare identifier `skill` — neither a minted key nor an "
      + "instance id) and no duplicate could be demonstrated. Honest bucket: Undetermined.",
  },
  {
    file: "components/workspace-navigation.tsx",
    expression: "item.view",
    sites: 1,
    bucket: "sound",
    why:
      "S-LIT: source is a static in-repo literal (NAVIGATION_ITEMS — 5 distinct `view` "
      + "values); its projected key values were read and are pairwise distinct.",
  },];
