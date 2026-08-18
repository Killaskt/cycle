---
id: 012
title: I Fell Off — 2nd occurrence, The Amendment (deterministic rule)
status: done
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

Built `src/lib/amendment.ts` (`proposeAmendment` — pure, no DB/model; `proposeAmendmentForFallOff`,
`acceptAmendment`, `rejectAmendmentWithRevision` — DB-touching, "code disposes" per ADR-0004) and
extended `src/lib/fallOff.ts` (ticket 011) so `recordFallOff` requires `mood` and triggers
`proposeAmendmentForFallOff` automatically at exactly `occurrence_in_slot === 2`.

- `proposeAmendment` reuses ticket 005's `wakeOrderedBuckets`/`blockedBucketSet`
  (`supabase/functions/generate/bucketOrder.ts`) for target-bucket selection rather than
  reinventing bucket picking — always proposes a different, non-blocked bucket; deterministic;
  falls back to repeating the current bucket only in the extreme edge case where every
  alternative is blocked or already excluded, so it never throws.
- Reject-with-reason applies its one deterministic revision (excluding the rejected bucket)
  immediately, rather than leaving it pending for a further round — logged as `[012]` in
  `docs/agents/CLARIFICATIONS.md` (medium confidence).
- Resolved the long-open `[context-doc]` "field split between 1st and 2nd fall-off" entry in
  `docs/agents/CLARIFICATIONS.md` — both halves are now built and tested.
- Tests: `src/lib/amendment.test.ts` (7 pure-function tests: always MOVE, different bucket,
  determinism, blocked-bucket avoidance, exclude-for-revision, occurrence guard, enum sync with
  the DB's `action_type`) and `src/test/integration/fallOff.test.ts` (extended — 2nd-fall mood
  requirement, unresolved MOVE proposal creation, accept applies the bucket change for real,
  reject-with-reason logs + applies a different revision, reject requires a non-empty reason).
- Verified green after restarting the local Supabase stack (see `KNOWN_ISSUES.md`'s
  `supabase_vector` restart-loop entry — unrelated infra flakiness, not a code issue):
  `npm run typecheck` clean, `npm test` 150/150 across 23 files.
- This ticket's implementation work was originally produced by a background agent that was
  interrupted mid-task by an account-level usage limit (not a code failure, not a retry-cap
  case) after both `amendment.ts` and the full test suite were already complete and passing —
  finished the wrap-up (CLARIFICATIONS.md entries, this file, verification, commit) directly
  rather than re-running the ticket from scratch.

Tickets unblocked: 013 (needs only 012), 014 (needs 010 + 012, both now done), 016 (needs 004 + 012,
both now done).
