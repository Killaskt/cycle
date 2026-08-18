---
id: 011
title: I Fell Off — 1st occurrence flow
status: done
blocked_by: [004, 009]
---

## Scope

`CONTEXT.md` §9a. Per-slot 1st fall: auto-filled slot (silent, from context — no user input needed for this field), tag (via ticket 004's repository), freeform "what happened" (verbatim, required). **No mood tap. No agent follow-up question. No plan change.** Reassurance copy only ("back on").

Increments the per-slot fall counter (`fall_offs.occurrence_in_slot = 1`) and the cycle-wide counter (denormalized `cycle_id` on the same row — ticket 014 reads this).

See `docs/agents/CLARIFICATIONS.md` — the exact 1st-vs-2nd field split is a logged assumption, not independently reconfirmed. Build to it, but if it turns out wrong, this ticket is the blast radius, not the whole fall-off system.

## Definition of done

- Submitting a 1st fall-off on a slot creates a `fall_offs` row with `occurrence_in_slot: 1`, populated `tag_id` and `what_happened`, and `mood: null`.
- No `amendments` row is created (no plan change at 1st fall).
- A second fall-off on the *same* slot correctly reads as `occurrence_in_slot: 2` (sets up ticket 012), not reset to 1.
- A fall-off on a *different* slot is an independent `occurrence_in_slot: 1`.

## Notes

Built `src/lib/fallOff.ts` (`recordFallOff`) and `src/test/integration/fallOff.test.ts`. No screen component — DoD is entirely data-layer (mirrors ticket 015's `excuseSlot`, which also shipped module-only); a "Fell Off" screen isn't specified by any ticket's DoD and stays out of scope here.

- `recordFallOff(client, userId, { slotId, whatHappened, tag })`: reads the slot's `cycle_id` via `commitments -> focus_areas -> cycles` (silent, auto-filled, no user input), resolves the tag through ticket 004's `resolveTag`, computes `occurrence_in_slot` by counting existing `fall_offs` rows for that `slot_id` and adding 1, inserts the `fall_offs` row with `mood: null` and no `agent_followup_*`, and creates zero `amendments` rows.
- Also sets the slot's `status` to `'fell_off'` after recording — not asserted by this ticket's DoD, but `today.ts`'s `completeSlot` already guards against and is tested against a `'fell_off'` slot, so something has to write it; logged as an assumption, not independently reconfirmed — `docs/agents/CLARIFICATIONS.md` [011].
- Unlike `completeSlot`/`excuseSlot`, `recordFallOff` does not guard on the slot's current status before writing, since a 2nd/3rd fall-off on the same slot (tickets 012/013) must remain recordable after a prior call already set `status: 'fell_off'`.
- Verified green: `npm run typecheck` and `npm test` (22 files / 138 tests) both pass, against the local Supabase stack.
- Left the `[context-doc]` "Exact field split between 1st and 2nd fall-off" entry in `docs/agents/CLARIFICATIONS.md` `open` (not `resolved`) — this ticket validated only the 1st-fall half; ticket 012 still needs to confirm the 2nd-fall half (mood tap + optional agent follow-up) before that entry can close.
- Ticket 012 (2nd occurrence / Amendment) is now unblocked.
