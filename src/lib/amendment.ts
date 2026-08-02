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
// Scope is strictly `occurrence_in_slot === 2` -> `MOVE`. The 3rd-fall
// `REMOVE` escalation (CONTEXT.md §9a's ladder) is ticket 013's extension of
// this same contract; cycle-wide overload (§9c) is ticket 014's. Neither is
// built here.
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
 * Pure rule — no DB, no model, no network (ADR-0007). For the 2nd fall on a
 * slot, always proposes `MOVE` to a different bucket with `confidence: 1.0`
 * and non-empty `reasoning`. `excludeBuckets` lets a caller ask for a
 * revision that avoids a previously-proposed (and rejected) target —
 * `rejectAmendmentWithRevision` below is the only caller that uses it.
 *
 * Throws for any `occurrence_in_slot` other than 2: this ticket's scope is
 * strictly the 2nd fall. Occurrence 3 (`REMOVE`) is ticket 013's extension
 * of this same function/contract, not a case silently handled here.
 */
export function proposeAmendment(
  fallOff: FallOffAmendmentContext,
  excludeBuckets: Bucket[] = [],
): AmendmentProposal {
  if (fallOff.occurrenceInSlot !== 2) {
    throw new Error(
      `proposeAmendment (ticket 012) only handles occurrence_in_slot === 2 (got ${fallOff.occurrenceInSlot}) — the 3rd-fall REMOVE escalation is ticket 013's scope`,
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
 * DB: the slot's commitment + current bucket, the owning cycle's wake_time,
 * and that cycle's blocked dates. Read-only — no mutation.
 */
async function loadAmendmentContext(
  client: SupabaseClient,
  fallOffId: string,
): Promise<{ fallOff: FallOffRow; context: FallOffAmendmentContext }> {
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
    .select('wake_time')
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
 * itself change the commitment's `bucket` — per ADR-0004, code only
 * "disposes" once the user has actually responded via `acceptAmendment` or
 * `rejectAmendmentWithRevision`.
 */
export async function proposeAmendmentForFallOff(
  client: SupabaseClient,
  fallOffId: string,
): Promise<ProposeAmendmentResult> {
  const { fallOff, context } = await loadAmendmentContext(client, fallOffId)
  const proposal = proposeAmendment(context)

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
 * commitment. Scoped to `MOVE` only — this ticket's rule never proposes
 * anything else, and executing the rest of the enum is ticket 013
 * (`REMOVE`) / 014 (cycle-wide)'s concern, each meant to extend this same
 * switch rather than duplicate it.
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
    default:
      throw new Error(
        `applyAction: action '${action}' is not handled by ticket 012's amendment path (only MOVE is in scope here)`,
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

  const { context } = await loadAmendmentContext(client, amendment.fall_off_id)
  const originalBucket = (amendment.params as { bucket?: Bucket }).bucket
  const revision = proposeAmendment(context, originalBucket ? [originalBucket] : [])

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
