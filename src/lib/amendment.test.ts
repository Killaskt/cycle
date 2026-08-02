import { describe, expect, it } from 'vitest'
import { ACTION_TYPES, proposeAmendment } from './amendment'

// Pure-function tests: no DB, no network, no model (ADR-0007) — ticket 012
// DoD's `proposeAmendment` contract in isolation from the Supabase
// round-trip (see src/test/integration/fallOff.test.ts for the DB-touching
// accept/reject/apply flow).

describe('ACTION_TYPES', () => {
  it('matches the DB action_type enum exactly (see src/test/integration/schema.test.ts)', () => {
    expect(ACTION_TYPES).toEqual([
      'NONE',
      'MOVE',
      'SHORTEN',
      'REDUCE_FREQUENCY',
      'REALLOCATE',
      'EASE_NEXT_DAY',
      'REMOVE',
      'UNHANDLED',
    ])
  })
})

describe('proposeAmendment', () => {
  it('occurrence 2 always proposes MOVE, confidence 1.0, non-empty reasoning, proposed_by rule', () => {
    const proposal = proposeAmendment({
      commitmentId: 'commitment-1',
      currentBucket: 'weekday_morning',
      wakeTime: '06:30',
      occurrenceInSlot: 2,
    })

    expect(proposal.action).toBe('MOVE')
    expect(proposal.confidence).toBe(1.0)
    expect(proposal.proposed_by).toBe('rule')
    expect(proposal.target).toEqual({ commitment_id: 'commitment-1' })
    expect(typeof proposal.reasoning).toBe('string')
    expect(proposal.reasoning.length).toBeGreaterThan(0)
  })

  it('proposes a bucket different from the current one', () => {
    const proposal = proposeAmendment({
      commitmentId: 'commitment-1',
      currentBucket: 'weekday_morning',
      wakeTime: '06:30',
      occurrenceInSlot: 2,
    })

    expect(proposal.params.bucket).not.toBe('weekday_morning')
  })

  it('is deterministic — identical inputs always produce identical output', () => {
    const input = {
      commitmentId: 'commitment-1',
      currentBucket: 'weekday_morning' as const,
      wakeTime: '06:30',
      occurrenceInSlot: 2,
    }

    expect(proposeAmendment(input)).toEqual(proposeAmendment(input))
  })

  it('never proposes a bucket blocked for this cycle', () => {
    const proposal = proposeAmendment({
      commitmentId: 'commitment-1',
      currentBucket: 'weekday_morning',
      wakeTime: '06:30',
      occurrenceInSlot: 2,
      blockedDates: ['2026-08-05'], // a weekday date -> all weekday_* buckets blocked
    })

    expect((proposal.params.bucket as string).startsWith('weekend_')).toBe(true)
  })

  it('excludeBuckets lets a caller ask for a revision avoiding a prior target', () => {
    const first = proposeAmendment({
      commitmentId: 'commitment-1',
      currentBucket: 'weekday_morning',
      wakeTime: '06:30',
      occurrenceInSlot: 2,
    })

    const revision = proposeAmendment(
      {
        commitmentId: 'commitment-1',
        currentBucket: 'weekday_morning',
        wakeTime: '06:30',
        occurrenceInSlot: 2,
      },
      [first.params.bucket as never],
    )

    expect(revision.params.bucket).not.toBe(first.params.bucket)
    expect(revision.params.bucket).not.toBe('weekday_morning')
  })

  it('throws for any occurrence other than 2 or 3', () => {
    expect(() =>
      proposeAmendment({
        commitmentId: 'commitment-1',
        currentBucket: 'weekday_morning',
        wakeTime: '06:30',
        occurrenceInSlot: 1,
      }),
    ).toThrow(/occurrence_in_slot 2 \(MOVE\) or 3 \(REMOVE\)/)

    expect(() =>
      proposeAmendment({
        commitmentId: 'commitment-1',
        currentBucket: 'weekday_morning',
        wakeTime: '06:30',
        occurrenceInSlot: 4,
      }),
    ).toThrow(/occurrence_in_slot 2 \(MOVE\) or 3 \(REMOVE\)/)
  })
})

// Ticket 013: occurrence 3 -> REMOVE (CONTEXT.md §9a's "the amendment was
// wrong, escalate to REMOVE"). Pure-function tests only — the `learnings`
// downgrade and the actual commitment/slot mutation are DB-touching and
// covered in src/test/integration/fallOff.test.ts.
describe('proposeAmendment — occurrence 3 (ticket 013)', () => {
  it('always proposes REMOVE, confidence 1.0, non-empty reasoning, proposed_by rule, no params', () => {
    const proposal = proposeAmendment({
      commitmentId: 'commitment-1',
      currentBucket: 'weekday_morning',
      wakeTime: '06:30',
      occurrenceInSlot: 3,
    })

    expect(proposal.action).toBe('REMOVE')
    expect(proposal.confidence).toBe(1.0)
    expect(proposal.proposed_by).toBe('rule')
    expect(proposal.target).toEqual({ commitment_id: 'commitment-1' })
    expect(proposal.params).toEqual({})
    expect(typeof proposal.reasoning).toBe('string')
    expect(proposal.reasoning.length).toBeGreaterThan(0)
  })

  it('is deterministic — identical inputs always produce identical output', () => {
    const input = {
      commitmentId: 'commitment-1',
      currentBucket: 'weekday_morning' as const,
      wakeTime: '06:30',
      occurrenceInSlot: 3,
    }

    expect(proposeAmendment(input)).toEqual(proposeAmendment(input))
  })

  it('reasoning never attributes failure to the person (CONTEXT.md §9e)', () => {
    const proposal = proposeAmendment({
      commitmentId: 'commitment-1',
      currentBucket: 'weekday_morning',
      wakeTime: '06:30',
      occurrenceInSlot: 3,
    })

    expect(proposal.reasoning.toLowerCase()).not.toMatch(/you (should|didn't|failed|need to)/)
    expect(proposal.reasoning).toMatch(/not you/i)
  })
})
