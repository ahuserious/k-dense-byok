# Release and marketplace gate

This package is intentionally `private` and uses a development version. Do not
remove that guard, publish to npm, create a GitHub release, or submit a Pi
marketplace listing without a new explicit approval from the repository owner.

Before requesting approval:

1. Make the Kady executor and the package's exported nonvisual API
   agree on one versioned graph/runtime boundary.
2. Run backend typecheck and tests plus frontend typecheck, feature-scope lint,
   tests, and production build on the exact release commit, including Windows
   CI. Repository-wide frontend lint remains blocked on documented upstream
   baseline failures until that separate cleanup lands.
3. Run `npm pack --dry-run --json` here and inspect every included path. The visual
   Builder, credentials, project data, sessions, logs, and test fixtures must
   not be present. Skill evaluation prompts under `skills/**/evals/` are
   development fixtures and are deliberately excluded; only each skill's
   `SKILL.md` and reviewed runtime scripts belong in the package.
4. Re-run the independent adversarial review for identity ownership,
   cancellation, timeout, limits, usage reconciliation, fallback rejection,
   path handling, and same-user trust assumptions. Cancellation tests must prove
   that caller abort, explicit cancel, host timeout, and disposal retain ownership
   until the exact V2 terminal acknowledgement, while wrong-owner, stale,
   malformed, and missing acknowledgements never claim provider stop. Prove
   that acknowledgement timeout full-charges without terminal usage, preserves
   the tuple in quarantine, blocks new admission/session teardown/project
   deletion, rejects malformed exact responses, and releases only on a fully
   validated exact terminal response. Resolve the current lack of durable
   cross-process quarantine reattachment before publication; this is an
   unresolved P0, and fail-closed accounting alone is not proof of quiescence.
5. Verify the package name and marketplace publisher account are controlled by
   the intended owner. Record the resulting namespace decision; do not infer it
   from a Git remote.
6. Regenerate dependency and license notices, choose a stable semver, remove
   `private` only in the release change, and obtain explicit approval for the
   packed artifact checksum.
7. Publish once, verify installation in a clean Pi agent directory, then create
   the marketplace entry from that immutable version. Roll back visibly if the
   installed extension differs from the reviewed artifact.
