import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { completeSlot, fetchTodaySlots } from '../lib/today'
import type { TodaySlot } from '../lib/today'

// Today screen — CONTEXT.md §8: "One view: what today asks of you. Check
// off or don't." Shows today's `slots` for the active cycle only
// (`fetchTodaySlots` throws if the cycle isn't active, so this screen can
// never render another date's or another cycle's slots). Checking a slot
// off calls `completeSlot`, which logs a `completions` row continuously —
// this is the reliability map's (ticket 010) primary data source, not just
// the fall-off flow's. Un-checking is not supported — see `src/lib/today.ts`.

export interface TodayProps {
  cycleId: string
  onReview?: (cycleId: string) => void
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; slots: TodaySlot[] }

export function Today({ cycleId, onReview }: TodayProps) {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [completingId, setCompletingId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setState({ status: 'loading' })
    try {
      const slots = await fetchTodaySlots(supabase, cycleId)
      setState({ status: 'ready', slots })
    } catch (err) {
      setState({
        status: 'error',
        message: err instanceof Error ? err.message : "Something went wrong loading today's plan.",
      })
    }
  }, [cycleId])

  useEffect(() => {
    load()
  }, [load])

  async function handleComplete(slotId: string) {
    setActionError(null)
    setCompletingId(slotId)
    try {
      await completeSlot(supabase, slotId)
      setState((prev) =>
        prev.status === 'ready'
          ? {
              status: 'ready',
              slots: prev.slots.map((slot) =>
                slot.id === slotId ? { ...slot, status: 'completed' } : slot,
              ),
            }
          : prev,
      )
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to check off that slot.')
    } finally {
      setCompletingId(null)
    }
  }

  if (state.status === 'loading') {
    return <p>Loading today…</p>
  }

  if (state.status === 'error') {
    return <p role="alert">{state.message}</p>
  }

  const { slots } = state

  return (
    <section aria-label="Today">
      <h1>Today</h1>

      {actionError && <p role="alert">{actionError}</p>}

      {slots.length === 0 ? (
        <p>Nothing scheduled today.</p>
      ) : (
        <ul>
          {slots.map((slot) => {
            const done = slot.status === 'completed'
            return (
              <li key={slot.id}>
                <h2>{slot.commitmentName}</h2>
                <p>{slot.sessionShape}</p>
                <p>{`${slot.dur} min`}</p>
                <p>{slot.bucket}</p>
                <label>
                  <input
                    type="checkbox"
                    checked={done}
                    disabled={done || completingId === slot.id}
                    onChange={() => handleComplete(slot.id)}
                  />
                  {done ? 'Done' : 'Mark done'}
                </label>
              </li>
            )
          })}
        </ul>
      )}

      {onReview && (
        <button type="button" onClick={() => onReview(cycleId)}>
          Review cycle
        </button>
      )}
    </section>
  )
}
