---
id: 018
title: Between-cycle regeneration — completion bands + measured load factor
status: open
blocked_by: [003, 017]
---

## Scope

`CONTEXT.md` §6. When starting a new cycle for a user with a closed prior cycle: per-goal completion rate from the prior cycle drives the band (≥90% advance, 60-89% hold, <60% retreat-halfway) **per goal**, not aggregated. The new cycle's ceiling uses `load_factor.last_cycle_completed_minutes × 1.15` instead of stated-current × 1.15 (cycle 1's rule) — this is the actual mechanism behind "capacity becomes measured, not claimed."

Update `load_factor.last_cycle_completed_minutes` at the same time (on cycle close, ticket 017, or here — pick one and be consistent; document the choice).

This ticket is where `docs/SPEC.md`'s deferred generator-schema assembly work and the cross-cycle `learnings`/`reliability_map` tables (already being written by tickets 010/012/013) actually get **read** for the first time — the previous 17 tickets write cross-cycle data, this one is the first to consume it.

## Definition of done

- A goal at ≥90% completion in the prior cycle advances one more step in the new cycle's target, per the ticket-003 math.
- A goal at 60-89% holds — new cycle's `target_freq`/`target_dur` for that goal equal the prior cycle's `plan_freq`/`plan_dur`, not the original intake target.
- A goal at <60% retreats halfway toward what was actually completed.
- The new cycle's ceiling calculation uses `load_factor`, not stated current — construct a case where these two would produce different ceilings and assert the measured one wins.

## Notes
