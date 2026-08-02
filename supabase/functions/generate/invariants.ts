// The four runtime invariant checks — docs/SPEC.md §3, run as "the actual
// runtime validator (not only in tests)". Pure logic, no Deno APIs —
// importable from both the Deno function runtime and Vitest.

import { computeDurationStep, computeStep } from '../../../src/lib/generationMath.ts'
import { blockedBucketSet } from './bucketOrder.ts'
import type { BlockedWindowInput, CommitmentResult, FocusAreaRequest } from './types.ts'

export interface InvariantResult {
  valid: boolean
  /** focus_area ids whose commitment failed at least one check. */
  offendingFocusAreaIds: string[]
  reasons: string[]
}

/**
 * Runs all four docs/SPEC.md §3 invariants against a full generation
 * response:
 *   1. Exactly one commitment per submitted focus area.
 *   2. No commitment's bucket collides with a blocked_windows-derived block.
 *   3. Every freq/dur is within the delta-formula's bounds for that focus area.
 *   4. Total load (Σ freq×dur) <= ceiling.
 */
export function checkInvariants(
  commitments: CommitmentResult[],
  focusAreas: FocusAreaRequest[],
  blockedWindows: BlockedWindowInput[],
): InvariantResult {
  const offending = new Set<string>()
  const reasons: string[] = []

  // 1. exactly one commitment per submitted focus area
  const byFocusArea = new Map<string, CommitmentResult[]>()
  for (const c of commitments) {
    byFocusArea.set(c.focus_area_id, [...(byFocusArea.get(c.focus_area_id) ?? []), c])
  }
  for (const fa of focusAreas) {
    const matches = byFocusArea.get(fa.id) ?? []
    if (matches.length !== 1) {
      offending.add(fa.id)
      reasons.push(`focus area ${fa.id}: expected exactly 1 commitment, got ${matches.length}`)
    }
  }

  // 2. no commitment's bucket collides with a blocked window
  const blocked = blockedBucketSet(blockedWindows)
  for (const c of commitments) {
    if (blocked.has(c.bucket)) {
      offending.add(c.focus_area_id)
      reasons.push(`focus area ${c.focus_area_id}: bucket ${c.bucket} collides with a blocked window`)
    }
  }

  // 3. freq/dur within delta-formula bounds
  const focusById = new Map(focusAreas.map((fa) => [fa.id, fa]))
  for (const c of commitments) {
    const fa = focusById.get(c.focus_area_id)
    if (!fa) continue // no matching focus area submitted — already caught by check 1
    const freqStep = computeStep(fa.current_freq, fa.target_freq)
    const durStep = computeDurationStep(fa.current_dur, fa.target_dur)
    const minFreq = fa.current_freq
    const maxFreq = fa.current_freq + freqStep
    const minDur = fa.current_dur
    const maxDur = fa.current_dur + durStep
    if (c.freq < minFreq || c.freq > maxFreq || c.dur < minDur || c.dur > maxDur) {
      offending.add(c.focus_area_id)
      reasons.push(
        `focus area ${c.focus_area_id}: freq/dur (${c.freq}/${c.dur}) outside delta bounds [${minFreq}-${maxFreq}]/[${minDur}-${maxDur}]`,
      )
    }
  }

  // 4. total load <= ceiling (CONTEXT.md §5: Σ(currentFreq × currentDur) × 1.15)
  const ceiling = focusAreas.reduce((sum, fa) => sum + fa.current_freq * fa.current_dur, 0) * 1.15
  const load = commitments.reduce((sum, c) => sum + c.freq * c.dur, 0)
  if (load > ceiling) {
    reasons.push(`total load ${load} exceeds ceiling ${ceiling}`)
    // A ceiling breach isn't attributable to a single focus area — mark
    // every submitted focus area offending so the retry/fallback path
    // re-derives freq/dur for the whole set.
    for (const fa of focusAreas) offending.add(fa.id)
  }

  return { valid: offending.size === 0, offendingFocusAreaIds: [...offending], reasons }
}
