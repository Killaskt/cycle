import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import {
  fetchFallOffSummary,
  fetchGoalsForReview,
  submitCycleReview,
  type FallOffSummary,
  type GoalForReview,
  type GoalResult,
} from '../lib/cycleReview'
import type { TagClassification } from '../lib/tagRepository'

// Cycle-close review screen — CONTEXT.md §11, docs/SPEC.md §2f. No
// notifications, no auto-close, no cycle-close nudge — closing only ever
// happens on the user's own press (CONTEXT.md §13/§17). This screen never
// writes `cycles.status` back to `draft`/`active` — `submitCycleReview`
// (../lib/cycleReview.ts) performs the one `active -> closed` transition
// and nothing else.
//
// Shown, not asked: the fall-off timeline + tag frequencies, read-only,
// assembled from existing data. Asked: per-goal hit/partial/missed,
// per-goal keep/drop, confirm-or-correct the fall/tag summary (including a
// tag's availability/motivation classification), and one freeform box.

export interface ReviewProps {
  cycleId: string
  onClosed?: (cycleId: string) => void
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; goals: GoalForReview[]; summary: FallOffSummary }
  | { status: 'closed' }

const GOAL_RESULTS: GoalResult[] = ['hit', 'partial', 'missed']
const CLASSIFICATIONS: TagClassification[] = ['availability', 'motivation']

export function Review({ cycleId, onClosed }: ReviewProps) {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [goalResults, setGoalResults] = useState<Record<string, GoalResult>>({})
  const [goalKeep, setGoalKeep] = useState<Record<string, boolean>>({})
  const [summaryConfirmed, setSummaryConfirmed] = useState(false)
  const [tagClassifications, setTagClassifications] = useState<Record<string, TagClassification>>({})
  const [freeform, setFreeform] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setState({ status: 'loading' })
    try {
      const [goals, summary] = await Promise.all([
        fetchGoalsForReview(supabase, cycleId),
        fetchFallOffSummary(supabase, cycleId),
      ])
      setGoalResults(Object.fromEntries(goals.map((g) => [g.focusAreaId, 'hit' as GoalResult])))
      setGoalKeep(Object.fromEntries(goals.map((g) => [g.focusAreaId, true])))
      setTagClassifications(
        Object.fromEntries(summary.tagFrequencies.map((t) => [t.tagId, t.classification])),
      )
      setState({ status: 'ready', goals, summary })
    } catch (err) {
      setState({
        status: 'error',
        message: err instanceof Error ? err.message : 'Something went wrong loading the review.',
      })
    }
  }, [cycleId])

  useEffect(() => {
    load()
  }, [load])

  if (state.status === 'loading') {
    return <p>Loading review…</p>
  }

  if (state.status === 'error') {
    return <p role="alert">{state.message}</p>
  }

  if (state.status === 'closed') {
    return <p>Cycle closed.</p>
  }

  const { goals, summary } = state

  async function handleSubmit() {
    setSubmitError(null)

    if (!summaryConfirmed) {
      setSubmitError('Confirm or correct the fall/tag summary before closing the cycle.')
      return
    }

    const tagCorrections = summary.tagFrequencies
      .filter((t) => tagClassifications[t.tagId] && tagClassifications[t.tagId] !== t.classification)
      .map((t) => ({ tagId: t.tagId, classification: tagClassifications[t.tagId] }))

    setSubmitting(true)
    try {
      await submitCycleReview(supabase, cycleId, {
        goals: goals.map((g) => ({
          focusAreaId: g.focusAreaId,
          result: goalResults[g.focusAreaId] ?? 'hit',
          keepNext: goalKeep[g.focusAreaId] ?? true,
        })),
        fallSummaryConfirmed: summaryConfirmed,
        tagCorrections,
        freeform,
      })
      setState({ status: 'closed' })
      onClosed?.(cycleId)
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to close the cycle.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section aria-label="Cycle review">
      <h1>Review this cycle</h1>

      {submitError && <p role="alert">{submitError}</p>}

      <section aria-label="Fall-off summary">
        <h2>Falls and recoveries</h2>
        {summary.timeline.length === 0 ? (
          <p>No fall-offs this cycle.</p>
        ) : (
          <ul>
            {summary.timeline.map((entry) => (
              <li key={entry.slotId}>
                {`${entry.weekday} — ${entry.bucket} — fell off ${entry.fallCount}x, tagged ${entry.tagCounts
                  .map((t) => `'${t.label}' ${t.count}x`)
                  .join(', ')}`}
              </li>
            ))}
          </ul>
        )}

        {summary.tagFrequencies.length > 0 && (
          <fieldset>
            <legend>Tag classifications</legend>
            {summary.tagFrequencies.map((tag) => (
              <label key={tag.tagId}>
                {`${tag.label} (${tag.count}x)`}
                <select
                  value={tagClassifications[tag.tagId] ?? tag.classification}
                  onChange={(e) =>
                    setTagClassifications((prev) => ({
                      ...prev,
                      [tag.tagId]: e.target.value as TagClassification,
                    }))
                  }
                >
                  {CLASSIFICATIONS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </fieldset>
        )}

        <label>
          <input
            type="checkbox"
            checked={summaryConfirmed}
            onChange={(e) => setSummaryConfirmed(e.target.checked)}
          />
          Confirm this fall/tag summary is accurate
        </label>
      </section>

      <fieldset>
        <legend>Goals</legend>
        {goals.map((goal) => (
          <div key={goal.focusAreaId}>
            <h3>{goal.name}</h3>
            {goal.commitmentRemoved && <p>This commitment was removed during the cycle.</p>}

            <fieldset>
              <legend>{`${goal.name} — result`}</legend>
              {GOAL_RESULTS.map((result) => (
                <label key={result}>
                  <input
                    type="radio"
                    name={`result-${goal.focusAreaId}`}
                    value={result}
                    checked={(goalResults[goal.focusAreaId] ?? 'hit') === result}
                    onChange={() => setGoalResults((prev) => ({ ...prev, [goal.focusAreaId]: result }))}
                  />
                  {result}
                </label>
              ))}
            </fieldset>

            <label>
              <input
                type="checkbox"
                checked={goalKeep[goal.focusAreaId] ?? true}
                onChange={(e) =>
                  setGoalKeep((prev) => ({ ...prev, [goal.focusAreaId]: e.target.checked }))
                }
              />
              {`Keep "${goal.name}" for next cycle`}
            </label>
          </div>
        ))}
      </fieldset>

      <label>
        What should next cycle do differently?
        <textarea value={freeform} onChange={(e) => setFreeform(e.target.value)} />
      </label>

      <button type="button" onClick={handleSubmit} disabled={submitting}>
        {submitting ? 'Closing…' : 'Close cycle'}
      </button>
    </section>
  )
}
