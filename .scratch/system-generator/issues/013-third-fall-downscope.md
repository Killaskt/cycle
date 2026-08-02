---
id: 013
title: I Fell Off — 3rd occurrence, same slot — downscope to REMOVE
status: open
blocked_by: [012]
---

## Scope

`CONTEXT.md` §9a, §9d. 3rd fall on the *same slot*, after an amendment already applied: the amendment was wrong. `proposeAmendment()` returns `{ action: 'REMOVE', confidence: 1.0, reasoning: '...' }` for this slot's commitment. Apply the guardrails from `CONTEXT.md` §9d: if the commitment's current state would make `REDUCE_FREQUENCY`/`SHORTEN` hit their floor rather than `REMOVE` outright — not applicable here since 3rd-fall-same-slot always maps directly to `REMOVE` per the escalation table, but the disinterest exposure gate (ticket 016) can override this — check that ticket's blocking relationship before assuming `REMOVE` is unconditional.

Also: downgrade the confidence of whatever `tag → action` mapping is associated with this slot's fall history, in the `learnings` table (`CONTEXT.md` §9a: "downgrade that tag→action mapping's confidence for this user").

## Definition of done

- 3rd fall-off on a slot that already had an accepted or rejected 2nd-fall amendment triggers `REMOVE`, and the commitment (and its future un-completed slots) is actually removed/deactivated.
- A `learnings` row for the relevant `(user_id, tag_id, action)` has its `confidence` reduced (assert it decreases, exact magnitude is an implementation choice — document whatever you pick in Notes).
- A 3rd fall on a slot that has **not** had a 2nd-fall amendment first (shouldn't be reachable via normal flow, but guard against it) does not silently apply `REMOVE` — assert this is either impossible by construction or explicitly rejected.

## Notes
