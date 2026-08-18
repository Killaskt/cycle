---
id: 014
title: Cycle-wide overload detection — placement vs. volume discriminator
status: done
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

Built `src/lib/overload.ts`: `checkOverload` (read-only rate/discriminator math, docs/SPEC.md §5's
contract) and `checkAndApplyCycleWideOverload` (the DB-touching orchestrator — "code disposes" per
ADR-0004, applied cycle-wide instead of per-slot). Hooked into `src/lib/fallOff.ts`'s `recordFallOff`
after every `fall_offs` insert, independent of `occurrence_in_slot` (cycle-wide overload is a
separate diagnosis from the per-slot ladder, per ADR-0008).

- `applyAction` (`src/lib/amendment.ts`) gained a `REDUCE_FREQUENCY` case (freq - 1, floored at 1;
  falls through to the existing `REMOVE` case when that would hit 0) and is now exported, along with
  `pickMoveTarget`, so the cycle-wide path reuses the exact same "code disposes" primitives as the
  per-slot 2nd/3rd-fall path rather than duplicating them.
- `MOVE_CLUSTER` moves every *active* commitment currently placed in the triggering bucket (not just
  the ones that actually fell off) to one shared new bucket — CONTEXT.md §9c: "global MOVE of that
  cluster."
- No user accept/reject step for the cycle-wide response — applied and logged as
  `user_response: 'accepted'` immediately. Logged as `[014]` in `docs/agents/CLARIFICATIONS.md`
  (medium confidence).
- Resolved two long-open `[context-doc]` entries in `docs/agents/CLARIFICATIONS.md`: the
  REDUCE_FREQUENCY-vs-drop-lowest-goal choice, and the double-trigger-in-one-cycle UX — both are now
  built and tested exactly as originally assumed (repeat trigger re-applies the same response,
  flagged via `params.repeat_trigger: true` and distinct reasoning text, no early-termination flow).
- Tests: `src/test/integration/overload.test.ts` — below-floor no-trigger, `MOVE_CLUSTER` (cluster
  moves together, unaffected commitment untouched), `REDUCE_FREQUENCY_ALL` (including the
  floor-breach → `REMOVE` case), and a nested second-trigger scenario proving `repeat_trigger: true`
  and correct floor-cascading on the repeat application. All four DoD bullets covered.
- Verified green: `npm run typecheck` clean, `npm test` 190/190 across 28 files.
- This ticket's implementation was originally produced by a background agent that completed all the
  real work (full implementation + passing tests) before an API error cut it off mid-wrapup —
  finished the CLARIFICATIONS.md entries, this file, verification, and commit directly.

This was the last open ticket in the queue — all 18 tickets are now `done`.
