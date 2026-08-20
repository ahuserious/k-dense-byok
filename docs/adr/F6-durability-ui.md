# ADR F6 — consume F14's one durability watcher

- Lane: F6
- Rows: 23–24
- Status: UI contract implemented; live server binding waits on F14 integration
- Interface: `wave-f/interfaces/F14-durability.md` round 2

## Decision

F6 does not add durability fields to NodeSpec and does not build a second watcher.
`DurabilityOptions` reads and writes the project-scoped `/durability/*` API that
F14 owns. The run details mount `DurabilityTimeline` over the same journal.

The options surface exposes:

- a master switch;
- separate watcher and rescue model pickers from the real model catalogue;
- effort, minimum rescue context, stall threshold, and bounded stop policy;
- all six server-described signals, including the honest 3 full / 2 partial /
  1 none observability split; and
- action and threshold controls restricted to each descriptor's
  `supportedActions`.

Both shipped defaults are unset. The master switch stays disabled with the
server's reason until the operator selects both models. `failed-skill-fire`
stays disabled because the server says it cannot observe a skill invocation.
The two partial signals remain operable but print `unobservableReason`.

## Timeline semantics

The timeline keeps F14's outcomes distinct:

- `durability.escalation.started` is in progress, never success;
- only `durability.escalation.completed` says a repair was deployed and a
  replacement run continued;
- `durability.escalation.deferred` says a proposal is waiting for approval and
  prints its unapplied proposal id;
- `lateral-pass` is its own dispatched action; and
- stop availability is read before the click, so a refused stop is disabled
  with its server-provided reason.

## Integration state

Current integration `51f0b7d` does not contain F14's route registration or
server modules. A 404 therefore renders the whole options surface disabled with
“not available in this server build yet”; a run timeline 404 renders nothing
rather than a false empty history. Contract-level Playwright items exercise the
full F14 payload. The unmocked preview proves the 404 state is honest.

Rows 23–24 cannot be promoted to backend PASS until F14 lands and those same
items run without route interception. No F6 server substitute is acceptable:
that would create the duplicate watcher the interface forbids.
