import { describe, expect, it } from 'vitest'
import { applyCeiling } from '../../../src/lib/generationMath'
import { checkInvariants } from './invariants'
import type { CommitmentResult, FocusAreaRequest } from './types'

const running: FocusAreaRequest = {
  id: 'fa-running',
  name: 'running',
  target_freq: 4,
  target_dur: 30,
  current_freq: 1,
  current_dur: 20,
  intake_order: 0,
}

// Ground truth for "in bounds" comes from the real math library, not a
// hand-computed guess — avoids the test silently drifting from the
// formula it's supposed to be checking.
const [plan] = applyCeiling([
  {
    intakeOrder: running.intake_order,
    currentFreq: running.current_freq,
    targetFreq: running.target_freq,
    currentDur: running.current_dur,
    targetDur: running.target_dur,
  },
])

const validCommitment: CommitmentResult = {
  focus_area_id: 'fa-running',
  name: 'Morning Run',
  session_shape: 'single continuous run',
  freq: plan.planFreq,
  dur: plan.planDur,
  bucket: 'weekday_morning',
  rationale: 'because',
  from_fallback: false,
}

describe('checkInvariants', () => {
  it('passes for a well-formed single-focus-area response', () => {
    const result = checkInvariants([validCommitment], [running], [])
    expect(result.valid).toBe(true)
    expect(result.offendingFocusAreaIds).toEqual([])
  })

  it('does not crash on empty blocked_windows/reliability inputs (cycle 1)', () => {
    expect(() => checkInvariants([validCommitment], [running], [])).not.toThrow()
  })

  it('fails when a focus area has zero commitments', () => {
    const result = checkInvariants([], [running], [])
    expect(result.valid).toBe(false)
    expect(result.offendingFocusAreaIds).toContain('fa-running')
  })

  it('fails when a focus area has more than one commitment', () => {
    const result = checkInvariants([validCommitment, { ...validCommitment }], [running], [])
    expect(result.valid).toBe(false)
    expect(result.offendingFocusAreaIds).toContain('fa-running')
  })

  it('fails when the bucket collides with a blocked window', () => {
    const result = checkInvariants([validCommitment], [running], [{ date: '2026-08-05' }]) // weekday
    expect(result.valid).toBe(false)
    expect(result.offendingFocusAreaIds).toContain('fa-running')
  })

  it('fails when freq is outside the delta-formula bounds', () => {
    const result = checkInvariants([{ ...validCommitment, freq: validCommitment.freq + 10 }], [running], [])
    expect(result.valid).toBe(false)
    expect(result.offendingFocusAreaIds).toContain('fa-running')
  })

  it('fails when dur is outside the delta-formula bounds', () => {
    const result = checkInvariants([{ ...validCommitment, dur: validCommitment.dur + 100 }], [running], [])
    expect(result.valid).toBe(false)
    expect(result.offendingFocusAreaIds).toContain('fa-running')
  })

  it('fails when total load exceeds the ceiling', () => {
    // Bypass applyCeiling entirely: freq/dur pinned straight to the
    // user's stated targets, ignoring the backoff loop that keeps load
    // under ceiling = currentFreq*currentDur*1.15.
    const overloaded = { ...validCommitment, freq: running.target_freq, dur: running.target_dur }
    const result = checkInvariants([overloaded], [running], [])
    expect(result.reasons.some((r) => r.includes('exceeds ceiling'))).toBe(true)
    expect(result.valid).toBe(false)
  })
})
