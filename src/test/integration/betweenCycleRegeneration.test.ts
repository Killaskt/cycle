// Ticket 018 DoD, exercised against the real local stack (RLS included):
// `prepareNextCycleFocusAreas` reads a closed prior cycle's per-goal
// completion rate (completed slots / scheduled slots) from real `slots`
// rows, applies CONTEXT.md §6's band per goal (not aggregated), and derives
// the next cycle's concrete current/target numbers — same exact-number
// cases as `src/lib/generationMath.test.ts`, now proven against real data
// end to end, plus the `keep_next: false` filter (docs/SPEC.md §2f).

import { describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL } from './localSupabase'
import { prepareNextCycleFocusAreas } from '../../lib/betweenCycleRegeneration'

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

interface GoalSpec {
  name: string
  intakeOrder: number
  targetFreq: number
  targetDur: number
  commitmentFreq: number
  commitmentDur: number
  scheduledSlots: number
  completedSlots: number
  keepNext: boolean
}

async function insertGoal(client: SupabaseClient, cycleId: string, spec: GoalSpec) {
  const { data: focusArea, error: focusAreaError } = await client
    .from('focus_areas')
    .insert({
      cycle_id: cycleId,
      name: spec.name,
      target_freq: spec.targetFreq,
      target_dur: spec.targetDur,
      current_freq: 1,
      current_dur: 10,
      intake_order: spec.intakeOrder,
    })
    .select()
    .single()
  if (focusAreaError) throw focusAreaError

  const { data: commitment, error: commitmentError } = await client
    .from('commitments')
    .insert({
      focus_area_id: focusArea.id,
      name: `${spec.name} commitment`,
      session_shape: 'one block',
      freq: spec.commitmentFreq,
      dur: spec.commitmentDur,
      bucket: 'weekday_morning',
    })
    .select()
    .single()
  if (commitmentError) throw commitmentError

  for (let i = 0; i < spec.scheduledSlots; i++) {
    const status = i < spec.completedSlots ? 'completed' : 'fell_off'
    const { error } = await client.from('slots').insert({
      commitment_id: commitment.id,
      scheduled_date: `2026-08-${String(3 + i).padStart(2, '0')}`,
      bucket: 'weekday_morning',
      status,
    })
    if (error) throw error
  }

  return { focusArea, commitment }
}

async function setUpClosedCycle(userId: string, client: SupabaseClient, goalSpecs: GoalSpec[]) {
  const { data: cycle, error } = await client
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
  if (error) throw error

  const goals: Awaited<ReturnType<typeof insertGoal>>[] = []
  for (const spec of goalSpecs) {
    goals.push(await insertGoal(client, cycle.id, spec))
  }

  const review = {
    goals: goalSpecs.map((spec, i) => ({
      focus_area_id: goals[i].focusArea.id,
      result: 'hit',
      keep_next: spec.keepNext,
    })),
    fall_summary_confirmed: true,
    tag_corrections: [],
    freeform: 'test fixture',
  }

  const { error: closeError } = await client
    .from('cycles')
    .update({ status: 'closed', review })
    .eq('id', cycle.id)
  if (closeError) throw closeError

  return { cycle, goals }
}

describe('prepareNextCycleFocusAreas', () => {
  it('computes the correct band and concrete numbers per goal, and drops keep_next: false goals', async () => {
    const { userId, client } = await mintUser('regen-bands')

    const goalSpecs: GoalSpec[] = [
      {
        name: 'running', // advance: 9/10 = 0.9
        intakeOrder: 0,
        targetFreq: 8,
        targetDur: 40,
        commitmentFreq: 5,
        commitmentDur: 25,
        scheduledSlots: 10,
        completedSlots: 9,
        keepNext: true,
      },
      {
        name: 'spanish', // hold: 7/10 = 0.7
        intakeOrder: 1,
        targetFreq: 6,
        targetDur: 40,
        commitmentFreq: 3,
        commitmentDur: 20,
        scheduledSlots: 10,
        completedSlots: 7,
        keepNext: true,
      },
      {
        name: 'guitar', // retreat_halfway: 1/10 = 0.1
        intakeOrder: 2,
        targetFreq: 8,
        targetDur: 60,
        commitmentFreq: 4,
        commitmentDur: 30,
        scheduledSlots: 10,
        completedSlots: 1,
        keepNext: true,
      },
      {
        name: 'journaling', // dropped — must not appear in the result at all
        intakeOrder: 3,
        targetFreq: 7,
        targetDur: 20,
        commitmentFreq: 3,
        commitmentDur: 15,
        scheduledSlots: 10,
        completedSlots: 9, // would be 'advance' if kept — proves it's excluded by keep_next, not by band
        keepNext: false,
      },
    ]

    const { cycle } = await setUpClosedCycle(userId, client, goalSpecs)

    const plans = await prepareNextCycleFocusAreas(client, cycle.id)

    expect(plans).toHaveLength(3)
    expect(plans.map((p) => p.name)).toEqual(['running', 'spanish', 'guitar'])

    const running = plans.find((p) => p.name === 'running')!
    expect(running.band).toBe('advance')
    expect(running.currentFreq).toBe(5)
    expect(running.currentDur).toBe(25)
    expect(running.targetFreq).toBe(8) // original target, unchanged
    expect(running.targetDur).toBe(40)

    const spanish = plans.find((p) => p.name === 'spanish')!
    expect(spanish.band).toBe('hold')
    expect(spanish.currentFreq).toBe(3)
    expect(spanish.targetFreq).toBe(3) // prior plan, not original target (6)
    expect(spanish.currentDur).toBe(20)
    expect(spanish.targetDur).toBe(20) // prior plan, not original target (40)

    const guitar = plans.find((p) => p.name === 'guitar')!
    expect(guitar.band).toBe('retreat_halfway')
    expect(guitar.currentFreq).toBe(2) // round((4 + 0.1*4)/2) = round(2.2) = 2
    expect(guitar.targetFreq).toBe(2)
    expect(guitar.currentDur).toBe(17) // round((30 + 0.1*30)/2) = round(16.5) = 17
    expect(guitar.targetDur).toBe(17)
  })

  it('throws for a cycle that is not closed yet', async () => {
    const { userId, client } = await mintUser('regen-not-closed')
    const { data: cycle, error } = await client
      .from('cycles')
      .insert({ user_id: userId, timeframe_days: 14, wake_time: '06:30', status: 'active', started_at: '2026-08-03T00:00:00Z' })
      .select()
      .single()
    if (error) throw error

    await expect(prepareNextCycleFocusAreas(client, cycle.id)).rejects.toThrow(/is not closed/)
  })
})
