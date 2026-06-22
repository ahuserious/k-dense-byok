---
name: background-rescue
description: Rescue a stalled, stuck, context-rotted, hallucinating, or looping workflow node or goal-loop node by re-grounding it. Use this skill whenever a workflow node or goal-loop iteration has gone off the rails — it has stalled and stopped making progress, its context has rotted (lost track of the original goal), it has started hallucinating results that were never produced, or it is stuck repeating the same failing step in a loop. Trigger on phrases like "this node is stuck", "the run stalled", "the agent is hallucinating", "it's looping on the same step", "context rot", "rescue this node", "get the goal loop unstuck", or any background watchdog that detects a node has diverged from its goal. This is a lateral pass: it does not finish the work itself — it produces a single clean re-grounding prompt that hands control back to the original, stronger reasoning agent.
---

# Background Rescue

A diverged node is rarely broken because the original agent is incapable. It is broken because the *context* the agent is reasoning over has degraded — the goal scrolled out of the window, an early hallucination got treated as fact, or a retry loop kept feeding its own failure back in. The fix is almost never "try harder from here." The fix is to hand the original agent a *clean, self-contained restart* — one prompt that re-states the goal, carries forward only what is actually verified, and points at the next concrete step.

Your job is to author that one prompt. You are a **lateral pass**, not the finisher: you diagnose the divergence and return control to the original (stronger) reasoning agent with a better starting context. You run on a cheap, very-large-context background model precisely so you can read the whole failing transcript without competing for the main agent's budget.

## Why this works

The original agent is usually the more capable reasoner. What it lacks at the moment of failure is a trustworthy context. By reading the full log from the outside — with fresh eyes and no investment in the path already taken — you can see what the in-context agent cannot: where the thread snapped, which "results" are fabricated, and which dead end it keeps walking back into. Re-grounding beats restarting from scratch (you keep the real progress) and beats pushing forward (you drop the rot).

## Procedure

Work through these steps in order. Do not skip the diagnosis — the quality of the re-grounding prompt depends entirely on naming the failure precisely.

### 1. Read the failing node's logs and its original goal

Pull the node's full execution log/transcript and the original goal/task it was given. Read all of it. You have a large context window for exactly this reason — do not skim. You are looking for the moment the node stopped serving the goal.

### 2. Restate the ORIGINAL goal

Before analyzing the failure, write down — in your own words — what this node was actually supposed to accomplish. Anchor to the *original* goal, not to whatever the node drifted into pursuing. This is your north star for everything that follows; if the node redefined its own objective mid-run, that drift is itself a finding.

### 3. Diagnose precisely where it diverged

Identify the single point of divergence and classify it. Be specific — quote or cite the step/turn where it happened. The failure is almost always one of:

- **Stalled** — the node stopped making forward progress: idling, waiting on nothing, repeating a no-op, or producing output that doesn't advance the goal.
- **Context-rot** — the node lost the thread: the original goal scrolled out of context, constraints were forgotten, or it's now optimizing for something that isn't the goal.
- **Hallucinated** — the node fabricated a result, a file, a tool output, a success, or a fact that was never actually produced or verified, and then built on it.
- **Looped** — the node is stuck cycling the same failing action (same command, same edit, same query) and re-feeding its own failure back in.

A run can show more than one; name the *primary* one that broke it, and note the others.

### 4. Separate verified progress from the rot

Go back through the log and split it: what did the node *actually accomplish and verify* (real files written, real tests passed, real outputs confirmed) versus what is unverified, fabricated, or contaminated by the divergence. **Never invent results.** If you can't confirm something actually happened from the log, it goes in the "discard / re-verify" pile — do not launder a hallucination into the re-grounding prompt by restating it as fact.

### 5. Synthesize ONE fresh, self-contained re-grounding prompt

Write a single prompt the original agent can act on with zero prior context. It must stand entirely on its own — assume the receiving agent has none of the failed run's history. Include, in this order:

1. **Restate the goal** — the original objective, clearly, up front.
2. **Summarize verified progress** — only what is actually confirmed done, so the agent doesn't redo real work.
3. **Flag what to discard** — name the hallucinated/unverified/looped material explicitly and instruct the agent to drop it and not trust it.
4. **Give the next concrete step** — one clear, actionable next move that gets the agent moving toward the goal again.

Keep it tight and self-contained. The whole point is a clean context, so don't drag the rot back in.

### 6. Emit the re-grounding prompt plus a one-line diagnosis

Return exactly two things:

- The new re-grounding prompt (ready to hand to the original agent).
- A one-line diagnosis stating the divergence type and where it happened (e.g. `Diagnosis: hallucinated — fabricated a passing test suite at step 7 that was never run`).

That's it. You do not continue the work, you do not try to solve the task yourself, and you do not pad the output. You hand the clean prompt back and let the stronger agent take it from there.

## Output format

```
Diagnosis: <stalled|context-rot|hallucinated|looped> — <where/what, one line>

--- RE-GROUNDING PROMPT ---
GOAL: <restated original goal>

VERIFIED PROGRESS: <only what's actually confirmed>

DISCARD / DO NOT TRUST: <hallucinated, unverified, or looped material to drop>

NEXT STEP: <one concrete, actionable move>
```

## Guardrails

- **Never invent results.** If the log doesn't prove it happened, it didn't happen — flag it for re-verification.
- **One prompt, not a plan.** You produce a single re-grounding prompt, not a multi-step roadmap. The original agent does the planning.
- **Stay lateral.** You re-ground and hand off; you do not finish the task. Resist the pull to "just fix it" — your value is the clean context, not the labor.
- **Anchor to the original goal**, never to the node's drifted-into objective.
