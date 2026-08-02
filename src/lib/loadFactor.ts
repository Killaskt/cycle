// Load factor — CONTEXT.md §2 ("Load factor / ceiling"), §6 ("Ceiling for
// cycle N+1 = actual minutes completed in cycle N × 1.15 ... capacity
// becomes measured, not claimed"); docs/SPEC.md §2 (`load_factor` table,
// cross-cycle, scoped to `user_id` not a cycle). Ticket 018.
//
// Two entry points:
//   - `getLoadFactorMinutes` — read `last_cycle_completed_minutes` for a
//     user. `null` if the row doesn't exist yet (cycle 1, or any user who
//     has never closed a cycle) — callers (systemPlan.ts) treat `null` the
//     same as "no override", falling back to `generate`'s cycle-1 ceiling
//     rule.
//   - `updateLoadFactorFromCycle` — computes total actual completed minutes
//     for one (normally just-closed) cycle and upserts it. Written at
//     cycle-close time (called from `cycleReview.ts`'s `submitCycleReview`,
//     not deferred to next-cycle-start) — CONTEXT.md §6/the ticket both
//     leave this choice open; cycle-close is the one point every closed
//     cycle passes through exactly once, whereas "next cycle start" isn't a
//     single well-defined event yet (no ticket builds that screen) and could
//     be delayed arbitrarily long or skipped, so snapshotting immediately
//     keeps the write co-located with the data that produced it.
//
// "Actual completed minutes" reads `slots.status = 'completed'` directly
// (not the `completions` table) — `today.ts`'s `completeSlot` keeps the two
// in lockstep 1:1 (one `completions` row iff `status = 'completed'`, never
// more), so `slots` alone is sufficient and avoids a second join.

import type { SupabaseClient } from '@supabase/supabase-js'

export async function getLoadFactorMinutes(
  client: SupabaseClient,
  userId: string,
): Promise<number | null> {
  const { data, error } = await client
    .from('load_factor')
    .select('last_cycle_completed_minutes')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  return (data as { last_cycle_completed_minutes: number | null }).last_cycle_completed_minutes
}

interface CommitmentDurRow {
  id: string
  dur: number
}

/**
 * Σ(dur) over every `completed` slot belonging to this cycle's commitments.
 * Every slot for a given commitment shares that commitment's `dur`
 * (docs/SPEC.md §2 — `slots` has no duration of its own), so this is a
 * straight per-commitment `dur × completedSlotCount` sum, not a per-slot
 * duration lookup.
 */
export async function computeCompletedMinutesForCycle(
  client: SupabaseClient,
  cycleId: string,
): Promise<number> {
  const { data: commitmentRows, error: commitmentError } = await client
    .from('commitments')
    .select('id, dur, focus_areas!inner(cycle_id)')
    .eq('focus_areas.cycle_id', cycleId)
  if (commitmentError) throw commitmentError

  const commitments = (commitmentRows ?? []) as CommitmentDurRow[]
  if (commitments.length === 0) return 0

  const durByCommitment = new Map(commitments.map((c) => [c.id, c.dur]))
  const commitmentIds = [...durByCommitment.keys()]

  const { data: completedSlotRows, error: slotsError } = await client
    .from('slots')
    .select('commitment_id')
    .in('commitment_id', commitmentIds)
    .eq('status', 'completed')
  if (slotsError) throw slotsError

  return ((completedSlotRows ?? []) as { commitment_id: string }[]).reduce(
    (sum, row) => sum + (durByCommitment.get(row.commitment_id) ?? 0),
    0,
  )
}

/**
 * Computes this cycle's actual completed minutes and upserts it as the
 * user's `load_factor.last_cycle_completed_minutes` — the next cycle's
 * generation ceiling (via `getLoadFactorMinutes` -> `systemPlan.ts` ->
 * `generate`'s `ceiling_basis_minutes`) reads exactly this value. Always
 * overwrites with the most recently closed cycle's figure — `load_factor`
 * is one row per user, "last cycle," not a history.
 */
export async function updateLoadFactorFromCycle(
  client: SupabaseClient,
  userId: string,
  cycleId: string,
): Promise<number> {
  const minutes = await computeCompletedMinutesForCycle(client, cycleId)
  const { error } = await client
    .from('load_factor')
    .upsert({ user_id: userId, last_cycle_completed_minutes: minutes, updated_at: new Date().toISOString() })
  if (error) throw error
  return minutes
}
