import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import {
  acceptCycle,
  fetchSystemPlan,
  generateInitialCommitments,
  regenerateCommitments,
} from '../lib/systemPlan'
import type { CommitmentRow, CycleRow, FocusAreaRow } from '../lib/systemPlan'

// System (locked) screen — CONTEXT.md §7, §6 (regenerate-once); ticket 008.
// Read-only plan display, no editing UI of any kind. On mount, loads the
// cycle's plan; if no `commitments` exist yet (first visit after intake,
// ticket 006), calls `generate` once via `generateInitialCommitments`. Two
// actions: Accept (draft -> active, materializes slots) and Regenerate
// (draft + not yet used only).

export interface SystemProps {
  cycleId: string
  onAccepted?: (cycleId: string) => void
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; cycle: CycleRow; focusAreas: FocusAreaRow[]; commitments: CommitmentRow[] }

export function System({ cycleId, onAccepted }: SystemProps) {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [accepting, setAccepting] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setState({ status: 'loading' })
    try {
      let plan = await fetchSystemPlan(supabase, cycleId)
      if (plan.commitments.length === 0) {
        await generateInitialCommitments(supabase, cycleId)
        plan = await fetchSystemPlan(supabase, cycleId)
      }
      setState({ status: 'ready', cycle: plan.cycle, focusAreas: plan.focusAreas, commitments: plan.commitments })
    } catch (err) {
      setState({
        status: 'error',
        message: err instanceof Error ? err.message : 'Something went wrong generating your system.',
      })
    }
  }, [cycleId])

  useEffect(() => {
    load()
  }, [load])

  async function handleAccept() {
    setActionError(null)
    setAccepting(true)
    try {
      await acceptCycle(supabase, cycleId)
      onAccepted?.(cycleId)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to accept the plan.')
    } finally {
      setAccepting(false)
    }
  }

  async function handleRegenerate() {
    setActionError(null)
    setRegenerating(true)
    try {
      await regenerateCommitments(supabase, cycleId)
      const plan = await fetchSystemPlan(supabase, cycleId)
      setState({ status: 'ready', cycle: plan.cycle, focusAreas: plan.focusAreas, commitments: plan.commitments })
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to regenerate the plan.')
    } finally {
      setRegenerating(false)
    }
  }

  if (state.status === 'loading') {
    return <p>Generating your system…</p>
  }

  if (state.status === 'error') {
    return <p role="alert">{state.message}</p>
  }

  const { cycle, focusAreas, commitments } = state
  const focusAreaNameById = new Map(focusAreas.map((fa) => [fa.id, fa.name]))
  const canAccept = cycle.status === 'draft'
  const canRegenerate = cycle.status === 'draft' && !cycle.regenerate_used

  return (
    <section aria-label="Your system">
      <h1>Your system</h1>

      {actionError && <p role="alert">{actionError}</p>}

      <ul>
        {commitments.map((commitment) => (
          <li key={commitment.id}>
            <h2>{commitment.name}</h2>
            <p>{focusAreaNameById.get(commitment.focus_area_id)}</p>
            <p>{commitment.session_shape}</p>
            <p>{`${commitment.freq}x/week, ${commitment.dur} min`}</p>
            <p>{commitment.bucket}</p>
            {commitment.rationale && <p>{commitment.rationale}</p>}
          </li>
        ))}
      </ul>

      <button type="button" onClick={handleAccept} disabled={!canAccept || accepting || regenerating}>
        {accepting ? 'Starting…' : 'Accept'}
      </button>
      <button type="button" onClick={handleRegenerate} disabled={!canRegenerate || accepting || regenerating}>
        {regenerating ? 'Regenerating…' : 'Regenerate'}
      </button>
    </section>
  )
}
