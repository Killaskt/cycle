---
id: 012
title: I Fell Off — 2nd occurrence, The Amendment (deterministic rule)
status: open
blocked_by: [011]
---

## Scope

`CONTEXT.md` §9b, `docs/adr/0007-deterministic-amendment-mvp.md`, `docs/SPEC.md` §4. 2nd fall on a slot: full field set (slot, tag, freeform, **+ mood tap**), then `proposeAmendment()` — a **pure function, no model, no Edge Function** — returns `{ action: 'MOVE', target, params, reasoning, confidence: 1.0, proposed_by: 'rule' }`.

Render the proposal to the user with its `reasoning`. User accepts, or rejects with a reason (`amendments.rejection_reason`) → the rule proposes exactly one revision (still deterministic — do not build agent-style creative revision logic, that's post-MVP). Both outcomes logged to `amendments` identically regardless of accept/reject, per ADR-0007 — **this logging is the actual point of the ticket**, not the `MOVE` action itself.

At most one agent-chosen follow-up question is described in `CONTEXT.md` §9a for this occurrence ("only when a hypothesis is worth testing") — that requires pattern-detection over prior fall-offs and is explicitly a model-shaped feature. **Out of scope for this ticket**; log it to `docs/agents/CLARIFICATIONS.md` if a ticket seems to need it, don't build an ad hoc version.

## Definition of done

- 2nd fall on a slot captures `mood` (non-null) in addition to the ticket-011 fields.
- `proposeAmendment()` for a 2nd-occurrence fall-off always returns `action: 'MOVE'` with non-empty `reasoning` and `proposed_by: 'rule'`.
- Accepting writes `amendments.user_response = 'accepted'`.
- Rejecting with a reason writes `rejection_reason` and a `revised_action`/`revised_target`/`revised_params` — still deterministic, still logged.
- The commitment's actual `bucket` changes in the DB after an accepted `MOVE` (this ticket must actually apply the action, not just log the proposal — `docs/adr/0004`'s "code disposes" half of the contract).

## Notes
