// Between-cycle regeneration — CONTEXT.md §6; docs/SPEC.md §2 (`cycles`,
// `focus_areas`, `commitments`, `slots`) and §2f (`cycles.review` shape,
// ticket 017). Ticket 018.
//
// This module is the read side: given a *closed* prior cycle, it computes
// each kept goal's completion band (ticket 003's `completionBand`, via
// `computeGoalCompletionRate`) and the concrete `current_freq`/`current_dur`/
// `target_freq`/`target_dur` numbers the next cycle's `focus_areas` should
// start from (`computeNextCycleGoalPlan`, `./generationMath`) — both reused
// verbatim, not reimplemented here. It does not create the new cycle itself
// (no ticket has specified where the new cycle's `timeframe_days`/
// `wake_time` come from — that's a future intake-for-cycle-2 screen's
// decision, not this ticket's) — callers take `NextCycleFocusAreaPlan[]`
// and insert whatever `focus_areas` rows they see fit once a new draft
// cycle exists.
//
// "Kept" = the prior cycle's review marked that goal `keep_next: true`
// (docs/SPEC.md §2f, ticket 017's `submitCycleReview`) — a goal the user
// dropped at cycle-close never gets carried forward, regardless of how it
// performed.

import type { SupabaseClient } from '@supabase/supabase-js'
import { computeNextCycleGoalPlan, type NextCycleGoalPlan } from './generationMath'

export interface NextCycleFocusAreaPlan extends NextCycleGoalPlan {
  focusAreaId: string
  name: string
}

interface CycleReviewRow {
  status: string
  review: { goals?: { focus_area_id: string; keep_next: boolean }[] } | null
}

interface FocusAreaRow {
  id: string
  name: string
  target_freq: number
  target_dur: number
  intake_order: number
}

interface CommitmentRow {
  id: string
  focus_area_id: string
  freq: number
  dur: number
}

interface SlotStatusRow {
  commitment_id: string
  status: string
}

/**
 * Per-goal outcome + next-cycle numbers for every `keep_next: true` goal in
 * a closed prior cycle, ordered by the prior cycle's `intake_order`. Throws
 * if the cycle isn't `closed` yet (no review to read `keep_next` from) or
 * has no review recorded at all.
 */
export async function prepareNextCycleFocusAreas(
  client: SupabaseClient,
  priorCycleId: string,
): Promise<NextCycleFocusAreaPlan[]> {
  const { data: cycleRow, error: cycleError } = await client
    .from('cycles')
    .select('status, review')
    .eq('id', priorCycleId)
    .single()
  if (cycleError) throw cycleError
  if (!cycleRow) throw new Error(`cycle ${priorCycleId} not found`)
  const cycle = cycleRow as CycleReviewRow
  if (cycle.status !== 'closed') {
    throw new Error(
      `cycle ${priorCycleId} is not closed (status: ${cycle.status}) — between-cycle regeneration requires a closed prior cycle`,
    )
  }
  if (!cycle.review || !cycle.review.goals) {
    throw new Error(`cycle ${priorCycleId} has no review recorded — cannot determine keep_next per goal`)
  }
  const keepNextByFocusArea = new Map(cycle.review.goals.map((g) => [g.focus_area_id, g.keep_next]))

  const { data: focusAreaRows, error: focusAreaError } = await client
    .from('focus_areas')
    .select('id, name, target_freq, target_dur, intake_order')
    .eq('cycle_id', priorCycleId)
    .order('intake_order', { ascending: true })
  if (focusAreaError) throw focusAreaError
  const focusAreas = (focusAreaRows ?? []) as FocusAreaRow[]
  if (focusAreas.length === 0) return []

  const focusAreaIds = focusAreas.map((fa) => fa.id)
  const { data: commitmentRows, error: commitmentError } = await client
    .from('commitments')
    .select('id, focus_area_id, freq, dur')
    .in('focus_area_id', focusAreaIds)
  if (commitmentError) throw commitmentError
  const commitmentByFocusArea = new Map(
    ((commitmentRows ?? []) as CommitmentRow[]).map((c) => [c.focus_area_id, c]),
  )

  const commitmentIds = [...commitmentByFocusArea.values()].map((c) => c.id)
  const slotCounts = new Map<string, { scheduled: number; completed: number }>()
  if (commitmentIds.length > 0) {
    const { data: slotRows, error: slotsError } = await client
      .from('slots')
      .select('commitment_id, status')
      .in('commitment_id', commitmentIds)
    if (slotsError) throw slotsError
    for (const row of (slotRows ?? []) as SlotStatusRow[]) {
      const entry = slotCounts.get(row.commitment_id) ?? { scheduled: 0, completed: 0 }
      entry.scheduled += 1
      if (row.status === 'completed') entry.completed += 1
      slotCounts.set(row.commitment_id, entry)
    }
  }

  const plans: NextCycleFocusAreaPlan[] = []
  for (const fa of focusAreas) {
    if (keepNextByFocusArea.get(fa.id) !== true) continue

    const commitment = commitmentByFocusArea.get(fa.id)
    if (!commitment) continue // never generated a commitment — nothing to carry forward

    const counts = slotCounts.get(commitment.id) ?? { scheduled: 0, completed: 0 }
    const plan = computeNextCycleGoalPlan({
      intakeOrder: fa.intake_order,
      priorPlanFreq: commitment.freq,
      priorPlanDur: commitment.dur,
      completions: counts.completed,
      scheduledSlots: counts.scheduled,
      originalTargetFreq: fa.target_freq,
      originalTargetDur: fa.target_dur,
    })

    plans.push({ ...plan, focusAreaId: fa.id, name: fa.name })
  }

  return plans
}
