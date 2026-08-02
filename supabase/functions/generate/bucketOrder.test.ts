import { describe, expect, it } from 'vitest'
import {
  blockedBucketSet,
  dayTypeForDate,
  firstAvailableBucket,
  resolveBucket,
  wakeOrderedBuckets,
} from './bucketOrder'

describe('dayTypeForDate', () => {
  it('classifies a Saturday/Sunday as weekend', () => {
    expect(dayTypeForDate('2026-08-08')).toBe('weekend') // Saturday
    expect(dayTypeForDate('2026-08-09')).toBe('weekend') // Sunday
  })

  it('classifies Mon-Fri as weekday', () => {
    expect(dayTypeForDate('2026-08-05')).toBe('weekday') // Wednesday
  })
})

describe('wakeOrderedBuckets', () => {
  it('starts the time-of-day scan at the wake bucket, weekday first', () => {
    const order = wakeOrderedBuckets('06:30') // early_morning
    expect(order[0]).toBe('weekday_early_morning')
    expect(order[5]).toBe('weekday_night')
    expect(order[6]).toBe('weekend_early_morning')
  })

  it('wraps time-of-day order for a late wake time', () => {
    const order = wakeOrderedBuckets('21:00') // night
    expect(order[0]).toBe('weekday_night')
    expect(order[1]).toBe('weekday_early_morning')
  })
})

describe('blockedBucketSet', () => {
  it('is empty for no blocked windows', () => {
    expect(blockedBucketSet([]).size).toBe(0)
  })

  it('blocks every bucket of a blocked date\'s day_type', () => {
    const blocked = blockedBucketSet([{ date: '2026-08-05' }]) // weekday
    expect(blocked.has('weekday_morning')).toBe(true)
    expect(blocked.has('weekday_night')).toBe(true)
    expect(blocked.has('weekend_morning')).toBe(false)
  })
})

describe('firstAvailableBucket', () => {
  it('picks the first wake-ordered bucket when nothing is blocked', () => {
    expect(firstAvailableBucket('06:30', [])).toBe('weekday_early_morning')
  })

  it('skips a fully-blocked day_type', () => {
    expect(firstAvailableBucket('06:30', [{ date: '2026-08-05' }])).toBe('weekend_early_morning')
  })
})

describe('resolveBucket', () => {
  it('keeps the model preferred bucket when nothing blocks it', () => {
    expect(resolveBucket('weekday_evening', '06:30', [], [])).toBe('weekday_evening')
  })

  it('reassigns away from a blocked preferred bucket', () => {
    const result = resolveBucket('weekday_morning', '06:30', [{ date: '2026-08-05' }], [])
    expect(result).not.toBe('weekday_morning')
    expect(result.startsWith('weekend_')).toBe(true)
  })

  it('treats an empty reliability_map as neutral (cycle 1) — no crash, no reassignment', () => {
    expect(resolveBucket('weekday_morning', '06:30', [], [])).toBe('weekday_morning')
  })

  it('reassigns to a meaningfully more reliable trusted alternative', () => {
    const reliabilityMap = [
      { bucket: 'weekday_morning' as const, completions: 2, scheduled: 10 }, // 20%, trusted
      { bucket: 'weekday_evening' as const, completions: 9, scheduled: 10 }, // 90%, trusted
    ]
    expect(resolveBucket('weekday_morning', '06:30', [], reliabilityMap)).toBe('weekday_evening')
  })

  it('does not reassign for an untrusted (scheduled < 3) bucket', () => {
    const reliabilityMap = [
      { bucket: 'weekday_morning' as const, completions: 0, scheduled: 1 },
      { bucket: 'weekday_evening' as const, completions: 5, scheduled: 5 },
    ]
    expect(resolveBucket('weekday_morning', '06:30', [], reliabilityMap)).toBe('weekday_morning')
  })
})
