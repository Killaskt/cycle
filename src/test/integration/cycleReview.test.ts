import { describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL } from './localSupabase'
import { fetchFallOffSummary, fetchGoalsForReview, submitCycleReview } from '../../lib/cycleReview'

// Ticket 017 DoD, exercised against the real local stack (RLS included):
// - The shown timeline correctly aggregates this cycle's fall_offs by tag,
//   with no user input required to produce it.
// - Submitting the review writes a cycles.review jsonb matching
//   docs/SPEC.md §2f exactly, and sets status: 'closed'.
// - Correcting a tag's classification updates the tags row itself.
// - A closed cycle can no longer be edited.

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

async function insertTag(client: SupabaseClient, userId: string, label: string, classification: string) {
  const { data, error } = await client
    .from('tags')
    .insert({ user_id: userId, label, classification })
    .select()
    .single()
  if (error) throw error
  return data
}

async function insertSlot(client: SupabaseClient, commitmentId: string, scheduledDate: string, bucket: string) {
  const { data, error } = await client
    .from('slots')
    .insert({ commitment_id: commitmentId, scheduled_date: scheduledDate, bucket, status: 'fell_off' })
    .select()
    .single()
  if (error) throw error
  return data
}

async function insertFallOff(
  client: SupabaseClient,
  slotId: string,
  cycleId: string,
  occurrence: number,
  tagId: string,
) {
  const { data, error } = await client
    .from('fall_offs')
    .insert({
      slot_id: slotId,
      cycle_id: cycleId,
      occurrence_in_slot: occurrence,
      what_happened: 'fell off',
      tag_id: tagId,
    })
    .select()
    .single()
  if (error) throw error
  return data
}

async function setUpCycleWithTwoGoals(label: string) {
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

  const { data: focusAreaA, error: focusAreaAError } = await client
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
  if (focusAreaAError) throw focusAreaAError

  const { data: focusAreaB, error: focusAreaBError } = await client
    .from('focus_areas')
    .insert({
      cycle_id: cycle.id,
      name: 'Spanish',
      target_freq: 3,
      target_dur: 20,
      current_freq: 1,
      current_dur: 10,
      intake_order: 1,
    })
    .select()
    .single()
  if (focusAreaBError) throw focusAreaBError

  const { data: commitmentA, error: commitmentAError } = await client
    .from('commitments')
    .insert({
      focus_area_id: focusAreaA.id,
      name: 'Morning Run',
      session_shape: 'one block',
      freq: 3,
      dur: 25,
      bucket: 'weekday_morning',
    })
    .select()
    .single()
  if (commitmentAError) throw commitmentAError

  const { data: commitmentB, error: commitmentBError } = await client
    .from('commitments')
    .insert({
      focus_area_id: focusAreaB.id,
      name: 'Spanish practice',
      session_shape: 'one block',
      freq: 2,
      dur: 15,
      bucket: 'weekday_evening',
      removed_at: '2026-08-05T00:00:00Z',
    })
    .select()
    .single()
  if (commitmentBError) throw commitmentBError

  return { userId, client, cycle, focusAreaA, focusAreaB, commitmentA, commitmentB }
}

describe('fetchGoalsForReview', () => {
  it('returns each focus area with its commitment, marking a removed commitment', async () => {
    const { client, cycle, focusAreaA, focusAreaB, commitmentA } = await setUpCycleWithTwoGoals('review-goals')

    const goals = await fetchGoalsForReview(client, cycle.id)

    expect(goals).toHaveLength(2)
    expect(goals[0]).toMatchObject({
      focusAreaId: focusAreaA.id,
      name: 'running',
      commitmentId: commitmentA.id,
      commitmentName: 'Morning Run',
      commitmentRemoved: false,
    })
    expect(goals[1]).toMatchObject({
      focusAreaId: focusAreaB.id,
      name: 'Spanish',
      commitmentName: 'Spanish practice',
      commitmentRemoved: true,
    })
  })
})

describe('fetchFallOffSummary', () => {
  it('aggregates fall_offs by slot (timeline) and by tag (cycle-wide frequency), with no user input', async () => {
    const { userId, client, cycle, commitmentA } = await setUpCycleWithTwoGoals('review-summary')

    const tiredTag = await insertTag(client, userId, 'tired', 'motivation')
    const busyTag = await insertTag(client, userId, 'busy', 'availability')

    const slot1 = await insertSlot(client, commitmentA.id, '2026-08-04', 'weekday_morning') // Tuesday
    const slot2 = await insertSlot(client, commitmentA.id, '2026-08-11', 'weekday_morning') // Tuesday

    await insertFallOff(client, slot1.id, cycle.id, 1, tiredTag.id)
    await insertFallOff(client, slot1.id, cycle.id, 2, tiredTag.id)
    await insertFallOff(client, slot1.id, cycle.id, 3, busyTag.id)
    await insertFallOff(client, slot2.id, cycle.id, 1, busyTag.id)

    const summary = await fetchFallOffSummary(client, cycle.id)

    expect(summary.totalFalls).toBe(4)

    expect(summary.timeline).toHaveLength(2)
    const slot1Entry = summary.timeline.find((e) => e.slotId === slot1.id)!
    expect(slot1Entry.weekday).toBe('Tuesday')
    expect(slot1Entry.fallCount).toBe(3)
    expect(slot1Entry.tagCounts).toEqual([
      { tagId: tiredTag.id, label: 'tired', count: 2, classification: 'motivation' },
      { tagId: busyTag.id, label: 'busy', count: 1, classification: 'availability' },
    ])

    const slot2Entry = summary.timeline.find((e) => e.slotId === slot2.id)!
    expect(slot2Entry.fallCount).toBe(1)

    // Timeline ordered by scheduled_date ascending.
    expect(summary.timeline.map((e) => e.slotId)).toEqual([slot1.id, slot2.id])

    // Both tags tied at count 2 — tie-break is alphabetical by label, so
    // "busy" sorts before "tired".
    expect(summary.tagFrequencies).toEqual([
      { tagId: busyTag.id, label: 'busy', count: 2, classification: 'availability' },
      { tagId: tiredTag.id, label: 'tired', count: 2, classification: 'motivation' },
    ])
  })

  it('returns an empty summary for a cycle with no fall-offs', async () => {
    const { client, cycle } = await setUpCycleWithTwoGoals('review-summary-empty')

    const summary = await fetchFallOffSummary(client, cycle.id)

    expect(summary).toEqual({ timeline: [], tagFrequencies: [], totalFalls: 0 })
  })
})

describe('submitCycleReview', () => {
  it('writes cycles.review matching docs/SPEC.md §2f and closes the cycle', async () => {
    const { client, cycle, focusAreaA, focusAreaB } = await setUpCycleWithTwoGoals('review-submit')

    await submitCycleReview(client, cycle.id, {
      goals: [
        { focusAreaId: focusAreaA.id, result: 'hit', keepNext: true },
        { focusAreaId: focusAreaB.id, result: 'missed', keepNext: false },
      ],
      fallSummaryConfirmed: true,
      tagCorrections: [],
      freeform: 'Start earlier in the day.',
    })

    const { data: updatedCycle, error } = await client
      .from('cycles')
      .select('status, review')
      .eq('id', cycle.id)
      .single()
    expect(error).toBeNull()
    expect(updatedCycle?.status).toBe('closed')
    expect(updatedCycle?.review).toEqual({
      goals: [
        { focus_area_id: focusAreaA.id, result: 'hit', keep_next: true },
        { focus_area_id: focusAreaB.id, result: 'missed', keep_next: false },
      ],
      fall_summary_confirmed: true,
      tag_corrections: [],
      freeform: 'Start earlier in the day.',
    })
  })

  it("correcting a tag's classification updates the tags row itself, not just the review blob", async () => {
    const { userId, client, cycle, focusAreaA, focusAreaB } = await setUpCycleWithTwoGoals(
      'review-tag-correction',
    )
    const tag = await insertTag(client, userId, 'unmotivated', 'availability')

    await submitCycleReview(client, cycle.id, {
      goals: [
        { focusAreaId: focusAreaA.id, result: 'partial', keepNext: true },
        { focusAreaId: focusAreaB.id, result: 'hit', keepNext: true },
      ],
      fallSummaryConfirmed: true,
      tagCorrections: [{ tagId: tag.id, classification: 'motivation' }],
      freeform: 'Nothing.',
    })

    const { data: updatedTag, error } = await client.from('tags').select('classification').eq('id', tag.id).single()
    expect(error).toBeNull()
    expect(updatedTag?.classification).toBe('motivation')

    const { data: updatedCycle } = await client.from('cycles').select('review').eq('id', cycle.id).single()
    expect(updatedCycle?.review.tag_corrections).toEqual([{ tag_id: tag.id, classification: 'motivation' }])
  })

  it('throws if goals is missing an entry for one of this cycle\'s focus areas', async () => {
    const { client, cycle, focusAreaA } = await setUpCycleWithTwoGoals('review-missing-goal')

    await expect(
      submitCycleReview(client, cycle.id, {
        goals: [{ focusAreaId: focusAreaA.id, result: 'hit', keepNext: true }],
        fallSummaryConfirmed: true,
        tagCorrections: [],
        freeform: 'Nothing.',
      }),
    ).rejects.toThrow(/goals is missing an entry/)
  })

  it('throws if goals contains a focus_area_id that does not belong to this cycle', async () => {
    const { client, cycle, focusAreaA, focusAreaB } = await setUpCycleWithTwoGoals('review-foreign-goal')

    await expect(
      submitCycleReview(client, cycle.id, {
        goals: [
          { focusAreaId: focusAreaA.id, result: 'hit', keepNext: true },
          { focusAreaId: focusAreaB.id, result: 'hit', keepNext: true },
          { focusAreaId: '00000000-0000-0000-0000-000000000000', result: 'hit', keepNext: true },
        ],
        fallSummaryConfirmed: true,
        tagCorrections: [],
        freeform: 'Nothing.',
      }),
    ).rejects.toThrow(/does not belong to cycle/)
  })

  it('requires non-empty freeform', async () => {
    const { client, cycle, focusAreaA, focusAreaB } = await setUpCycleWithTwoGoals('review-empty-freeform')

    await expect(
      submitCycleReview(client, cycle.id, {
        goals: [
          { focusAreaId: focusAreaA.id, result: 'hit', keepNext: true },
          { focusAreaId: focusAreaB.id, result: 'hit', keepNext: true },
        ],
        fallSummaryConfirmed: true,
        tagCorrections: [],
        freeform: '   ',
      }),
    ).rejects.toThrow(/freeform is required/)
  })

  it('a closed cycle cannot be reviewed/closed again — no write path back to draft/active', async () => {
    const { client, cycle, focusAreaA, focusAreaB } = await setUpCycleWithTwoGoals('review-no-reclose')

    const goals = [
      { focusAreaId: focusAreaA.id, result: 'hit' as const, keepNext: true },
      { focusAreaId: focusAreaB.id, result: 'hit' as const, keepNext: true },
    ]

    await submitCycleReview(client, cycle.id, {
      goals,
      fallSummaryConfirmed: true,
      tagCorrections: [],
      freeform: 'First close.',
    })

    await expect(
      submitCycleReview(client, cycle.id, {
        goals,
        fallSummaryConfirmed: true,
        tagCorrections: [],
        freeform: 'Second attempt.',
      }),
    ).rejects.toThrow(/is not active/)

    const { data: cycleRow } = await client.from('cycles').select('status').eq('id', cycle.id).single()
    expect(cycleRow?.status).toBe('closed')
  })

  it('writes load_factor.last_cycle_completed_minutes for this cycle at cycle-close time (ticket 018, CONTEXT.md §6)', async () => {
    const { userId, client, cycle, focusAreaA, focusAreaB, commitmentA } = await setUpCycleWithTwoGoals(
      'review-load-factor',
    )
    // commitmentA: dur 25, two completed slots -> 50 minutes. commitmentB
    // was already removed in the fixture and has no slots.
    const { error: slot1Error } = await client
      .from('slots')
      .insert({ commitment_id: commitmentA.id, scheduled_date: '2026-08-04', bucket: 'weekday_morning', status: 'completed' })
    if (slot1Error) throw slot1Error
    const { error: slot2Error } = await client
      .from('slots')
      .insert({ commitment_id: commitmentA.id, scheduled_date: '2026-08-06', bucket: 'weekday_morning', status: 'completed' })
    if (slot2Error) throw slot2Error
    const { error: slot3Error } = await client
      .from('slots')
      .insert({ commitment_id: commitmentA.id, scheduled_date: '2026-08-08', bucket: 'weekday_morning', status: 'fell_off' })
    if (slot3Error) throw slot3Error

    await submitCycleReview(client, cycle.id, {
      goals: [
        { focusAreaId: focusAreaA.id, result: 'hit', keepNext: true },
        { focusAreaId: focusAreaB.id, result: 'missed', keepNext: false },
      ],
      fallSummaryConfirmed: true,
      tagCorrections: [],
      freeform: 'Keep running, drop Spanish.',
    })

    const { data: loadFactor, error } = await client
      .from('load_factor')
      .select('last_cycle_completed_minutes')
      .eq('user_id', userId)
      .single()
    expect(error).toBeNull()
    expect(loadFactor?.last_cycle_completed_minutes).toBe(50)
  })

  it('a draft cycle (never started) cannot be closed', async () => {
    const { userId, client } = await mintUser('review-draft-cycle')
    const { data: draftCycle, error } = await client
      .from('cycles')
      .insert({ user_id: userId, timeframe_days: 14, wake_time: '06:30', status: 'draft' })
      .select()
      .single()
    if (error) throw error

    await expect(
      submitCycleReview(client, draftCycle.id, {
        goals: [],
        fallSummaryConfirmed: true,
        tagCorrections: [],
        freeform: 'Nothing.',
      }),
    ).rejects.toThrow(/is not active/)
  })
})
