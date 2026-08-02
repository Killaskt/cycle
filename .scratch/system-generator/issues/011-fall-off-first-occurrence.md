---
id: 011
title: I Fell Off — 1st occurrence flow
status: open
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
