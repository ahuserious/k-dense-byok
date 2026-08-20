---
name: create-scientific-agent
description: >-
  Create a usable project scientific specialist through Kady's existing Agents
  API, or select an installed reusable personality as a council head through
  the skill curator. Use when a user wants a domain scientist, reviewer,
  methodologist, or council persona that real runs can instantiate.
argument-hint: "[specialty and role]"
---

# Create scientific agent

Produce an agent definition that an existing runtime consumes. Do not invent a
third persona format.

Kady has two distinct, intentional surfaces:

1. **Project specialist** — a `.pi/agents/<name>.md` definition managed through
   `PUT /agents/<name>` and discovered by pi-subagents.
2. **Council head** — a reference to an existing profile in the server-owned,
   pinned personality library, attached through
   `settings.deliberation.mimeographs.personalityRefs`.

A project specialist file is not copied into the immutable personality store.
A personality profile is not exposed as ambient Pi instructions.

## Gather the contract

Ask for:

- scientific domain and methods
- decisions the agent may make
- evidence sources it must inspect
- tools required (least privilege)
- expected output structure
- failure/escalation conditions
- desired model/thinking level, if any
- whether the result is a project specialist, a council head, or both

Reject a role that asks the agent to read credentials, bypass evidence checks,
change budgets, or spawn unbounded children.

## Create a project specialist

Use a lowercase safe name, then call:

```text
PUT /agents/<name>
```

Example body:

```json
{
  "description": "Review causal-inference designs and identify threats to identification.",
  "thinking": "high",
  "tools": "read, grep, find, ls",
  "systemPromptMode": "append",
  "inheritProjectContext": true,
  "inheritSkills": true,
  "systemPrompt": "You are a causal-inference methodology specialist. Reconstruct the estimand, treatment assignment, timing, covariates, outcome process, and identifying assumptions. Inspect project evidence with read-only tools. Separate observed facts from assumptions. For every design claim, state the estimand, required assumptions, falsification or sensitivity check, and residual uncertainty. Never read credentials, mutate files, start another agent, or claim a check ran when it did not. Return findings ordered by decision impact with exact artifact citations."
}
```

Read `GET /agents` and require the returned project entry to have:

- the exact name
- `source: "project"`
- `enabled !== false`
- the requested system prompt and tool allowlist

Only then say the specialist is usable. New chat tabs/subagent runs load the new
definition; a live session keeps the roster it started with.

## Select a council head

1. Load a workflow's curator state:
   `GET /skills/curator/workflows/<workflowId>`.
2. Require `personalities.available: true`.
3. Match the user's requested perspective against the returned
   `personalities[]`. Never invent a ref.
4. Select one or more unique refs (maximum 32).
5. Apply them to the exact deliberating node:

```json
{
  "expectedRevision": 3,
  "nodeIds": [
    "council-review"
  ],
  "skillRefs": [
    "create-scientific-agent"
  ],
  "skillsMode": "manual",
  "writeMode": "merge",
  "mimeographs": {
    "mode": "manual",
    "personalityRefs": [
      "causal-inference/methodologist",
      "statistics/skeptic"
    ]
  }
}
```

Send it to:

```text
POST /skills/curator/workflows/<workflowId>/apply
```

Use only refs returned by the live library; the example refs are illustrative.
The curator sets `bestOfNPersonalityCount` to the selected count so NodeSpec
validation and runtime staffing agree.

## Make both usable together

When the user requests both:

- create the project specialist for explicit subagent delegation;
- independently select an installed personality profile for council
  deliberation;
- explain that they are two runtime identities with separate trust and update
  boundaries;
- attach this skill to the node so its operating instructions load with the
  node execution.

Do not claim they are byte-identical unless their actual prompts were compared.

## Quality checklist

- Description tells the router when to delegate.
- System prompt names domain, evidence rules, output contract, and limits.
- Tool list is no broader than required.
- Mutating tools are omitted unless the user provided a concrete need.
- The prompt tells the agent how to fail when evidence is absent.
- No secret value or filesystem-specific credential path appears.
- Existing agent names are not overwritten without confirmation.
- Council refs come from the pinned personality inventory.

## Failure handling

- Invalid/duplicate agent name: offer a safe alternative; do not overwrite.
- Empty system prompt: refuse to save.
- Agents API save succeeds but readback is absent/disabled: report creation as
  incomplete.
- Personality library unavailable: council-head creation is disabled with the
  returned pin-configuration reason. The project specialist path may still
  proceed.
- Personality ref absent: re-list; do not attach a guessed ref.
- Workflow revision conflict: reload and ask the user to confirm the merged
  choice.
- Manual personality count mismatch: use the curator, which binds the count and
  refs together; do not hand-edit around validation.
