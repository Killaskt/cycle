// Model response shape validation — docs/SPEC.md §3 ("Model response,
// validated against this shape; anything else is a validation failure").
// Pure logic, no Deno APIs — importable from both the Deno function
// runtime and Vitest (this is what the fixture contract test runs
// against directly).

import { ALL_BUCKETS } from './types.ts'
import type { Bucket, ModelResponse } from './types.ts'

export function isValidBucket(value: unknown): value is Bucket {
  return typeof value === 'string' && (ALL_BUCKETS as string[]).includes(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Validates a raw model (or fixture) response against the shape in
 * docs/SPEC.md §3. Returns the validated response, or `null` if anything
 * is missing, mistyped, or (for `preferred_bucket`) out of the bucket
 * enum — the caller retries once on `null`, then applies the
 * CONTEXT.md §12 deterministic fallback.
 */
export function validateModelResponse(raw: unknown): ModelResponse | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>

  if (!isNonEmptyString(r.focus_id)) return null
  if (!isNonEmptyString(r.commitment_name)) return null
  if (!isNonEmptyString(r.session_shape)) return null
  if (!isValidBucket(r.preferred_bucket)) return null
  if (!isNonEmptyString(r.rationale)) return null

  return {
    focus_id: r.focus_id,
    commitment_name: r.commitment_name,
    session_shape: r.session_shape,
    preferred_bucket: r.preferred_bucket,
    rationale: r.rationale,
  }
}
