// Ticket 005 DoD: fixture-provider tests through the real `generate`
// Edge Function, served locally (`MODEL_PROVIDER=fixture supabase
// functions serve generate` — see .claude/skills/local-supabase-stack/
// SKILL.md). No live network call — the fixture provider is selected by
// the server process's own MODEL_PROVIDER env var, not by this test.
import { beforeAll, describe, expect, it } from 'vitest'
import { checkInvariants } from '../../../supabase/functions/generate/invariants'
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './localSupabase'

const GENERATE_URL = `${SUPABASE_URL}/functions/v1/generate`

interface FocusAreaRequestBody {
  id: string
  name: string
  target_freq: number
  target_dur: number
  current_freq: number
  current_dur: number
  intake_order: number
}

interface CommitmentResultBody {
  focus_area_id: string
  name: string
  session_shape: string
  freq: number
  dur: number
  bucket: string
  rationale: string | null
  from_fallback: boolean
}

async function callGenerate(body: {
  wake_time: string
  focus_areas: FocusAreaRequestBody[]
  reliability_map: unknown[]
  blocked_windows: { date: string }[]
}): Promise<{ status: number; json: { commitments: CommitmentResultBody[] } }> {
  const res = await fetch(GENERATE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(body),
  })
  const json = await res.json()
  return { status: res.status, json }
}

// Fails fast with a clear message instead of every test in the file
// timing out one by one if the local function server isn't up.
beforeAll(async () => {
  try {
    await callGenerate({
      wake_time: '06:30',
      focus_areas: [],
      reliability_map: [],
      blocked_windows: [],
    })
  } catch {
    throw new Error(
      'generate function unreachable at ' +
        GENERATE_URL +
        ' — run `MODEL_PROVIDER=fixture npx -y supabase@latest functions serve generate` first ' +
        '(see .claude/skills/local-supabase-stack/SKILL.md).',
    )
  }
})

const runningFocusArea: FocusAreaRequestBody = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'running',
  target_freq: 4,
  target_dur: 30,
  current_freq: 1,
  current_dur: 20,
  intake_order: 0,
}

const spanishFocusArea: FocusAreaRequestBody = {
  id: '33333333-3333-3333-3333-333333333333',
  name: 'spanish',
  target_freq: 3,
  target_dur: 40,
  current_freq: 1,
  current_dur: 15,
  intake_order: 1,
}

describe('generate: fixture-provider happy path', () => {
  it('produces a commitment per focus area, sourced from the matching fixture', async () => {
    const { status, json } = await callGenerate({
      wake_time: '06:30',
      focus_areas: [runningFocusArea],
      reliability_map: [],
      blocked_windows: [],
    })

    expect(status).toBe(200)
    expect(json.commitments).toHaveLength(1)
    const [commitment] = json.commitments
    expect(commitment.focus_area_id).toBe(runningFocusArea.id)
    expect(commitment.name).toBe('Morning Run') // from fixtures/running.json
    expect(commitment.from_fallback).toBe(false)
    expect(commitment.rationale).not.toBeNull()
    // delta formula: freqStep=clamp(round(0.25*3),1,2)=1, durStep=clamp(round(0.25*10),5,15)=5
    // -> planFreq=2, planDur=25 -> load 50 > ceiling 23 -> backed off to freq=1, dur=23
    expect(commitment.freq).toBe(1)
    expect(commitment.dur).toBe(23)
  })

  it('handles multiple focus areas, applying the ceiling across all of them', async () => {
    const { status, json } = await callGenerate({
      wake_time: '06:30',
      focus_areas: [runningFocusArea, spanishFocusArea],
      reliability_map: [],
      blocked_windows: [],
    })

    expect(status).toBe(200)
    expect(json.commitments).toHaveLength(2)
    const totalLoad = json.commitments.reduce((sum, c) => sum + c.freq * c.dur, 0)
    const ceiling =
      (runningFocusArea.current_freq * runningFocusArea.current_dur +
        spanishFocusArea.current_freq * spanishFocusArea.current_dur) *
      1.15
    expect(totalLoad).toBeLessThanOrEqual(ceiling)
  })

  it('does not crash with an empty reliability_map (cycle 1) and treats it as neutral', async () => {
    const { status, json } = await callGenerate({
      wake_time: '06:30',
      focus_areas: [runningFocusArea],
      reliability_map: [],
      blocked_windows: [],
    })
    expect(status).toBe(200)
    expect(json.commitments[0].bucket).toBe('weekday_morning') // model's own preferred bucket, untouched
  })
})

describe('generate: malformed model response -> retry once -> deterministic fallback', () => {
  it('falls back to verbatim name, flat session shape, and first non-blocked bucket', async () => {
    const focusArea: FocusAreaRequestBody = {
      id: '22222222-2222-2222-2222-222222222222',
      name: '__invalid_bucket__', // fixture provider sentinel: returns an out-of-enum preferred_bucket every call
      target_freq: 5,
      target_dur: 45,
      current_freq: 2,
      current_dur: 20,
      intake_order: 0,
    }

    const { status, json } = await callGenerate({
      wake_time: '06:30',
      focus_areas: [focusArea],
      reliability_map: [],
      blocked_windows: [{ date: '2026-08-05' }], // a weekday date -> all weekday_* buckets blocked
    })

    expect(status).toBe(200)
    expect(json.commitments).toHaveLength(1)
    const [commitment] = json.commitments
    expect(commitment.from_fallback).toBe(true)
    expect(commitment.rationale).toBeNull()
    expect(commitment.name).toBe(focusArea.name) // verbatim focus-area text
    expect(commitment.session_shape).toMatch(/^single \d+-minute session$/) // flat block sized to plan_dur
    expect(commitment.bucket).toBe('weekend_early_morning') // first non-blocked bucket, wake-time order
  })
})

describe('generate: invariant checks against fixture output', () => {
  it('passes all four runtime invariants for a normal request', async () => {
    const focusAreas = [runningFocusArea, spanishFocusArea]
    const { json } = await callGenerate({
      wake_time: '06:30',
      focus_areas: focusAreas,
      reliability_map: [],
      blocked_windows: [],
    })

    const commitments = json.commitments.map((c) => ({
      focus_area_id: c.focus_area_id,
      name: c.name,
      session_shape: c.session_shape,
      freq: c.freq,
      dur: c.dur,
      bucket: c.bucket as never,
      rationale: c.rationale,
      from_fallback: c.from_fallback,
    }))

    const result = checkInvariants(commitments, focusAreas, [])
    expect(result.valid).toBe(true)
    expect(result.reasons).toEqual([])
  })

  it('no commitment lands in a blocked bucket', async () => {
    const { json } = await callGenerate({
      wake_time: '06:30',
      focus_areas: [runningFocusArea],
      reliability_map: [],
      blocked_windows: [{ date: '2026-08-05' }], // weekday
    })
    expect(json.commitments[0].bucket.startsWith('weekend_')).toBe(true)
  })
})
