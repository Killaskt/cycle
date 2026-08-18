// Provider seam — docs/SPEC.md §3, ADR-0005: "same provider-seam pattern
// as the amendment path, selected by env var". Deno-only (Deno.env, JSON
// import attributes) — never imported from Vitest directly; exercised
// only via HTTP against the locally-served function.

// deno-lint-ignore-file no-explicit-any
import runningFixture from './fixtures/running.json' with { type: 'json' }
import spanishFixture from './fixtures/spanish.json' with { type: 'json' }
import strengthTrainingFixture from './fixtures/strength_training.json' with { type: 'json' }
import type { FocusAreaRequest } from './types.ts'

export interface ProviderInput {
  focus_area: FocusAreaRequest
  wake_time: string
}

// Returns a raw, unvalidated candidate response — validate.ts is the
// single place that decides whether it's usable.
export type Provider = (input: ProviderInput) => Promise<unknown>

interface CannedResponse {
  commitment_name: string
  session_shape: string
  preferred_bucket: string
  rationale: string
}

// Checked-in fixtures, keyed by focus area name (exact match). Every file
// here must pass validate.ts's shape check — see the contract test.
const FIXTURES: Record<string, CannedResponse> = {
  running: runningFixture,
  spanish: spanishFixture,
  strength_training: strengthTrainingFixture,
}

// Deliberately-invalid response, used only to exercise the retry-then-
// fallback path in tests (ticket 005 DoD). Not a checked-in fixture file
// on purpose: the contract test asserts every *file* in fixtures/ is
// valid, and this sentinel must stay outside that sweep.
const INVALID_BUCKET_SENTINEL = '__invalid_bucket__'

function defaultFixtureFor(focusArea: FocusAreaRequest): CannedResponse {
  return {
    commitment_name: focusArea.name,
    session_shape: 'single session',
    preferred_bucket: 'weekday_morning',
    rationale: `Fixture-generated plan for ${focusArea.name}.`,
  }
}

export const fixtureProvider: Provider = (input) => {
  if (input.focus_area.name === INVALID_BUCKET_SENTINEL) {
    return Promise.resolve({
      focus_id: input.focus_area.id,
      commitment_name: 'Bad Fixture',
      session_shape: 'x',
      preferred_bucket: 'not_a_real_bucket',
      rationale: 'y',
    })
  }
  const canned = FIXTURES[input.focus_area.name] ?? defaultFixtureFor(input.focus_area)
  return Promise.resolve({ focus_id: input.focus_area.id, ...canned })
}

// Real provider — not covered by this ticket's tests (no live API key in
// CI/local automated runs; MODEL_PROVIDER=live is for manual dev use
// only, per .claude/skills/local-supabase-stack/SKILL.md).
// docs/agents/CLARIFICATIONS.md: neither CONTEXT.md nor SPEC.md names a
// specific model/provider for the live path. Conservative, reversible
// assumption: Anthropic's Messages API, model name overridable via
// MODEL_NAME, key via ANTHROPIC_API_KEY — swappable later with no change
// to the seam's shape.
const liveProvider: Provider = async (input) => {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) {
    throw new Error(
      'MODEL_PROVIDER=live requires ANTHROPIC_API_KEY in supabase/functions/generate/.env.local (never commit this file)',
    )
  }
  const model = Deno.env.get('MODEL_NAME') ?? 'claude-3-5-haiku-latest'

  const prompt = [
    'Turn this focus area into a schedulable commitment shape.',
    'Respond with ONLY a JSON object, no prose, matching exactly:',
    '{ "focus_id": string, "commitment_name": string, "session_shape": string, "preferred_bucket": string, "rationale": string }',
    '"preferred_bucket" must be one of the 12 values day_type_time_of_day where',
    'day_type is "weekday" or "weekend" and time_of_day is one of "early_morning",',
    '"morning", "midday", "afternoon", "evening", "night".',
    'Never invent frequency or duration numbers — those are computed elsewhere.',
    '',
    `focus_id: ${input.focus_area.id}`,
    `focus area name: ${input.focus_area.name}`,
    `wake time: ${input.wake_time}`,
  ].join('\n')

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      temperature: 0, // CONTEXT.md §12: temperature 0 helps marginally; invariants are the real guarantee
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  if (!res.ok) {
    throw new Error(`live model call failed: ${res.status} ${await res.text()}`)
  }

  const data = (await res.json()) as { content?: { type: string; text?: string }[] }
  const text = data.content?.find((block) => block.type === 'text')?.text ?? ''
  try {
    return JSON.parse(text)
  } catch {
    // Not valid JSON at all — let validate.ts's shape check reject it
    // (null) so the standard retry-then-fallback path handles it.
    return null
  }
}

export function getProvider(): Provider {
  const mode = Deno.env.get('MODEL_PROVIDER') ?? 'fixture'
  return mode === 'live' ? liveProvider : fixtureProvider
}
