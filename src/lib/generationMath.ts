// Deterministic generation math — CONTEXT.md §5 (cycle 1 delta/ceiling) and §6
// (between-cycle completion bands). Pure functions only: no DB, no network,
// no model calls. See ticket 003.

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * Frequency step for cycle 1 generation — CONTEXT.md §5.
 *
 *   gap  = targetFreq - currentFreq
 *   step = gap > 0 ? clamp(round(0.25 * gap), 1, 2) : 0
 *
 * The `gap <= 0` guard must return exactly 0 — never clamp up to a minimum
 * of 1. Re-introducing that clamp (making step at least 1 even when the
 * target is already met or exceeded) was a caught bug in the design
 * session; do not "fix" this to always return >= 1.
 */
export function computeStep(currentFreq: number, targetFreq: number): number {
  const gap = targetFreq - currentFreq
  if (gap <= 0) return 0
  return clamp(Math.round(0.25 * gap), 1, 2)
}

/**
 * Duration step (minutes) for cycle 1 generation — CONTEXT.md §5.
 *
 *   durGap  = targetDur - currentDur
 *   durStep = durGap > 0 ? clamp(round(0.25 * durGap), 5, 15) : 0
 *
 * Same zero guard as computeStep: gap <= 0 must produce exactly 0.
 */
export function computeDurationStep(currentDur: number, targetDur: number): number {
  const gap = targetDur - currentDur
  if (gap <= 0) return 0
  return clamp(Math.round(0.25 * gap), 5, 15)
}

export interface FocusAreaInput {
  /** Intake entry order. Ceiling back-off tie-break: last-entered (highest) goes first. */
  intakeOrder: number
  currentFreq: number
  targetFreq: number
  currentDur: number
  targetDur: number
}

export interface FocusAreaPlan extends FocusAreaInput {
  freqStep: number
  durStep: number
  planFreq: number
  planDur: number
}

function addedMinutes(area: {
  currentFreq: number
  currentDur: number
  planFreq: number
  planDur: number
}): number {
  return area.planFreq * area.planDur - area.currentFreq * area.currentDur
}

/**
 * Ceiling back-off loop — CONTEXT.md §5.
 *
 *   load    = Σ(planFreq × planDur)
 *   ceiling = Σ(currentFreq × currentDur) × 1.15   (cycle 1: stated current; fixed for the whole loop)
 *   while load > ceiling:
 *       back off the goal contributing the most *added* minutes, by one step
 *       // tie-break: intake order, LAST-entered goal (highest intakeOrder) backed off first
 *
 * Back-off granularity (docs/agents/CLARIFICATIONS.md — genuine spec gap,
 * conservative assumption made): a goal's frequency step is retreated to 0
 * one unit at a time before its duration step is touched at all, then the
 * duration step is retreated one minute at a time. This is what guarantees
 * termination — once every goal's freqStep and durStep are both 0,
 * load == Σ(currentFreq × currentDur), which is always <= ceiling since
 * ceiling is that same sum × 1.15 (and freq/dur are never negative).
 */
export function applyCeiling(focusAreas: FocusAreaInput[]): FocusAreaPlan[] {
  const plans: FocusAreaPlan[] = focusAreas.map((area) => {
    const freqStep = computeStep(area.currentFreq, area.targetFreq)
    const durStep = computeDurationStep(area.currentDur, area.targetDur)
    return {
      ...area,
      freqStep,
      durStep,
      planFreq: area.currentFreq + freqStep,
      planDur: area.currentDur + durStep,
    }
  })

  const ceiling = plans.reduce((sum, a) => sum + a.currentFreq * a.currentDur, 0) * 1.15
  const currentLoad = () => plans.reduce((sum, a) => sum + a.planFreq * a.planDur, 0)

  while (currentLoad() > ceiling) {
    const candidates = plans.filter((a) => a.freqStep > 0 || a.durStep > 0)
    // Unreachable given the ceiling formula above (see doc comment), but
    // guard against an infinite loop rather than trust that invariant blindly.
    if (candidates.length === 0) break

    let chosen = candidates[0]
    let chosenAdded = addedMinutes(chosen)
    for (const candidate of candidates.slice(1)) {
      const candidateAdded = addedMinutes(candidate)
      if (
        candidateAdded > chosenAdded ||
        (candidateAdded === chosenAdded && candidate.intakeOrder > chosen.intakeOrder)
      ) {
        chosen = candidate
        chosenAdded = candidateAdded
      }
    }

    if (chosen.freqStep > 0) {
      chosen.freqStep -= 1
      chosen.planFreq = chosen.currentFreq + chosen.freqStep
    } else {
      chosen.durStep -= 1
      chosen.planDur = chosen.currentDur + chosen.durStep
    }
  }

  return plans
}

export type CompletionBand = 'advance' | 'hold' | 'retreat_halfway'

/**
 * Per-goal completion band — CONTEXT.md §6. Evaluated per goal, never
 * aggregated across the cycle. `rate` is a 0..1 fraction (completed /
 * scheduled) for a single goal.
 *
 *   >= 0.90        -> advance one more step toward target
 *   0.60 .. 0.89   -> hold, same plan
 *   < 0.60         -> retreat halfway toward what was actually completed
 */
export function completionBand(rate: number): CompletionBand {
  if (rate >= 0.9) return 'advance'
  if (rate >= 0.6) return 'hold'
  return 'retreat_halfway'
}
