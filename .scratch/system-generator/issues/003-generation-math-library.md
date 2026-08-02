---
id: 003
title: Deterministic generation math library (delta, ceiling, completion bands)
status: open
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
