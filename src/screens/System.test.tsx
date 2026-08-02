import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { Client } from 'pg'
import { DB_URL, SUPABASE_ANON_KEY, SUPABASE_URL } from '../test/integration/localSupabase'
import { System } from './System'
import { supabase } from '../lib/supabase'
import { initAuthSession } from '../lib/auth'

// Integration test against the local Docker Supabase stack and the real
// `generate` Edge Function running locally (fixture provider) — ticket 008
// DoD. Uses the app's own `supabase` singleton (as the real app does) so
// the anonymous session created here is the same one RLS checks against
// for the cycle/focus_areas rows set up directly in this test.

let db: Client

beforeAll(async () => {
  db = new Client({ connectionString: DB_URL })
  await db.connect()

  const res = await fetch(`${SUPABASE_URL}/functions/v1/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ wake_time: '06:30', focus_areas: [], reliability_map: [], blocked_windows: [] }),
  }).catch(() => null)
  if (!res) {
    throw new Error(
      'generate function unreachable at ' +
        SUPABASE_URL +
        ' — run `MODEL_PROVIDER=fixture npx -y supabase@latest functions serve generate` first ' +
        '(see .claude/skills/local-supabase-stack/SKILL.md).',
    )
  }
})

afterAll(async () => {
  await db.end()
})

beforeEach(() => {
  window.localStorage.clear()
})

async function setUpDraftCycle() {
  const session = await initAuthSession(supabase)

  const { data: cycle, error: cycleError } = await supabase
    .from('cycles')
    .insert({
      user_id: session.user.id,
      status: 'draft',
      timeframe_days: 7,
      wake_time: '06:30',
    })
    .select()
    .single()
  if (cycleError) throw cycleError

  const { error: focusAreaError } = await supabase.from('focus_areas').insert({
    cycle_id: cycle.id,
    name: 'running',
    target_freq: 4,
    target_dur: 30,
    current_freq: 1,
    current_dur: 20,
    intake_order: 0,
  })
  if (focusAreaError) throw focusAreaError

  return cycle
}

describe('System (integration, local Supabase + generate function)', () => {
  it('generates the plan on load and shows it read-only', async () => {
    const cycle = await setUpDraftCycle()
    render(<System cycleId={cycle.id} />)

    expect(await screen.findByRole('heading', { name: 'Your system' })).toBeInTheDocument()
    // fixture provider's running.json fixture name — confirms the real
    // generate function's response made it into the DOM.
    expect(await screen.findByText('Morning Run')).toBeInTheDocument()

    const commitmentsRes = await db.query(
      'select id from commitments where focus_area_id in (select id from focus_areas where cycle_id = $1)',
      [cycle.id],
    )
    expect(commitmentsRes.rows).toHaveLength(1)
  })

  it('Accept transitions the cycle to active and materializes slots', async () => {
    const onAccepted = vi.fn()
    const cycle = await setUpDraftCycle()
    render(<System cycleId={cycle.id} onAccepted={onAccepted} />)

    await screen.findByText('Morning Run')
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))

    await waitFor(() => expect(onAccepted).toHaveBeenCalledWith(cycle.id))

    const cycleRes = await db.query('select status, started_at from cycles where id = $1', [cycle.id])
    expect(cycleRes.rows[0].status).toBe('active')
    expect(cycleRes.rows[0].started_at).not.toBeNull()

    const slotsRes = await db.query(
      'select count(*)::int as count from slots s join commitments c on c.id = s.commitment_id join focus_areas fa on fa.id = c.focus_area_id where fa.cycle_id = $1',
      [cycle.id],
    )
    expect(slotsRes.rows[0].count).toBeGreaterThan(0)
  })

  it('Regenerate replaces the plan, flips regenerate_used, and then disables itself', async () => {
    const cycle = await setUpDraftCycle()
    render(<System cycleId={cycle.id} />)

    await screen.findByText('Morning Run')
    const regenerateButton = screen.getByRole('button', { name: 'Regenerate' })
    expect(regenerateButton).not.toBeDisabled()

    fireEvent.click(regenerateButton)

    await waitFor(() => expect(screen.getByRole('button', { name: 'Regenerate' })).toBeDisabled())

    const cycleRes = await db.query('select regenerate_used from cycles where id = $1', [cycle.id])
    expect(cycleRes.rows[0].regenerate_used).toBe(true)
  })

  it('Accept is disabled once the cycle is no longer draft, after a full accept + reload', async () => {
    const cycle = await setUpDraftCycle()
    const { unmount } = render(<System cycleId={cycle.id} />)
    await screen.findByText('Morning Run')
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    await waitFor(async () => {
      const res = await db.query('select status from cycles where id = $1', [cycle.id])
      expect(res.rows[0].status).toBe('active')
    })
    unmount()

    render(<System cycleId={cycle.id} />)
    await screen.findByText('Morning Run')
    expect(screen.getByRole('button', { name: 'Accept' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeDisabled()
  })
})
