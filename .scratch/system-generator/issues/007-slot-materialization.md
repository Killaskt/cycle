---
id: 007
title: Slot materialization from commitments across the cycle window
status: open
blocked_by: [001]
---

## Scope

Given a cycle's `commitments` (each with `freq`, `dur`, `bucket`) and the cycle's `timeframe_days` + `started_at`, generate the concrete `slots` rows (specific `scheduled_date` + `bucket`) spanning the window. Respect `blocked_windows` rows that already exist for the cycle at materialization time (skip/reschedule an affected date rather than double-booking it).

This runs once, at the transition from `draft` to `active` (ticket 008 calls this), not continuously.

## Definition of done

- Given a commitment with `freq: 3` over a 14-day cycle, exactly 3 `slots` rows per week are created, distributed across days consistent with `bucket` (weekday vs weekend).
- A `blocked_windows` row for a date within the window results in no slot being placed on that date for an affected commitment.
- Re-running materialization for the same cycle is a no-op or explicitly rejected (must not double-create slots) — pick one and assert it.

## Notes
