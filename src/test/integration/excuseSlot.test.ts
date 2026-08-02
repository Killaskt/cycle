import { describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL } from './localSupabase'
import { excuseSlot } from '../../lib/excuseSlot'

// Ticket 015 DoD, exercised against the real local stack (RLS included):
// - excuseSlot sets the slot's status to 'excused'.
// - excuseSlot creates one blocked_windows row, cycle-scoped, with
//   affected_slot_id pointing at the real slot (post-materialization, so
//   unlike ticket 007's cycle-wide-only blocking this can populate it).
// - excuseSlot creates zero fall_offs rows — the entire point of the ticket.
// - excuseSlot refuses to excuse a slot that isn't 'pending'.

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

async function setUpCycleWithSlot(label: string) {
  const { userId, client } = await mintUser(label)

  const { data: cycle, error: cycleError } = await client
    .from('cycles')
    .insert({
      user_id: userId,
      timeframe_days: 14,
      wake_time: '06:30',
      status: 'active',
      started_at: '2026-08-03T00:00:00Z',
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
      name: 'Run',
      session_shape: 'one block',
      freq: 3,
      dur: 30,
      bucket: 'weekday_morning',
    })
    .select()
    .single()
  if (commitmentError) throw commitmentError

  const { data: slot, error: slotError } = await client
    .from('slots')
    .insert({
      commitment_id: commitment.id,
      scheduled_date: '2026-08-04',
      bucket: 'weekday_morning',
      status: 'pending',
    })
    .select()
    .single()
  if (slotError) throw slotError

  return { client, cycle, commitment, slot }
}

describe('excuseSlot', () => {
  it('marks the slot excused, writes one cycle-scoped blocked_windows row, and creates zero fall_offs rows', async () => {
    const { client, cycle, slot } = await setUpCycleWithSlot('excuse-basic')

    const result = await excuseSlot(client, slot.id)
    expect(result.slotId).toBe(slot.id)
    expect(result.cycleId).toBe(cycle.id)
    expect(result.date).toBe('2026-08-04')

    const { data: updatedSlot, error: slotReadError } = await client
      .from('slots')
      .select('status')
      .eq('id', slot.id)
      .single()
    expect(slotReadError).toBeNull()
    expect(updatedSlot?.status).toBe('excused')

    const { data: blockedRows, error: blockedError } = await client
      .from('blocked_windows')
      .select('id, cycle_id, date, affected_slot_id')
      .eq('cycle_id', cycle.id)
    expect(blockedError).toBeNull()
    expect(blockedRows).toHaveLength(1)
    expect(blockedRows?.[0]).toMatchObject({
      cycle_id: cycle.id,
      date: '2026-08-04',
      affected_slot_id: slot.id,
    })

    const { count: fallOffCount, error: fallOffError } = await client
      .from('fall_offs')
      .select('id', { count: 'exact', head: true })
      .eq('cycle_id', cycle.id)
    expect(fallOffError).toBeNull()
    expect(fallOffCount).toBe(0)
  })

  it('refuses to excuse a slot that is not pending', async () => {
    const { client, slot } = await setUpCycleWithSlot('excuse-non-pending')

    const { error: updateError } = await client
      .from('slots')
      .update({ status: 'completed' })
      .eq('id', slot.id)
    expect(updateError).toBeNull()

    await expect(excuseSlot(client, slot.id)).rejects.toThrow(/only a pending slot/)
  })
})
