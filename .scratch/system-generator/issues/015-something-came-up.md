---
id: 015
title: "Something came up" — the non-fall external-event tap
status: open
blocked_by: [007]
---

## Scope

`CONTEXT.md` §10, `docs/adr/0006-plan-reality-boundary.md`. A second, lightweight path next to "I Fell Off" for today's slot(s): no survey, no tag, no freeform, no escalation. Writes a `blocked_windows` row (date + optionally the specific `affected_slot_id`) and marks the affected slot `excused` rather than `fell_off`. **Must not** increment either fall-off counter (per-slot or cycle-wide) and **must not** write a `fall_offs` row at all — this is the entire point of the ticket, protecting reliability-map data quality.

## Definition of done

- Tapping "something came up" on a slot sets that slot's status to `excused`, creates a `blocked_windows` row, and creates zero `fall_offs` rows.
- The reliability-map updater (ticket 010) does not count an excused slot as either a completion or a fall — assert `scheduled` does not increment for it either (an excused slot is not a signal about that bucket at all).
- The cycle-wide overload rate calculation (ticket 014) excludes excused slots from its denominator.

## Notes
