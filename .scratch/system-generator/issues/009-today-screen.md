---
id: 009
title: Today screen — check off, continuous completion logging
status: open
blocked_by: [007, 008]
---

## Scope

`CONTEXT.md` §8. One view: today's `slots` (`scheduled_date == today`) for the active cycle. Check off → insert a `completions` row (slot + timestamp). Un-checking (if supported) removes it — decide and document whichever you pick in this ticket's Notes, since the spec doesn't dictate undo behavior.

Completions log **continuously** — every check-off, not just what feeds the fall-off flow. This is the reliability-map's primary data source (ticket 010).

## Definition of done

- Checking off a slot creates exactly one `completions` row with an accurate timestamp.
- Only today's slots for the active cycle are shown — slots from other dates or other cycles never appear.
- Checking off a slot that's already completed does not create a duplicate `completions` row.

## Notes
