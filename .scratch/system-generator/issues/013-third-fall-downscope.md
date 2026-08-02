---
id: 013
title: I Fell Off — 3rd occurrence, same slot — downscope to REMOVE
status: done
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

Extended `src/lib/amendment.ts` (ticket 012's module, not a parallel implementation) and
`src/lib/fallOff.ts` (ticket 011/012's `recordFallOff`) rather than rewriting either.

- `proposeAmendment` now handles `occurrenceInSlot === 3` -> `{ action: 'REMOVE', target:
  { commitment_id }, params: {}, reasoning, confidence: 1.0, proposed_by: 'rule' }`; still throws
  for any occurrence other than 2 or 3.
- `applyAction`'s switch gained a `REMOVE` case. The `commitments` table had no
  active/removed flag, and a hard `delete from commitments` cascades to `slots` and then hits
  `fall_offs.slot_id`'s un-cascaded FK, which would fail (or, if fall_offs were deleted too,
  would destroy fall-off/amendment history the product's retention thesis depends on —
  CONTEXT.md §1/§16). Added a new migration
  (`supabase/migrations/20260802020000_commitments_removed_at.sql`) adding nullable
  `commitments.removed_at timestamptz` (null = active); `REMOVE` sets it and deletes the
  commitment's still-`pending` slots only ("future un-completed slots" per this ticket's DoD —
  `pending` is the only non-terminal `slots.status` value). `completed`/`fell_off`/`excused`
  slots, and all `fall_offs`/`amendments` rows, are left untouched. Also updated
  `docs/SPEC.md` and `src/test/integration/schema.test.ts` for the new column. Logged as
  `[013]` in `docs/agents/CLARIFICATIONS.md` (medium confidence).
- `fallOff.ts`'s `recordFallOff` now triggers `proposeAmendmentForFallOff` at occurrence 2
  *or* 3 (was 2 only).
- **Learnings downgrade**: `downgradeTagActionLearning` (new, in `amendment.ts`) runs inside
  `proposeAmendmentForFallOff` whenever the computed proposal is `REMOVE` (i.e. exactly at
  occurrence 3) — not gated behind the user accepting/rejecting the `REMOVE` proposal, since
  "this tag→action mapping already failed once" is a fact independent of what happens to the
  *current* proposal. It downgrades `(user_id, tag_id, action)` where `tag_id` is the 2nd
  fall's tag and `action` is whatever was actually applied from the 2nd-fall amendment
  (`amendments.action`, or `.revised_action` if rejected-and-revised). **Magnitude: fixed
  `-0.20` absolute step, floored at 0** (`LEARNING_DOWNGRADE_STEP`), upserting a new row at
  the schema default `0.50` minus the step if none exists yet, and incrementing
  `sample_size`. Both the tag/action selection and the magnitude/timing are logged as
  `[013]` entries in `docs/agents/CLARIFICATIONS.md` (spec is silent on both).
- **Guard against a 3rd fall reaching `REMOVE` without a prior 2nd-fall amendment**:
  `downgradeTagActionLearning` looks up the 2nd-fall's `fall_offs` row and its `amendments`
  row and throws if either is missing — this doubles as the explicit guard the DoD asks for.
  Via `recordFallOff`'s normal flow this is unreachable by construction (occurrence 2 always
  synchronously creates both rows before an occurrence-3 call is even possible, since
  `occurrence_in_slot` is computed from real row counts), but `proposeAmendmentForFallOff` is
  also directly callable, so the guard is real, not decorative — exercised in
  `src/test/integration/fallOff.test.ts` by bypassing `recordFallOff` and inserting a
  `fall_offs` row directly at `occurrence_in_slot: 3` with no occurrence-2 row.
- Tests: `src/lib/amendment.test.ts` (3 new pure-function tests for occurrence 3: always
  `REMOVE`/confidence/reasoning/no-params, determinism, no character-blame framing; updated
  the old "throws for any occurrence other than 2" test since 3 no longer throws) and
  `src/test/integration/fallOff.test.ts` (5 new tests: REMOVE proposal shape, accept
  soft-deletes the commitment + deletes future pending slots while preserving the fallen
  slot's history, learnings downgrade after accept, learnings downgrade + REMOVE proposal
  after the 2nd-fall amendment was rejected-with-revision instead of accepted, and the
  no-prior-2nd-fall-amendment guard).
- Ticket 016 (disinterest exposure gate, `blocked_by: [004, 012]`) is *not* blocked by this
  ticket and therefore lands after it, overriding this ticket's unconditional `REMOVE` when a
  `disinterest`-tagged fall has fewer than 3 prior completions — nothing here implements that
  gate, per the ticket's own scope note.
- Verified green: `npm run typecheck` clean, `npm test` 158/158 across 23 files (was 150/150
  after ticket 012; +8 new tests, 0 removed).

Tickets unblocked: none newly unblocked by 013 alone — 014 and 016 were already unblocked by
010/012 per ticket 012's notes.
