// Cycle close review — CONTEXT.md §11, docs/SPEC.md §2f (`cycles.review`
// shape) and §2 (`tags`, `fall_offs`, `focus_areas`, `commitments`). Ticket
// 017.
//
// Two read-only assemblies (CONTEXT.md §11 "shown, not asked" — no user
// input required to produce these, they're read straight off data tickets
// 004/007/011/012/013 already wrote):
//   - `fetchGoalsForReview` — per `focus_areas` (+ its `commitments` row, if
//     one still exists and hasn't been `REMOVE`d) for the "hit/partial/
//     missed" + "keep/drop" prompts.
//   - `fetchFallOffSummary` — this cycle's `fall_offs`, aggregated per slot
//     (a timeline entry, e.g. "Tuesday, weekday_morning — fell off 3x,
//     tagged 'sleep' twice") and per tag (cycle-wide frequency).
//
// One write: `submitCycleReview` — the four asked-for inputs (CONTEXT.md
// §11), written into `cycles.review` exactly per docs/SPEC.md §2f, and
// `cycles.status -> 'closed'`. Tag classification corrections
// (`tagCorrections`) update the `tags` row itself (ticket 004's
// `tagRepository.ts` table), not just the review jsonb blob, so future
// fall-offs referencing that tag see the corrected classification
// immediately (ticket 017 DoD) — `resolveTag`/`recordFallOff` read
// `tags.classification` live, no cache to invalidate.
//
// This module performs exactly one `cycles.status` transition —
// `'active' -> 'closed'`, guarded by `.eq('status', 'active')` — and no
// other function here writes `cycles.status` at all. There is no write
// path back to `draft`/`active` for a cycle from this module, satisfying
// the ticket's "a closed cycle can no longer be edited" requirement.
//
// `submitCycleReview` also writes `load_factor.last_cycle_completed_minutes`
// for this cycle (`./loadFactor`'s `updateLoadFactorFromCycle`) — ticket
// 018, CONTEXT.md §6. Cycle-close is picked (over next-cycle-start) as the
// one point every closed cycle passes through exactly once; see
// `loadFactor.ts`'s doc comment for the full reasoning.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Bucket } from './slots'
import type { TagClassification } from './tagRepository'
import { updateLoadFactorFromCycle } from './loadFactor'

export type GoalResult = 'hit' | 'partial' | 'missed'

export interface GoalForReview {
  focusAreaId: string
  name: string
  commitmentId: string | null
  commitmentName: string | null
  /** `true` when a commitment existed but was soft-deleted (ticket 013's `REMOVE`, `commitments.removed_at`). */
  commitmentRemoved: boolean
}

export interface TagFrequency {
  tagId: string
  label: string
  count: number
  /** This tag's *current* `tags.classification` — the value the "confirm or correct" UI starts from. */
  classification: TagClassification
}

export interface SlotFallOffTimelineEntry {
  slotId: string
  scheduledDate: string
  /** Derived from `scheduledDate` — CONTEXT.md §11's worked example ("Tuesday 6:30am"). */
  weekday: string
  bucket: Bucket
  fallCount: number
  /** Descending by count, tie-broken alphabetically by label. */
  tagCounts: TagFrequency[]
}

export interface FallOffSummary {
  /** Ordered by `scheduledDate` ascending. */
  timeline: SlotFallOffTimelineEntry[]
  /** Cycle-wide tag frequencies, descending by count, tie-broken alphabetically. */
  tagFrequencies: TagFrequency[]
  totalFalls: number
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function weekdayName(scheduledDate: string): string {
  const d = new Date(`${scheduledDate.slice(0, 10)}T00:00:00Z`)
  return WEEKDAY_NAMES[d.getUTCDay()]
}

function sortByCountDesc<T extends { count: number; label: string }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

interface FocusAreaQueryRow {
  id: string
  name: string
}

interface CommitmentQueryRow {
  id: string
  focus_area_id: string
  name: string
  removed_at: string | null
}

/**
 * Every focus area for this cycle, joined to its commitment (if any still
 * exists — a commitment may have been soft-deleted by a 3rd-fall `REMOVE`,
 * ticket 013). Read-only; assembled entirely from `focus_areas`/
 * `commitments` — no new data collected here.
 */
export async function fetchGoalsForReview(client: SupabaseClient, cycleId: string): Promise<GoalForReview[]> {
  const { data: focusAreaRows, error: focusAreaError } = await client
    .from('focus_areas')
    .select('id, name')
    .eq('cycle_id', cycleId)
    .order('intake_order', { ascending: true })
  if (focusAreaError) throw focusAreaError

  const focusAreas = (focusAreaRows ?? []) as FocusAreaQueryRow[]
  if (focusAreas.length === 0) return []

  const focusAreaIds = focusAreas.map((fa) => fa.id)
  const { data: commitmentRows, error: commitmentError } = await client
    .from('commitments')
    .select('id, focus_area_id, name, removed_at')
    .in('focus_area_id', focusAreaIds)
  if (commitmentError) throw commitmentError

  const commitmentByFocusArea = new Map(
    ((commitmentRows ?? []) as CommitmentQueryRow[]).map((c) => [c.focus_area_id, c]),
  )

  return focusAreas.map((fa) => {
    const commitment = commitmentByFocusArea.get(fa.id)
    return {
      focusAreaId: fa.id,
      name: fa.name,
      commitmentId: commitment?.id ?? null,
      commitmentName: commitment?.name ?? null,
      commitmentRemoved: Boolean(commitment?.removed_at),
    }
  })
}

interface FallOffQueryRow {
  id: string
  slot_id: string
  tag_id: string
  tags:
    | { label: string; classification: TagClassification }
    | { label: string; classification: TagClassification }[]
    | null
  slots: { scheduled_date: string; bucket: Bucket } | { scheduled_date: string; bucket: Bucket }[] | null
}

function single<T>(value: T | T[] | null): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value
}

/**
 * This cycle's `fall_offs`, aggregated two ways from the same rows
 * (CONTEXT.md §9: per-slot and cycle-wide are "two different diagnoses"
 * even off identical underlying events):
 *   - `timeline` — one entry per slot that ever fell off, with its fall
 *     count and a per-tag breakdown for that slot.
 *   - `tagFrequencies` — cycle-wide count per tag, across every slot.
 *
 * Read-only, no user input required to produce it (ticket 017 DoD).
 */
export async function fetchFallOffSummary(client: SupabaseClient, cycleId: string): Promise<FallOffSummary> {
  const { data, error } = await client
    .from('fall_offs')
    .select('id, slot_id, tag_id, tags(label, classification), slots!inner(scheduled_date, bucket)')
    .eq('cycle_id', cycleId)
  if (error) throw error

  const rows = (data ?? []) as unknown as FallOffQueryRow[]

  interface SlotAccumulator {
    slotId: string
    scheduledDate: string
    bucket: Bucket
    fallCount: number
    tagCounts: Map<string, TagFrequency>
  }

  const slotAccumulators = new Map<string, SlotAccumulator>()
  const tagFrequencyMap = new Map<string, TagFrequency>()

  for (const row of rows) {
    const tag = single(row.tags)
    const slot = single(row.slots)
    if (!tag || !slot) continue

    let slotAcc = slotAccumulators.get(row.slot_id)
    if (!slotAcc) {
      slotAcc = {
        slotId: row.slot_id,
        scheduledDate: slot.scheduled_date,
        bucket: slot.bucket,
        fallCount: 0,
        tagCounts: new Map(),
      }
      slotAccumulators.set(row.slot_id, slotAcc)
    }
    slotAcc.fallCount += 1
    const slotTagEntry = slotAcc.tagCounts.get(row.tag_id)
    if (slotTagEntry) {
      slotTagEntry.count += 1
    } else {
      slotAcc.tagCounts.set(row.tag_id, {
        tagId: row.tag_id,
        label: tag.label,
        count: 1,
        classification: tag.classification,
      })
    }

    const cycleTagEntry = tagFrequencyMap.get(row.tag_id)
    if (cycleTagEntry) {
      cycleTagEntry.count += 1
    } else {
      tagFrequencyMap.set(row.tag_id, {
        tagId: row.tag_id,
        label: tag.label,
        count: 1,
        classification: tag.classification,
      })
    }
  }

  const timeline: SlotFallOffTimelineEntry[] = Array.from(slotAccumulators.values())
    .map((acc) => ({
      slotId: acc.slotId,
      scheduledDate: acc.scheduledDate,
      weekday: weekdayName(acc.scheduledDate),
      bucket: acc.bucket,
      fallCount: acc.fallCount,
      tagCounts: sortByCountDesc(Array.from(acc.tagCounts.values())),
    }))
    .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate))

  return {
    timeline,
    tagFrequencies: sortByCountDesc(Array.from(tagFrequencyMap.values())),
    totalFalls: rows.length,
  }
}

export interface GoalReviewInput {
  focusAreaId: string
  result: GoalResult
  keepNext: boolean
}

export interface TagCorrectionInput {
  tagId: string
  classification: TagClassification
}

export interface SubmitCycleReviewInput {
  goals: GoalReviewInput[]
  fallSummaryConfirmed: boolean
  tagCorrections: TagCorrectionInput[]
  freeform: string
}

/**
 * Exactly the shape docs/SPEC.md §2f defines — snake_case keys, because this
 * is written verbatim into `cycles.review` jsonb, not read back through any
 * camelCase mapping layer.
 */
interface CycleReviewJson {
  goals: { focus_area_id: string; result: GoalResult; keep_next: boolean }[]
  fall_summary_confirmed: boolean
  tag_corrections: { tag_id: string; classification: TagClassification }[]
  freeform: string
}

/**
 * Writes the cycle-close review (CONTEXT.md §11's four asked-for inputs)
 * and closes the cycle. Requires the cycle to currently be `active` —
 * throws otherwise (a draft cycle has no fall-off/completion history to
 * review yet; an already-closed cycle can't be reviewed again, since
 * re-review would mean a write path back into an edit of a closed cycle,
 * which the ticket DoD explicitly forbids).
 *
 * Requires `goals` to cover every one of this cycle's `focus_areas` exactly
 * once — no missing goal, no stray `focus_area_id` that doesn't belong to
 * this cycle — since "per goal" (CONTEXT.md §11) means all of them, not a
 * subset the caller happened to submit.
 *
 * Tag corrections are applied to the `tags` table itself (not just logged
 * into the jsonb blob) *before* the cycle is closed, so a failure updating a
 * tag aborts the whole submission rather than closing the cycle with a
 * `tag_corrections` entry that was never actually applied.
 */
export async function submitCycleReview(
  client: SupabaseClient,
  cycleId: string,
  input: SubmitCycleReviewInput,
): Promise<void> {
  const freeform = input.freeform.trim()
  if (!freeform) {
    throw new Error('freeform is required')
  }

  const { data: cycleRow, error: cycleError } = await client
    .from('cycles')
    .select('id, status, user_id')
    .eq('id', cycleId)
    .single()
  if (cycleError) throw cycleError
  if (!cycleRow) throw new Error(`cycle ${cycleId} not found`)
  if (cycleRow.status !== 'active') {
    throw new Error(
      `cycle ${cycleId} is not active (status: ${cycleRow.status}) — only an active cycle can be closed`,
    )
  }

  const { data: focusAreaRows, error: focusAreaError } = await client
    .from('focus_areas')
    .select('id')
    .eq('cycle_id', cycleId)
  if (focusAreaError) throw focusAreaError

  const focusAreaIds = new Set(((focusAreaRows ?? []) as { id: string }[]).map((fa) => fa.id))
  const submittedIds = new Set(input.goals.map((g) => g.focusAreaId))

  if (submittedIds.size !== input.goals.length) {
    throw new Error('goals contains a duplicate focus_area_id')
  }
  for (const id of focusAreaIds) {
    if (!submittedIds.has(id)) {
      throw new Error(`goals is missing an entry for focus_area_id ${id}`)
    }
  }
  for (const id of submittedIds) {
    if (!focusAreaIds.has(id)) {
      throw new Error(`goals contains focus_area_id ${id}, which does not belong to cycle ${cycleId}`)
    }
  }

  for (const correction of input.tagCorrections) {
    const { error: tagError } = await client
      .from('tags')
      .update({ classification: correction.classification })
      .eq('id', correction.tagId)
    if (tagError) throw tagError
  }

  // CONTEXT.md §6, ticket 018: snapshot this cycle's actual completed
  // minutes into load_factor before closing — a failure here aborts the
  // whole submission (cycle stays 'active'), same pattern as tag
  // corrections above, rather than closing a cycle whose load_factor write
  // silently never happened.
  await updateLoadFactorFromCycle(client, cycleRow.user_id, cycleId)

  const review: CycleReviewJson = {
    goals: input.goals.map((g) => ({
      focus_area_id: g.focusAreaId,
      result: g.result,
      keep_next: g.keepNext,
    })),
    fall_summary_confirmed: input.fallSummaryConfirmed,
    tag_corrections: input.tagCorrections.map((c) => ({
      tag_id: c.tagId,
      classification: c.classification,
    })),
    freeform,
  }

  const { data: updated, error: updateError } = await client
    .from('cycles')
    .update({ status: 'closed', review })
    .eq('id', cycleId)
    .eq('status', 'active')
    .select()
    .maybeSingle()
  if (updateError) throw updateError
  if (!updated) {
    throw new Error(`cycle ${cycleId} was not closed — it may have been closed concurrently`)
  }
}
