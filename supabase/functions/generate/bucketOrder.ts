// Bucket ordering + resolution — docs/SPEC.md §3 step 3, CONTEXT.md §12
// fallback rule. Pure logic, no Deno APIs — importable from both the Deno
// function runtime and Vitest.

import { DAY_TYPES, TIME_OF_DAY_ORDER } from './types.ts'
import type { Bucket, BlockedWindowInput, DayType, ReliabilityBucketInput, TimeOfDay } from './types.ts'

// Time-of-day boundaries (24h clock, hour >= bound wins, last match in
// scan order applies). Nothing in CONTEXT.md/SPEC.md defines these exact
// clock boundaries — docs/agents/CLARIFICATIONS.md logs this gap. Six
// roughly-even bands across the day, chosen as a conservative, reversible
// default.
const TIME_OF_DAY_HOUR_BOUNDS: [TimeOfDay, number][] = [
  ['night', 0],
  ['early_morning', 5],
  ['morning', 8],
  ['midday', 11],
  ['afternoon', 14],
  ['evening', 17],
  ['night', 20],
]

export function timeOfDayForMinutes(minutesSinceMidnight: number): TimeOfDay {
  const hour = Math.floor(minutesSinceMidnight / 60) % 24
  let result: TimeOfDay = 'night'
  for (const [tod, boundHour] of TIME_OF_DAY_HOUR_BOUNDS) {
    if (hour >= boundHour) result = tod
  }
  return result
}

export function parseWakeTime(wakeTime: string): number {
  const [hours, minutes] = wakeTime.split(':').map(Number)
  return hours * 60 + (minutes || 0)
}

/** Weekday vs weekend for a plain `YYYY-MM-DD` date string. */
export function dayTypeForDate(dateStr: string): DayType {
  const date = new Date(`${dateStr}T00:00:00Z`)
  const day = date.getUTCDay() // 0 = Sunday, 6 = Saturday
  return day === 0 || day === 6 ? 'weekend' : 'weekday'
}

/** Time-of-day sequence starting at the wake-time bucket, wrapping through the rest of the day. */
export function wakeOrderedTimesOfDay(wakeTime: string): TimeOfDay[] {
  const wakeTod = timeOfDayForMinutes(parseWakeTime(wakeTime))
  const startIdx = TIME_OF_DAY_ORDER.indexOf(wakeTod)
  return [...TIME_OF_DAY_ORDER.slice(startIdx), ...TIME_OF_DAY_ORDER.slice(0, startIdx)]
}

/**
 * Fixed bucket scan order — CONTEXT.md §12 fallback rule ("scan buckets in
 * a fixed order starting after wake time"). Weekday day-type is scanned
 * before weekend; docs/agents/CLARIFICATIONS.md logs that day-type
 * priority isn't specified anywhere and this is a conservative default.
 */
export function wakeOrderedBuckets(wakeTime: string): Bucket[] {
  const times = wakeOrderedTimesOfDay(wakeTime)
  return DAY_TYPES.flatMap((dayType) => times.map((tod) => `${dayType}_${tod}` as Bucket))
}

/**
 * Buckets considered blocked for this request — docs/agents/
 * CLARIFICATIONS.md logs the underlying gap: `blocked_windows` in the
 * `generate` request only carry a bare `date` (docs/SPEC.md §3 example),
 * and `generate` itself is never given the cycle's start date, so a date
 * can't be mapped to a specific weekday occurrence or time-of-day here.
 * Conservative assumption: derive day_type (weekday/weekend) from the
 * date and treat every bucket of that day_type as blocked. This
 * over-blocks from a single blocked date, but errs toward "never place
 * into a period with a known disruption" rather than risking a real
 * collision, and is easy to loosen once blocked_windows carry real
 * time-of-day info.
 */
export function blockedBucketSet(blockedWindows: BlockedWindowInput[]): Set<Bucket> {
  const blockedDayTypes = new Set(blockedWindows.map((bw) => dayTypeForDate(bw.date)))
  const blocked = new Set<Bucket>()
  for (const dayType of blockedDayTypes) {
    for (const tod of TIME_OF_DAY_ORDER) blocked.add(`${dayType}_${tod}` as Bucket)
  }
  return blocked
}

function completionRate(bucket: Bucket, reliabilityMap: ReliabilityBucketInput[]): number | null {
  const entry = reliabilityMap.find((r) => r.bucket === bucket)
  // "trusted" = scheduled >= 3 (docs/SPEC.md §2, reliability_map comment);
  // below that, or with no entry at all (cycle 1: reliability_map is
  // always []), the bucket reads neutral — no reassignment on its account.
  if (!entry || entry.scheduled < 3) return null
  return entry.completions / entry.scheduled
}

// docs/agents/CLARIFICATIONS.md: "meaningfully worse... relative to
// alternatives" (CONTEXT.md §12 wording) has no numeric threshold in the
// spec. A candidate is only displaced by an alternative whose trusted
// completion rate is at least this much higher — conservative, reversible.
const UNRELIABLE_GAP = 0.2

/**
 * Final bucket resolution — docs/SPEC.md §3 step 3. Starts from the
 * model's preferred bucket; reassigns if it's blocked, or if the
 * reliability map shows a trusted alternative is meaningfully better.
 */
export function resolveBucket(
  preferredBucket: Bucket,
  wakeTime: string,
  blockedWindows: BlockedWindowInput[],
  reliabilityMap: ReliabilityBucketInput[],
): Bucket {
  const blocked = blockedBucketSet(blockedWindows)
  const order = wakeOrderedBuckets(wakeTime)
  const available = order.filter((b) => !blocked.has(b))

  // Every bucket blocked (extreme edge case) — nothing better to offer.
  if (available.length === 0) return preferredBucket

  let candidate = available.includes(preferredBucket) ? preferredBucket : available[0]

  const candidateRate = completionRate(candidate, reliabilityMap)
  if (candidateRate !== null) {
    let best = candidate
    let bestRate = candidateRate
    for (const b of available) {
      const rate = completionRate(b, reliabilityMap)
      if (rate !== null && rate > bestRate + UNRELIABLE_GAP) {
        best = b
        bestRate = rate
      }
    }
    candidate = best
  }

  return candidate
}

/** CONTEXT.md §12 fallback: first non-blocked bucket in wake-time order. */
export function firstAvailableBucket(wakeTime: string, blockedWindows: BlockedWindowInput[]): Bucket {
  const blocked = blockedBucketSet(blockedWindows)
  const order = wakeOrderedBuckets(wakeTime)
  return order.find((b) => !blocked.has(b)) ?? order[0]
}
