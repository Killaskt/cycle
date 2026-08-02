// The Amendment — CONTEXT.md §9b, docs/adr/0004-agent-proposes-code-disposes-
// action-enum.md, docs/adr/0007-deterministic-amendment-mvp.md, docs/SPEC.md
// §4 (`proposeAmendment` contract) and §2 (`amendments` table). Ticket 012.
//
// ADR-0004's "agent proposes, code disposes": `proposeAmendment` is a pure
// function — no DB, no model, no network — that only ever computes a
// proposal `{ action, target, params, reasoning, confidence, proposed_by }`.
// Turning that proposal into a real DB mutation ("code disposes") is a
// separate, explicit step (`acceptAmendment` / `rejectAmendmentWithRevision`)
// so a bad or rejected proposal can never mutate a commitment on its own —
// the same guarantee a future model-based proposer gets for free by sitting
// behind this same contract.
//
// Ticket 012 built `occurrence_in_slot === 2` -> `MOVE`. Ticket 013 adds
// `occurrence_in_slot === 3` -> `REMOVE` (CONTEXT.md §9a's ladder: "the
// amendment was wrong, escalate to REMOVE") plus the tag→action `learnings`
// confidence downgrade CONTEXT.md §9a calls for at that same occurrence.
// Cycle-wide overload (§9c) is ticket 014's, still not built here.
//
// Ticket 016 (this extension) adds the disinterest-tag exposure gate
// (CONTEXT.md §9a: "cannot trigger REMOVE before 3 completed sessions") in
// front of 013's unconditional occurrence-3 REMOVE — see
// `applyDisinterestExposureGate` below. Applied both where a fresh proposal
// is created (`proposeAmendmentForFallOff`) and where a rejected proposal is
// revised (`rejectAmendmentWithRevision`), so neither path can bypass it.
//
// The "at most one agent-chosen follow-up question" mechanic (CONTEXT.md
// §9a: "only if a hypothesis is worth testing... e.g. 3 morning falls tagged
// 'tired' earns 'what time have you been getting to sleep?'") requires
// pattern-detection over prior fall-off history and is explicitly
// model-shaped — out of scope for this ticket. `fall_offs.
// agent_followup_question`/`.agent_followup_answer` are never written here;
// see docs/agents/CLARIFICATIONS.md's "field split between 1st and 2nd
// fall-off" entry, which this ticket resolves the previously-open half of.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Bucket } from './slots'
import { blockedBucketSet, wakeOrderedBuckets } from '../../supabase/functions/generate/bucketOrder'
import { DISINTEREST_LABEL, normalizeLabel } from './tagRepository'

/**
 * ADR-0004's bounded `ActionType` enum, defined once here in application
 * code — the DB's `action_type` enum (docs/SPEC.md §2) is the schema source
 * of truth this must stay in sync with (see
 * src/test/integration/schema.test.ts's `actionTypeValues`). Any future
 * prompt's action menu is generated from this array at runtime, never
 * hand-maintained as a second parallel list (ADR-0004).
 */
export const ACTION_TYPES = [
  'NONE',
  'MOVE',
  'SHORTEN',
  'REDUCE_FREQUENCY',
  'REALLOCATE',
  'EASE_NEXT_DAY',
  'REMOVE',
  'UNHANDLED',
] as const
export type ActionType = (typeof ACTION_TYPES)[number]

export interface AmendmentTarget {
  commitment_id: string
}

export interface AmendmentProposal {
  action: ActionType
  target: AmendmentTarget
  params: Record<string, unknown>
  /** Non-empty, human-readable — CONTEXT.md §9e's guardrail: describes the plan as wrong, never the person. */
  reasoning: string
  confidence: number
  proposed_by: 'rule'
}

export interface FallOffAmendmentContext {
  commitmentId: string
  currentBucket: Bucket
  wakeTime: string
  occurrenceInSlot: number
  /** This cycle's blocked dates (docs/SPEC.md §5's `blocked_windows`), so a MOVE never targets a known-blocked day_type. */
  blockedDates?: string[]
}

// CONTEXT.md §9e: never attribute failure to character/discipline/
// willpower, describe the plan as wrong, never the person. Fixed string —
// ADR-0007 requires the same reasoning text a real agent's MOVE-at-2nd-fall
// output would need to satisfy, not a template that varies per call.
const MOVE_REASONING =
  "This has fallen off twice at this time. The plan was wrong for this slot, not you — moving it to a different time of day keeps the same commitment without adding or removing anything."

// CONTEXT.md §9a's 3rd-fall row: "the amendment was wrong" — the *plan*
// (specifically, the MOVE tried at the 2nd fall), never the person. §9e:
// copy escalates in directness, not interrogation, as falls accumulate.
const REMOVE_REASONING =
  "This has fallen off a third time, even after moving it. The plan for this commitment was wrong, not you — removing it stops it from continuing to fail rather than trying the same thing again."

/**
 * Picks the next candidate bucket after `current` in wake-time scan order —
 * reusing ticket 005's `wakeOrderedBuckets`/`blockedBucketSet`
 * (`supabase/functions/generate/bucketOrder.ts`, docs/SPEC.md §3) rather
 * than reinventing bucket selection. Skips `current` itself, every bucket in
 * `exclude` (already-proposed/already-rejected targets), and every bucket
 * blocked for this cycle. Falls back to any non-blocked bucket other than
 * `current` if every alternative has been excluded (extreme edge case:
 * every other bucket is either blocked or already tried), and only as an
 * absolute last resort repeats `current` — a `MOVE` proposal must always be
 * producible, never throw.
 */
function pickMoveTarget(current: Bucket, wakeTime: string, blockedDates: string[], exclude: Bucket[]): Bucket {
  const blocked = blockedBucketSet(blockedDates.map((date) => ({ date })))
  const order = wakeOrderedBuckets(wakeTime) as Bucket[]
  const excludeSet = new Set<Bucket>([current, ...exclude])

  const preferred = order.find((b) => !blocked.has(b) && !excludeSet.has(b))
  if (preferred) return preferred

  const anyNonBlockedAlternative = order.find((b) => !blocked.has(b) && b !== current)
  return anyNonBlockedAlternative ?? current
}

/**
 * Pure rule — no DB, no model, no network (ADR-0007).
 *
 * Occurrence 2: always proposes `MOVE` to a different bucket with
 * `confidence: 1.0` and non-empty `reasoning`. `excludeBuckets` lets a
 * caller ask for a revision that avoids a previously-proposed (and
 * rejected) target — `rejectAmendmentWithRevision` below is the only caller
 * that uses it.
 *
 * Occurrence 3 (ticket 013, CONTEXT.md §9a's ladder — "the amendment was
 * wrong, escalate to REMOVE"): always proposes `REMOVE` on the same
 * commitment, `confidence: 1.0`, non-empty `reasoning`. No `params` —
 * `REMOVE` has no magnitude to tune (CONTEXT.md §9d lists a magnitude only
 * for `SHORTEN`/`REDUCE_FREQUENCY`/`EASE_NEXT_DAY`/`REALLOCATE`; `MOVE` and
 * `REMOVE` are both magnitude-less). `excludeBuckets` is unused for this
 * branch (nothing to avoid — `REMOVE` doesn't pick a bucket).
 *
 * Throws for any other `occurrence_in_slot` — this function's scope is
 * strictly the 2nd and 3rd fall.
 */
export function proposeAmendment(
  fallOff: FallOffAmendmentContext,
  excludeBuckets: Bucket[] = [],
): AmendmentProposal {
  if (fallOff.occurrenceInSlot === 3) {
    return {
      action: 'REMOVE',
      target: { commitment_id: fallOff.commitmentId },
      params: {},
      reasoning: REMOVE_REASONING,
      confidence: 1.0,
      proposed_by: 'rule',
    }
  }

  if (fallOff.occurrenceInSlot !== 2) {
    throw new Error(
      `proposeAmendment only handles occurrence_in_slot 2 (MOVE) or 3 (REMOVE) — got ${fallOff.occurrenceInSlot}`,
    )
  }

  const bucket = pickMoveTarget(fallOff.currentBucket, fallOff.wakeTime, fallOff.blockedDates ?? [], excludeBuckets)

  return {
    action: 'MOVE',
    target: { commitment_id: fallOff.commitmentId },
    params: { bucket },
    reasoning: MOVE_REASONING,
    confidence: 1.0,
    proposed_by: 'rule',
  }
}

interface FallOffRow {
  id: string
  occurrence_in_slot: number
  slot_id: string
}

/**
 * Gathers everything `proposeAmendment` needs for this fall-off from the
 * DB: the slot's commitment + current bucket, the owning cycle's wake_time
 * + user_id, and that cycle's blocked dates. Read-only — no mutation.
 * `userId` is returned alongside (not part of `FallOffAmendmentContext`,
 * which stays exactly what the pure `proposeAmendment` rule needs) for the
 * occurrence-3 `learnings` downgrade, which is scoped to `user_id` (ticket
 * 013, docs/SPEC.md §2's `learnings` table).
 */
async function loadAmendmentContext(
  client: SupabaseClient,
  fallOffId: string,
): Promise<{ fallOff: FallOffRow; context: FallOffAmendmentContext; userId: string }> {
  const { data: fallOffRow, error: fallOffError } = await client
    .from('fall_offs')
    .select('id, occurrence_in_slot, slot_id')
    .eq('id', fallOffId)
    .single()
  if (fallOffError) throw fallOffError
  if (!fallOffRow) throw new Error(`fall_off ${fallOffId} not found`)

  const { data: slotRow, error: slotError } = await client
    .from('slots')
    .select('id, bucket, commitment_id, commitments!inner(focus_areas!inner(cycle_id))')
    .eq('id', fallOffRow.slot_id)
    .single()
  if (slotError) throw slotError
  if (!slotRow) throw new Error(`slot ${fallOffRow.slot_id} not found`)

  const cycleId = (
    slotRow as unknown as { commitments: { focus_areas: { cycle_id: string } } }
  ).commitments.focus_areas.cycle_id
  const commitmentId = (slotRow as unknown as { commitment_id: string }).commitment_id
  const currentBucket = (slotRow as unknown as { bucket: Bucket }).bucket

  const { data: cycleRow, error: cycleError } = await client
    .from('cycles')
    .select('wake_time, user_id')
    .eq('id', cycleId)
    .single()
  if (cycleError) throw cycleError
  if (!cycleRow) throw new Error(`cycle ${cycleId} not found`)

  const { data: blockedRows, error: blockedError } = await client
    .from('blocked_windows')
    .select('date')
    .eq('cycle_id', cycleId)
  if (blockedError) throw blockedError

  return {
    fallOff: fallOffRow as FallOffRow,
    context: {
      commitmentId,
      currentBucket,
      wakeTime: (cycleRow as { wake_time: string }).wake_time,
      occurrenceInSlot: fallOffRow.occurrence_in_slot,
      blockedDates: (blockedRows ?? []).map((b: { date: string }) => b.date),
    },
    userId: (cycleRow as { user_id: string }).user_id,
  }
}

/**
 * Fixed absolute confidence decrement applied to the `(user_id, tag_id,
 * action)` `learnings` row when a 3rd fall proves that mapping's action
 * choice wrong (CONTEXT.md §9a: "downgrade that tag→action mapping's
 * confidence for this user"). Floored at 0 — confidence is never negative.
 * 0.20 is a deliberately large single-event step (versus e.g. a smoothed
 * running average): one instance of "we tried this action for this tag and
 * the plan still failed" is exactly the kind of strong, cheap-to-collect
 * signal CONTEXT.md §16 calls out as reversible/tunable-from-data later —
 * see this ticket's Notes for the full reasoning and how to retune it.
 */
const LEARNING_DOWNGRADE_STEP = 0.2

interface SecondFallOffTag {
  fallOffId: string
  tagId: string
}

/**
 * Shared by `downgradeTagActionLearning` (ticket 013) and
 * `applyDisinterestExposureGate` (ticket 016) — both need "the 2nd fall's
 * tag," per the same reasoning docs/agents/CLARIFICATIONS.md's [013] "Which
 * tag→action mapping gets downgraded on a 3rd fall" entry already settled:
 * that's the tag/action pair the now-proven-wrong 2nd-fall amendment traces
 * back to, not the 3rd fall's own tag (which by definition hasn't yet been
 * associated with any amendment/action). Ticket 016 reuses this same
 * reasoning for "the relevant tag" its gate checks, for consistency rather
 * than re-deriving a different answer.
 *
 * Throws if no 2nd-fall `fall_offs` row exists for this slot — doubles as
 * ticket 013's guard against a 3rd fall reaching this point without a prior
 * 2nd-fall amendment (see callers' docs).
 */
async function getSecondFallOffTag(client: SupabaseClient, slotId: string): Promise<SecondFallOffTag> {
  const { data: secondFallOff, error } = await client
    .from('fall_offs')
    .select('id, tag_id')
    .eq('slot_id', slotId)
    .eq('occurrence_in_slot', 2)
    .maybeSingle()
  if (error) throw error
  if (!secondFallOff) {
    throw new Error(
      `3rd fall on slot ${slotId} has no 2nd-fall fall_offs row — REMOVE requires a prior amendment at occurrence 2`,
    )
  }
  return { fallOffId: secondFallOff.id, tagId: secondFallOff.tag_id }
}

/**
 * Occurrence-3 side effect (CONTEXT.md §9a): find the tag→action mapping
 * that produced the now-proven-wrong 2nd-fall amendment for this slot, and
 * reduce its `learnings` confidence. The "tag" is the 2nd fall's `tag_id`
 * (the fall that *caused* the amendment now being escalated past) and the
 * "action" is whatever was actually applied from that amendment — `action`
 * normally, or `revised_action` if the user rejected the original proposal
 * (both are always `MOVE` under ticket 012's deterministic rule, but this
 * reads the real applied value rather than hardcoding that).
 *
 * Doubles as this ticket's explicit guard against a 3rd fall reaching this
 * point without a prior 2nd-fall amendment: throws if no 2nd-fall
 * `fall_offs` row, or no `amendments` row for it, exists for this slot.
 * Via `recordFallOff`'s normal flow this is unreachable (occurrence 2
 * always synchronously creates the fall_offs row *and* its amendments row
 * before an occurrence-3 call is even possible — occurrence_in_slot is
 * computed from real row counts), but this function is also reachable
 * directly (as `proposeAmendmentForFallOff` is), so the guard is real, not
 * decorative.
 *
 * Upserts a new `learnings` row at the DB default (`confidence: 0.50`)
 * minus the step if none exists yet — 0.50 is the schema's own default for
 * an as-yet-unobserved mapping (docs/SPEC.md §2), so a downgrade starting
 * from "neutral, never observed" is the same default every other consumer
 * of this table would read before this ticket's data ever existed.
 */
async function downgradeTagActionLearning(client: SupabaseClient, userId: string, slotId: string): Promise<void> {
  const { fallOffId: secondFallOffId, tagId: secondFallOffTagId } = await getSecondFallOffTag(client, slotId)

  const { data: secondAmendment, error: secondAmendmentError } = await client
    .from('amendments')
    .select('action, revised_action, user_response')
    .eq('fall_off_id', secondFallOffId)
    .maybeSingle()
  if (secondAmendmentError) throw secondAmendmentError
  if (!secondAmendment) {
    throw new Error(
      `3rd fall on slot ${slotId}: the 2nd-fall fall_off ${secondFallOffId} has no amendments row — REMOVE requires a prior amendment at occurrence 2`,
    )
  }

  const appliedAction = (
    secondAmendment.user_response === 'rejected' ? secondAmendment.revised_action : secondAmendment.action
  ) as ActionType

  const { data: existingLearning, error: learningError } = await client
    .from('learnings')
    .select('confidence, sample_size')
    .eq('user_id', userId)
    .eq('tag_id', secondFallOffTagId)
    .eq('action', appliedAction)
    .maybeSingle()
  if (learningError) throw learningError

  const baseConfidence = existingLearning?.confidence ?? 0.5
  const nextConfidence = Math.max(0, Math.round((baseConfidence - LEARNING_DOWNGRADE_STEP) * 100) / 100)
  const nextSampleSize = (existingLearning?.sample_size ?? 0) + 1

  const { error: upsertError } = await client.from('learnings').upsert(
    {
      user_id: userId,
      tag_id: secondFallOffTagId,
      action: appliedAction,
      confidence: nextConfidence,
      sample_size: nextSampleSize,
    },
    { onConflict: 'user_id,tag_id,action' },
  )
  if (upsertError) throw upsertError
}

// CONTEXT.md §9a: "disinterest... cannot trigger REMOVE before 3 completed
// sessions" (locked number).
const MINIMUM_COMPLETIONS_BEFORE_REMOVE = 3

// CONTEXT.md §9e: describe the plan as wrong, never the person; copy
// escalates in directness, not interrogation. This sits *between* the 2nd
// fall's MOVE and the full REMOVE — the plan gets one more honest change
// before removal is back on the table.
const DISINTEREST_GATE_REASONING =
  "This has fallen off a third time and is tagged as not clicking for you yet — but it hasn't had enough real tries to justify removing it. Moving it to a different time of day gives the plan one more honest chance before we consider cutting it."

/**
 * CONTEXT.md §9a's disinterest exposure gate (ticket 016): the `disinterest`
 * tag cannot trigger `REMOVE` before 3 completed sessions of the commitment.
 * Only relevant when the pure rule already proposed `REMOVE` (occurrence 3)
 * — any other action passes through untouched.
 *
 * "The relevant tag" is the 2nd fall's tag (`getSecondFallOffTag`), per the
 * same reasoning ticket 013 already established for the learnings downgrade
 * — see that function's doc comment. Not the 3rd fall's own tag.
 *
 * Downgrades to `MOVE`, not `REDUCE_FREQUENCY` (the ticket's DoD allows
 * either): `applyAction`'s switch has no `REDUCE_FREQUENCY` case yet (ticket
 * 014 will likely add one for cycle-wide overload), and `MOVE` alone already
 * satisfies the DoD, so this avoids touching that switch/case list and any
 * collision risk with 014. `MOVE` is also already the exact mechanism this
 * slot fell back to once before at occurrence 2, so reusing it here needs no
 * new machinery — just a fresh bucket pick via the same `pickMoveTarget`
 * occurrence-2 already uses.
 */
async function applyDisinterestExposureGate(
  client: SupabaseClient,
  proposal: AmendmentProposal,
  context: FallOffAmendmentContext,
  slotId: string,
  excludeBuckets: Bucket[],
): Promise<AmendmentProposal> {
  if (proposal.action !== 'REMOVE') return proposal

  const { tagId } = await getSecondFallOffTag(client, slotId)

  const { data: tagRow, error: tagError } = await client
    .from('tags')
    .select('label')
    .eq('id', tagId)
    .maybeSingle()
  if (tagError) throw tagError
  if (!tagRow || normalizeLabel(tagRow.label) !== DISINTEREST_LABEL) return proposal

  const { count, error: completionsError } = await client
    .from('completions')
    .select('id, slots!inner(commitment_id)', { count: 'exact', head: true })
    .eq('slots.commitment_id', context.commitmentId)
  if (completionsError) throw completionsError
  if ((count ?? 0) >= MINIMUM_COMPLETIONS_BEFORE_REMOVE) return proposal

  const bucket = pickMoveTarget(context.currentBucket, context.wakeTime, context.blockedDates ?? [], excludeBuckets)

  return {
    action: 'MOVE',
    target: proposal.target,
    params: { bucket },
    reasoning: DISINTEREST_GATE_REASONING,
    confidence: 1.0,
    proposed_by: 'rule',
  }
}

export interface ProposeAmendmentResult {
  amendmentId: string
  proposal: AmendmentProposal
}

/**
 * DB-touching orchestrator: loads this fall-off's slot/commitment/cycle
 * context, computes the pure `proposeAmendment` proposal, and inserts one
 * `amendments` row with `user_response` left null (unresolved). Does **not**
 * itself change the commitment's `bucket`/removal state — per ADR-0004,
 * code only "disposes" once the user has actually responded via
 * `acceptAmendment` or `rejectAmendmentWithRevision`.
 *
 * At occurrence 3 only, also runs the `learnings` confidence downgrade
 * (`downgradeTagActionLearning`, ticket 013, CONTEXT.md §9a). This is
 * deliberately *not* gated behind the user accepting/rejecting the `REMOVE`
 * proposal: unlike a commitment mutation (which ADR-0004 requires stay
 * pending until disposed), "this tag→action mapping's prior application
 * failed" is a fact about what already happened, established the moment
 * the 3rd fall_offs row exists — the same trigger point ticket 010's
 * reliability-map triggers react to raw fall_offs/completions inserts
 * regardless of any later amendment outcome.
 */
export async function proposeAmendmentForFallOff(
  client: SupabaseClient,
  fallOffId: string,
): Promise<ProposeAmendmentResult> {
  const { fallOff, context, userId } = await loadAmendmentContext(client, fallOffId)
  let proposal = proposeAmendment(context)

  if (proposal.action === 'REMOVE') {
    // Downgrade happens regardless of the disinterest gate's outcome below:
    // "the 2nd-fall MOVE failed a 3rd time" is a fact established the
    // moment this 3rd fall_offs row exists, independent of what escalation
    // action ends up being proposed for it (ticket 013's reasoning, CONTEXT.md
    // §9a) — CLARIFICATIONS.md [013] "Downgrade magnitude and timing".
    await downgradeTagActionLearning(client, userId, fallOff.slot_id)
    proposal = await applyDisinterestExposureGate(client, proposal, context, fallOff.slot_id, [])
  }

  const { data: inserted, error } = await client
    .from('amendments')
    .insert({
      fall_off_id: fallOff.id,
      action: proposal.action,
      target: proposal.target,
      params: proposal.params,
      reasoning: proposal.reasoning,
      confidence: proposal.confidence,
      proposed_by: proposal.proposed_by,
    })
    .select()
    .single()
  if (error) throw error

  return { amendmentId: inserted.id, proposal }
}

/**
 * "Code disposes" (ADR-0004): the only place a proposal actually mutates a
 * commitment. `MOVE` (ticket 012) and `REMOVE` (ticket 013) are in scope;
 * the rest of the enum is ticket 014 (cycle-wide)'s concern, meant to
 * extend this same switch rather than duplicate it.
 *
 * `REMOVE` is a soft-delete (`commitments.removed_at`, migration
 * `20260802020000_commitments_removed_at.sql`) — never a hard `delete from
 * commitments`, which would cascade-delete `slots` and hit `fall_offs`'
 * un-cascaded FK to `slots`, destroying fall-off/amendment history a hard
 * delete has no way to preserve (see that migration's comment). Alongside
 * the soft-delete, this deletes the commitment's still-`pending` slots —
 * "future un-completed slots" per this ticket's DoD; `pending` is the only
 * non-terminal `slots.status` value, so it's the correct filter for
 * "future and un-completed" without needing an explicit date comparison.
 * Slots already `completed`/`fell_off`/`excused` are left untouched — they
 * are exactly the history this whole soft-delete design exists to keep.
 */
async function applyAction(
  client: SupabaseClient,
  action: ActionType,
  target: AmendmentTarget,
  params: Record<string, unknown>,
): Promise<void> {
  switch (action) {
    case 'MOVE': {
      const bucket = (params as { bucket?: Bucket }).bucket
      if (!bucket) throw new Error('MOVE params missing bucket')
      const { error } = await client.from('commitments').update({ bucket }).eq('id', target.commitment_id)
      if (error) throw error
      return
    }
    case 'REMOVE': {
      const { error: removeError } = await client
        .from('commitments')
        .update({ removed_at: new Date().toISOString() })
        .eq('id', target.commitment_id)
      if (removeError) throw removeError

      const { error: slotsError } = await client
        .from('slots')
        .delete()
        .eq('commitment_id', target.commitment_id)
        .eq('status', 'pending')
      if (slotsError) throw slotsError
      return
    }
    default:
      throw new Error(
        `applyAction: action '${action}' is not handled by this amendment path yet (only MOVE/REMOVE are in scope)`,
      )
  }
}

/**
 * Accept: writes `user_response: 'accepted'` and actually applies the
 * proposed action to the commitment (docs/SPEC.md's amendments DoD — "the
 * commitment's actual bucket changes in the DB", ADR-0004's "code disposes"
 * half of the contract, not just logging the proposal). Throws if this
 * amendment has already been responded to, rather than silently re-applying
 * or overwriting a prior response.
 */
export async function acceptAmendment(client: SupabaseClient, amendmentId: string): Promise<void> {
  const { data: amendment, error } = await client
    .from('amendments')
    .select('id, action, target, params, user_response')
    .eq('id', amendmentId)
    .single()
  if (error) throw error
  if (!amendment) throw new Error(`amendment ${amendmentId} not found`)
  if (amendment.user_response) {
    throw new Error(`amendment ${amendmentId} already has a user_response (${amendment.user_response})`)
  }

  await applyAction(client, amendment.action, amendment.target, amendment.params)

  const { error: updateError } = await client
    .from('amendments')
    .update({ user_response: 'accepted' })
    .eq('id', amendmentId)
    .is('user_response', null)
  if (updateError) throw updateError
}

/**
 * Reject-with-reason: writes `user_response: 'rejected'`, `rejection_reason`,
 * and a `revised_action`/`revised_target`/`revised_params` — one
 * deterministic revision from the same rule (`proposeAmendment`, excluding
 * the already-rejected bucket), never creative/varying logic.
 *
 * The revision is applied immediately (same `applyAction` "code disposes"
 * path as `acceptAmendment`), rather than left pending for a further
 * accept/reject round: ADR-0007 describes reject-with-reason as producing
 * "one revision," and MVP has no further UI round-trip specified for
 * re-offering that revision. This is a logged assumption — see
 * docs/agents/CLARIFICATIONS.md [012].
 */
export async function rejectAmendmentWithRevision(
  client: SupabaseClient,
  amendmentId: string,
  rejectionReason: string,
): Promise<AmendmentProposal> {
  const reason = rejectionReason.trim()
  if (!reason) throw new Error('rejection_reason is required')

  const { data: amendment, error } = await client
    .from('amendments')
    .select('id, fall_off_id, params, user_response')
    .eq('id', amendmentId)
    .single()
  if (error) throw error
  if (!amendment) throw new Error(`amendment ${amendmentId} not found`)
  if (amendment.user_response) {
    throw new Error(`amendment ${amendmentId} already has a user_response (${amendment.user_response})`)
  }

  const { fallOff, context } = await loadAmendmentContext(client, amendment.fall_off_id)
  const originalBucket = (amendment.params as { bucket?: Bucket }).bucket
  const excludeBuckets = originalBucket ? [originalBucket] : []
  let revision = proposeAmendment(context, excludeBuckets)

  if (revision.action === 'REMOVE') {
    // Re-applies the same gate a fresh proposal gets — reachable both when
    // the rejected proposal was itself REMOVE (gate wasn't triggered, or
    // exposure has since crossed the threshold) and when it was the gate's
    // own MOVE downgrade (proposeAmendment's pure re-computation above has
    // no memory of the prior gating and always returns REMOVE for
    // occurrence 3, so the gate must run again here too).
    revision = await applyDisinterestExposureGate(client, revision, context, fallOff.slot_id, excludeBuckets)
  }

  await applyAction(client, revision.action, revision.target, revision.params)

  const { error: updateError } = await client
    .from('amendments')
    .update({
      user_response: 'rejected',
      rejection_reason: reason,
      revised_action: revision.action,
      revised_target: revision.target,
      revised_params: revision.params,
    })
    .eq('id', amendmentId)
    .is('user_response', null)
  if (updateError) throw updateError

  return revision
}
