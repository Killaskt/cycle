import { describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL } from './localSupabase'
import { recordFallOff } from '../../lib/fallOff'
import { acceptAmendment, proposeAmendmentForFallOff, rejectAmendmentWithRevision } from '../../lib/amendment'

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

// Ticket 013 DoD, exercised against the real local stack (RLS included):
// - A 3rd fall-off on a slot that already had a resolved 2nd-fall amendment
//   proposes REMOVE (unresolved amendments row), and accepting it actually
//   soft-deletes the commitment (`removed_at`) and deletes its future
//   still-pending slots, while leaving already-resolved slots (the one that
//   fell off) and all fall-off/amendment history untouched.
// - The (user_id, tag_id, action) `learnings` row for the 2nd-fall's
//   tag→action mapping has its confidence reduced.
// - A 3rd fall reaching the amendment path without a prior 2nd-fall
//   amendment is explicitly rejected, not silently turned into a REMOVE.
describe('recordFallOff — 3rd occurrence, downscope to REMOVE (ticket 013)', () => {
  async function fallOffThreeTimes(
    label: string,
    options: { resolveSecond?: 'accept' | 'reject' } = {},
  ) {
    const setup = await setUpCycleWithSlots(label, ['2026-08-04', '2026-08-11'])
    const slot = setup.slots[0]
    const futureSlot = setup.slots[1]

    const first = await recordFallOff(setup.client, setup.userId, {
      slotId: slot.id,
      whatHappened: 'Overslept.',
      tag: { label: 'tired', classification: 'motivation' },
    })

    const second = await recordFallOff(setup.client, setup.userId, {
      slotId: slot.id,
      whatHappened: 'Overslept again.',
      tag: { label: 'tired' },
      mood: 'discouraged',
    })

    if (options.resolveSecond === 'accept') {
      await acceptAmendment(setup.client, second.amendment!.amendmentId)
    } else if (options.resolveSecond === 'reject') {
      await rejectAmendmentWithRevision(setup.client, second.amendment!.amendmentId, 'still not great')
    }

    const third = await recordFallOff(setup.client, setup.userId, {
      slotId: slot.id,
      whatHappened: 'Fell off a third time.',
      tag: { label: 'tired' },
    })

    return { ...setup, slot, futureSlot, first, second, third }
  }

  it('3rd fall on a slot with a resolved 2nd-fall amendment proposes REMOVE (unresolved amendments row)', async () => {
    const { third, commitment } = await fallOffThreeTimes('fall-off-third-propose', { resolveSecond: 'accept' })

    expect(third.occurrenceInSlot).toBe(3)
    expect(third.amendment).toBeTruthy()
    expect(third.amendment?.proposal).toMatchObject({
      action: 'REMOVE',
      target: { commitment_id: commitment.id },
      confidence: 1.0,
      proposed_by: 'rule',
    })
    expect(third.amendment?.proposal.reasoning.length).toBeGreaterThan(0)

    const { data: amendmentRow, error } = await admin
      .from('amendments')
      .select('*')
      .eq('fall_off_id', third.fallOffId)
      .single()
    expect(error).toBeNull()
    expect(amendmentRow).toMatchObject({ action: 'REMOVE', user_response: null, proposed_by: 'rule' })
  })

  it('accepting the REMOVE amendment soft-deletes the commitment and deletes its future pending slots only', async () => {
    const { third, commitment, client, futureSlot } = await fallOffThreeTimes('fall-off-third-accept', {
      resolveSecond: 'accept',
    })
    const amendmentId = third.amendment!.amendmentId

    const { data: beforeCommitment, error: beforeError } = await client
      .from('commitments')
      .select('removed_at')
      .eq('id', commitment.id)
      .single()
    expect(beforeError).toBeNull()
    expect(beforeCommitment?.removed_at).toBeNull()

    await acceptAmendment(client, amendmentId)

    const { data: afterCommitment, error: commitmentError } = await client
      .from('commitments')
      .select('removed_at')
      .eq('id', commitment.id)
      .single()
    expect(commitmentError).toBeNull()
    expect(afterCommitment?.removed_at).not.toBeNull()

    const { data: remainingFutureSlot, error: slotError } = await client
      .from('slots')
      .select('id')
      .eq('id', futureSlot.id)
      .maybeSingle()
    expect(slotError).toBeNull()
    expect(remainingFutureSlot).toBeNull()

    // The slot that actually fell off 3 times keeps its history — REMOVE
    // only deletes future *pending* slots, never already-resolved ones.
    const { data: fallenSlot, error: fallenSlotError } = await client
      .from('slots')
      .select('id, status')
      .eq('id', third.slotId)
      .single()
    expect(fallenSlotError).toBeNull()
    expect(fallenSlot?.status).toBe('fell_off')

    const { count: fallOffCount, error: fallOffCountError } = await client
      .from('fall_offs')
      .select('id', { count: 'exact', head: true })
      .eq('slot_id', third.slotId)
    expect(fallOffCountError).toBeNull()
    expect(fallOffCount).toBe(3)
  })

  it("downgrades the (user, tag, action) learnings row for the 2nd-fall's tag→action mapping", async () => {
    const { third, userId, second } = await fallOffThreeTimes('fall-off-third-learnings', {
      resolveSecond: 'accept',
    })
    expect(third.occurrenceInSlot).toBe(3)

    const { data: learningRow, error } = await admin
      .from('learnings')
      .select('confidence, sample_size')
      .eq('user_id', userId)
      .eq('tag_id', second.tagId)
      .eq('action', 'MOVE')
      .single()
    expect(error).toBeNull()
    expect(learningRow?.confidence).toBeLessThan(0.5)
    expect(learningRow?.sample_size).toBeGreaterThan(0)
  })

  it('downgrades learnings and proposes REMOVE even when the 2nd-fall amendment was rejected-with-revision', async () => {
    const { third, userId, second } = await fallOffThreeTimes('fall-off-third-after-reject', {
      resolveSecond: 'reject',
    })

    expect(third.amendment?.proposal.action).toBe('REMOVE')

    const { data: learningRow, error } = await admin
      .from('learnings')
      .select('confidence')
      .eq('user_id', userId)
      .eq('tag_id', second.tagId)
      .eq('action', 'MOVE')
      .single()
    expect(error).toBeNull()
    expect(learningRow?.confidence).toBeLessThan(0.5)
  })

  // Ticket 016 DoD, exercised against the real local stack (RLS included):
  // - A 3rd fall tagged `disinterest` (the *2nd* fall's tag, per
  //   CLARIFICATIONS.md [016]/[013]) with fewer than 3 prior completions on
  //   the commitment downgrades to MOVE instead of REMOVE.
  // - The identical scenario with 3+ prior completions allows REMOVE
  //   normally.
  // - A 3rd fall tagged with anything other than `disinterest` is
  //   unaffected by this gate — already covered by the 'tired'-tagged tests
  //   above (`fall-off-third-*`), all of which run with 0 completions and
  //   still assert REMOVE.
  describe('recordFallOff — 3rd occurrence, disinterest exposure gate (ticket 016)', () => {
    async function fallOffThreeTimesWithDisinterest(label: string, priorCompletions: number) {
      const setup = await setUpCycleWithSlots(label, ['2026-08-04', '2026-08-11'])
      const slot = setup.slots[0]

      for (let i = 0; i < priorCompletions; i++) {
        const { error } = await setup.client.from('completions').insert({ slot_id: slot.id })
        if (error) throw error
      }

      const first = await recordFallOff(setup.client, setup.userId, {
        slotId: slot.id,
        whatHappened: 'Just did not want to.',
        tag: { label: 'disinterest' },
      })

      const second = await recordFallOff(setup.client, setup.userId, {
        slotId: slot.id,
        whatHappened: 'Still not feeling it.',
        tag: { label: 'disinterest' },
        mood: 'indifferent',
      })
      await acceptAmendment(setup.client, second.amendment!.amendmentId)

      const third = await recordFallOff(setup.client, setup.userId, {
        slotId: slot.id,
        whatHappened: 'Third time, still not feeling it.',
        tag: { label: 'disinterest' },
      })

      return { ...setup, slot, first, second, third }
    }

    it('fewer than 3 prior completions: downgrades the 3rd-fall proposal to MOVE instead of REMOVE', async () => {
      const { third, commitment } = await fallOffThreeTimesWithDisinterest('fall-off-disinterest-gated', 2)

      expect(third.occurrenceInSlot).toBe(3)
      expect(third.amendment).toBeTruthy()
      expect(third.amendment?.proposal).toMatchObject({
        action: 'MOVE',
        target: { commitment_id: commitment.id },
        confidence: 1.0,
        proposed_by: 'rule',
      })
      expect(third.amendment?.proposal.params.bucket).toBeTruthy()
      expect(third.amendment?.proposal.reasoning.length).toBeGreaterThan(0)

      const { data: commitmentRow, error } = await admin
        .from('commitments')
        .select('removed_at')
        .eq('id', commitment.id)
        .single()
      expect(error).toBeNull()
      expect(commitmentRow?.removed_at).toBeNull()
    })

    it('3+ prior completions: allows REMOVE normally, gate does not apply', async () => {
      const { third, commitment } = await fallOffThreeTimesWithDisinterest('fall-off-disinterest-ungated', 3)

      expect(third.occurrenceInSlot).toBe(3)
      expect(third.amendment?.proposal).toMatchObject({
        action: 'REMOVE',
        target: { commitment_id: commitment.id },
        confidence: 1.0,
        proposed_by: 'rule',
      })
    })

    it('still downgrades the learnings row even when the gate downgrades REMOVE to MOVE', async () => {
      const { third, userId, second } = await fallOffThreeTimesWithDisinterest('fall-off-disinterest-learnings', 0)
      expect(third.amendment?.proposal.action).toBe('MOVE')

      const { data: learningRow, error } = await admin
        .from('learnings')
        .select('confidence')
        .eq('user_id', userId)
        .eq('tag_id', second.tagId)
        .eq('action', 'MOVE')
        .single()
      expect(error).toBeNull()
      expect(learningRow?.confidence).toBeLessThan(0.5)
    })
  })

  it('a 3rd fall reaching the amendment path with no prior 2nd-fall amendment is explicitly rejected, not silently REMOVEd', async () => {
    const { userId, client, cycle, slots } = await setUpCycleWithSlots('fall-off-third-no-second', [
      '2026-08-04',
    ])
    const slot = slots[0]

    // Bypass recordFallOff's normal ladder entirely: insert a fall_offs row
    // directly at occurrence_in_slot 3, skipping occurrence 2 (and
    // therefore skipping the amendments row occurrence 2 would have
    // created) — the scenario ticket 013's DoD asks to guard against.
    const { data: tag, error: tagError } = await client
      .from('tags')
      .insert({ user_id: userId, label: 'skip-second', classification: 'motivation' })
      .select()
      .single()
    expect(tagError).toBeNull()

    const { data: fallOffRow, error: fallOffError } = await client
      .from('fall_offs')
      .insert({
        slot_id: slot.id,
        cycle_id: cycle.id,
        occurrence_in_slot: 3,
        what_happened: 'Skipped straight to three.',
        tag_id: tag!.id,
      })
      .select()
      .single()
    expect(fallOffError).toBeNull()

    await expect(proposeAmendmentForFallOff(client, fallOffRow!.id)).rejects.toThrow(
      /REMOVE requires a prior amendment at occurrence 2/,
    )
  })
})
