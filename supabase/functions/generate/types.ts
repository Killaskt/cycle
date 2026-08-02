// Shared types for the `generate` Edge Function — docs/SPEC.md §1, §3.
// Pure types/constants only, no Deno APIs — importable from both the Deno
// function runtime and Vitest (contract/unit tests).

export type DayType = 'weekday' | 'weekend'

export type TimeOfDay =
  | 'early_morning'
  | 'morning'
  | 'midday'
  | 'afternoon'
  | 'evening'
  | 'night'

export type Bucket =
  | 'weekday_early_morning'
  | 'weekday_morning'
  | 'weekday_midday'
  | 'weekday_afternoon'
  | 'weekday_evening'
  | 'weekday_night'
  | 'weekend_early_morning'
  | 'weekend_morning'
  | 'weekend_midday'
  | 'weekend_afternoon'
  | 'weekend_evening'
  | 'weekend_night'

export const TIME_OF_DAY_ORDER: TimeOfDay[] = [
  'early_morning',
  'morning',
  'midday',
  'afternoon',
  'evening',
  'night',
]

export const DAY_TYPES: DayType[] = ['weekday', 'weekend']

export const ALL_BUCKETS: Bucket[] = DAY_TYPES.flatMap((dayType) =>
  TIME_OF_DAY_ORDER.map((timeOfDay) => `${dayType}_${timeOfDay}` as Bucket),
)

export interface FocusAreaRequest {
  id: string
  name: string
  target_freq: number
  target_dur: number
  current_freq: number
  current_dur: number
  intake_order: number
}

export interface ReliabilityBucketInput {
  bucket: Bucket
  completions: number
  scheduled: number
}

export interface BlockedWindowInput {
  date: string
}

export interface GenerateRequest {
  wake_time: string
  focus_areas: FocusAreaRequest[]
  reliability_map: ReliabilityBucketInput[]
  blocked_windows: BlockedWindowInput[]
}

// The one thing the model is asked for, per focus area — CONTEXT.md §12.
export interface ModelResponse {
  focus_id: string
  commitment_name: string
  session_shape: string
  preferred_bucket: Bucket
  rationale: string
}

export interface CommitmentResult {
  focus_area_id: string
  name: string
  session_shape: string
  freq: number
  dur: number
  bucket: Bucket
  rationale: string | null
  from_fallback: boolean
}

export interface GenerateResponse {
  commitments: CommitmentResult[]
}
