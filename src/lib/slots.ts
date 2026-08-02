// Slot materialization — CONTEXT.md §2 (slot vocabulary), docs/SPEC.md §2
// (`slots` table shape). Given a cycle's `commitments` (freq/dur/bucket) and
// the cycle's `timeframe_days` + `started_at`, generate the concrete `slots`
// rows spanning the window, distributing `freq` occurrences per week
// consistent with the commitment's bucket (weekday vs weekend half of the
// enum), skipping dates already covered by a `blocked_windows` row for that
// cycle. Ticket 007. Runs once at the draft -> active transition (ticket 008
// calls `materializeCycleSlots`; wiring that call in is out of scope here).

import type { SupabaseClient } from '@supabase/supabase-js'

export type DayType = 'weekday' | 'weekend'
export type TimeOfDay =
  | 'early_morning'
  | 'morning'
  | 'midday'
  | 'afternoon'
  | 'evening'
  | 'night'
export type Bucket = `${DayType}_${TimeOfDay}`

export type SlotStatus = 'pending' | 'completed' | 'fell_off' | 'excused'

export interface CommitmentForMaterialization {
  id: string
  freq: number
  dur: number
  bucket: Bucket
}

export interface SlotInsert {
  commitment_id: string
  scheduled_date: string // YYYY-MM-DD
  bucket: Bucket
  status: SlotStatus
}

export interface MaterializeSlotsInput {
  commitments: CommitmentForMaterialization[]
  /** Cycle start date, `YYYY-MM-DD` (or any ISO string — only the date part is used). */
  startedAt: string
  timeframeDays: number
  /**
   * Dates (`YYYY-MM-DD`) blocked cycle-wide via an existing `blocked_windows`
   * row. At materialization time `affected_slot_id` is necessarily null (no
   * slots exist yet to reference), so a blocked date excludes every
   * commitment from scheduling on that date — see
   * docs/agents/CLARIFICATIONS.md [007].
   */
  blockedDates?: Iterable<string>
}

function dayTypeOfBucket(bucket: Bucket): DayType {
  return bucket.startsWith('weekend_') ? 'weekend' : 'weekday'
}

function toDateOnly(isoOrDate: string): string {
  return isoOrDate.slice(0, 10)
}

function addDaysUTC(dateStr: string, days: number): string {
  const d = new Date(`${toDateOnly(dateStr)}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function matchesDayType(dateStr: string, dayType: DayType): boolean {
  const dow = new Date(`${dateStr}T00:00:00Z`).getUTCDay() // 0 = Sun ... 6 = Sat
  const isWeekend = dow === 0 || dow === 6
  return dayType === 'weekend' ? isWeekend : !isWeekend
}

/**
 * Pick `freq` dates out of `pool`, spread as evenly as possible across it.
 * Deterministic (no randomness) so materialization is reproducible for the
 * same inputs. If `freq >= pool.length`, the whole pool is used (freq is
 * effectively capped by how many eligible days exist that week).
 */
function pickDaysInWeek(pool: string[], freq: number): string[] {
  if (freq <= 0 || pool.length === 0) return []
  if (freq >= pool.length) return pool
  const step = pool.length / freq
  const picked: string[] = []
  for (let i = 0; i < freq; i++) {
    picked.push(pool[Math.floor(i * step)])
  }
  return picked
}

/**
 * Pure computation: no DB, no network. Every 7 consecutive calendar days
 * (chunked from `startedAt`, not aligned to Monday) contain exactly 5
 * weekday dates and 2 weekend dates regardless of which day the cycle
 * starts on, so chunking this way guarantees a stable weekly pool size to
 * distribute `freq` across.
 *
 * Blocked dates are removed from a week's eligible pool *before* picking,
 * so a block on one candidate day lets materialization try to still hit
 * `freq` from the remaining eligible days that week rather than silently
 * under-scheduling.
 */
export function materializeSlots(input: MaterializeSlotsInput): SlotInsert[] {
  const { commitments, startedAt, timeframeDays, blockedDates } = input
  const blocked = new Set(
    Array.from(blockedDates ?? [], (d) => toDateOnly(d)),
  )
  const start = toDateOnly(startedAt)
  const rows: SlotInsert[] = []

  for (const commitment of commitments) {
    if (commitment.freq <= 0) continue
    const dayType = dayTypeOfBucket(commitment.bucket)
    const weekCount = Math.ceil(timeframeDays / 7)

    for (let week = 0; week < weekCount; week++) {
      const weekStart = week * 7
      const weekEnd = Math.min(weekStart + 7, timeframeDays)
      const pool: string[] = []
      for (let i = weekStart; i < weekEnd; i++) {
        const date = addDaysUTC(start, i)
        if (blocked.has(date)) continue
        if (matchesDayType(date, dayType)) pool.push(date)
      }

      for (const date of pickDaysInWeek(pool, commitment.freq)) {
        rows.push({
          commitment_id: commitment.id,
          scheduled_date: date,
          bucket: commitment.bucket,
          status: 'pending',
        })
      }
    }
  }

  return rows
}

/**
 * DB-touching orchestrator: fetches the cycle, its commitments, and its
 * blocked windows, then inserts the materialized `slots` rows. Idempotency:
 * re-running for a cycle that already has slots is explicitly rejected
 * (throws) rather than a silent no-op — see docs/agents/CLARIFICATIONS.md
 * [007]. Callers (ticket 008) should only ever call this once, at the
 * draft -> active transition.
 */
export async function materializeCycleSlots(
  client: SupabaseClient,
  cycleId: string,
): Promise<SlotInsert[]> {
  const { data: cycle, error: cycleError } = await client
    .from('cycles')
    .select('id, started_at, timeframe_days')
    .eq('id', cycleId)
    .single()
  if (cycleError) throw cycleError
  if (!cycle) throw new Error(`cycle ${cycleId} not found`)
  if (!cycle.started_at) {
    throw new Error(
      `cycle ${cycleId} has no started_at — materialization requires an active cycle`,
    )
  }

  const { data: commitmentRows, error: commitmentsError } = await client
    .from('commitments')
    .select('id, freq, dur, bucket, focus_areas!inner(cycle_id)')
    .eq('focus_areas.cycle_id', cycleId)
  if (commitmentsError) throw commitmentsError

  const commitments: CommitmentForMaterialization[] = (commitmentRows ?? []).map(
    (c: { id: string; freq: number; dur: number; bucket: Bucket }) => ({
      id: c.id,
      freq: c.freq,
      dur: c.dur,
      bucket: c.bucket,
    }),
  )
  if (commitments.length === 0) return []

  const commitmentIds = commitments.map((c) => c.id)
  const { data: existingSlots, error: existingError } = await client
    .from('slots')
    .select('id')
    .in('commitment_id', commitmentIds)
    .limit(1)
  if (existingError) throw existingError
  if (existingSlots && existingSlots.length > 0) {
    throw new Error(
      `slots already materialized for cycle ${cycleId} — materialization does not re-run`,
    )
  }

  const { data: blockedRows, error: blockedError } = await client
    .from('blocked_windows')
    .select('date')
    .eq('cycle_id', cycleId)
  if (blockedError) throw blockedError

  const rows = materializeSlots({
    commitments,
    startedAt: cycle.started_at,
    timeframeDays: cycle.timeframe_days,
    blockedDates: (blockedRows ?? []).map((b: { date: string }) => b.date),
  })
  if (rows.length === 0) return []

  const { data: inserted, error: insertError } = await client
    .from('slots')
    .insert(rows)
    .select()
  if (insertError) throw insertError
  return (inserted ?? []) as SlotInsert[]
}
