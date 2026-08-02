---
id: 009
title: Today screen — check off, continuous completion logging
status: done
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

Built `src/lib/today.ts` (`fetchTodaySlots`, `completeSlot`, `todayDateString`) and `src/screens/Today.tsx`.

- **Un-checking: not supported.** No `uncompleteSlot` function exists. Rationale: `completions` rows are the reliability map's primary, continuously-logged signal (CONTEXT.md §8), and ticket 010's triggers only ever increment `reliability_map` on insert — there is no compensating decrement path. Supporting undo would mean either deleting a `completions` row the trigger has already reacted to (leaving `reliability_map` overcounted) or inventing a new decrement trigger, neither of which the spec asks for. Most conservative/reversible: ship check-only; add uncheck (and its trigger-side decrement) as a follow-up ticket if product wants it. Logged to `docs/agents/CLARIFICATIONS.md`.
- `fetchTodaySlots` throws if the given cycle isn't `status: 'active'`, rather than silently returning `[]` — so the screen can never be pointed at a draft/closed cycle by caller error and render nothing when it should have errored loudly. Mirrors the throw-not-silently-fail pattern used by `materializeCycleSlots` (007) and `excuseSlot` (015).
- `completeSlot` refuses (throws) on a slot whose status is `fell_off` or `excused` — same terminal-state guard `excuseSlot` (015) uses for the reverse case — but is idempotent (no-op, no duplicate row) on a slot that's already `completed`, per this ticket's explicit DoD.
- Verified green: `npm run typecheck` and `npm test` (21 files / 133 tests) both pass, against the local Supabase stack + `MODEL_PROVIDER=fixture` `generate` function serve.
