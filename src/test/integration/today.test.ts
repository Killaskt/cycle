import { describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL } from './localSupabase'
import { completeSlot, fetchTodaySlots, todayDateString } from '../../lib/today'

// Ticket 009 DoD, exercised against the real local stack (RLS included):
// - Checking off a slot creates exactly one `completions` row with an
//   accurate timestamp.
// - Only today's slots for the active cycle are shown — other dates and
//   other cycles' slots never appear.
// - Checking off an already-completed slot does not create a duplicate
//   `completions` row.

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
const TODAY = todayDateString()
const YESTERDAY = todayDateString(new Date(Date.now() - 24 * 60 * 60 * 1000))

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

async function setUpActiveCycleWithCommitment(label: string, cycleOverrides: Record<string, unknown> = {}) {
  const { userId, client } = await mintUser(label)

  const { data: cycle, error: cycleError } = await client
    .from('cycles')
    .insert({
      user_id: userId,
      timeframe_days: 14,
      wake_time: '06:30',
      status: 'active',
      started_at: '2026-08-01T00:00:00Z',
      ...cycleOverrides,
    })
    .select()
    .single()
  if (cycleError) throw cycleError

  const { data: focusArea, error: focusAreaError } = await client
    .from('focus_areas')
    .insert({
      cycle_id: cycle.id,
      name: 'running',
      target_freq: 4,
      target_dur: 30,
      current_freq: 1,
      current_dur: 20,
      intake_order: 0,
    })
    .select()
    .single()
  if (focusAreaError) throw focusAreaError

  const { data: commitment, error: commitmentError } = await client
    .from('commitments')
    .insert({
      focus_area_id: focusArea.id,
      name: 'Morning Run',
      session_shape: 'one block',
      freq: 3,
      dur: 25,
      bucket: 'weekday_morning',
    })
    .select()
    .single()
  if (commitmentError) throw commitmentError

  return { client, userId, cycle, commitment }
}

async function insertSlot(
  client: SupabaseClient,
  commitmentId: string,
  scheduledDate: string,
  status: 'pending' | 'completed' | 'fell_off' | 'excused' = 'pending',
) {
  const { data: slot, error } = await client
    .from('slots')
    .insert({
      commitment_id: commitmentId,
      scheduled_date: scheduledDate,
      bucket: 'weekday_morning',
      status,
    })
    .select()
    .single()
  if (error) throw error
  return slot
}

describe('fetchTodaySlots', () => {
  it('returns only today slots for the active cycle, excluding other dates and other cycles', async () => {
    const { client, cycle, commitment } = await setUpActiveCycleWithCommitment('today-basic')
    const todaySlot = await insertSlot(client, commitment.id, TODAY)
    await insertSlot(client, commitment.id, YESTERDAY)

    // A second, unrelated active cycle for the same user — its slot must
    // never leak into the first cycle's Today view.
    const { data: otherCycle, error: otherCycleError } = await client
      .from('cycles')
      .insert({
        user_id: cycle.user_id,
        timeframe_days: 14,
        wake_time: '07:00',
        status: 'active',
        started_at: '2026-08-01T00:00:00Z',
      })
      .select()
      .single()
    if (otherCycleError) throw otherCycleError
    const { data: otherFocusArea, error: otherFocusAreaError } = await client
      .from('focus_areas')
      .insert({
        cycle_id: otherCycle.id,
        name: 'spanish',
        target_freq: 3,
        target_dur: 20,
        current_freq: 1,
        current_dur: 10,
        intake_order: 0,
      })
      .select()
      .single()
    if (otherFocusAreaError) throw otherFocusAreaError
    const { data: otherCommitment, error: otherCommitmentError } = await client
      .from('commitments')
      .insert({
        focus_area_id: otherFocusArea.id,
        name: 'Spanish practice',
        session_shape: 'one block',
        freq: 3,
        dur: 20,
        bucket: 'weekday_evening',
      })
      .select()
      .single()
    if (otherCommitmentError) throw otherCommitmentError
    await insertSlot(client, otherCommitment.id, TODAY)

    const result = await fetchTodaySlots(client, cycle.id)

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe(todaySlot.id)
    expect(result[0].scheduledDate).toBe(TODAY)
    expect(result[0].commitmentName).toBe('Morning Run')
  })

  it('throws for a cycle that is not active', async () => {
    const { client, cycle, commitment } = await setUpActiveCycleWithCommitment('today-not-active', {
      status: 'draft',
      started_at: null,
    })
    await insertSlot(client, commitment.id, TODAY)

    await expect(fetchTodaySlots(client, cycle.id)).rejects.toThrow(/not active/)
  })
})

describe('completeSlot', () => {
  it('creates exactly one completions row with a timestamp and marks the slot completed', async () => {
    const { client, commitment } = await setUpActiveCycleWithCommitment('complete-basic')
    const slot = await insertSlot(client, commitment.id, TODAY)

    const result = await completeSlot(client, slot.id)
    expect(result.alreadyCompleted).toBe(false)
    expect(result.completionId).toBeTruthy()

    const { data: updatedSlot, error: slotError } = await client
      .from('slots')
      .select('status')
      .eq('id', slot.id)
      .single()
    expect(slotError).toBeNull()
    expect(updatedSlot?.status).toBe('completed')

    const { data: completions, error: completionsError } = await client
      .from('completions')
      .select('id, slot_id, completed_at')
      .eq('slot_id', slot.id)
    expect(completionsError).toBeNull()
    expect(completions).toHaveLength(1)
    expect(completions?.[0].slot_id).toBe(slot.id)
    expect(completions?.[0].completed_at).toBeTruthy()
  })

  it('checking off an already-completed slot does not create a duplicate completions row', async () => {
    const { client, commitment } = await setUpActiveCycleWithCommitment('complete-idempotent')
    const slot = await insertSlot(client, commitment.id, TODAY)

    const first = await completeSlot(client, slot.id)
    expect(first.alreadyCompleted).toBe(false)

    const second = await completeSlot(client, slot.id)
    expect(second.alreadyCompleted).toBe(true)
    expect(second.completionId).toBeNull()

    const { data: completions, error: completionsError } = await client
      .from('completions')
      .select('id')
      .eq('slot_id', slot.id)
    expect(completionsError).toBeNull()
    expect(completions).toHaveLength(1)
  })

  it('refuses to complete a slot that has already fallen off', async () => {
    const { client, commitment } = await setUpActiveCycleWithCommitment('complete-fell-off')
    const slot = await insertSlot(client, commitment.id, TODAY, 'fell_off')

    await expect(completeSlot(client, slot.id)).rejects.toThrow(/only a pending slot/)
  })
})
