import { useState } from 'react'
import type { FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { initAuthSession } from '../lib/auth'

// Intake screen — CONTEXT.md §4, docs/SPEC.md §2 (`cycles` / `focus_areas`).
// Captures wake time, a freeform normal-day description, the cycle
// timeframe, and one or more focus areas (target/current freq+dur each).
// Submitting writes exactly one `cycles` row (status: 'draft') and its
// `focus_areas` rows, recording `intake_order` in entry sequence — ticket
// 003's ceiling back-off tie-break depends on that field. This screen never
// calls the `generate` Edge Function (ticket 008's territory).

interface FocusAreaFormValue {
  key: string
  name: string
  targetFreq: string
  targetDur: string
  currentFreq: string
  currentDur: string
}

function emptyFocusArea(): FocusAreaFormValue {
  return {
    key: crypto.randomUUID(),
    name: '',
    targetFreq: '',
    targetDur: '',
    currentFreq: '',
    currentDur: '',
  }
}

function isNonNegativeInteger(raw: string): boolean {
  if (raw.trim() === '') return false
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0
}

export interface IntakeProps {
  onSubmitted?: (cycleId: string) => void
}

export function Intake({ onSubmitted }: IntakeProps) {
  const [wakeTime, setWakeTime] = useState('06:30')
  const [normalDayNotes, setNormalDayNotes] = useState('')
  const [timeframeDays, setTimeframeDays] = useState('14')
  const [focusAreas, setFocusAreas] = useState<FocusAreaFormValue[]>([emptyFocusArea()])
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  function updateFocusArea(key: string, patch: Partial<FocusAreaFormValue>) {
    setFocusAreas((areas) => areas.map((area) => (area.key === key ? { ...area, ...patch } : area)))
  }

  function addFocusArea() {
    setFocusAreas((areas) => [...areas, emptyFocusArea()])
  }

  function removeFocusArea(key: string) {
    setFocusAreas((areas) => areas.filter((area) => area.key !== key))
  }

  function validate(): string | null {
    if (!isNonNegativeInteger(timeframeDays) || Number(timeframeDays) < 1) {
      return 'Timeframe must be a whole number of days, at least 1.'
    }
    if (focusAreas.length === 0) {
      return 'Add at least one focus area.'
    }
    for (let i = 0; i < focusAreas.length; i++) {
      const area = focusAreas[i]
      const label = area.name.trim() || `Focus area ${i + 1}`
      if (!area.name.trim()) {
        return `${label}: name is required.`
      }
      const fields: Array<[string, string]> = [
        ['target frequency', area.targetFreq],
        ['target duration', area.targetDur],
        ['current frequency', area.currentFreq],
        ['current duration', area.currentDur],
      ]
      for (const [fieldLabel, raw] of fields) {
        if (!isNonNegativeInteger(raw)) {
          return `${label}: ${fieldLabel} must be a non-negative whole number.`
        }
      }
    }
    return null
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)

    const validationError = validate()
    if (validationError) {
      setError(validationError)
      return
    }

    setSubmitting(true)
    try {
      const session = await initAuthSession()

      const { data: cycle, error: cycleError } = await supabase
        .from('cycles')
        .insert({
          user_id: session.user.id,
          status: 'draft',
          timeframe_days: Number(timeframeDays),
          wake_time: wakeTime,
          normal_day_notes: normalDayNotes.trim() || null,
        })
        .select()
        .single()

      if (cycleError || !cycle) {
        throw cycleError ?? new Error('Insert returned no cycle')
      }

      const focusAreaRows = focusAreas.map((area, index) => ({
        cycle_id: cycle.id,
        name: area.name.trim(),
        target_freq: Number(area.targetFreq),
        target_dur: Number(area.targetDur),
        current_freq: Number(area.currentFreq),
        current_dur: Number(area.currentDur),
        intake_order: index,
      }))

      const { error: focusAreasError } = await supabase.from('focus_areas').insert(focusAreaRows)
      if (focusAreasError) throw focusAreasError

      onSubmitted?.(cycle.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong submitting intake.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} aria-label="Intake" noValidate>
      <h1>Set up your cycle</h1>

      <label>
        Wake time
        <input
          type="time"
          value={wakeTime}
          onChange={(e) => setWakeTime(e.target.value)}
          required
        />
      </label>

      <label>
        Normal day, roughly
        <textarea
          value={normalDayNotes}
          onChange={(e) => setNormalDayNotes(e.target.value)}
        />
      </label>

      <label>
        Timeframe (days)
        <input
          type="number"
          min={1}
          step={1}
          value={timeframeDays}
          onChange={(e) => setTimeframeDays(e.target.value)}
          required
        />
      </label>

      <fieldset>
        <legend>Focus areas</legend>
        {focusAreas.map((area, index) => (
          <div key={area.key}>
            <label>
              {`Focus area ${index + 1} name`}
              <input
                type="text"
                value={area.name}
                onChange={(e) => updateFocusArea(area.key, { name: e.target.value })}
              />
            </label>
            <label>
              {`Focus area ${index + 1} target frequency (sessions)`}
              <input
                type="number"
                min={0}
                step={1}
                value={area.targetFreq}
                onChange={(e) => updateFocusArea(area.key, { targetFreq: e.target.value })}
              />
            </label>
            <label>
              {`Focus area ${index + 1} target duration (minutes)`}
              <input
                type="number"
                min={0}
                step={1}
                value={area.targetDur}
                onChange={(e) => updateFocusArea(area.key, { targetDur: e.target.value })}
              />
            </label>
            <label>
              {`Focus area ${index + 1} current frequency (sessions)`}
              <input
                type="number"
                min={0}
                step={1}
                value={area.currentFreq}
                onChange={(e) => updateFocusArea(area.key, { currentFreq: e.target.value })}
              />
            </label>
            <label>
              {`Focus area ${index + 1} current duration (minutes)`}
              <input
                type="number"
                min={0}
                step={1}
                value={area.currentDur}
                onChange={(e) => updateFocusArea(area.key, { currentDur: e.target.value })}
              />
            </label>
            <button type="button" onClick={() => removeFocusArea(area.key)}>
              {`Remove focus area ${index + 1}`}
            </button>
          </div>
        ))}
        <button type="button" onClick={addFocusArea}>
          Add focus area
        </button>
      </fieldset>

      {error && <p role="alert">{error}</p>}

      <button type="submit" disabled={submitting}>
        {submitting ? 'Saving…' : 'Start cycle'}
      </button>
    </form>
  )
}
