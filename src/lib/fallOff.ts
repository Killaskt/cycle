// I Fell Off — 1st and 2nd occurrence flow. CONTEXT.md §9a (per-slot
// escalation ladder), docs/adr/0008-two-fall-off-counters.md, docs/SPEC.md
// §2 (`fall_offs` table). Tickets 011 (1st fall) and 012 (2nd fall + The
// Amendment, ./amendment.ts).
//
// 1st fall on a slot: auto-filled `slot_id` (silent, from context — no user
// input for this field), `tag_id` (via ticket 004's tag repository),
// `what_happened` (verbatim freeform, required). `mood` stays null — no
// mood tap at the 1st fall.
//
// 2nd fall on a slot (ticket 012): same fields, **plus `mood`, now
// required**. Confirms the other half of docs/agents/CLARIFICATIONS.md's
// "Exact field split between 1st and 2nd fall-off" entry (see that file —
// this ticket flips it to resolved). The "at most one agent-chosen
// follow-up question" mechanic (CONTEXT.md §9a) requires pattern-detection
// over prior fall-off history and is explicitly model-shaped — out of scope
// for this ticket. `agent_followup_question`/`agent_followup_answer` are
// never written by this module, at any occurrence — left null by design,
// not silently skipped.
//
// `occurrence_in_slot` is computed, never user-entered: count of existing
// `fall_offs` rows for this exact `slot_id`, + 1 — so a repeat fall-off on
// the same slot correctly ladders to 2, 3 (ticket 013) instead of resetting
// to 1, while a fall-off on a different slot is independently 1. Only
// occurrence 2 requires (and writes) `mood`; any other occurrence (1st, or
// 3rd+ — ticket 013's scope, not this one's) writes `mood: null` regardless
// of what's passed in, so this module never guesses at 013's still-unbuilt
// field set.
// `cycle_id` is denormalized onto the row by reading it off the slot's
// commitment's focus_area's cycle (docs/SPEC.md §2 — ticket 014's
// cycle-wide rate queries read this).
//
// At occurrence 2, this also triggers The Amendment
// (`proposeAmendmentForFallOff`, ./amendment.ts): a pure deterministic rule
// proposes a `MOVE`, logged to `amendments` with `user_response` left
// unresolved until the caller renders the proposal and the user accepts or
// rejects it (`acceptAmendment`/`rejectAmendmentWithRevision`).
//
// At occurrence 3 (ticket 013, CONTEXT.md §9a: "the amendment was wrong,
// escalate to REMOVE"), the same trigger fires again — `proposeAmendment`
// now handles occurrence 3 too, proposing `REMOVE` instead of `MOVE`, and
// `proposeAmendmentForFallOff` also downgrades the relevant `learnings`
// tag→action row as a side effect (see ./amendment.ts). No per-slot
// `amendments` row is created at any occurrence other than 2 or 3.
//
// Independently of the per-slot ladder above, ticket 014 (CONTEXT.md §9c,
// ./overload.ts) runs `checkAndApplyCycleWideOverload` after *every*
// `fall_offs` insert, at any occurrence — cycle-wide overload is a totally
// separate diagnosis (ADR-0008) from the per-slot escalation ladder, so it
// isn't gated on occurrence_in_slot the way the per-slot amendment is.

import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveTag, type ResolveTagInput } from './tagRepository'
import { proposeAmendmentForFallOff, type AmendmentProposal } from './amendment'
import { checkAndApplyCycleWideOverload, type CycleWideOverloadResult } from './overload'

export interface RecordFallOffInput {
  slotId: string
  /** Verbatim freeform text, required at every occurrence. */
  whatHappened: string
  tag: ResolveTagInput
  /**
   * Required starting at the 2nd fall on this slot (CONTEXT.md §9a); ignored
   * (always written `null`) at any other occurrence. Since
   * `occurrence_in_slot` is computed server-side from existing history, not
   * caller-supplied, this is validated against the *computed* occurrence,
   * not against which screen the caller thinks it's rendering.
   */
  mood?: string
}

export interface RecordFallOffResult {
  fallOffId: string
  slotId: string
  cycleId: string
  occurrenceInSlot: number
  tagId: string
  /**
   * Present only when this call's `occurrence_in_slot` is 2 (`MOVE`, ticket
   * 012) or 3 (`REMOVE`, ticket 013) — The Amendment.
   */
  amendment?: { amendmentId: string; proposal: AmendmentProposal }
  /**
   * Present only when this fall-off pushed the cycle's trailing-7-day rate
   * over the cycle-wide overload threshold (CONTEXT.md §9c, ticket 014,
   * ./overload.ts). Independent of `amendment` above — both can be present
   * on the same call (e.g. a 2nd fall on one slot that also happens to be
   * the 4th fall cycle-wide).
   */
  cycleWideOverload?: CycleWideOverloadResult
}

/**
 * Records a fall-off on a slot. Always computes `occurrence_in_slot` from
 * this slot's existing `fall_offs` history rather than trusting a caller-
 * supplied value, so the per-slot escalation ladder (CONTEXT.md §9a) is
 * driven by real counts.
 *
 * `mood` is required exactly when the computed `occurrence_in_slot` is 2
 * (throws otherwise) and written `null` for every other occurrence (1st, or
 * 3rd+ — ticket 013's field set, not decided here), regardless of what the
 * caller passed. `agent_followup_question`/`agent_followup_answer` are never
 * written by this function at any occurrence — see the file header.
 *
 * At occurrence 2 or 3, this also calls `proposeAmendmentForFallOff`
 * (./amendment.ts) after the `fall_offs` insert succeeds, logging a `MOVE`
 * (occurrence 2) or `REMOVE` (occurrence 3, ticket 013) proposal to
 * `amendments` (unresolved — the caller still has to render it and call
 * `acceptAmendment`/`rejectAmendmentWithRevision`). No `amendments` row is
 * created at any other occurrence.
 *
 * Unlike `completeSlot`/`excuseSlot` (today.ts / excuseSlot.ts), this does
 * not guard on the slot's current `status`: recording a 2nd or 3rd fall-off
 * on a slot that a prior call already marked `'fell_off'` is the entire
 * point of the escalation ladder, so the same slot must remain writable
 * across repeat calls. What this function does do, as its own side effect
 * (mirroring `completeSlot`/`excuseSlot` each flipping the slot's status as
 * part of their write): after recording, it sets the slot's `status` to
 * `'fell_off'`. `docs/SPEC.md` §2's `slots.status` enum, and `today.ts`'s
 * `completeSlot` (see `today.test.ts`, "refuses to complete a slot that has
 * already fallen off"), already assume something in the system is the one
 * writer of that status value — ticket 011's own DoD is silent on this
 * exact write, so it's logged as an assumption, not independently
 * reconfirmed — see docs/agents/CLARIFICATIONS.md [011].
 */
export async function recordFallOff(
  client: SupabaseClient,
  userId: string,
  input: RecordFallOffInput,
): Promise<RecordFallOffResult> {
  const whatHappened = input.whatHappened.trim()
  if (!whatHappened) {
    throw new Error('what_happened is required')
  }

  const { data: slotRow, error: slotError } = await client
    .from('slots')
    .select('id, commitments!inner(focus_areas!inner(cycle_id))')
    .eq('id', input.slotId)
    .single()
  if (slotError) throw slotError
  if (!slotRow) throw new Error(`slot ${input.slotId} not found`)

  const cycleId = (
    slotRow as unknown as {
      commitments: { focus_areas: { cycle_id: string } }
    }
  ).commitments.focus_areas.cycle_id

  const { tag } = await resolveTag(client, userId, input.tag)

  const { count: priorCount, error: countError } = await client
    .from('fall_offs')
    .select('id', { count: 'exact', head: true })
    .eq('slot_id', input.slotId)
  if (countError) throw countError

  const occurrenceInSlot = (priorCount ?? 0) + 1

  let mood: string | null = null
  if (occurrenceInSlot === 2) {
    const trimmedMood = input.mood?.trim()
    if (!trimmedMood) {
      throw new Error('mood is required on the 2nd fall-off for this slot')
    }
    mood = trimmedMood
  }

  const { data: fallOff, error: insertError } = await client
    .from('fall_offs')
    .insert({
      slot_id: input.slotId,
      cycle_id: cycleId,
      occurrence_in_slot: occurrenceInSlot,
      what_happened: whatHappened,
      tag_id: tag.id,
      mood,
    })
    .select()
    .single()
  if (insertError) throw insertError

  const { error: updateError } = await client
    .from('slots')
    .update({ status: 'fell_off' })
    .eq('id', input.slotId)
  if (updateError) throw updateError

  let amendment: RecordFallOffResult['amendment']
  if (occurrenceInSlot === 2 || occurrenceInSlot === 3) {
    const { amendmentId, proposal } = await proposeAmendmentForFallOff(client, fallOff.id)
    amendment = { amendmentId, proposal }
  }

  const cycleWideOverload = (await checkAndApplyCycleWideOverload(client, fallOff.id)) ?? undefined

  return {
    fallOffId: fallOff.id,
    slotId: input.slotId,
    cycleId,
    occurrenceInSlot,
    tagId: tag.id,
    amendment,
    cycleWideOverload,
  }
}
