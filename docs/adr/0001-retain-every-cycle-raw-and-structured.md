# ADR-0001: Retain every cycle record, raw and structured, never overwritten

## Status
Accepted

## Context

The original brief specified "one JSON blob per cycle" as storage and listed "multi-cycle history" as explicitly out of scope for MVP. But the product's core retention bet is that fall-off history compounds across generations — "generation #7 is better than generation #1." Those two statements can't both be literally true: if the blob is overwritten each cycle, there's no data left to demonstrate the compounding claim, and cycle 2's generation has nothing real to differ against.

## Decision

Retain every cycle's record permanently, never overwritten. "Multi-cycle history out of scope" is reinterpreted as *no browsing UI for past cycles* — not *don't keep the data*. Save raw (verbatim freeform answers) and structured (extracted fields) side by side.

Captured per cycle: the generated plan as issued (schedule, goals, timeframe), every completion (slot + timestamp), every fall-off event (slot, timestamp, occurrence number, verbatim "what happened," tag, mood where captured), every amendment (proposed action, reasoning, accepted/rejected, rejection reason, revision), and review answers at close.

Captured across cycles, in the learnings store: rolling `tag → action` confidence mappings, the reliability map, observed load factor.

## Consequences

- Missing a *feature* (a browsing UI) is cheap to add later. Missing *data* from a cycle already run is unrecoverable — this is why the decision leans toward over-capturing now.
- Raw + structured both means summarization strategy, tag vocabulary, and how the generator consumes learnings can all be rewritten later against stored ground truth, without re-running cycles.
- Storage now needs to be a durable backend, not a local scratch blob — this is the direct cause of ADR-0002 (Supabase) and ADR-0003 (auth that survives device loss).
