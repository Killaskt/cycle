import { describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL } from './localSupabase'
import { getReliabilityMap } from '../../lib/reliabilityMap'

// Ticket 010 DoD, exercised against the real local stack (RLS + triggers
// included, not mocked):
// - a `completions` insert increments both `.completions` and `.scheduled`
//   for that slot's bucket.
// - a `fall_offs` insert increments `.scheduled` only.
// - `scheduled < 3` reads untrusted; `scheduled >= 3` reads trusted.
// - values accumulate across a simulated cycle boundary rather than resetting
//   (reliability_map is scoped to user_id, not cycle_id).

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

async function insertCycle(client: SupabaseClient, userId: string, startedAt: string) {
  const { data, error } = await client
    .from('cycles')
    .insert({
      user_id: userId,
      timeframe_days: 14,
      wake_time: '06:30',
      status: 'active',
      started_at: startedAt,
    })
    .select()
    .single()
  if (error) throw error
  return data
}

async function insertCommitment(client: SupabaseClient, cycleId: string, bucket: string) {
  const { data: focusArea, error: focusAreaError } = await client
    .from('focus_areas')
    .insert({
      cycle_id: cycleId,
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
      name: 'Run',
      session_shape: 'one block',
      freq: 3,
      dur: 30,
      bucket,
    })
    .select()
    .single()
  if (commitmentError) throw commitmentError
  return commitment
}

async function insertSlot(
  client: SupabaseClient,
  commitmentId: string,
  bucket: string,
  scheduledDate: string,
) {
  const { data, error } = await client
    .from('slots')
    .insert({ commitment_id: commitmentId, scheduled_date: scheduledDate, bucket, status: 'pending' })
    .select()
    .single()
  if (error) throw error
  return data
}

async function insertTag(client: SupabaseClient, userId: string, label: string) {
  const { data, error } = await client
    .from('tags')
    .insert({ user_id: userId, label, classification: 'motivation' })
    .select()
    .single()
  if (error) throw error
  return data
}

async function setUp(label: string, bucket: string, startedAt = '2026-08-03T00:00:00Z') {
  const { userId, client } = await mintUser(label)
  const cycle = await insertCycle(client, userId, startedAt)
  const commitment = await insertCommitment(client, cycle.id, bucket)
  return { userId, client, cycle, commitment }
}

describe('reliability map updater (ticket 010)', () => {
  it('a completions insert increments both completions and scheduled for the slot bucket', async () => {
    const { userId, client, commitment } = await setUp('rm-complete', 'weekday_morning')
    const slot = await insertSlot(client, commitment.id, 'weekday_morning', '2026-08-03')

    const { error } = await client.from('completions').insert({ slot_id: slot.id })
    expect(error).toBeNull()

    const map = await getReliabilityMap(client, userId)
    const entry = map.find((e) => e.bucket === 'weekday_morning')
    expect(entry).toMatchObject({ completions: 1, scheduled: 1, trusted: false })
    expect(entry?.rate).toBe(1)
  })

  it('a fall_offs insert increments scheduled only, not completions', async () => {
    const { userId, client, cycle, commitment } = await setUp('rm-fall', 'weekday_evening')
    const slot = await insertSlot(client, commitment.id, 'weekday_evening', '2026-08-04')
    const tag = await insertTag(client, userId, 'busy')

    const { error } = await client.from('fall_offs').insert({
      slot_id: slot.id,
      cycle_id: cycle.id,
      occurrence_in_slot: 1,
      what_happened: 'ran out of time',
      tag_id: tag.id,
    })
    expect(error).toBeNull()

    const map = await getReliabilityMap(client, userId)
    const entry = map.find((e) => e.bucket === 'weekday_evening')
    expect(entry).toMatchObject({ completions: 0, scheduled: 1, trusted: false })
    expect(entry?.rate).toBe(0)
  })

  it('a bucket is untrusted below scheduled 3 and trusted at scheduled >= 3', async () => {
    const { userId, client, commitment } = await setUp('rm-trust', 'weekend_afternoon')

    for (const date of ['2026-08-08', '2026-08-09']) {
      const slot = await insertSlot(client, commitment.id, 'weekend_afternoon', date)
      const { error } = await client.from('completions').insert({ slot_id: slot.id })
      expect(error).toBeNull()
    }

    let map = await getReliabilityMap(client, userId)
    let entry = map.find((e) => e.bucket === 'weekend_afternoon')
    expect(entry?.scheduled).toBe(2)
    expect(entry?.trusted).toBe(false)

    const thirdSlot = await insertSlot(client, commitment.id, 'weekend_afternoon', '2026-08-10')
    const { error } = await client.from('completions').insert({ slot_id: thirdSlot.id })
    expect(error).toBeNull()

    map = await getReliabilityMap(client, userId)
    entry = map.find((e) => e.bucket === 'weekend_afternoon')
    expect(entry?.scheduled).toBe(3)
    expect(entry?.completions).toBe(3)
    expect(entry?.trusted).toBe(true)
  })

  it('mixed completions and fall_offs on the same bucket accumulate correctly', async () => {
    const { userId, client, cycle, commitment } = await setUp('rm-mixed', 'weekday_night')
    const tag = await insertTag(client, userId, 'tired')

    const completedSlot = await insertSlot(client, commitment.id, 'weekday_night', '2026-08-03')
    await client.from('completions').insert({ slot_id: completedSlot.id })

    const fellOffSlot = await insertSlot(client, commitment.id, 'weekday_night', '2026-08-04')
    await client.from('fall_offs').insert({
      slot_id: fellOffSlot.id,
      cycle_id: cycle.id,
      occurrence_in_slot: 1,
      what_happened: 'too tired',
      tag_id: tag.id,
    })

    const map = await getReliabilityMap(client, userId)
    const entry = map.find((e) => e.bucket === 'weekday_night')
    expect(entry).toMatchObject({ completions: 1, scheduled: 2, trusted: false })
    expect(entry?.rate).toBe(0.5)
  })

  it('values accumulate across a simulated cycle boundary rather than resetting', async () => {
    const { userId, client } = await mintUser('rm-cross-cycle')

    const cycle1 = await insertCycle(client, userId, '2026-08-03T00:00:00Z')
    const commitment1 = await insertCommitment(client, cycle1.id, 'weekday_night')
    const slot1 = await insertSlot(client, commitment1.id, 'weekday_night', '2026-08-03')
    await client.from('completions').insert({ slot_id: slot1.id })

    // Simulate cycle close + a fresh cycle 2 for the same user, same bucket.
    const cycle2 = await insertCycle(client, userId, '2026-08-20T00:00:00Z')
    const commitment2 = await insertCommitment(client, cycle2.id, 'weekday_night')
    const slot2 = await insertSlot(client, commitment2.id, 'weekday_night', '2026-08-21')
    await client.from('completions').insert({ slot_id: slot2.id })

    const map = await getReliabilityMap(client, userId)
    const entry = map.find((e) => e.bucket === 'weekday_night')
    expect(entry?.completions).toBe(2)
    expect(entry?.scheduled).toBe(2)
  })
})
