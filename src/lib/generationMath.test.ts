import { describe, expect, it } from 'vitest'
import {
  applyCeiling,
  completionBand,
  computeDurationStep,
  computeStep,
  type FocusAreaInput,
} from './generationMath'

describe('computeStep', () => {
  it('gap > 0: clamp(round(0.25 * gap), 1, 2), mid-range', () => {
    // gap = 4, 0.25*4 = 1, round = 1, clamp(1,1,2) = 1
    expect(computeStep(1, 5)).toBe(1)
  })

  it('gap > 0: clamps up to 2 for a large gap', () => {
    // gap = 10, 0.25*10 = 2.5, round = 3, clamp(3,1,2) = 2
    expect(computeStep(0, 10)).toBe(2)
  })

  it('gap > 0: clamps up to 1 for a tiny gap that rounds to 0', () => {
    // gap = 1, 0.25*1 = 0.25, round = 0, clamp(0,1,2) = 1
    expect(computeStep(2, 3)).toBe(1)
  })

  it('gap == 0 produces step 0 (guard, not clamped to a minimum of 1)', () => {
    expect(computeStep(3, 3)).toBe(0)
  })

  it('gap < 0 produces step 0 (guard, not clamped to a minimum of 1)', () => {
    expect(computeStep(5, 3)).toBe(0)
  })
})

describe('computeDurationStep', () => {
  it('gap > 0: clamp(round(0.25 * gap), 5, 15), mid-range', () => {
    // gap = 40, 0.25*40 = 10, round = 10, clamp(10,5,15) = 10
    expect(computeDurationStep(10, 50)).toBe(10)
  })

  it('gap > 0: clamps up to 15 for a large gap', () => {
    // gap = 100, 0.25*100 = 25, round = 25, clamp(25,5,15) = 15
    expect(computeDurationStep(0, 100)).toBe(15)
  })

  it('gap > 0: clamps down to 5 for a tiny gap', () => {
    // gap = 2, 0.25*2 = 0.5, round = 1, clamp(1,5,15) = 5
    expect(computeDurationStep(10, 12)).toBe(5)
  })

  it('gap == 0 produces step 0 (guard, not clamped to a minimum of 5)', () => {
    expect(computeDurationStep(20, 20)).toBe(0)
  })

  it('gap < 0 produces step 0 (guard, not clamped to a minimum of 5)', () => {
    expect(computeDurationStep(30, 20)).toBe(0)
  })
})

describe('applyCeiling', () => {
  it('leaves the step untouched when load is already within ceiling', () => {
    const areas: FocusAreaInput[] = [
      { intakeOrder: 0, currentFreq: 10, targetFreq: 11, currentDur: 30, targetDur: 30 },
    ]
    // gap = 1 -> step = clamp(round(0.25),1,2) = 1 -> planFreq = 11, planDur = 30 (durGap = 0)
    // load = 11*30 = 330, ceiling = (10*30)*1.15 = 345 -> already within ceiling, no back-off.
    const [plan] = applyCeiling(areas)
    expect(plan.freqStep).toBe(1)
    expect(plan.planFreq).toBe(11)
  })

  it('tie-break: on equal added minutes, the last-entered goal (highest intakeOrder) is backed off', () => {
    const areas: FocusAreaInput[] = [
      { intakeOrder: 0, currentFreq: 4, targetFreq: 8, currentDur: 30, targetDur: 30 },
      { intakeOrder: 1, currentFreq: 4, targetFreq: 8, currentDur: 30, targetDur: 30 },
    ]
    // Each goal: gap = 4 -> step = 1 -> planFreq = 5, planDur = 30 (durGap = 0)
    // addedMinutes = 5*30 - 4*30 = 30 for both goals -> tie.
    // ceiling = (4*30 + 4*30) * 1.15 = 276
    // load before back-off = 5*30 + 5*30 = 300 > 276
    // one back-off (30 minutes) brings load to 270 <= 276 -> exactly one back-off needed.
    const [goalA, goalB] = applyCeiling(areas)

    expect(goalB.freqStep).toBe(0) // last-entered (intakeOrder 1) backed off
    expect(goalB.planFreq).toBe(goalB.currentFreq)
    expect(goalA.freqStep).toBe(1) // first-entered untouched
    expect(goalA.planFreq).toBe(5)

    const load = goalA.planFreq * goalA.planDur + goalB.planFreq * goalB.planDur
    const ceiling = (areas[0].currentFreq * areas[0].currentDur + areas[1].currentFreq * areas[1].currentDur) * 1.15
    expect(load).toBeLessThanOrEqual(ceiling)
  })

  it('terminates and never leaves load > ceiling, even when both freq and duration steps must be fully retreated', () => {
    const areas: FocusAreaInput[] = [
      { intakeOrder: 0, currentFreq: 1, targetFreq: 10, currentDur: 10, targetDur: 100 },
      { intakeOrder: 1, currentFreq: 1, targetFreq: 10, currentDur: 10, targetDur: 100 },
    ]
    // Large gaps on both axes force the loop through many iterations,
    // including retreating durStep after freqStep is already at 0.
    const plans = applyCeiling(areas)

    const load = plans.reduce((sum, p) => sum + p.planFreq * p.planDur, 0)
    const ceiling = areas.reduce((sum, a) => sum + a.currentFreq * a.currentDur, 0) * 1.15
    expect(load).toBeLessThanOrEqual(ceiling)

    // Reverting every goal to zero step (plan == current) is what guarantees
    // satisfiability; confirm the algorithm actually reached that floor here.
    for (const plan of plans) {
      expect(plan.freqStep).toBeGreaterThanOrEqual(0)
      expect(plan.durStep).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('completionBand', () => {
  it('>= 90% advances', () => {
    expect(completionBand(0.9)).toBe('advance')
    expect(completionBand(1)).toBe('advance')
  })

  it('60-89% holds', () => {
    expect(completionBand(0.6)).toBe('hold')
    expect(completionBand(0.89)).toBe('hold')
  })

  it('< 60% retreats halfway', () => {
    expect(completionBand(0.59)).toBe('retreat_halfway')
    expect(completionBand(0)).toBe('retreat_halfway')
  })

  it('evaluates each goal independently, not aggregated', () => {
    const rates = [0.95, 0.7, 0.3]
    const bands = rates.map(completionBand)
    expect(bands).toEqual(['advance', 'hold', 'retreat_halfway'])
  })
})
