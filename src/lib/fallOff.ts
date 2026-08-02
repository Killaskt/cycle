// I Fell Off — 1st occurrence flow. CONTEXT.md §9a (per-slot escalation
// ladder), docs/adr/0008-two-fall-off-counters.md, docs/SPEC.md §2
// (`fall_offs` table). Ticket 011.
//
// 1st fall on a slot: auto-filled `slot_id` (silent, from context — no user
// input for this field), `tag_id` (via ticket 004's tag repository),
// `what_happened` (verbatim freeform, required). `mood` stays null — per
// docs/agents/CLARIFICATIONS.md's "Exact field split between 1st and 2nd
// fall-off" entry, the mood tap and the possible agent follow-up question
// only start at the 2nd fall (ticket 012), not this one.
//
// `occurrence_in_slot` is computed, never user-entered: count of existing
// `fall_offs` rows for this exact `slot_id`, + 1 — so a repeat fall-off on
// the same slot correctly ladders to 2, 3 (tickets 012/013) instead of
// resetting to 1, while a fall-off on a different slot is independently 1.
// `cycle_id` is denormalized onto the row by reading it off the slot's
// commitment's focus_area's cycle (docs/SPEC.md §2 — ticket 014's
// cycle-wide rate queries read this).
//
// No `amendments` row is created here — 1st fall never changes the plan
// (ticket 012 owns occurrence 2's Amendment).

import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveTag, type ResolveTagInput } from './tagRepository'

export interface RecordFallOffInput {
  slotId: string
  /** Verbatim freeform text, required at every occurrence. */
  whatHappened: string
  tag: ResolveTagInput
}

export interface RecordFallOffResult {
  fallOffId: string
  slotId: string
  cycleId: string
  occurrenceInSlot: number
  tagId: string
}

/**
 * Records a fall-off on a slot. Always computes `occurrence_in_slot` from
 * this slot's existing `fall_offs` history rather than trusting a caller-
 * supplied value, so the per-slot escalation ladder (CONTEXT.md §9a) is
 * driven by real counts.
 *
 * Ticket 011's scope is strictly the 1st-occurrence shape: `mood` is always
 * written `null` here, no `agent_followup_question`/`agent_followup_answer`,
 * and no `amendments` row — regardless of what `occurrence_in_slot` this
 * particular call happens to compute. A future occurrence's fuller field set
 * (mood, the Amendment) is ticket 012, layered on top of this same write
 * path rather than duplicated here.
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

  const { data: fallOff, error: insertError } = await client
    .from('fall_offs')
    .insert({
      slot_id: input.slotId,
      cycle_id: cycleId,
      occurrence_in_slot: occurrenceInSlot,
      what_happened: whatHappened,
      tag_id: tag.id,
      mood: null,
    })
    .select()
    .single()
  if (insertError) throw insertError

  const { error: updateError } = await client
    .from('slots')
    .update({ status: 'fell_off' })
    .eq('id', input.slotId)
  if (updateError) throw updateError

  return {
    fallOffId: fallOff.id,
    slotId: input.slotId,
    cycleId,
    occurrenceInSlot,
    tagId: tag.id,
  }
}
