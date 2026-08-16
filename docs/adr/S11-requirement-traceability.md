# S11 requirement traceability and status

## Status

Recorded 2026-08-15. Task #29 (S11) is **REOPENED**; owner ruling: wire hosted-runner execution
(task #56 option c). This ADR exists because `GOAL.md` — the file named as the requirement source for the
epic — contains no S11, Stably, cloud, or 200-item wording, and the acceptance criterion drifted during
lane briefing.

## The requirement, verbatim

Owner's words, from the session that started the epic:

> "final outer /loop is that this is tested on stabily with visual cloud agents that press every button and
> can confirm a 200 item test has passed."

Mission document `dfg-evidence-20260807-135127/sds-goal-prompt.md` (outside this repo), section
"S11 — Stably cloud verification outer loop (the epic's exit gate)", items 2–4 and 7: suite authored with
`stably plan` / `stably create` to ≥ 200 items with "press every button" taken literally; cloud execution;
evidence returned from `stably runs`; exit = 200-item suite green **in cloud** + adversarial assessment of the
evidence bundle + tip gate green.

## How the work drifted

The S11 lane brief reduced the clause to *"TARGET >= 200 test items total"* plus *"DO NOT run any `stably`
cloud commands yourself."* The acceptance criterion became a count; substance was never specified. That is
how a 239/239-green suite was judged 39 substantive on first assessment. `stably plan` and `stably create`
were never used. `stably test --browser cloud` was later shown to run locally (the flag only sets
`STABLY_CLOUD_BROWSER=1`, consumed by the agent commands `create`/`fix`/`verify`).

## Honest position as of 2026-08-15

- 246-item Playwright suite green **locally** (242 passed / 0 failed / 4 fixme, warm app, pinned workers);
  independently counted **210 substantive of 246** at `c11a47a`.
- 64 of those tests green from a public HTTPS origin **with a local browser**.
- **One** agent-verified flow (`stably verify --browser cloud`) from a Stably cloud browser against the real
  backend, which found deployment blocker #59.
- **No repository Playwright test has been executed by a browser outside this machine.** The clause is not
  met; earlier "remote execution" claims were withdrawn three times (own IPv6 egress; Playwright's default
  Windows UA; own tailnet XFF).

Authoritative evidence: `dfg-evidence-20260807-135127/s11/RESULT.md` (scope banner at top) and
`cloud-run-final/CORRECTION-no-cloud-execution.md`.

## Decision (owner, 2026-08-15)

Wire real hosted-runner execution rather than waive: push `integration/dfg-20260807-135127` to the
`ahuserious` fork (that one branch only; never K-Dense-AI), add a CI workflow with a GitHub Actions job
running `npx stably test` and a `stablyai/stably-runner-action@v4` job on Stably Cloud, and iterate until the
suite is green from a runner that is not the operator's machine, with a fingerprint deny-list proof of
remoteness. Task #29 closes only then, with the exact wording of what passed. Fallbacks (public preview
deploy; local execution + waiver) are recorded but not chosen.

## Consequences

- `GOAL.md` gains a pointer to this ADR (below the hook table) so the requirement is discoverable in-repo.
- Every future evidence claim about remoteness must enumerate this host's addresses and default UAs into a
  deny-list before asserting foreign-ness.
- "200 items" is a floor on **substantive** items, not collected items.
