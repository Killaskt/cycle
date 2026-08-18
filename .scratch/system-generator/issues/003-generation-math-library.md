---
id: 003
title: Deterministic generation math library (delta, ceiling, completion bands)
status: done
blocked_by: []
---

## Scope

Pure functions, no DB, no network, no model — `CONTEXT.md` §5-6:

- `computeStep(currentFreq, targetFreq)` and the duration equivalent — including the `gap > 0` guard (never advance when gap is zero or negative).
- `applyCeiling(focusAreas)` — the back-off loop, tie-break = intake order, **last-entered goal backed off first**.
- `completionBand(rate)` — per-goal ≥90%/60-89%/<60% → advance/hold/retreat-halfway.

This is the highest-leverage ticket to get exactly right — the Edge Function (004) and between-cycle regeneration (018) both depend on it, and a bug here is a bug in every generated plan.

## Definition of done

One test per formula branch, at minimum:
- `gap > 0` produces `clamp(round(0.25*gap), 1, 2)`.
- `gap == 0` and `gap < 0` both produce step `0` (the guard — this was a caught bug, see `docs/agents/CLARIFICATIONS.md` context and make sure it doesn't regress).
- Ceiling back-off: construct a case where two goals tie on added minutes, assert the goal with the higher `intake_order` (last-entered) is the one backed off.
- Ceiling back-off terminates and never leaves `load > ceiling` when reverting all goals to zero step would satisfy it.
- Each completion band, per goal independently (not aggregated).

## Notes

Implemented in `src/lib/generationMath.ts` with tests in `src/lib/generationMath.test.ts`
(13 tests, all green; full suite 18/18 passing). `npm run typecheck` and `npm test` both
exit 0.

- `computeStep` / `computeDurationStep`: implement the `gap > 0` clamp and the `gap <= 0` -> 0
  guard exactly as specified (no re-introduction of the min-1 clamp bug).
- `applyCeiling`: the back-off loop's "back off by one step" was underspecified for goals with
  both a frequency and a duration delta — logged as a genuine spec gap in
  `docs/agents/CLARIFICATIONS.md` ([003] entry) with a conservative, deterministic assumption
  (retreat frequency step to 0 first, then duration step one minute at a time). This guarantees
  termination since reverting every goal to zero step always satisfies `load <= ceiling`.
- `completionBand`: per-goal classifier only (advance/hold/retreat_halfway), as scoped by this
  ticket. The actual "retreat halfway toward completed" magnitude math is between-cycle
  regeneration (ticket 018), not built here.
- No unrelated test failures observed from tickets 001/002's in-progress work at time of running
  (full suite was 2 files / 18 tests, all passing).
