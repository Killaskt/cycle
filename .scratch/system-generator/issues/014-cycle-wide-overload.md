---
id: 014
title: Cycle-wide overload detection — placement vs. volume discriminator
status: open
blocked_by: [010, 012]
---

## Scope

`CONTEXT.md` §9c, `docs/SPEC.md` §5. After every `fall_offs` insert, run `checkOverload(cycleId)`: rate = falls in trailing 7 days / scheduled slots in trailing 7 days for that cycle, no trigger below 4 raw falls regardless of rate, trigger at rate ≥ 0.40.

On trigger, discriminate using the fall-off records' buckets: ≥60% of the triggering falls share one bucket → `MOVE_CLUSTER` (global `MOVE` of everything in that bucket, load untouched); otherwise → `REDUCE_FREQUENCY_ALL` (apply `REDUCE_FREQUENCY` to every active commitment in the cycle — this is a **logged assumption**, see `docs/agents/CLARIFICATIONS.md`, the source material floated "drop lowest-completion goal" as an alternative and never picked; build to `REDUCE_FREQUENCY_ALL` as specified there).

Fires at most once per cycle — track this via the presence of a system-generated `amendments` row with `target->>'scope' = 'cycle_wide'` for this cycle (no new schema needed, per `docs/SPEC.md` §5). A second trigger condition in the same cycle: log it via `docs/agents/CLARIFICATIONS.md`'s pattern (this exact scenario is already flagged there as unresolved) rather than inventing new UX for it.

## Definition of done

- Fewer than 4 falls in 7 days never triggers, regardless of rate.
- ≥4 falls and rate ≥40%, clustered ≥60% in one bucket → exactly one `MOVE_CLUSTER` response, that bucket's commitments moved, nothing else changed.
- ≥4 falls and rate ≥40%, spread evenly → `REDUCE_FREQUENCY_ALL`, every active commitment's `freq` reduced by the ticket-012 guardrail rules (floor respected, `REMOVE` if a reduction would breach it).
- A second qualifying trigger in the same cycle does not fire a second global response — assert whatever no-op/logged behavior you implement.

## Notes
