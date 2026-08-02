// Ticket 018 DoD, exercised against the real local stack (RLS included):
// `updateLoadFactorFromCycle` sums `dur` across every `completed` slot for
// a cycle (across all its commitments) and upserts it as
// `load_factor.last_cycle_completed_minutes`; `getLoadFactorMinutes` reads
// it back, `null` when no row exists yet for a user (cycle 1).

import { describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL } from './localSupabase'
import { computeCompletedMinutesForCycle, getLoadFactorMinutes, updateLoadFactorFromCycle } from '../../lib/loadFactor'

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

async function mintUser(label: string) {
  const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`
  const password = 'password123!'
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (error || !data.user) throw error ?? new Error('createUser returned no user')

  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { error: signInError } = await client.auth.signInWithPassword({ email, password })
  if (signInError) throw signInError

  return { userId: data.user.id, client }
}

async function insertCommitment(
  client: SupabaseClient,
  cycleId: string,
  name: string,
  dur: number,
  freq: number,
) {
  const { data: focusArea, error: focusAreaError } = await client
    .from('focus_areas')
    .insert({
      cycle_id: cycleId,
      name,
      target_freq: freq + 2,
      target_dur: dur + 10,
      current_freq: 1,
      current_dur: 10,
      intake_order: 0,
    })
    .select()
    .single()
  if (focusAreaError) throw focusAreaError

  const { data: commitment, error: commitmentError } = await client
    .from('commitments')
    .insert({
      focus_area_id: focusArea.id,
      name: `${name} commitment`,
      session_shape: 'one block',
      freq,
      dur,
      bucket: 'weekday_morning',
    })
    .select()
    .single()
  if (commitmentError) throw commitmentError

  return commitment
}

async function insertSlot(client: SupabaseClient, commitmentId: string, date: string, status: string) {
  const { error } = await client
    .from('slots')
    .insert({ commitment_id: commitmentId, scheduled_date: date, bucket: 'weekday_morning', status })
  if (error) throw error
}

async function setUpActiveCycle(userId: string, client: SupabaseClient) {
  const { data: cycle, error } = await client
    .from('cycles')
    .insert({ user_id: userId, timeframe_days: 14, wake_time: '06:30', status: 'active', started_at: '2026-08-03T00:00:00Z' })
    .select()
    .single()
  if (error) throw error
  return cycle
}

describe('computeCompletedMinutesForCycle', () => {
  it('sums dur across every completed slot, across every commitment in the cycle', async () => {
    const { userId, client } = await mintUser('loadfactor-sum')
    const cycle = await setUpActiveCycle(userId, client)

    const running = await insertCommitment(client, cycle.id, 'running', 25, 3)
    await insertSlot(client, running.id, '2026-08-03', 'completed')
    await insertSlot(client, running.id, '2026-08-05', 'completed')
    await insertSlot(client, running.id, '2026-08-07', 'pending') // not counted

    const spanish = await insertCommitment(client, cycle.id, 'spanish', 15, 4)
    await insertSlot(client, spanish.id, '2026-08-03', 'completed')
    await insertSlot(client, spanish.id, '2026-08-04', 'completed')
    await insertSlot(client, spanish.id, '2026-08-05', 'completed')
    await insertSlot(client, spanish.id, '2026-08-06', 'completed')
    await insertSlot(client, spanish.id, '2026-08-07', 'fell_off') // not counted

    // running: 2 * 25 = 50, spanish: 4 * 15 = 60 -> 110
    const minutes = await computeCompletedMinutesForCycle(client, cycle.id)
    expect(minutes).toBe(110)
  })

  it('returns 0 for a cycle with no commitments', async () => {
    const { userId, client } = await mintUser('loadfactor-empty')
    const cycle = await setUpActiveCycle(userId, client)

    expect(await computeCompletedMinutesForCycle(client, cycle.id)).toBe(0)
  })
})

describe('updateLoadFactorFromCycle / getLoadFactorMinutes', () => {
  it('is null before any cycle has been closed for a user', async () => {
    const { userId, client } = await mintUser('loadfactor-none-yet')
    expect(await getLoadFactorMinutes(client, userId)).toBeNull()
  })

  it('upserts last_cycle_completed_minutes and getLoadFactorMinutes reads it back', async () => {
    const { userId, client } = await mintUser('loadfactor-upsert')
    const cycle = await setUpActiveCycle(userId, client)
    const running = await insertCommitment(client, cycle.id, 'running', 20, 3)
    await insertSlot(client, running.id, '2026-08-03', 'completed')
    await insertSlot(client, running.id, '2026-08-05', 'completed')

    const written = await updateLoadFactorFromCycle(client, userId, cycle.id)
    expect(written).toBe(40)
    expect(await getLoadFactorMinutes(client, userId)).toBe(40)
  })

  it('overwrites (not accumulates) on a second call for a different cycle', async () => {
    const { userId, client } = await mintUser('loadfactor-overwrite')
    const cycleOne = await setUpActiveCycle(userId, client)
    const runningOne = await insertCommitment(client, cycleOne.id, 'running', 20, 3)
    await insertSlot(client, runningOne.id, '2026-08-03', 'completed')
    await updateLoadFactorFromCycle(client, userId, cycleOne.id) // 20

    const cycleTwo = await setUpActiveCycle(userId, client)
    const runningTwo = await insertCommitment(client, cycleTwo.id, 'running', 30, 3)
    await insertSlot(client, runningTwo.id, '2026-08-20', 'completed')
    await insertSlot(client, runningTwo.id, '2026-08-21', 'completed')
    const second = await updateLoadFactorFromCycle(client, userId, cycleTwo.id) // 60, not 20+60

    expect(second).toBe(60)
    expect(await getLoadFactorMinutes(client, userId)).toBe(60)
  })
})
