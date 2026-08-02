// Today screen support — CONTEXT.md §8 (continuous completion logging);
// docs/SPEC.md §2 (`slots`/`completions`). Ticket 009.
//
// Two DB-touching entry points:
//   - `fetchTodaySlots` — today's `slots` (`scheduled_date == today`) for
//     the cycle's *active* status only. Never returns slots from another
//     date or a non-active cycle.
//   - `completeSlot` — checking off a slot: inserts exactly one
//     `completions` row (slot_id + timestamp) and flips the slot's status
//     to `completed`. Idempotent on a slot that's already `completed` (no
//     duplicate `completions` row). Ticket 010's reliability-map triggers
//     react to the `completions` insert automatically — this module never
//     writes to `reliability_map` itself.
//
// Un-checking is NOT supported (see docs/agents/CLARIFICATIONS.md [009]):
// there is no `uncompleteSlot`. `completions` rows are the primary,
// continuously-logged signal the reliability map is built from (CONTEXT.md
// §8); the DoD and CONTEXT.md are both silent on undo, and reversing a
// completion would mean either deleting history the reliability-map
// triggers have already reacted to (no compensating decrement trigger
// exists) or leaving stale data behind — neither is a safe default to
// invent unasked. Most conservative/reversible: ship check-only now: a
// future ticket can add uncheck plus the trigger-side decrement it would
// require.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Bucket, SlotStatus } from './slots'

export interface TodaySlot {
  id: string
  scheduledDate: string
  bucket: Bucket
  status: SlotStatus
  commitmentId: string
  commitmentName: string
  sessionShape: string
  dur: number
}

export interface CompleteSlotResult {
  slotId: string
  /** `true` if the slot was already `completed` — no new row was inserted. */
  alreadyCompleted: boolean
  completionId: string | null
}

/** `YYYY-MM-DD` for `now` in UTC — consistent with `slots.ts`'s date handling. */
export function todayDateString(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}

interface TodaySlotQueryRow {
  id: string
  scheduled_date: string
  bucket: Bucket
  status: SlotStatus
  commitment_id: string
  commitments: {
    name: string
    session_shape: string
    dur: number
    focus_areas: { cycle_id: string }
  }
}

/**
 * Today's slots for the given cycle — only when that cycle is `active`.
 * Throws if the cycle isn't found or isn't `active`, rather than silently
 * returning an empty list, so a caller can never accidentally render a
 * draft/closed cycle's slots as "today" (CONTEXT.md §8: "one view" scoped
 * to the active cycle only).
 */
export async function fetchTodaySlots(
  client: SupabaseClient,
  cycleId: string,
  todayDate: string = todayDateString(),
): Promise<TodaySlot[]> {
  const { data: cycle, error: cycleError } = await client
    .from('cycles')
    .select('id, status')
    .eq('id', cycleId)
    .single()
  if (cycleError) throw cycleError
  if (!cycle) throw new Error(`cycle ${cycleId} not found`)
  if (cycle.status !== 'active') {
    throw new Error(
      `cycle ${cycleId} is not active (status: ${cycle.status}) — the Today screen only shows an active cycle's slots`,
    )
  }

  const { data, error } = await client
    .from('slots')
    .select(
      'id, scheduled_date, bucket, status, commitment_id, commitments!inner(name, session_shape, dur, focus_areas!inner(cycle_id))',
    )
    .eq('commitments.focus_areas.cycle_id', cycleId)
    .eq('scheduled_date', todayDate)
    .order('bucket', { ascending: true })
  if (error) throw error

  return ((data ?? []) as unknown as TodaySlotQueryRow[]).map((row) => ({
    id: row.id,
    scheduledDate: row.scheduled_date,
    bucket: row.bucket,
    status: row.status,
    commitmentId: row.commitment_id,
    commitmentName: row.commitments.name,
    sessionShape: row.commitments.session_shape,
    dur: row.commitments.dur,
  }))
}

/**
 * Checks off a slot: inserts one `completions` row and sets the slot's
 * status to `completed`. Idempotent — calling this on a slot that's
 * already `completed` inserts nothing and returns `alreadyCompleted: true`
 * (DoD: no duplicate `completions` row).
 *
 * Refuses (throws) on a `fell_off` or `excused` slot: those are terminal,
 * already-logged outcomes (mirrors `excuseSlot`'s same guard, ticket 015 /
 * docs/agents/CLARIFICATIONS.md [015]) — silently overwriting either to
 * `completed` would desync the slot's status from history that already
 * references it (a `fall_offs` row, or a `blocked_windows` row) without
 * deleting that history.
 */
export async function completeSlot(
  client: SupabaseClient,
  slotId: string,
): Promise<CompleteSlotResult> {
  const { data: slotRow, error: slotError } = await client
    .from('slots')
    .select('id, status')
    .eq('id', slotId)
    .single()
  if (slotError) throw slotError
  if (!slotRow) throw new Error(`slot ${slotId} not found`)

  const status = (slotRow as { status: SlotStatus }).status

  if (status === 'completed') {
    return { slotId, alreadyCompleted: true, completionId: null }
  }
  if (status !== 'pending') {
    throw new Error(
      `slot ${slotId} has status "${status}" — only a pending slot can be completed`,
    )
  }

  const { data: completion, error: completionError } = await client
    .from('completions')
    .insert({ slot_id: slotId })
    .select()
    .single()
  if (completionError) throw completionError

  const { error: updateError } = await client
    .from('slots')
    .update({ status: 'completed' })
    .eq('id', slotId)
  if (updateError) throw updateError

  return { slotId, alreadyCompleted: false, completionId: completion.id }
}
