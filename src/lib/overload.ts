// Cycle-wide overload detection — CONTEXT.md §9c, docs/adr/
// 0008-two-fall-off-counters.md, docs/SPEC.md §5 (`checkOverload` contract).
// Ticket 014, hooked into `recordFallOff` (`src/lib/fallOff.ts`) after every
// `fall_offs` insert, the same "extend the hook" pattern tickets 012/013/016
// already used.
//
// Reuses `src/lib/amendment.ts`'s `applyAction` (exported by this ticket,
// gaining a `REDUCE_FREQUENCY` case there) and `pickMoveTarget` — the
// per-commitment mutation primitives are identical to the ones the per-slot
// 2nd/3rd-fall ladder already uses, just applied to every affected
// commitment instead of one ("code disposes", ADR-0004).
//
// Two functions, deliberately split the same way ADR-0004 splits "propose"
// from "dispose":
//   - `checkOverload` — read-only rate/discriminator math (docs/SPEC.md §5's
//     contract almost verbatim). No mutation, no opinion about whether this
//     cycle has already fired before.
//   - `checkAndApplyCycleWideOverload` — the DB-touching orchestrator:
//     calls `checkOverload`, and if triggered, actually mutates every
//     affected commitment and logs one system-generated `amendments` row
//     with `target.scope: 'cycle_wide'`.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Bucket } from './slots'
import { applyAction, pickMoveTarget, type ActionType } from './amendment'

// CONTEXT.md §9c: "falls >= 40% of scheduled items over a rolling 7 days,
// minimum 4 falls."
const MIN_RAW_FALLS = 4
const TRIGGER_RATE = 0.4
// CONTEXT.md §9c: ">=60% of the cycle-wide falls land in one time bucket".
const CLUSTER_RATIO = 0.6
const WINDOW_DAYS = 7

export type OverloadResponseType = 'MOVE_CLUSTER' | 'REDUCE_FREQUENCY_ALL'

export interface OverloadResult {
  response: OverloadResponseType
  /** Present only for `MOVE_CLUSTER` — the bucket the falls clustered in. */
  bucket?: Bucket
}

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10)
}

interface FallOffWithBucket {
  id: string
  slots: { bucket: Bucket } | { bucket: Bucket }[]
}

function bucketOf(row: FallOffWithBucket): Bucket {
  const slots = row.slots
  return Array.isArray(slots) ? slots[0].bucket : slots.bucket
}

/**
 * docs/SPEC.md §5's `checkOverload(cycleId)` contract: rate = fall_offs in
 * the trailing 7 (calendar) days / slots scheduled in the trailing 7 days,
 * for this cycle. Never triggers below 4 raw falls in that window
 * regardless of rate — "can't fire in the first two days" (CONTEXT.md §9c)
 * falls naturally out of this floor, since two days can't produce 4 falls
 * under any real schedule. At trigger, discriminates placement (>=60% of
 * the triggering falls' slots share one bucket) from volume (spread).
 *
 * Read-only — does not know or care whether cycle-wide overload has already
 * fired earlier this cycle. That "already fired"/repeat-trigger bookkeeping
 * is `checkAndApplyCycleWideOverload`'s concern (see its own doc comment
 * and docs/agents/CLARIFICATIONS.md's already-logged "double-trigger in one
 * cycle" entry, which this ticket resolves) — this function's job is only
 * "is the rolling-window condition true right now."
 *
 * The 7-day window is 7 inclusive calendar days ending "now" (today and the
 * 6 days before it), not a rolling 168-hour clock window — `slots.
 * scheduled_date` is date-only, so anchoring to calendar days keeps the
 * fall_offs (timestamp) and slots (date) halves of the rate comparable
 * without a spurious off-by-one depending on what time of day this runs.
 */
export async function checkOverload(
  client: SupabaseClient,
  cycleId: string,
  now: Date = new Date(),
): Promise<OverloadResult | null> {
  const windowStartDate = dateOnly(new Date(now.getTime() - (WINDOW_DAYS - 1) * 24 * 60 * 60 * 1000))
  const windowEndDate = dateOnly(now)
  const windowStartTimestamp = `${windowStartDate}T00:00:00.000Z`

  const { data: fallOffRows, error: fallOffsError } = await client
    .from('fall_offs')
    .select('id, slots!inner(bucket)')
    .eq('cycle_id', cycleId)
    .gte('created_at', windowStartTimestamp)
    .lte('created_at', now.toISOString())
  if (fallOffsError) throw fallOffsError

  const falls = (fallOffRows ?? []) as unknown as FallOffWithBucket[]
  if (falls.length < MIN_RAW_FALLS) return null

  const { count: scheduledCount, error: scheduledError } = await client
    .from('slots')
    .select('id, commitments!inner(focus_areas!inner(cycle_id))', { count: 'exact', head: true })
    .eq('commitments.focus_areas.cycle_id', cycleId)
    .gte('scheduled_date', windowStartDate)
    .lte('scheduled_date', windowEndDate)
  if (scheduledError) throw scheduledError
  if (!scheduledCount) return null

  const rate = falls.length / scheduledCount
  if (rate < TRIGGER_RATE) return null

  const bucketCounts = new Map<Bucket, number>()
  for (const row of falls) {
    const bucket = bucketOf(row)
    bucketCounts.set(bucket, (bucketCounts.get(bucket) ?? 0) + 1)
  }

  let clusterBucket: Bucket | undefined
  let clusterCount = 0
  for (const [bucket, count] of bucketCounts) {
    if (count > clusterCount) {
      clusterBucket = bucket
      clusterCount = count
    }
  }

  if (clusterBucket && clusterCount / falls.length >= CLUSTER_RATIO) {
    return { response: 'MOVE_CLUSTER', bucket: clusterBucket }
  }

  return { response: 'REDUCE_FREQUENCY_ALL' }
}

export interface CycleWideOverloadResult {
  amendmentId: string
  response: OverloadResponseType
  bucket?: Bucket
  affectedCommitmentIds: string[]
  /**
   * `true` when an `amendments` row with `target->>'scope' = 'cycle_wide'`
   * already existed for this cycle before this one — docs/agents/
   * CLARIFICATIONS.md's "double-trigger in one cycle" entry: no
   * early-termination flow exists, the same response is simply applied
   * again, distinguished only by this flag (and matching `params.
   * repeat_trigger`/reasoning text on the logged row) so a human reviewing
   * the amendments table can find it.
   */
  repeatTrigger: boolean
}

const MOVE_CLUSTER_REASONING_FIRST =
  'Falls have clustered heavily at one time of day across the whole plan this week — a placement problem, not a volume one. Moving everything scheduled then to a different time of day keeps every commitment’s frequency and duration exactly as they were.'

const MOVE_CLUSTER_REASONING_REPEAT =
  'This is a second cycle-wide clustering trigger this cycle. The same time-of-day move is being applied again rather than any special escalation — flagged here for a human to review, since a repeat trigger within one cycle was left an open question rather than fully specified.'

const REDUCE_FREQUENCY_ALL_REASONING_FIRST =
  'Falls have spread across the whole plan this week rather than clustering on one commitment or one time of day — a volume problem. Every active commitment’s frequency is being reduced by one so the whole plan is lighter, not just one part of it.'

const REDUCE_FREQUENCY_ALL_REASONING_REPEAT =
  'This is a second cycle-wide volume trigger this cycle. The same across-the-board frequency cut is being applied again rather than any special escalation — flagged here for a human to review, since a repeat trigger within one cycle was left an open question rather than fully specified.'

interface ActiveCommitment {
  id: string
  freq: number
  bucket: Bucket
}

async function loadActiveCommitments(client: SupabaseClient, cycleId: string): Promise<ActiveCommitment[]> {
  const { data, error } = await client
    .from('commitments')
    .select('id, freq, bucket, focus_areas!inner(cycle_id)')
    .eq('focus_areas.cycle_id', cycleId)
    .is('removed_at', null)
  if (error) throw error
  return (data ?? []) as unknown as ActiveCommitment[]
}

/**
 * DB-touching orchestrator: `checkOverload` (read-only) + "code disposes"
 * (ADR-0004) applied cycle-wide instead of to one commitment. Call after
 * every `fall_offs` insert (docs/SPEC.md §5) — `recordFallOff`
 * (`src/lib/fallOff.ts`) is the only caller in this codebase, mirroring how
 * it already calls `proposeAmendmentForFallOff` at occurrence 2/3.
 *
 * Unlike the per-slot path, this has no user accept/reject step: CONTEXT.md
 * §9c describes the cycle-wide response as something the system "fires" and
 * applies, never mentioning a review screen the way §9b explicitly does for
 * the per-slot 2nd/3rd fall amendment ("rendered to the user, accepted or
 * rejected-with-reason"). Logged as an assumption — see
 * docs/agents/CLARIFICATIONS.md [014]. The logged `amendments` row is
 * written with `user_response: 'accepted'` immediately to reflect that it
 * was auto-applied, not left pending.
 *
 * "Already fired" (docs/SPEC.md §5): derived from whether any `amendments`
 * row with `target->>'scope' = 'cycle_wide'` already exists for this cycle,
 * queried *before* inserting this call's own row. Per
 * docs/agents/CLARIFICATIONS.md's already-logged "double-trigger in one
 * cycle" entry (this ticket resolves it): a repeat trigger gets no special
 * early-termination handling — it applies the exact same MOVE_CLUSTER/
 * REDUCE_FREQUENCY_ALL response again over whatever's still active, and is
 * distinguished only by `repeatTrigger: true` on the return value and
 * `params.repeat_trigger: true` plus repeat-specific reasoning on the
 * logged row.
 *
 * `MOVE_CLUSTER` targets every *active* commitment currently placed in the
 * triggering bucket (not just the commitment(s) whose slots actually fell
 * off) — CONTEXT.md §9c: "global MOVE of that cluster." All of them move to
 * the same single new bucket (one `pickMoveTarget` call, reused from
 * ./amendment.ts), keeping the whole cluster together rather than
 * scattering it — CONTEXT.md doesn't ask for per-commitment distinct
 * targets, only that the bucket stops being overloaded. `REDUCE_FREQUENCY_
 * ALL` targets every active commitment in the cycle, each via `applyAction`
 * (which itself falls to `REMOVE` per-commitment if that commitment's own
 * floor would be breached — CONTEXT.md §9d).
 */
export async function checkAndApplyCycleWideOverload(
  client: SupabaseClient,
  fallOffId: string,
  now: Date = new Date(),
): Promise<CycleWideOverloadResult | null> {
  const { data: fallOffRow, error: fallOffError } = await client
    .from('fall_offs')
    .select('id, cycle_id')
    .eq('id', fallOffId)
    .single()
  if (fallOffError) throw fallOffError
  if (!fallOffRow) throw new Error(`fall_off ${fallOffId} not found`)

  const cycleId = (fallOffRow as { cycle_id: string }).cycle_id

  const result = await checkOverload(client, cycleId, now)
  if (!result) return null

  const { count: priorTriggerCount, error: priorError } = await client
    .from('amendments')
    .select('id, fall_offs!inner(cycle_id)', { count: 'exact', head: true })
    .eq('fall_offs.cycle_id', cycleId)
    .eq('target->>scope', 'cycle_wide')
  if (priorError) throw priorError
  const repeatTrigger = (priorTriggerCount ?? 0) > 0

  const commitments = await loadActiveCommitments(client, cycleId)

  let affected: ActiveCommitment[]
  let action: ActionType
  let targetBucket: Bucket | undefined

  if (result.response === 'MOVE_CLUSTER') {
    action = 'MOVE'
    targetBucket = result.bucket
    affected = commitments.filter((c) => c.bucket === result.bucket)

    if (affected.length > 0 && result.bucket) {
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

      const newBucket = pickMoveTarget(
        result.bucket,
        (cycleRow as { wake_time: string }).wake_time,
        (blockedRows ?? []).map((b: { date: string }) => b.date),
        [],
      )

      for (const commitment of affected) {
        await applyAction(client, 'MOVE', { commitment_id: commitment.id }, { bucket: newBucket })
      }
    }
  } else {
    action = 'REDUCE_FREQUENCY'
    affected = commitments
    for (const commitment of affected) {
      await applyAction(client, 'REDUCE_FREQUENCY', { commitment_id: commitment.id }, {})
    }
  }

  const reasoning =
    result.response === 'MOVE_CLUSTER'
      ? repeatTrigger
        ? MOVE_CLUSTER_REASONING_REPEAT
        : MOVE_CLUSTER_REASONING_FIRST
      : repeatTrigger
        ? REDUCE_FREQUENCY_ALL_REASONING_REPEAT
        : REDUCE_FREQUENCY_ALL_REASONING_FIRST

  const { data: inserted, error: insertError } = await client
    .from('amendments')
    .insert({
      fall_off_id: fallOffId,
      action,
      target: {
        scope: 'cycle_wide',
        response: result.response,
        bucket: targetBucket ?? null,
        commitment_ids: affected.map((c) => c.id),
      },
      params: { repeat_trigger: repeatTrigger },
      reasoning,
      confidence: 1.0,
      proposed_by: 'rule',
      user_response: 'accepted',
    })
    .select()
    .single()
  if (insertError) throw insertError

  return {
    amendmentId: inserted.id,
    response: result.response,
    bucket: targetBucket,
    affectedCommitmentIds: affected.map((c) => c.id),
    repeatTrigger,
  }
}
