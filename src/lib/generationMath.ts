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
 * Ceiling back-off loop — CONTEXT.md §5 (cycle 1) and §6 (cycle 2+).
 *
 *   load    = Σ(planFreq × planDur)
 *   ceiling = ceilingBasisMinutes × 1.15
 *   while load > ceiling:
 *       back off the goal contributing the most *added* minutes, by one step
 *       // tie-break: intake order, LAST-entered goal (highest intakeOrder) backed off first
 *
 * `ceilingBasisMinutes` — the un-multiplied total minutes the ceiling is
 * based on. Omit it (cycle 1, CONTEXT.md §5) and it defaults to
 * Σ(currentFreq × currentDur) — the stated-current rule. Pass it explicitly
 * (cycle 2+, CONTEXT.md §6 — ticket 018) to use
 * `load_factor.last_cycle_completed_minutes` (measured completion) instead
 * — "capacity becomes measured, not claimed." This is the one seam ticket
 * 018 needed in ticket 003's math: a ceiling-basis parameter, not a forked
 * copy of this function.
 *
 * Back-off granularity (docs/agents/CLARIFICATIONS.md — genuine spec gap,
 * conservative assumption made): a goal's frequency step is retreated to 0
 * one unit at a time before its duration step is touched at all, then the
 * duration step is retreated one minute at a time. This is what guarantees
 * termination — once every goal's freqStep and durStep are both 0,
 * load == Σ(currentFreq × currentDur), which is always <= ceiling when
 * ceilingBasisMinutes >= Σ(currentFreq × currentDur) (true for the cycle 1
 * default, since that sum × 1.15 >= the sum itself; callers passing a
 * measured cycle-2+ basis are responsible for that basis being sane).
 */
export function applyCeiling(
  focusAreas: FocusAreaInput[],
  ceilingBasisMinutes?: number,
): FocusAreaPlan[] {
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

  const basis =
    ceilingBasisMinutes ?? plans.reduce((sum, a) => sum + a.currentFreq * a.currentDur, 0)
  const ceiling = basis * 1.15
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

/**
 * A single goal's completion rate for a closed cycle — CONTEXT.md §6:
 * "that goal's `completions` count / that goal's total scheduled `slots`
 * count in the prior cycle." `scheduledSlots <= 0` (a goal with no
 * materialized slots at all) reads as 0, not NaN/Infinity — same neutral
 * treatment as an untrusted reliability-map bucket.
 */
export function computeGoalCompletionRate(completions: number, scheduledSlots: number): number {
  if (scheduledSlots <= 0) return 0
  return completions / scheduledSlots
}

/** One goal's outcome from the prior (closed) cycle — the input to `computeNextCycleGoalPlan`. */
export interface PriorGoalOutcome {
  intakeOrder: number
  /** Prior cycle's `commitments.freq`/`dur` — what was actually scheduled, ticket 018. */
  priorPlanFreq: number
  priorPlanDur: number
  /** This goal's completed slot count / total scheduled slot count, prior cycle. */
  completions: number
  scheduledSlots: number
  /** The focus area's original (intake) `target_freq`/`target_dur` — only consulted by the `advance` band. */
  originalTargetFreq: number
  originalTargetDur: number
}

/** What `computeNextCycleGoalPlan` derives for one goal, ready to seed the new cycle's `focus_areas` row. */
export interface NextCycleGoalPlan {
  intakeOrder: number
  band: CompletionBand
  completionRate: number
  currentFreq: number
  currentDur: number
  targetFreq: number
  targetDur: number
}

/**
 * Between-cycle regeneration, per goal — CONTEXT.md §6, ticket 018. Turns
 * one goal's prior-cycle outcome into the new cycle's `focus_areas.
 * current_freq/current_dur/target_freq/target_dur` (or whatever the caller
 * feeds the next `generate` call with), evaluated per goal — never
 * aggregated.
 *
 * `advance` (>=90%): the new cycle starts from the prior plan
 * (`currentFreq/Dur = priorPlanFreq/Dur`) with the *original* intake target
 * left untouched — so the very next `generate` call's own `computeStep`/
 * `computeDurationStep` (ticket 003's math, reused verbatim, not
 * reimplemented) naturally takes one more delta step from where the prior
 * cycle actually left off, toward the same target. This is "advance one
 * more step toward target" using the existing formula, not a new one.
 *
 * `hold` (60-89%): CONTEXT.md §6 says "same plan" — implemented by pinning
 * `targetFreq/Dur = currentFreq/Dur = priorPlanFreq/Dur`. Gap is
 * deliberately forced to exactly 0 so a downstream `computeStep` call can
 * only ever produce 0 — "hold" cannot accidentally drift via the 0.25
 * rounding rule.
 *
 * `retreat_halfway` (<60%): CONTEXT.md §6 says "retreat halfway toward what
 * was actually completed." The schema has no per-slot recorded duration or
 * per-week actual-frequency figure — only a binary completed/scheduled per
 * slot (docs/SPEC.md §2 `slots.status`) — so "what was actually completed"
 * is derived as `completionRate * priorPlanFreq/Dur` (the same rate
 * `completionBand` already used to pick this band), then averaged with the
 * prior plan and rounded. `currentFreq/Dur` and `targetFreq/Dur` are both
 * pinned to that retreated number, same reasoning as `hold`: the retreat
 * amount is decided *here*, once, not re-derived by a second formula pass.
 * Genuine spec gap — logged to docs/agents/CLARIFICATIONS.md [018].
 */
export function computeNextCycleGoalPlan(outcome: PriorGoalOutcome): NextCycleGoalPlan {
  const completionRate = computeGoalCompletionRate(outcome.completions, outcome.scheduledSlots)
  const band = completionBand(completionRate)

  if (band === 'advance') {
    return {
      intakeOrder: outcome.intakeOrder,
      band,
      completionRate,
      currentFreq: outcome.priorPlanFreq,
      currentDur: outcome.priorPlanDur,
      targetFreq: outcome.originalTargetFreq,
      targetDur: outcome.originalTargetDur,
    }
  }

  if (band === 'hold') {
    return {
      intakeOrder: outcome.intakeOrder,
      band,
      completionRate,
      currentFreq: outcome.priorPlanFreq,
      currentDur: outcome.priorPlanDur,
      targetFreq: outcome.priorPlanFreq,
      targetDur: outcome.priorPlanDur,
    }
  }

  const actualFreq = completionRate * outcome.priorPlanFreq
  const actualDur = completionRate * outcome.priorPlanDur
  const retreatFreq = Math.round((outcome.priorPlanFreq + actualFreq) / 2)
  const retreatDur = Math.round((outcome.priorPlanDur + actualDur) / 2)

  return {
    intakeOrder: outcome.intakeOrder,
    band,
    completionRate,
    currentFreq: retreatFreq,
    currentDur: retreatDur,
    targetFreq: retreatFreq,
    targetDur: retreatDur,
  }
}
