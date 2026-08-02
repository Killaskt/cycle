import { describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL } from './localSupabase'
import { recordFallOff } from '../../lib/fallOff'
import { acceptAmendment, rejectAmendmentWithRevision } from '../../lib/amendment'

// Ticket 011 DoD, exercised against the real local stack (RLS included):
// - Submitting a 1st fall-off creates a fall_offs row with
//   occurrence_in_slot: 1, populated tag_id and what_happened, mood: null.
// - No amendments row is created (no plan change at 1st fall).
// - A second fall-off on the *same* slot reads as occurrence_in_slot: 2, not
//   reset to 1.
// - A fall-off on a *different* slot is an independent occurrence_in_slot: 1.

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

async function insertSlot(
  client: SupabaseClient,
  commitmentId: string,
  scheduledDate: string,
) {
  const { data: slot, error } = await client
    .from('slots')
    .insert({
      commitment_id: commitmentId,
      scheduled_date: scheduledDate,
      bucket: 'weekday_morning',
      status: 'pending',
    })
    .select()
    .single()
  if (error) throw error
  return slot
}

async function setUpCycleWithSlots(label: string, slotDates: string[]) {
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

  const slots = []
  for (const date of slotDates) {
    slots.push(await insertSlot(client, commitment.id, date))
  }

  return { userId, client, cycle, commitment, slots }
}

describe('recordFallOff', () => {
  it('creates a 1st fall_offs row: occurrence 1, tag_id + what_happened populated, mood null, no amendment', async () => {
    const { userId, client, cycle, slots } = await setUpCycleWithSlots('fall-off-first', [
      '2026-08-04',
    ])
    const slot = slots[0]

    const result = await recordFallOff(client, userId, {
      slotId: slot.id,
      whatHappened: 'Overslept and missed the window.',
      tag: { label: 'tired', classification: 'motivation' },
    })

    expect(result.slotId).toBe(slot.id)
    expect(result.cycleId).toBe(cycle.id)
    expect(result.occurrenceInSlot).toBe(1)
    expect(result.tagId).toBeTruthy()

    const { data: fallOffRow, error: fallOffError } = await client
      .from('fall_offs')
      .select('*')
      .eq('id', result.fallOffId)
      .single()
    expect(fallOffError).toBeNull()
    expect(fallOffRow).toMatchObject({
      slot_id: slot.id,
      cycle_id: cycle.id,
      occurrence_in_slot: 1,
      what_happened: 'Overslept and missed the window.',
      tag_id: result.tagId,
      mood: null,
      agent_followup_question: null,
      agent_followup_answer: null,
    })

    const { count: amendmentCount, error: amendmentError } = await client
      .from('amendments')
      .select('id', { count: 'exact', head: true })
      .eq('fall_off_id', result.fallOffId)
    expect(amendmentError).toBeNull()
    expect(amendmentCount).toBe(0)
  })

  it('a second fall-off on the same slot reads as occurrence_in_slot 2, not reset to 1', async () => {
    const { userId, client, slots } = await setUpCycleWithSlots('fall-off-second', ['2026-08-04'])
    const slot = slots[0]

    const first = await recordFallOff(client, userId, {
      slotId: slot.id,
      whatHappened: 'Overslept.',
      tag: { label: 'tired', classification: 'motivation' },
    })
    expect(first.occurrenceInSlot).toBe(1)

    const second = await recordFallOff(client, userId, {
      slotId: slot.id,
      whatHappened: 'Overslept again.',
      tag: { label: 'tired' },
      mood: 'frustrated',
    })
    expect(second.occurrenceInSlot).toBe(2)

    const { data: rows, error } = await client
      .from('fall_offs')
      .select('occurrence_in_slot')
      .eq('slot_id', slot.id)
      .order('occurrence_in_slot', { ascending: true })
    expect(error).toBeNull()
    expect(rows?.map((r) => r.occurrence_in_slot)).toEqual([1, 2])
  })

  it('a fall-off on a different slot is an independent occurrence_in_slot 1', async () => {
    const { userId, client, slots } = await setUpCycleWithSlots('fall-off-different-slot', [
      '2026-08-04',
      '2026-08-11',
    ])
    const [slotA, slotB] = slots

    const onA = await recordFallOff(client, userId, {
      slotId: slotA.id,
      whatHappened: 'Overslept.',
      tag: { label: 'tired', classification: 'motivation' },
    })
    expect(onA.occurrenceInSlot).toBe(1)

    const onB = await recordFallOff(client, userId, {
      slotId: slotB.id,
      whatHappened: 'Got busy at work.',
      tag: { label: 'busy', classification: 'availability' },
    })
    expect(onB.occurrenceInSlot).toBe(1)
  })

  it('sets the slot status to fell_off', async () => {
    const { userId, client, slots } = await setUpCycleWithSlots('fall-off-status', ['2026-08-04'])
    const slot = slots[0]

    await recordFallOff(client, userId, {
      slotId: slot.id,
      whatHappened: 'Overslept.',
      tag: { label: 'tired', classification: 'motivation' },
    })

    const { data: updatedSlot, error } = await client
      .from('slots')
      .select('status')
      .eq('id', slot.id)
      .single()
    expect(error).toBeNull()
    expect(updatedSlot?.status).toBe('fell_off')
  })

  it('requires non-empty what_happened', async () => {
    const { userId, client, slots } = await setUpCycleWithSlots('fall-off-empty', ['2026-08-04'])
    const slot = slots[0]

    await expect(
      recordFallOff(client, userId, {
        slotId: slot.id,
        whatHappened: '   ',
        tag: { label: 'tired', classification: 'motivation' },
      }),
    ).rejects.toThrow(/what_happened is required/)
  })
})

// Ticket 012 DoD, exercised against the real local stack (RLS included):
// - 2nd fall on a slot requires (and writes) mood; 1st fall never does.
// - proposeAmendment always returns MOVE, confidence 1.0, non-empty
//   reasoning, proposed_by 'rule' — logged as an unresolved `amendments` row.
// - Accepting applies the MOVE for real: the commitment's bucket actually
//   changes in the DB.
// - Rejecting with a reason logs rejection_reason + revised_action/target/
//   params (still MOVE, a different bucket) and applies that revision.
describe('recordFallOff — 2nd occurrence, The Amendment (ticket 012)', () => {
  async function fallOffTwice(label: string, secondMood?: string) {
    const setup = await setUpCycleWithSlots(label, ['2026-08-04'])
    const slot = setup.slots[0]

    await recordFallOff(setup.client, setup.userId, {
      slotId: slot.id,
      whatHappened: 'Overslept.',
      tag: { label: 'tired', classification: 'motivation' },
    })

    const second = await recordFallOff(setup.client, setup.userId, {
      slotId: slot.id,
      whatHappened: 'Overslept again.',
      tag: { label: 'tired' },
      mood: secondMood ?? 'discouraged',
    })

    return { ...setup, slot, second }
  }

  it('requires mood on the 2nd fall-off for this slot', async () => {
    const { userId, client, slots } = await setUpCycleWithSlots('fall-off-mood-required', [
      '2026-08-04',
    ])
    const slot = slots[0]

    await recordFallOff(client, userId, {
      slotId: slot.id,
      whatHappened: 'Overslept.',
      tag: { label: 'tired', classification: 'motivation' },
    })

    await expect(
      recordFallOff(client, userId, {
        slotId: slot.id,
        whatHappened: 'Overslept again.',
        tag: { label: 'tired' },
      }),
    ).rejects.toThrow(/mood is required/)
  })

  it('writes mood on the 2nd fall, leaves agent_followup_* null, and creates an unresolved MOVE proposal', async () => {
    const { second, commitment } = await fallOffTwice('fall-off-amendment-propose', 'discouraged')

    expect(second.occurrenceInSlot).toBe(2)
    expect(second.amendment).toBeTruthy()
    expect(second.amendment?.proposal).toMatchObject({
      action: 'MOVE',
      target: { commitment_id: commitment.id },
      confidence: 1.0,
      proposed_by: 'rule',
    })
    expect(second.amendment?.proposal.reasoning.length).toBeGreaterThan(0)

    const { data: fallOffRow, error: fallOffError } = await admin
      .from('fall_offs')
      .select('mood, agent_followup_question, agent_followup_answer')
      .eq('id', second.fallOffId)
      .single()
    expect(fallOffError).toBeNull()
    expect(fallOffRow).toMatchObject({
      mood: 'discouraged',
      agent_followup_question: null,
      agent_followup_answer: null,
    })

    const { data: amendmentRow, error: amendmentError } = await admin
      .from('amendments')
      .select('*')
      .eq('fall_off_id', second.fallOffId)
      .single()
    expect(amendmentError).toBeNull()
    expect(amendmentRow).toMatchObject({
      action: 'MOVE',
      user_response: null,
      proposed_by: 'rule',
    })
    expect(amendmentRow?.target).toMatchObject({ commitment_id: commitment.id })
    expect(amendmentRow?.params.bucket).toBe('weekday_early_morning')
  })

  it('accepting the amendment applies the MOVE to the commitment bucket for real', async () => {
    const { second, commitment, client } = await fallOffTwice('fall-off-amendment-accept')
    const amendmentId = second.amendment!.amendmentId

    await acceptAmendment(client, amendmentId)

    const { data: updatedCommitment, error: commitmentError } = await client
      .from('commitments')
      .select('bucket')
      .eq('id', commitment.id)
      .single()
    expect(commitmentError).toBeNull()
    expect(updatedCommitment?.bucket).toBe(second.amendment!.proposal.params.bucket)
    expect(updatedCommitment?.bucket).not.toBe('weekday_morning')

    const { data: amendmentRow, error: amendmentError } = await client
      .from('amendments')
      .select('user_response')
      .eq('id', amendmentId)
      .single()
    expect(amendmentError).toBeNull()
    expect(amendmentRow?.user_response).toBe('accepted')

    await expect(acceptAmendment(client, amendmentId)).rejects.toThrow(/already has a user_response/)
  })

  it('rejecting with a reason logs the rejection + a different deterministic revision, and applies that revision', async () => {
    const { second, commitment, client } = await fallOffTwice('fall-off-amendment-reject')
    const amendmentId = second.amendment!.amendmentId
    const originalBucket = second.amendment!.proposal.params.bucket

    const revision = await rejectAmendmentWithRevision(client, amendmentId, "that time doesn't work either")

    expect(revision.action).toBe('MOVE')
    expect(revision.params.bucket).not.toBe(originalBucket)
    expect(revision.params.bucket).not.toBe('weekday_morning')

    const { data: amendmentRow, error: amendmentError } = await client
      .from('amendments')
      .select('*')
      .eq('id', amendmentId)
      .single()
    expect(amendmentError).toBeNull()
    expect(amendmentRow).toMatchObject({
      user_response: 'rejected',
      rejection_reason: "that time doesn't work either",
      revised_action: 'MOVE',
    })
    expect(amendmentRow?.revised_target).toMatchObject({ commitment_id: commitment.id })
    expect(amendmentRow?.revised_params.bucket).toBe(revision.params.bucket)

    const { data: updatedCommitment, error: commitmentError } = await client
      .from('commitments')
      .select('bucket')
      .eq('id', commitment.id)
      .single()
    expect(commitmentError).toBeNull()
    expect(updatedCommitment?.bucket).toBe(revision.params.bucket)
  })

  it('rejecting requires a non-empty reason', async () => {
    const { second, client } = await fallOffTwice('fall-off-amendment-reject-empty')
    const amendmentId = second.amendment!.amendmentId

    await expect(rejectAmendmentWithRevision(client, amendmentId, '   ')).rejects.toThrow(
      /rejection_reason is required/,
    )
  })
})
