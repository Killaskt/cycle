---
id: 016
title: Disinterest tag — minimum exposure gate before REMOVE
status: done
blocked_by: [004, 012]
---

## Scope

`CONTEXT.md` §9a: the `disinterest` tag cannot trigger `REMOVE` before **3 completed sessions** of that commitment (locked number). Before that threshold, any action that would otherwise be `REMOVE` because of a `disinterest`-tagged fall downgrades to `REDUCE_FREQUENCY` or `MOVE` instead. After 3 completed sessions, `REMOVE` is allowed normally.

This overrides ticket 013's "3rd fall on same slot → REMOVE" specifically when the fall-off history for that slot is tagged `disinterest` and the commitment has fewer than 3 completions.

## Definition of done

- A 3rd-fall-same-slot tagged `disinterest`, with fewer than 3 prior completions on that commitment, produces `REDUCE_FREQUENCY` or `MOVE` (pick one, document the choice), not `REMOVE`.
- The identical scenario with 3+ prior completions on that commitment allows `REMOVE` normally.
- A 3rd fall tagged with anything other than `disinterest` is unaffected by this gate (ticket 013's plain `REMOVE` behavior still applies).

## Notes

Extended `src/lib/amendment.ts` (tickets 012/013's module) rather than a parallel implementation.

- New `applyDisinterestExposureGate` runs only when `proposeAmendment` already computed `REMOVE`
  (occurrence 3). It resolves "the relevant tag" as the **2nd fall's** tag — reusing ticket 013's
  already-established reasoning for the `learnings` downgrade (CLARIFICATIONS.md [013]/[016]) for
  consistency, not the 3rd fall's own tag. Looks up that tag's `label`; if it's not `disinterest`
  (via `tagRepository.ts`'s `normalizeLabel`, now exported as `DISINTEREST_LABEL` for reuse), the
  `REMOVE` proposal passes through unchanged. If it is, counts `completions` joined through
  `slots.commitment_id` for the commitment being considered for removal; `>= 3` also passes
  `REMOVE` through unchanged (exposure met). Below 3, downgrades to **`MOVE`** (picked over
  `REDUCE_FREQUENCY` per the ticket's own guidance — `applyAction`'s switch has no
  `REDUCE_FREQUENCY` case yet and ticket 014 will likely add one, so this avoids touching that
  switch/case list at all, and never did). Reuses the existing `pickMoveTarget` helper for a fresh
  bucket.
- Applied in both `proposeAmendmentForFallOff` (fresh 3rd-fall proposals) and
  `rejectAmendmentWithRevision` (revisions of a rejected proposal) — a rejected/re-proposed
  occurrence-3 amendment re-runs the gate each time rather than trusting the prior proposal's
  action, since `proposeAmendment`'s pure re-computation has no memory of prior gating and
  completions exposure can change between calls.
- The `learnings` confidence downgrade (ticket 013) still runs unconditionally whenever the *raw*
  rule computed `REMOVE`, regardless of whether the gate then downgrades the final proposal to
  `MOVE` — "the 2nd-fall MOVE failed a 3rd time" is a fact independent of what escalation action
  ends up being proposed for it, per the same reasoning ticket 013 already used for not gating the
  downgrade behind user accept/reject.
- Refactored the 2nd-fall lookup shared by both the downgrade and the gate into a new
  `getSecondFallOffTag` helper (previously inlined in `downgradeTagActionLearning`) — same query,
  same guard/throw behavior, now reused instead of duplicated.
- **Did not touch `applyAction`'s switch statement** — `MOVE` was already a handled case before
  this ticket; no new case was added.
- Logged the "relevant tag" + MOVE-vs-REDUCE_FREQUENCY choice as `[016]` in
  `docs/agents/CLARIFICATIONS.md` (medium confidence — the ticket explicitly permitted either
  reading/either action, so this documents the pick rather than flags a true gap).
- Tests: `src/test/integration/fallOff.test.ts`, three new tests nested under ticket 013's "3rd
  occurrence, downscope to REMOVE" describe block — fewer-than-3-completions downgrades to `MOVE`
  (commitment stays active), 3-or-more completions still allows `REMOVE` normally, and the
  `learnings` downgrade still fires even when the gate downgrades the visible action to `MOVE`.
  The DoD's third bullet (non-`disinterest` tags unaffected) is already covered by ticket 013's
  existing `'tired'`-tagged tests, which run with 0 completions and still assert `REMOVE` — no
  new test duplicated that.
- Verified green: `npm run typecheck` clean, `npm test` 172/172 across 25 files (+3 tests from
  the prior 013-era baseline of 169/169 — the actual pre-016 count reflects all tickets done
  through 015/017, not just 013).

Tickets unblocked: none newly unblocked by 016 alone — 014 and 018 were already unblocked by
010/012 and 003/017 respectively.
