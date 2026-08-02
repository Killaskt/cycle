import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { Client } from 'pg'
import { DB_URL } from '../test/integration/localSupabase'
import { Review } from './Review'
import { supabase } from '../lib/supabase'
import { initAuthSession } from '../lib/auth'

// Integration test against the local Docker Supabase stack — ticket 017
// DoD. Uses the app's own `supabase` singleton (as the real app does) so
// the anonymous session created here is the same one RLS checks against.

let db: Client

beforeAll(async () => {
  db = new Client({ connectionString: DB_URL })
  await db.connect()
})

afterAll(async () => {
  await db.end()
})

beforeEach(() => {
  window.localStorage.clear()
})

async function setUpActiveCycleWithFallOff() {
  const session = await initAuthSession(supabase)

  const { data: cycle, error: cycleError } = await supabase
    .from('cycles')
    .insert({
      user_id: session.user.id,
      status: 'active',
      timeframe_days: 7,
      wake_time: '06:30',
      started_at: '2026-08-01T00:00:00Z',
    })
    .select()
    .single()
  if (cycleError) throw cycleError

  const { data: focusArea, error: focusAreaError } = await supabase
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

  const { data: commitment, error: commitmentError } = await supabase
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

  const { data: tag, error: tagError } = await supabase
    .from('tags')
    .insert({ user_id: session.user.id, label: 'tired', classification: 'motivation' })
    .select()
    .single()
  if (tagError) throw tagError

  const { data: slot, error: slotError } = await supabase
    .from('slots')
    .insert({
      commitment_id: commitment.id,
      scheduled_date: '2026-08-04',
      bucket: 'weekday_morning',
      status: 'fell_off',
    })
    .select()
    .single()
  if (slotError) throw slotError

  const { error: fallOffError } = await supabase.from('fall_offs').insert({
    slot_id: slot.id,
    cycle_id: cycle.id,
    occurrence_in_slot: 1,
    what_happened: 'Overslept.',
    tag_id: tag.id,
  })
  if (fallOffError) throw fallOffError

  return { cycle, focusArea, commitment, tag, slot }
}

describe('Review (integration, local Supabase)', () => {
  it('shows the goal and the fall-off summary, and closing writes cycles.review + status closed', async () => {
    const { cycle } = await setUpActiveCycleWithFallOff()
    render(<Review cycleId={cycle.id} />)

    expect(await screen.findByRole('heading', { name: 'Review this cycle' })).toBeInTheDocument()
    expect(await screen.findByText('running')).toBeInTheDocument()
    expect(await screen.findByText(/fell off 1x, tagged 'tired' 1x/)).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Confirm this fall/tag summary is accurate'))
    fireEvent.change(screen.getByLabelText('What should next cycle do differently?'), {
      target: { value: 'Start a bit later.' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Close cycle' }))

    await waitFor(() => expect(screen.getByText('Cycle closed.')).toBeInTheDocument())

    const dbResult = await db.query('select status, review from cycles where id = $1', [cycle.id])
    expect(dbResult.rows[0].status).toBe('closed')
    expect(dbResult.rows[0].review.fall_summary_confirmed).toBe(true)
    expect(dbResult.rows[0].review.freeform).toBe('Start a bit later.')
    expect(dbResult.rows[0].review.goals).toHaveLength(1)
  })
})
