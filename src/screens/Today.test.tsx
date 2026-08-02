import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { Client } from 'pg'
import { DB_URL } from '../test/integration/localSupabase'
import { todayDateString } from '../lib/today'
import { Today } from './Today'
import { supabase } from '../lib/supabase'
import { initAuthSession } from '../lib/auth'

// Integration test against the local Docker Supabase stack — ticket 009
// DoD. Uses the app's own `supabase` singleton (as the real app does) so
// the anonymous session created here is the same one RLS checks against.

let db: Client
const TODAY = todayDateString()

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

async function setUpActiveCycleWithSlot() {
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

  const { data: slot, error: slotError } = await supabase
    .from('slots')
    .insert({
      commitment_id: commitment.id,
      scheduled_date: TODAY,
      bucket: 'weekday_morning',
      status: 'pending',
    })
    .select()
    .single()
  if (slotError) throw slotError

  return { cycle, commitment, slot }
}

describe('Today (integration, local Supabase)', () => {
  it("shows today's slots for the active cycle", async () => {
    const { cycle } = await setUpActiveCycleWithSlot()
    render(<Today cycleId={cycle.id} />)

    expect(await screen.findByRole('heading', { name: 'Today' })).toBeInTheDocument()
    expect(await screen.findByText('Morning Run')).toBeInTheDocument()
  })

  it('checking off a slot inserts one completions row and marks it done in the UI', async () => {
    const { cycle, slot } = await setUpActiveCycleWithSlot()
    render(<Today cycleId={cycle.id} />)

    await screen.findByText('Morning Run')
    const checkbox = screen.getByRole('checkbox', { name: 'Mark done' })
    fireEvent.click(checkbox)

    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Done' })).toBeChecked())

    const completionsRes = await db.query(
      'select count(*)::int as count from completions where slot_id = $1',
      [slot.id],
    )
    expect(completionsRes.rows[0].count).toBe(1)
  })
})
