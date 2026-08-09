# 3× Adversarial Verify Block

Auto-append this after **every substantive phase node** `X` (lit-review, EDA,
modeling, interpretation, synthesis — NOT the small parse/scribe nodes). It is
mandatory: it's what keeps the pipeline honest.

## How it works

Three verifier nodes run **in series** (`X-verify-1` → `X-verify-2` →
`X-verify-3`), each in a **fresh context** (`context: fresh`) on
`openrouter/anthropic/claude-opus-4.8`, each independently re-reading `X`'s
**goal** and `X`'s **output** and emitting exactly `PASS` or `FAIL: <reasons>`.

The next real node depends on `X-verify-3` and gates on `PASS`:
`when: "$X-verify-3.output == 'PASS'"`.

Three independent fresh reads (instead of one) defeat the failure mode where a
single verifier rubber-stamps a plausible-but-wrong result — three fresh agents
have to agree before the pipeline advances. The `output_format` pins the output
to a single token so the `when:` string-equality check is reliable.

## Template (substitute `X`, the goal, and `X`'s upstream output ref)

```yaml
- id: X-verify-1
  prompt: |
    ADVERSARIAL VERIFICATION (fresh context, attempt 1 of 3).
    The phase "X" had this goal:
      <goal>
      __X_GOAL__
      </goal>
    Here is what it produced:
      <output>
      $X.output
      </output>
    Re-derive whether the output actually achieves the goal. Hunt for errors,
    unsupported claims, missing steps, and wrong results. Be adversarial — your
    job is to FAIL it if it does not hold up.
    Respond with exactly "PASS" or "FAIL: <reasons>".
  model: openrouter/anthropic/claude-opus-4.8
  context: fresh
  depends_on: [X]
  output_format:
    type: object
    properties:
      verdict: { type: string }
    required: [verdict]

- id: X-verify-2
  prompt: |
    ADVERSARIAL VERIFICATION (fresh context, attempt 2 of 3).
    Goal of phase "X":
      <goal>
      __X_GOAL__
      </goal>
    Output produced:
      <output>
      $X.output
      </output>
    Independently re-check. Do NOT trust the prior verifier. Respond with
    exactly "PASS" or "FAIL: <reasons>".
  model: openrouter/anthropic/claude-opus-4.8
  context: fresh
  depends_on: [X-verify-1]
  output_format:
    type: object
    properties:
      verdict: { type: string }
    required: [verdict]

- id: X-verify-3
  prompt: |
    ADVERSARIAL VERIFICATION (fresh context, attempt 3 of 3 — final gate).
    Goal of phase "X":
      <goal>
      __X_GOAL__
      </goal>
    Output produced:
      <output>
      $X.output
      </output>
    Final independent re-check. Respond with exactly "PASS" or "FAIL: <reasons>".
  model: openrouter/anthropic/claude-opus-4.8
  context: fresh
  depends_on: [X-verify-2]
  output_format:
    type: object
    properties:
      verdict: { type: string }
    required: [verdict]
```

## Wiring the next real node

The next real phase node depends on `X-verify-3` and only runs on PASS:

```yaml
- id: next-phase
  prompt: "..."
  depends_on: [X-verify-3]
  when: "$X-verify-3.output.verdict == 'PASS'"
```

Notes:
- `output_format` makes the verdict a JSON field, so the gate uses
  `$X-verify-3.output.verdict == 'PASS'` (dot-notation field access). If you
  prefer a plain-text verdict, drop `output_format` from the verify nodes and
  gate on `$X-verify-3.output == 'PASS'` instead — but then instruct the
  verifier to output ONLY the bare token so the equality holds.
- Keep the `__X_GOAL__` placeholder filled with the one-line goal of phase `X`
  (the same goal you wrote into `X`'s own prompt) so the verifier judges against
  intent, not just plausibility.
- A `FAIL` from `X-verify-3` skips the gated next node (fail-closed). If the
  user wants auto-rework on failure, route `FAIL` into an `approval` node with
  `on_reject`, or a `loop` that re-runs `X` — offer this, don't add it silently.
