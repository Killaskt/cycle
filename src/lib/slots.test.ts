import { describe, expect, it } from 'vitest'
import { materializeSlots, type CommitmentForMaterialization } from './slots'

// startedAt chosen as a Monday (2026-08-03) so weekday/weekend pools are
// easy to reason about by hand across full 7-day chunks.
const MONDAY_START = '2026-08-03'

describe('materializeSlots — weekday distribution', () => {
  it('freq: 3 over a 14-day cycle creates exactly 3 slots per week, all on weekdays', () => {
    const commitments: CommitmentForMaterialization[] = [
      { id: 'c1', freq: 3, dur: 30, bucket: 'weekday_morning' },
    ]
    const rows = materializeSlots({
      commitments,
      startedAt: MONDAY_START,
      timeframeDays: 14,
    })

    expect(rows).toHaveLength(6)
    for (const row of rows) {
      expect(row.commitment_id).toBe('c1')
      expect(row.bucket).toBe('weekday_morning')
      expect(row.status).toBe('pending')
      const dow = new Date(`${row.scheduled_date}T00:00:00Z`).getUTCDay()
      expect(dow).not.toBe(0)
      expect(dow).not.toBe(6)
    }

    // 3 in week 1 (days 0-6), 3 in week 2 (days 7-13)
    const week1 = rows.filter((r) => r.scheduled_date < '2026-08-10')
    const week2 = rows.filter((r) => r.scheduled_date >= '2026-08-10')
    expect(week1).toHaveLength(3)
    expect(week2).toHaveLength(3)
  })

  it('freq: 2 weekend commitment over a 14-day cycle creates exactly 2 slots per week, all on weekends', () => {
    const commitments: CommitmentForMaterialization[] = [
      { id: 'c2', freq: 2, dur: 45, bucket: 'weekend_afternoon' },
    ]
    const rows = materializeSlots({
      commitments,
      startedAt: MONDAY_START,
      timeframeDays: 14,
    })

    expect(rows).toHaveLength(4)
    for (const row of rows) {
      const dow = new Date(`${row.scheduled_date}T00:00:00Z`).getUTCDay()
      expect(dow === 0 || dow === 6).toBe(true)
    }
  })

  it('multiple commitments are materialized independently', () => {
    const commitments: CommitmentForMaterialization[] = [
      { id: 'c1', freq: 3, dur: 30, bucket: 'weekday_morning' },
      { id: 'c2', freq: 1, dur: 45, bucket: 'weekend_evening' },
    ]
    const rows = materializeSlots({
      commitments,
      startedAt: MONDAY_START,
      timeframeDays: 7,
    })

    expect(rows.filter((r) => r.commitment_id === 'c1')).toHaveLength(3)
    expect(rows.filter((r) => r.commitment_id === 'c2')).toHaveLength(1)
  })

  it('freq: 0 produces no slots for that commitment', () => {
    const commitments: CommitmentForMaterialization[] = [
      { id: 'c1', freq: 0, dur: 30, bucket: 'weekday_morning' },
    ]
    const rows = materializeSlots({
      commitments,
      startedAt: MONDAY_START,
      timeframeDays: 14,
    })
    expect(rows).toHaveLength(0)
  })

  it('caps at the number of eligible days in a partial final week', () => {
    // 3-day cycle starting Monday: only Mon/Tue/Wed are in range, all weekdays.
    const commitments: CommitmentForMaterialization[] = [
      { id: 'c1', freq: 5, dur: 30, bucket: 'weekday_morning' },
    ]
    const rows = materializeSlots({
      commitments,
      startedAt: MONDAY_START,
      timeframeDays: 3,
    })
    expect(rows).toHaveLength(3)
  })
})

describe('materializeSlots — blocked_windows exclusion', () => {
  it('a blocked date within the window gets no slot placed on it', () => {
    const commitments: CommitmentForMaterialization[] = [
      { id: 'c1', freq: 3, dur: 30, bucket: 'weekday_morning' },
    ]
    const blockedDate = '2026-08-04' // Tuesday of week 1
    const rows = materializeSlots({
      commitments,
      startedAt: MONDAY_START,
      timeframeDays: 14,
      blockedDates: [blockedDate],
    })

    expect(rows.some((r) => r.scheduled_date === blockedDate)).toBe(false)
  })

  it('still fills freq from remaining eligible days that week when possible', () => {
    // Week 1 has 5 weekday slots available; blocking one still leaves 4,
    // enough to satisfy freq: 3.
    const commitments: CommitmentForMaterialization[] = [
      { id: 'c1', freq: 3, dur: 30, bucket: 'weekday_morning' },
    ]
    const rows = materializeSlots({
      commitments,
      startedAt: MONDAY_START,
      timeframeDays: 7,
      blockedDates: ['2026-08-04'],
    })
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.scheduled_date !== '2026-08-04')).toBe(true)
  })

  it('a weekend-only block does not affect a weekday commitment', () => {
    const commitments: CommitmentForMaterialization[] = [
      { id: 'c1', freq: 3, dur: 30, bucket: 'weekday_morning' },
    ]
    const rows = materializeSlots({
      commitments,
      startedAt: MONDAY_START,
      timeframeDays: 7,
      blockedDates: ['2026-08-08'], // Saturday
    })
    expect(rows).toHaveLength(3)
  })
})
