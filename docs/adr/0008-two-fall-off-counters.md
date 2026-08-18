# ADR-0008: Fall-offs are tallied per-slot and cycle-wide, as two independent counters

## Status
Accepted

## Context

A single fall-off counter, however it's scoped, is blind to one of two real failure modes. Scoped per-slot only: missing a run Monday, reading Tuesday, meditation Wednesday, Spanish Thursday, and the gym Friday each read as an isolated 1st fall — the per-slot escalation ladder never fires, even though five different commitments failed in five days. Scoped cycle-wide only: three fails concentrated on one commitment reads identically to five fails spread across five commitments, even though the correct response is completely different (fix one commitment vs. the whole plan is too heavy).

## Decision

Every fall-off event is tallied in two places from the same write: a **per-slot** counter, which drives the escalation ladder (CONTEXT.md §9a) because an amendment has to target something specific — you can't `MOVE` or `SHORTEN` "in general." And a separate **cycle-wide** counter, which drives overload detection (CONTEXT.md §9c) as a rate (falls ≥ 40% of scheduled items over a rolling 7 days, minimum 4 falls) rather than a raw count, so it behaves consistently regardless of how many commitments are in the plan.

Both counters reset at the start of every new cycle — they are within-cycle mechanics. Only the learnings store (tag→action mappings, reliability map, load factor) persists across cycles (ADR-0001).

## Consequences

- One fall-off write, two reads — no duplicated event logging, no risk of the two counters drifting out of sync.
- The cycle-wide trigger needs its own discriminator (placement vs. volume, CONTEXT.md §9c) before choosing a response, since "overloaded" and "one bad time slot" produce the same raw count but need opposite fixes.
- Both counters resetting per-cycle means a pattern that's real but sits just under a single cycle's threshold (e.g., chronic-but-mild lateness on one slot across many cycles) is only visible through the cross-cycle learnings store, not through either counter directly — acceptable for MVP since the learnings store is what's designed to carry that signal forward.
