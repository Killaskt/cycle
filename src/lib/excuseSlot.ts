// "Something came up" — the non-fall external-event tap. CONTEXT.md §10,
// docs/adr/0006-plan-reality-boundary.md, ticket 015.
//
// Structurally separate write path from the fall-off path (ADR-0006): this
// module writes only to `blocked_windows` and `slots.status`. It must never
// import from, or call into, any fall-off/amendment code, and must never
// touch `fall_offs`, `completions`, or `reliability_map` — there is no
// shared code path with those by construction, not just by convention, so
// an excused slot structurally cannot increment either fall-off counter or
// register as a reliability-map observation (tickets 010/014 only ever
// react to `completions`/`fall_offs` inserts, and this module creates
// neither).
//
// This runs post-materialization (ticket 007 has already run for the
// cycle), so unlike the cycle-wide-only blocking at materialization time
// (docs/agents/CLARIFICATIONS.md [007], where `affected_slot_id` had to be
// null because no slot rows existed yet), a real slot row exists here and
// `affected_slot_id` is populated for real.

import type { SupabaseClient } from '@supabase/supabase-js'

export interface ExcuseSlotResult {
  slotId: string
  cycleId: string
  blockedWindowId: string
  date: string
}

/**
 * Marks a single slot as excused because something external came up: no
 * survey, no tag, no freeform text, no escalation. Inserts one
 * `blocked_windows` row (`cycle_id`, `date` = the slot's `scheduled_date`,
 * `affected_slot_id` = this slot) and sets the slot's `status` to
 * `'excused'`. Creates zero `fall_offs` rows — the entire point of this
 * ticket is protecting reliability-map data quality, since an unavoidable
 * absence isn't a fall.
 *
 * Only callable on a `pending` slot — see docs/agents/CLARIFICATIONS.md
 * [015]. The spec doesn't say what should happen if a slot has already
 * been completed or has already fallen off; rewriting either of those
 * terminal, already-logged outcomes to `excused` would silently destroy
 * real history, so this throws instead of overwriting it.
 */
export async function excuseSlot(
  client: SupabaseClient,
  slotId: string,
): Promise<ExcuseSlotResult> {
  const { data: slotRow, error: slotError } = await client
    .from('slots')
    .select('id, scheduled_date, status, commitments!inner(focus_areas!inner(cycle_id))')
    .eq('id', slotId)
    .single()
  if (slotError) throw slotError
  if (!slotRow) throw new Error(`slot ${slotId} not found`)

  const { status, scheduled_date: scheduledDate } = slotRow as unknown as {
    status: string
    scheduled_date: string
  }
  const cycleId = (
    slotRow as unknown as {
      commitments: { focus_areas: { cycle_id: string } }
    }
  ).commitments.focus_areas.cycle_id

  if (status !== 'pending') {
    throw new Error(
      `slot ${slotId} has status "${status}" — only a pending slot can be excused`,
    )
  }

  const { data: blockedWindow, error: blockedError } = await client
    .from('blocked_windows')
    .insert({
      cycle_id: cycleId,
      date: scheduledDate,
      affected_slot_id: slotId,
    })
    .select()
    .single()
  if (blockedError) throw blockedError

  const { error: updateError } = await client
    .from('slots')
    .update({ status: 'excused' })
    .eq('id', slotId)
  if (updateError) throw updateError

  return {
    slotId,
    cycleId,
    blockedWindowId: blockedWindow.id,
    date: scheduledDate,
  }
}
