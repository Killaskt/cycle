// System (locked) screen support — CONTEXT.md §7, §6 (regenerate-once);
// docs/SPEC.md §2 (`cycles`/`commitments`), §3 (`generate` contract). Ticket
// 008 wires together three pieces that already exist and must be reused,
// not reimplemented: this module only calls the `generate` Edge Function
// (ticket 005) and `materializeCycleSlots` (ticket 007, `./slots`) — it
// contains no generation math and no materialization logic of its own.
//
// Three DB-touching entry points, each mapping onto one ticket-008 action:
//   - `generateInitialCommitments` — first-ever generation for a draft
//     cycle (called once, when the System screen finds no commitments yet).
//   - `regenerateCommitments` — the regenerate-once action. Only while
//     `status === 'draft' && !regenerate_used`; replaces the `commitments`
//     rows and flips `regenerate_used`.
//   - `acceptCycle` — draft -> active, `started_at = now()`, then
//     `materializeCycleSlots` exactly once. `materializeCycleSlots` itself
//     throws on a second call for the same cycle (ticket 007's logged
//     idempotency decision) — that error is deliberately left to propagate
//     out of `acceptCycle`, not caught here, so a legitimate second Accept
//     is rejected loudly rather than silently swallowed.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Bucket } from './slots'
import { materializeCycleSlots } from './slots'
import { getReliabilityMap } from './reliabilityMap'

export type CycleStatus = 'draft' | 'active' | 'closed'

export interface CycleRow {
  id: string
  user_id: string
  status: CycleStatus
  wake_time: string
  regenerate_used: boolean
  started_at: string | null
}

export interface FocusAreaRow {
  id: string
  name: string
  target_freq: number
  target_dur: number
  current_freq: number
  current_dur: number
  intake_order: number
}

export interface CommitmentRow {
  id: string
  focus_area_id: string
  name: string
  session_shape: string
  freq: number
  dur: number
  bucket: Bucket
  rationale: string | null
  from_fallback: boolean
}

export interface SystemPlan {
  cycle: CycleRow
  focusAreas: FocusAreaRow[]
  commitments: CommitmentRow[]
}

interface GenerateResponseCommitment {
  focus_area_id: string
  name: string
  session_shape: string
  freq: number
  dur: number
  bucket: Bucket
  rationale: string | null
  from_fallback: boolean
}

async function fetchCycle(client: SupabaseClient, cycleId: string): Promise<CycleRow> {
  const { data, error } = await client
    .from('cycles')
    .select('id, user_id, status, wake_time, regenerate_used, started_at')
    .eq('id', cycleId)
    .single()
  if (error) throw error
  if (!data) throw new Error(`cycle ${cycleId} not found`)
  return data as CycleRow
}

async function fetchFocusAreas(client: SupabaseClient, cycleId: string): Promise<FocusAreaRow[]> {
  const { data, error } = await client
    .from('focus_areas')
    .select('id, name, target_freq, target_dur, current_freq, current_dur, intake_order')
    .eq('cycle_id', cycleId)
    .order('intake_order', { ascending: true })
  if (error) throw error
  return (data ?? []) as FocusAreaRow[]
}

async function fetchCommitments(client: SupabaseClient, cycleId: string): Promise<CommitmentRow[]> {
  const { data, error } = await client
    .from('commitments')
    .select(
      'id, focus_area_id, name, session_shape, freq, dur, bucket, rationale, from_fallback, focus_areas!inner(cycle_id)',
    )
    .eq('focus_areas.cycle_id', cycleId)
  if (error) throw error
  return (data ?? []).map((row: Record<string, unknown>) => ({
    id: row.id,
    focus_area_id: row.focus_area_id,
    name: row.name,
    session_shape: row.session_shape,
    freq: row.freq,
    dur: row.dur,
    bucket: row.bucket,
    rationale: row.rationale,
    from_fallback: row.from_fallback,
  })) as CommitmentRow[]
}

/**
 * Everything the System screen needs to render, in one call: the cycle
 * row, its focus areas (intake order), and its commitments (if any exist
 * yet), sorted to match focus-area intake order rather than DB insert
 * order.
 */
export async function fetchSystemPlan(client: SupabaseClient, cycleId: string): Promise<SystemPlan> {
  const cycle = await fetchCycle(client, cycleId)
  const focusAreas = await fetchFocusAreas(client, cycleId)
  const rawCommitments = await fetchCommitments(client, cycleId)
  const orderByFocusArea = new Map(focusAreas.map((fa, i) => [fa.id, i]))
  const commitments = [...rawCommitments].sort(
    (a, b) => (orderByFocusArea.get(a.focus_area_id) ?? 0) - (orderByFocusArea.get(b.focus_area_id) ?? 0),
  )
  return { cycle, focusAreas, commitments }
}

async function buildGenerateRequestBody(
  client: SupabaseClient,
  cycle: CycleRow,
  focusAreas: FocusAreaRow[],
) {
  // Cycle 1: no reliability history yet, so this reads `[]` and every
  // bucket is treated as neutral by `generate` — docs/SPEC.md §3.
  const reliabilityEntries = await getReliabilityMap(client, cycle.user_id)
  const { data: blockedRows, error: blockedError } = await client
    .from('blocked_windows')
    .select('date')
    .eq('cycle_id', cycle.id)
  if (blockedError) throw blockedError

  return {
    wake_time: cycle.wake_time,
    focus_areas: focusAreas.map((fa) => ({
      id: fa.id,
      name: fa.name,
      target_freq: fa.target_freq,
      target_dur: fa.target_dur,
      current_freq: fa.current_freq,
      current_dur: fa.current_dur,
      intake_order: fa.intake_order,
    })),
    reliability_map: reliabilityEntries.map((r) => ({
      bucket: r.bucket,
      completions: r.completions,
      scheduled: r.scheduled,
    })),
    blocked_windows: (blockedRows ?? []).map((b: { date: string }) => ({ date: b.date })),
  }
}

/**
 * Calls the real `generate` Edge Function (ticket 005) over HTTP via the
 * Supabase client — the same function served locally with
 * `MODEL_PROVIDER=fixture supabase functions serve generate`. Returns the
 * raw response commitments; does not touch the DB.
 */
async function callGenerate(
  client: SupabaseClient,
  cycle: CycleRow,
  focusAreas: FocusAreaRow[],
): Promise<GenerateResponseCommitment[]> {
  const body = await buildGenerateRequestBody(client, cycle, focusAreas)
  const { data, error } = await client.functions.invoke('generate', { body })
  if (error) throw error
  const commitments = (data as { commitments?: GenerateResponseCommitment[] } | null)?.commitments
  if (!commitments) throw new Error('generate function returned no commitments')
  return commitments
}

function toInsertRows(commitments: GenerateResponseCommitment[]) {
  return commitments.map((c) => ({
    focus_area_id: c.focus_area_id,
    name: c.name,
    session_shape: c.session_shape,
    freq: c.freq,
    dur: c.dur,
    bucket: c.bucket,
    rationale: c.rationale,
    from_fallback: c.from_fallback,
  }))
}

/**
 * First-ever generation for a draft cycle. Throws if the cycle already has
 * commitments (that's what `regenerateCommitments` is for) or has no
 * focus areas (nothing for `generate` to work from — an intake bug, not a
 * state this function should paper over).
 */
export async function generateInitialCommitments(
  client: SupabaseClient,
  cycleId: string,
): Promise<CommitmentRow[]> {
  const cycle = await fetchCycle(client, cycleId)
  const focusAreas = await fetchFocusAreas(client, cycleId)
  if (focusAreas.length === 0) {
    throw new Error(`cycle ${cycleId} has no focus areas — nothing to generate`)
  }

  const existing = await fetchCommitments(client, cycleId)
  if (existing.length > 0) {
    throw new Error(
      `cycle ${cycleId} already has commitments — call regenerateCommitments to replace them, not generateInitialCommitments`,
    )
  }

  const generated = await callGenerate(client, cycle, focusAreas)
  const { data: inserted, error: insertError } = await client
    .from('commitments')
    .insert(toInsertRows(generated))
    .select()
  if (insertError) throw insertError
  return (inserted ?? []) as CommitmentRow[]
}

/**
 * The regenerate-once action — CONTEXT.md §6: "only available before the
 * cycle starts... once the cycle begins, it's locked, full stop." Re-calls
 * `generate` (same formula-derived freq/dur for the same inputs; only
 * naming/placement may re-roll, since those come from the model layer),
 * replaces the `commitments` rows, and flips `regenerate_used`. Rejects
 * (throws) outright — no silent no-op — if the cycle isn't `draft` or has
 * already used its one regenerate.
 */
export async function regenerateCommitments(
  client: SupabaseClient,
  cycleId: string,
): Promise<CommitmentRow[]> {
  const cycle = await fetchCycle(client, cycleId)
  if (cycle.status !== 'draft') {
    throw new Error(
      `cycle ${cycleId} is not draft (status: ${cycle.status}) — regenerate is only available before the cycle starts (CONTEXT.md §6)`,
    )
  }
  if (cycle.regenerate_used) {
    throw new Error(`cycle ${cycleId} has already used its one regenerate`)
  }

  const focusAreas = await fetchFocusAreas(client, cycleId)
  if (focusAreas.length === 0) {
    throw new Error(`cycle ${cycleId} has no focus areas — nothing to generate`)
  }

  const generated = await callGenerate(client, cycle, focusAreas)

  const focusAreaIds = focusAreas.map((fa) => fa.id)
  const { error: deleteError } = await client.from('commitments').delete().in('focus_area_id', focusAreaIds)
  if (deleteError) throw deleteError

  const { data: inserted, error: insertError } = await client
    .from('commitments')
    .insert(toInsertRows(generated))
    .select()
  if (insertError) throw insertError

  // Guarded update, not a blind write: only flips the flag if the cycle is
  // still exactly the draft/not-yet-regenerated state checked above, so a
  // concurrent second regenerate call can't both "succeed".
  const { data: flagUpdated, error: flagError } = await client
    .from('cycles')
    .update({ regenerate_used: true })
    .eq('id', cycleId)
    .eq('status', 'draft')
    .eq('regenerate_used', false)
    .select()
    .maybeSingle()
  if (flagError) throw flagError
  if (!flagUpdated) {
    throw new Error(`cycle ${cycleId} regenerate_used flag did not update — concurrent regenerate?`)
  }

  return (inserted ?? []) as CommitmentRow[]
}

/**
 * Accept: draft -> active, `started_at = now()`, then materialize slots
 * exactly once (ticket 007's `materializeCycleSlots`). The status/
 * started_at update is guarded to `status = 'draft'` so a legitimate
 * second Accept call (e.g. a double-tap) can't stomp `started_at` a
 * second time — but `materializeCycleSlots`'s own "already materialized"
 * throw is deliberately left uncaught here, so that second call is still
 * rejected loudly rather than silently no-op'd.
 */
export async function acceptCycle(client: SupabaseClient, cycleId: string): Promise<void> {
  const { error: updateError } = await client
    .from('cycles')
    .update({ status: 'active', started_at: new Date().toISOString() })
    .eq('id', cycleId)
    .eq('status', 'draft')
  if (updateError) throw updateError

  await materializeCycleSlots(client, cycleId)
}
