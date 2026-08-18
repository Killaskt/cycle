import type { SupabaseClient } from '@supabase/supabase-js'
import type { Bucket } from './slots'

// Reliability map read-path — CONTEXT.md §9, §12; docs/SPEC.md §2. The rows
// themselves are kept up to date by DB triggers (see
// supabase/migrations/20260802010000_reliability_map_triggers.sql), fired on
// every `completions`/`fall_offs` insert regardless of caller — this module
// only reads. A bucket is "trusted" once `scheduled >= 3`; generation
// (ticket 005) must treat an untrusted bucket as neutral, not unreliable.

const TRUST_THRESHOLD = 3

export interface ReliabilityMapRow {
  bucket: Bucket
  completions: number
  scheduled: number
}

export interface ReliabilityMapEntry extends ReliabilityMapRow {
  /** `scheduled >= 3` (CONTEXT.md §9). Below this, treat the bucket as neutral. */
  trusted: boolean
  /** `completions / scheduled`, or `null` when `scheduled === 0` (no data at all yet). */
  rate: number | null
}

export function isTrusted(scheduled: number): boolean {
  return scheduled >= TRUST_THRESHOLD
}

function toEntry(row: ReliabilityMapRow): ReliabilityMapEntry {
  return {
    ...row,
    trusted: isTrusted(row.scheduled),
    rate: row.scheduled > 0 ? row.completions / row.scheduled : null,
  }
}

/**
 * Every bucket this user has any history for, with a computed `trusted`
 * flag and completion `rate`. Buckets with no rows at all simply aren't
 * present in the result — callers treat a missing bucket the same as one
 * with `scheduled: 0` (untrusted/neutral), consistent with `generate`'s
 * request shape sending `reliability_map: []` on cycle 1 (docs/SPEC.md §3).
 */
export async function getReliabilityMap(
  client: SupabaseClient,
  userId: string,
): Promise<ReliabilityMapEntry[]> {
  const { data, error } = await client
    .from('reliability_map')
    .select('bucket, completions, scheduled')
    .eq('user_id', userId)
  if (error) throw error
  return (data ?? []).map((row: ReliabilityMapRow) => toEntry(row))
}
