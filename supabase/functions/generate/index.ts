// `generate` Edge Function — docs/SPEC.md §3, docs/adr/0005. The model
// interprets (name/shape/placement suggestion), code schedules (delta
// formula, ceiling, blocked windows, reliability map — CONTEXT.md §12).

import { applyCeiling } from '../../../src/lib/generationMath.ts'
import type { FocusAreaInput } from '../../../src/lib/generationMath.ts'
import { blockedBucketSet, firstAvailableBucket, resolveBucket } from './bucketOrder.ts'
import { checkInvariants } from './invariants.ts'
import { getProvider } from './provider.ts'
import type { Provider } from './provider.ts'
import type { CommitmentResult, FocusAreaRequest, GenerateRequest, ModelResponse } from './types.ts'
import { validateModelResponse } from './validate.ts'

/**
 * Calls the provider for one focus area, retrying once on an invalid
 * response — docs/SPEC.md §3: "anything else is a validation failure →
 * retry once → fallback". Returns `null` if both attempts were invalid.
 */
async function getModelResponse(
  focusArea: FocusAreaRequest,
  wakeTime: string,
  provider: Provider,
): Promise<ModelResponse | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await provider({ focus_area: focusArea, wake_time: wakeTime })
    const validated = validateModelResponse(raw)
    if (validated && validated.focus_id === focusArea.id) return validated
  }
  return null
}

/** CONTEXT.md §12 deterministic fallback for one focus area. */
function fallbackCommitment(
  focusArea: FocusAreaRequest,
  planFreq: number,
  planDur: number,
  wakeTime: string,
  blockedWindows: GenerateRequest['blocked_windows'],
): CommitmentResult {
  return {
    focus_area_id: focusArea.id,
    name: focusArea.name, // verbatim, never rewritten
    session_shape: `single ${planDur}-minute session`, // one flat block sized to plan_dur
    freq: planFreq,
    dur: planDur,
    bucket: firstAvailableBucket(wakeTime, blockedWindows),
    rationale: null, // null when the deterministic fallback produced this row
    from_fallback: true,
  }
}

function commitmentFromModelResponse(
  focusArea: FocusAreaRequest,
  planFreq: number,
  planDur: number,
  modelResponse: ModelResponse,
  request: GenerateRequest,
): CommitmentResult {
  return {
    focus_area_id: focusArea.id,
    name: modelResponse.commitment_name,
    session_shape: modelResponse.session_shape,
    freq: planFreq,
    dur: planDur,
    bucket: resolveBucket(modelResponse.preferred_bucket, request.wake_time, request.blocked_windows, request.reliability_map),
    rationale: modelResponse.rationale,
    from_fallback: false,
  }
}

export async function buildCommitments(request: GenerateRequest): Promise<CommitmentResult[]> {
  const provider = getProvider()

  // Deterministic math — CONTEXT.md §5, ticket 003. No model involved.
  // `ceiling_basis_minutes` (CONTEXT.md §6, ticket 018): present for cycle
  // 2+ (systemPlan.ts sets it from load_factor), absent for cycle 1 — in
  // which case `applyCeiling` falls back to its own stated-current default.
  const plans = applyCeiling(
    request.focus_areas.map(
      (fa): FocusAreaInput => ({
        intakeOrder: fa.intake_order,
        currentFreq: fa.current_freq,
        targetFreq: fa.target_freq,
        currentDur: fa.current_dur,
        targetDur: fa.target_dur,
      }),
    ),
    request.ceiling_basis_minutes,
  )

  const commitments: CommitmentResult[] = []
  for (let i = 0; i < request.focus_areas.length; i++) {
    const focusArea = request.focus_areas[i]
    const plan = plans[i]
    const modelResponse = await getModelResponse(focusArea, request.wake_time, provider)

    commitments.push(
      modelResponse
        ? commitmentFromModelResponse(focusArea, plan.planFreq, plan.planDur, modelResponse, request)
        : fallbackCommitment(focusArea, plan.planFreq, plan.planDur, request.wake_time, request.blocked_windows),
    )
  }

  // Runtime invariant validator — docs/SPEC.md §3, run for real (not only
  // in tests). Should be a no-op given the above already enforces these,
  // but is the actual guarantee, not a test convenience. Any failure:
  // retry the model call once more for the offending focus area(s) only,
  // second failure → deterministic fallback for those only.
  const firstCheck = checkInvariants(
    commitments,
    request.focus_areas,
    request.blocked_windows,
    request.ceiling_basis_minutes,
  )
  if (!firstCheck.valid) {
    for (const focusAreaId of firstCheck.offendingFocusAreaIds) {
      const idx = commitments.findIndex((c) => c.focus_area_id === focusAreaId)
      const focusAreaIdx = request.focus_areas.findIndex((fa) => fa.id === focusAreaId)
      if (idx === -1 || focusAreaIdx === -1) continue
      const focusArea = request.focus_areas[focusAreaIdx]
      const plan = plans[focusAreaIdx]

      const retried = await getModelResponse(focusArea, request.wake_time, provider)
      const candidate = retried
        ? commitmentFromModelResponse(focusArea, plan.planFreq, plan.planDur, retried, request)
        : null
      const blocked = blockedBucketSet(request.blocked_windows)
      commitments[idx] =
        candidate && !blocked.has(candidate.bucket)
          ? candidate
          : fallbackCommitment(focusArea, plan.planFreq, plan.planDur, request.wake_time, request.blocked_windows)
    }
  }

  return commitments
}

Deno.serve(async (req: Request) => {
  try {
    const body = (await req.json()) as GenerateRequest
    const commitments = await buildCommitments(body)
    return new Response(JSON.stringify({ commitments }), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'unknown error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  }
})
