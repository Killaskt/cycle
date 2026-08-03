import { describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL } from './localSupabase'
import { recordFallOff } from '../../lib/fallOff'
import { checkOverload } from '../../lib/overload'
import { todayDateString } from '../../lib/today'

// Ticket 014 DoD, exercised against the real local stack (RLS included):
// - Fewer than 4 falls in 7 days never triggers, regardless of rate.
// - >=4 falls and rate >=40%, clustered >=60% in one bucket -> exactly one
//   MOVE_CLUSTER response, that bucket's active commitments moved (even the
//   ones that didn't themselves fall off), nothing else changed.
// - >=4 falls and rate >=40%, spread evenly -> REDUCE_FREQUENCY_ALL, every
//   active commitment's freq reduced by one, REMOVE instead when that would
//   breach the floor.
// - A second qualifying trigger in the same cycle applies the same response
//   again (CONTEXT.md's double-trigger entry, CLARIFICATIONS.md) rather
//   than a special early-termination flow, flagged via `repeat_trigger`.

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
const TODAY = todayDateString()

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

async function setUpCycle(label: string) {
  const { userId, client } = await mintUser(label)
  const { data: cycle, error } = await client
    .from('cycles')
    .insert({
      user_id: userId,
      timeframe_days: 14,
      wake_time: '06:30',
      status: 'active',
      started_at: `${TODAY}T00:00:00Z`,
    })
    .select()
    .single()
  if (error) throw error
  return { userId, client, cycle }
}

async function createCommitment(
  client: SupabaseClient,
  cycleId: string,
  name: string,
  freq: number,
  bucket: string,
  intakeOrder = 0,
) {
  const { data: focusArea, error: faError } = await client
    .from('focus_areas')
    .insert({
      cycle_id: cycleId,
      name,
      target_freq: freq,
      target_dur: 30,
      current_freq: freq,
      current_dur: 30,
      intake_order: intakeOrder,
    })
    .select()
    .single()
  if (faError) throw faError

  const { data: commitment, error } = await client
    .from('commitments')
    .insert({
      focus_area_id: focusArea.id,
      name,
      session_shape: 'one block',
      freq,
      dur: 30,
      bucket,
    })
    .select()
    .single()
  if (error) throw error
  return commitment
}

async function createSlots(client: SupabaseClient, commitmentId: string, bucket: string, count: number) {
  const rows = Array.from({ length: count }, () => ({
    commitment_id: commitmentId,
    scheduled_date: TODAY,
    bucket,
    status: 'pending',
  }))
  const { data, error } = await client.from('slots').insert(rows).select()
  if (error) throw error
  return data as { id: string }[]
}

async function fallOffOnce(client: SupabaseClient, userId: string, slotId: string, tagLabel: string) {
  return recordFallOff(client, userId, {
    slotId,
    whatHappened: 'Did not happen.',
    tag: { label: tagLabel, classification: 'motivation' },
  })
}

describe('checkOverload', () => {
  it('never triggers below 4 raw falls, regardless of rate', async () => {
    const { userId, client, cycle } = await setUpCycle('overload-below-floor')
    const commitment = await createCommitment(client, cycle.id, 'Run', 3, 'weekday_morning')
    const slots = await createSlots(client, commitment.id, 'weekday_morning', 5)

    // 3 falls out of 5 scheduled = 60% rate, but only 3 raw falls.
    for (const slot of slots.slice(0, 3)) {
      await fallOffOnce(client, userId, slot.id, 'tired')
    }

    const result = await checkOverload(client, cycle.id)
    expect(result).toBeNull()
  })
})

describe('recordFallOff — cycle-wide overload (ticket 014)', () => {
  it('clustered falls (>=60% in one bucket) trigger MOVE_CLUSTER: every active commitment in that bucket moves, nothing else changes', async () => {
    const { userId, client, cycle } = await setUpCycle('overload-move-cluster')

    const morningA = await createCommitment(client, cycle.id, 'Morning A', 4, 'weekday_morning', 0)
    const morningB = await createCommitment(client, cycle.id, 'Morning B', 2, 'weekday_morning', 1)
    const evening = await createCommitment(client, cycle.id, 'Evening', 3, 'weekday_evening', 2)

    const morningASlots = await createSlots(client, morningA.id, 'weekday_morning', 6)
    await createSlots(client, morningB.id, 'weekday_morning', 2)
    await createSlots(client, evening.id, 'weekday_evening', 4)
    // total scheduled = 12

    let lastResult
    for (const slot of morningASlots.slice(0, 5)) {
      lastResult = await fallOffOnce(client, userId, slot.id, 'tired')
    }

    // 5 falls / 12 scheduled = ~41.7% >= 40%, all 5 in weekday_morning = 100% cluster.
    expect(lastResult!.cycleWideOverload).toBeTruthy()
    expect(lastResult!.cycleWideOverload).toMatchObject({
      response: 'MOVE_CLUSTER',
      bucket: 'weekday_morning',
      repeatTrigger: false,
    })
    expect(lastResult!.cycleWideOverload!.affectedCommitmentIds.sort()).toEqual(
      [morningA.id, morningB.id].sort(),
    )

    const { data: commitmentsAfter, error } = await admin
      .from('commitments')
      .select('id, bucket, freq')
      .in('id', [morningA.id, morningB.id, evening.id])
    if (error) throw error
    const byId = new Map(commitmentsAfter!.map((c) => [c.id, c]))

    // Both weekday_morning commitments moved off weekday_morning, load (freq) untouched.
    expect(byId.get(morningA.id)!.bucket).not.toBe('weekday_morning')
    expect(byId.get(morningA.id)!.freq).toBe(4)
    expect(byId.get(morningB.id)!.bucket).not.toBe('weekday_morning')
    expect(byId.get(morningB.id)!.freq).toBe(2)
    // both moved to the same new bucket
    expect(byId.get(morningA.id)!.bucket).toBe(byId.get(morningB.id)!.bucket)
    // the evening commitment is entirely untouched
    expect(byId.get(evening.id)!.bucket).toBe('weekday_evening')
    expect(byId.get(evening.id)!.freq).toBe(3)

    const { data: amendmentRow, error: amendmentError } = await admin
      .from('amendments')
      .select('*')
      .eq('id', lastResult!.cycleWideOverload!.amendmentId)
      .single()
    if (amendmentError) throw amendmentError
    expect(amendmentRow).toMatchObject({
      action: 'MOVE',
      proposed_by: 'rule',
      user_response: 'accepted',
    })
    expect(amendmentRow!.target).toMatchObject({ scope: 'cycle_wide', response: 'MOVE_CLUSTER' })
    expect(amendmentRow!.params).toMatchObject({ repeat_trigger: false })
  })

  it('evenly spread falls trigger REDUCE_FREQUENCY_ALL: every active commitment reduced by 1, REMOVE at the floor', async () => {
    const { userId, client, cycle } = await setUpCycle('overload-reduce-all')

    const atFloor = await createCommitment(client, cycle.id, 'At Floor', 1, 'weekday_morning', 0)
    const midFreq = await createCommitment(client, cycle.id, 'Mid Freq', 3, 'weekday_afternoon', 1)
    const lowFreq = await createCommitment(client, cycle.id, 'Low Freq', 2, 'weekend_morning', 2)
    const fourth = await createCommitment(client, cycle.id, 'Fourth', 2, 'weekday_evening', 3)

    const atFloorSlots = await createSlots(client, atFloor.id, 'weekday_morning', 1)
    const midFreqSlots = await createSlots(client, midFreq.id, 'weekday_afternoon', 1)
    const lowFreqSlots = await createSlots(client, lowFreq.id, 'weekend_morning', 1)
    const fourthSlots = await createSlots(client, fourth.id, 'weekday_evening', 1)
    // total scheduled = 4

    let lastResult
    lastResult = await fallOffOnce(client, userId, atFloorSlots[0].id, 'tired')
    lastResult = await fallOffOnce(client, userId, midFreqSlots[0].id, 'busy')
    lastResult = await fallOffOnce(client, userId, lowFreqSlots[0].id, 'tired')
    lastResult = await fallOffOnce(client, userId, fourthSlots[0].id, 'busy')

    // 4 falls / 4 scheduled = 100% >= 40%, spread across 4 distinct buckets
    // (max cluster = 1/4 = 25% < 60%) -> REDUCE_FREQUENCY_ALL.
    expect(lastResult!.cycleWideOverload).toBeTruthy()
    expect(lastResult!.cycleWideOverload).toMatchObject({
      response: 'REDUCE_FREQUENCY_ALL',
      repeatTrigger: false,
    })
    expect(lastResult!.cycleWideOverload!.affectedCommitmentIds.sort()).toEqual(
      [atFloor.id, midFreq.id, lowFreq.id, fourth.id].sort(),
    )

    const { data: commitmentsAfter, error } = await admin
      .from('commitments')
      .select('id, freq, removed_at, bucket')
      .in('id', [atFloor.id, midFreq.id, lowFreq.id, fourth.id])
    if (error) throw error
    const byId = new Map(commitmentsAfter!.map((c) => [c.id, c]))

    // freq 1 -> would hit 0 -> REMOVE instead
    expect(byId.get(atFloor.id)!.removed_at).not.toBeNull()
    // freq 3 -> 2, freq 2 -> 1, bucket untouched throughout
    expect(byId.get(midFreq.id)!.freq).toBe(2)
    expect(byId.get(midFreq.id)!.removed_at).toBeNull()
    expect(byId.get(midFreq.id)!.bucket).toBe('weekday_afternoon')
    expect(byId.get(lowFreq.id)!.freq).toBe(1)
    expect(byId.get(lowFreq.id)!.removed_at).toBeNull()
    expect(byId.get(fourth.id)!.freq).toBe(1)
    expect(byId.get(fourth.id)!.removed_at).toBeNull()

    const { data: amendmentRow, error: amendmentError } = await admin
      .from('amendments')
      .select('*')
      .eq('id', lastResult!.cycleWideOverload!.amendmentId)
      .single()
    if (amendmentError) throw amendmentError
    expect(amendmentRow).toMatchObject({
      action: 'REDUCE_FREQUENCY',
      proposed_by: 'rule',
      user_response: 'accepted',
    })
    expect(amendmentRow!.target).toMatchObject({ scope: 'cycle_wide', response: 'REDUCE_FREQUENCY_ALL' })
    expect(amendmentRow!.params).toMatchObject({ repeat_trigger: false })

    // A second qualifying trigger in the same cycle: one more fall keeps the
    // rate/count condition true (5 falls now exist in the window), so it
    // fires again rather than going through any early-termination flow —
    // applying the same REDUCE_FREQUENCY_ALL response to whatever's still
    // active (CLARIFICATIONS.md's double-trigger entry, ticket 014).
    const extraSlots = await createSlots(client, midFreq.id, 'weekday_afternoon', 1)
    const second = await fallOffOnce(client, userId, extraSlots[0].id, 'busy')

    expect(second.cycleWideOverload).toBeTruthy()
    expect(second.cycleWideOverload).toMatchObject({
      response: 'REDUCE_FREQUENCY_ALL',
      repeatTrigger: true,
    })
    // atFloor was already removed by the first trigger, so it's not active
    // any more and is not part of this second application.
    expect(second.cycleWideOverload!.affectedCommitmentIds).not.toContain(atFloor.id)
    expect(second.cycleWideOverload!.affectedCommitmentIds.sort()).toEqual(
      [midFreq.id, lowFreq.id, fourth.id].sort(),
    )

    const { data: secondAmendmentRow, error: secondAmendmentError } = await admin
      .from('amendments')
      .select('*')
      .eq('id', second.cycleWideOverload!.amendmentId)
      .single()
    if (secondAmendmentError) throw secondAmendmentError
    expect(secondAmendmentRow!.params).toMatchObject({ repeat_trigger: true })

    const { count: cycleWideAmendmentCount, error: countError } = await admin
      .from('amendments')
      .select('id, fall_offs!inner(cycle_id)', { count: 'exact', head: true })
      .eq('fall_offs.cycle_id', cycle.id)
      .eq('target->>scope', 'cycle_wide')
    if (countError) throw countError
    expect(cycleWideAmendmentCount).toBe(2)

    // lowFreq and fourth (both freq 1 after the first trigger) hit the
    // floor on this second application -> REMOVE instead of freq 0.
    // midFreq (freq 2 after the first trigger) still has room -> freq 1.
    const { data: afterSecond, error: afterSecondError } = await admin
      .from('commitments')
      .select('id, freq, removed_at')
      .in('id', [midFreq.id, lowFreq.id, fourth.id])
    if (afterSecondError) throw afterSecondError
    const afterSecondById = new Map(afterSecond!.map((c) => [c.id, c]))
    expect(afterSecondById.get(midFreq.id)!.freq).toBe(1)
    expect(afterSecondById.get(midFreq.id)!.removed_at).toBeNull()
    expect(afterSecondById.get(lowFreq.id)!.removed_at).not.toBeNull()
    expect(afterSecondById.get(fourth.id)!.removed_at).not.toBeNull()
  })
})
