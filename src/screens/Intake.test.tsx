import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { Client } from 'pg'
import { DB_URL } from '../test/integration/localSupabase'
import { Intake } from './Intake'
import { supabase } from '../lib/supabase'

// Integration test against the local Docker Supabase stack
// (.claude/skills/local-supabase-stack/SKILL.md) — ticket 006 DoD.
// Signs in anonymously for real via the component's own use of
// initAuthSession() (ticket 002), then verifies the written rows directly
// in Postgres (RLS/PostgREST don't expose enough for these assertions).

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

function fillFocusArea(
  index: number,
  values: { name: string; targetFreq: string; targetDur: string; currentFreq: string; currentDur: string },
) {
  const n = index + 1
  fireEvent.change(screen.getByLabelText(`Focus area ${n} name`), { target: { value: values.name } })
  fireEvent.change(screen.getByLabelText(`Focus area ${n} target frequency (sessions)`), {
    target: { value: values.targetFreq },
  })
  fireEvent.change(screen.getByLabelText(`Focus area ${n} target duration (minutes)`), {
    target: { value: values.targetDur },
  })
  fireEvent.change(screen.getByLabelText(`Focus area ${n} current frequency (sessions)`), {
    target: { value: values.currentFreq },
  })
  fireEvent.change(screen.getByLabelText(`Focus area ${n} current duration (minutes)`), {
    target: { value: values.currentDur },
  })
}

describe('Intake (integration, local Supabase)', () => {
  it('valid submission creates one draft cycle and its focus_areas rows in entry order', async () => {
    const onSubmitted = vi.fn()
    render(<Intake onSubmitted={onSubmitted} />)

    fireEvent.change(screen.getByLabelText('Wake time'), { target: { value: '06:30' } })
    fireEvent.change(screen.getByLabelText('Normal day, roughly'), {
      target: { value: 'Work 9-5, gym after if I make it.' },
    })
    fireEvent.change(screen.getByLabelText('Timeframe (days)'), { target: { value: '14' } })

    fillFocusArea(0, { name: 'Running', targetFreq: '4', targetDur: '30', currentFreq: '1', currentDur: '20' })

    fireEvent.click(screen.getByRole('button', { name: 'Add focus area' }))
    fillFocusArea(1, { name: 'Spanish', targetFreq: '3', targetDur: '20', currentFreq: '0', currentDur: '0' })

    fireEvent.click(screen.getByRole('button', { name: 'Start cycle' }))

    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1))
    const cycleId = onSubmitted.mock.calls[0][0] as string

    const cycleRes = await db.query('select * from cycles where id = $1', [cycleId])
    expect(cycleRes.rows).toHaveLength(1)
    expect(cycleRes.rows[0].status).toBe('draft')
    expect(cycleRes.rows[0].timeframe_days).toBe(14)
    expect(cycleRes.rows[0].normal_day_notes).toBe('Work 9-5, gym after if I make it.')

    const focusAreaRes = await db.query(
      'select name, target_freq, target_dur, current_freq, current_dur, intake_order from focus_areas where cycle_id = $1 order by intake_order asc',
      [cycleId],
    )
    expect(focusAreaRes.rows).toHaveLength(2)
    expect(focusAreaRes.rows[0]).toMatchObject({
      name: 'Running',
      target_freq: 4,
      target_dur: 30,
      current_freq: 1,
      current_dur: 20,
      intake_order: 0,
    })
    expect(focusAreaRes.rows[1]).toMatchObject({
      name: 'Spanish',
      target_freq: 3,
      target_dur: 20,
      current_freq: 0,
      current_dur: 0,
      intake_order: 1,
    })
  })
})

describe('Intake validation', () => {
  it('rejects a negative frequency before submission', async () => {
    const onSubmitted = vi.fn()
    const fromSpy = vi.spyOn(supabase, 'from')
    render(<Intake onSubmitted={onSubmitted} />)

    fireEvent.change(screen.getByLabelText('Wake time'), { target: { value: '06:30' } })
    fireEvent.change(screen.getByLabelText('Timeframe (days)'), { target: { value: '14' } })
    fillFocusArea(0, { name: 'Running', targetFreq: '-1', targetDur: '30', currentFreq: '1', currentDur: '20' })

    fireEvent.click(screen.getByRole('button', { name: 'Start cycle' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/target frequency/i)
    expect(onSubmitted).not.toHaveBeenCalled()
    expect(fromSpy).not.toHaveBeenCalled()

    fromSpy.mockRestore()
  })

  it('rejects a missing duration before submission', async () => {
    const onSubmitted = vi.fn()
    const fromSpy = vi.spyOn(supabase, 'from')
    render(<Intake onSubmitted={onSubmitted} />)

    fireEvent.change(screen.getByLabelText('Wake time'), { target: { value: '06:30' } })
    fireEvent.change(screen.getByLabelText('Timeframe (days)'), { target: { value: '14' } })
    fillFocusArea(0, { name: 'Running', targetFreq: '4', targetDur: '', currentFreq: '1', currentDur: '20' })

    fireEvent.click(screen.getByRole('button', { name: 'Start cycle' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/target duration/i)
    expect(onSubmitted).not.toHaveBeenCalled()
    expect(fromSpy).not.toHaveBeenCalled()

    fromSpy.mockRestore()
  })

  it('rejects zero focus areas', async () => {
    const onSubmitted = vi.fn()
    const fromSpy = vi.spyOn(supabase, 'from')
    render(<Intake onSubmitted={onSubmitted} />)

    fireEvent.change(screen.getByLabelText('Wake time'), { target: { value: '06:30' } })
    fireEvent.change(screen.getByLabelText('Timeframe (days)'), { target: { value: '14' } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove focus area 1' }))

    fireEvent.click(screen.getByRole('button', { name: 'Start cycle' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/at least one focus area/i)
    expect(onSubmitted).not.toHaveBeenCalled()
    expect(fromSpy).not.toHaveBeenCalled()

    fromSpy.mockRestore()
  })
})
