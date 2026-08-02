// Ticket 008 DoD, exercised against the real local stack (RLS included)
// and the real `generate` Edge Function running locally with the fixture
// provider — `MODEL_PROVIDER=fixture npx -y supabase@latest functions
// serve generate` (see .claude/skills/local-supabase-stack/SKILL.md):
// - Accept transitions status draft -> active and materializes slots
//   exactly once (a second Accept surfaces materializeCycleSlots' own
//   "already materialized" rejection, not a silent no-op).
// - Regenerate before accept keeps the same formula-derived freq/dur (same
//   inputs -> same deterministic math) and flips regenerate_used.
// - Regenerate a second time, or after the cycle is active, is rejected.

import { beforeAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL } from './localSupabase'
import {
  acceptCycle,
  fetchSystemPlan,
  generateInitialCommitments,
  regenerateCommitments,
} from '../../lib/systemPlan'

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

async function mintUser(label: string) {
  const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`
  const password = 'password123!'
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (error || !data.user) throw error ?? new Error('createUser returned no user')

  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { error: signInError } = await client.auth.signInWithPassword({ email, password })
  if (signInError) throw signInError

  return { userId: data.user.id, client }
}

async function setUpDraftCycle(
  client: SupabaseClient,
  userId: string,
  opts: { timeframeDays?: number } = {},
) {
  const { data: cycle, error: cycleError } = await client
    .from('cycles')
    .insert({
      user_id: userId,
      status: 'draft',
      timeframe_days: opts.timeframeDays ?? 14,
      wake_time: '06:30',
    })
    .select()
    .single()
  if (cycleError) throw cycleError

  const { error: focusAreaError } = await client.from('focus_areas').insert([
    {
      cycle_id: cycle.id,
      name: 'running',
      target_freq: 4,
      target_dur: 30,
      current_freq: 1,
      current_dur: 20,
      intake_order: 0,
    },
    {
      cycle_id: cycle.id,
      name: 'spanish',
      target_freq: 3,
      target_dur: 40,
      current_freq: 1,
      current_dur: 15,
      intake_order: 1,
    },
  ])
  if (focusAreaError) throw focusAreaError

  return cycle
}

// Fails fast with a clear message instead of every test in the file
// timing out one by one if the local function server isn't up — same
// pattern as src/test/integration/generate.test.ts.
beforeAll(async () => {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ wake_time: '06:30', focus_areas: [], reliability_map: [], blocked_windows: [] }),
  }).catch(() => null)
  if (!res) {
    throw new Error(
      'generate function unreachable at ' +
        SUPABASE_URL +
        ' — run `MODEL_PROVIDER=fixture npx -y supabase@latest functions serve generate` first ' +
        '(see .claude/skills/local-supabase-stack/SKILL.md).',
    )
  }
})

describe('generateInitialCommitments', () => {
  it('generates one commitment per focus area and leaves regenerate_used false', async () => {
    const { userId, client } = await mintUser('sysplan-initial')
    const cycle = await setUpDraftCycle(client, userId)

    const commitments = await generateInitialCommitments(client, cycle.id)
    expect(commitments).toHaveLength(2)

    const plan = await fetchSystemPlan(client, cycle.id)
    expect(plan.commitments).toHaveLength(2)
    expect(plan.cycle.regenerate_used).toBe(false)
    expect(plan.cycle.status).toBe('draft')
  })

  it('refuses to generate again once commitments already exist', async () => {
    const { userId, client } = await mintUser('sysplan-initial-twice')
    const cycle = await setUpDraftCycle(client, userId)

    await generateInitialCommitments(client, cycle.id)
    await expect(generateInitialCommitments(client, cycle.id)).rejects.toThrow(/already has commitments/)
  })
})

describe('regenerateCommitments', () => {
  it('keeps the same formula-derived freq/dur and flips regenerate_used to true', async () => {
    const { userId, client } = await mintUser('sysplan-regen')
    const cycle = await setUpDraftCycle(client, userId)

    const first = await generateInitialCommitments(client, cycle.id)
    const firstByFocusArea = new Map(first.map((c) => [c.focus_area_id, c]))

    const second = await regenerateCommitments(client, cycle.id)
    expect(second).toHaveLength(first.length)
    for (const commitment of second) {
      const before = firstByFocusArea.get(commitment.focus_area_id)
      expect(before).toBeDefined()
      // Deterministic parts (CONTEXT.md §5) must be identical for the same
      // inputs — only naming/placement (model layer) may re-roll.
      expect(commitment.freq).toBe(before!.freq)
      expect(commitment.dur).toBe(before!.dur)
    }

    const plan = await fetchSystemPlan(client, cycle.id)
    expect(plan.cycle.regenerate_used).toBe(true)
    // Old commitment rows were replaced, not appended.
    expect(plan.commitments).toHaveLength(first.length)
  })

  it('rejects a second regenerate for the same cycle', async () => {
    const { userId, client } = await mintUser('sysplan-regen-twice')
    const cycle = await setUpDraftCycle(client, userId)

    await generateInitialCommitments(client, cycle.id)
    await regenerateCommitments(client, cycle.id)

    await expect(regenerateCommitments(client, cycle.id)).rejects.toThrow(/already used its one regenerate/)
  })

  it('rejects regenerate once the cycle is active', async () => {
    const { userId, client } = await mintUser('sysplan-regen-active')
    const cycle = await setUpDraftCycle(client, userId)

    await generateInitialCommitments(client, cycle.id)
    await acceptCycle(client, cycle.id)

    await expect(regenerateCommitments(client, cycle.id)).rejects.toThrow(/is not draft/)
  })
})

describe('acceptCycle', () => {
  it('transitions draft -> active, sets started_at, and materializes slots exactly once', async () => {
    const { userId, client } = await mintUser('sysplan-accept')
    const cycle = await setUpDraftCycle(client, userId, { timeframeDays: 7 })
    await generateInitialCommitments(client, cycle.id)

    await acceptCycle(client, cycle.id)

    const plan = await fetchSystemPlan(client, cycle.id)
    expect(plan.cycle.status).toBe('active')
    expect(plan.cycle.started_at).not.toBeNull()

    const commitmentIds = plan.commitments.map((c) => c.id)
    const { data: slots, error: slotsError } = await client
      .from('slots')
      .select('id')
      .in('commitment_id', commitmentIds)
    expect(slotsError).toBeNull()
    expect((slots ?? []).length).toBeGreaterThan(0)
  })

  it('a second Accept surfaces the already-materialized rejection rather than silently no-op-ing', async () => {
    const { userId, client } = await mintUser('sysplan-accept-twice')
    const cycle = await setUpDraftCycle(client, userId, { timeframeDays: 7 })
    await generateInitialCommitments(client, cycle.id)

    await acceptCycle(client, cycle.id)
    const afterFirst = await fetchSystemPlan(client, cycle.id)

    await expect(acceptCycle(client, cycle.id)).rejects.toThrow(/already materialized/)

    // started_at from the first, legitimate Accept must not have been
    // clobbered by the rejected second call.
    const afterSecond = await fetchSystemPlan(client, cycle.id)
    expect(afterSecond.cycle.started_at).toBe(afterFirst.cycle.started_at)
  })
})
