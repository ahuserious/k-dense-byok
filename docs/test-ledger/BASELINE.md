# Test-count baseline

The Phase R baseline is:

| Suite | Passed | Skipped |
| --- | ---: | ---: |
| Server | 1,062 | 5 |
| Web | 590 | 0 |

<!-- test-ledger-baseline {"server":{"passed":1062,"skipped":5},"web":{"passed":590,"skipped":0}} -->

## Recorded environment observations

The orchestrator-side R1 lane run reported **1,061 passed / 6 skipped**. One
otherwise-passing Python helper test became conditional because the lane shell
did not have the integration environment's Python helper dependencies. This is
an environment observation, not a code-count delta.

<!-- test-ledger-entry {"id":"r1-python-helper-environment","suite":"server","kind":"observation","passed":1061,"skipped":6,"reason":"One Python-helper test is environment-skipped when optional helper dependencies are unavailable."} -->

The recorded post-R2 checkpoint is **1,066 passed / 4 skipped**: one live-gated
test is no longer in the count and four cassette-harness tests are present.
This checkpoint is recorded before the R2 commit merges here; consult that
commit message for the exact test identities.

<!-- test-ledger-entry {"id":"post-r2-cassette-harness","suite":"server","kind":"observation","passed":1066,"skipped":4,"reason":"Post-R2 checkpoint: minus one live-gated test and plus four cassette-harness tests."} -->

## Adding code deltas

Future files in this directory may add active count changes with a machine-readable
comment such as:

```md
<!-- test-ledger-entry-example {"id":"feature-tests","suite":"server","kind":"delta","active":true,"passedDelta":3,"skippedDelta":0,"reason":"Three new unit tests."} -->
```

Every active delta needs a unique id and a non-empty reason. Environment-specific
counts belong in `observation` entries and must match exactly to be accepted.
