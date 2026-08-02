---
id: 010
title: Reliability map updater
status: open
blocked_by: [001, 007]
---

## Scope

`CONTEXT.md` §9, §12. On every `completions` insert and every `fall_offs` insert, update the corresponding `reliability_map` row for that user's `(bucket)`: increment `scheduled` when a slot's scheduled time passes (completed or fell off both count as "scheduled happened"), increment `completions` only when actually completed. A bucket is "trusted" once `scheduled >= 3`; below that, generation (ticket 005) must treat it as neutral, not as unreliable.

This is cross-cycle data (`reliability_map` is scoped to `user_id`, not `cycle_id` — `docs/SPEC.md` §2) — it must keep accumulating across cycle boundaries, never reset.

## Definition of done

- Completing a slot increments both `completions` and `scheduled` for that slot's bucket.
- Falling off a slot increments `scheduled` only, not `completions`.
- A bucket with `scheduled < 3` is reported as untrusted/neutral by whatever read-path ticket 005 uses; `scheduled >= 3` is reported as trusted with its real rate.
- Values persist across a simulated cycle boundary (two cycles' worth of activity for the same user accumulate in the same rows, not reset).

## Notes
