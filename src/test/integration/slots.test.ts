import { describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL } from './localSupabase'
import { materializeCycleSlots } from '../../lib/slots'

// Ticket 007 DoD, exercised against the real local stack (RLS included):
// - freq: 3 over a 14-day cycle -> exactly 3 slots/week, weekday-consistent.
// - a blocked_windows row removes that date from scheduling.
// - re-running materialization for the same cycle is explicitly rejected.

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

async function setUpCycleWithCommitment(opts: {
  label: string
  startedAt: string
  timeframeDays: number
  freq: number
  bucket: string
}) {
  const { userId, client } = await mintUser(opts.label)

  const { data: cycle, error: cycleError } = await client
    .from('cycles')
    .insert({
      user_id: userId,
      timeframe_days: opts.timeframeDays,
      wake_time: '06:30',
      status: 'active',
      started_at: `${opts.startedAt}T00:00:00Z`,
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
      freq: opts.freq,
      dur: 30,
      bucket: opts.bucket,
    })
    .select()
    .single()
  if (commitmentError) throw commitmentError

  return { client, cycle, commitment }
}

describe('materializeCycleSlots', () => {
  it('creates exactly freq slots per week, matching the commitment bucket', async () => {
    const { client, cycle } = await setUpCycleWithCommitment({
      label: 'materialize-basic',
      startedAt: '2026-08-03', // Monday
      timeframeDays: 14,
      freq: 3,
      bucket: 'weekday_morning',
    })

    const rows = await materializeCycleSlots(client, cycle.id)
    expect(rows).toHaveLength(6)
    for (const row of rows) {
      expect(row.bucket).toBe('weekday_morning')
      expect(row.status).toBe('pending')
    }

    const { data: persisted, error } = await client
      .from('slots')
      .select('id')
      .eq('commitment_id', rows[0].commitment_id)
    expect(error).toBeNull()
    expect(persisted).toHaveLength(6)
  })

  it('a blocked_windows row for a date excludes it from materialization', async () => {
    const { client, cycle, commitment } = await setUpCycleWithCommitment({
      label: 'materialize-blocked',
      startedAt: '2026-08-03', // Monday
      timeframeDays: 7,
      freq: 3,
      bucket: 'weekday_morning',
    })

    const blockedDate = '2026-08-04' // Tuesday, in-window weekday
    const { error: blockedError } = await client
      .from('blocked_windows')
      .insert({ cycle_id: cycle.id, date: blockedDate })
    expect(blockedError).toBeNull()

    const rows = await materializeCycleSlots(client, cycle.id)
    expect(rows.some((r) => r.scheduled_date === blockedDate)).toBe(false)
    expect(rows.every((r) => r.commitment_id === commitment.id)).toBe(true)
  })

  it('rejects re-running materialization for a cycle that already has slots', async () => {
    const { client, cycle } = await setUpCycleWithCommitment({
      label: 'materialize-idempotent',
      startedAt: '2026-08-03',
      timeframeDays: 7,
      freq: 2,
      bucket: 'weekday_morning',
    })

    await materializeCycleSlots(client, cycle.id)
    await expect(materializeCycleSlots(client, cycle.id)).rejects.toThrow(
      /already materialized/,
    )
  })
})
