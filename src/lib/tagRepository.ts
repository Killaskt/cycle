import type { SupabaseClient } from '@supabase/supabase-js'

// Tag repository — CONTEXT.md §9a, ticket 004.
//
// Tags are user-created, reusable, 1-3 words, offered as a dropdown of
// existing tags + "something else." New entries are fuzzy-matched against
// the user's existing tags to resist vocabulary fragmentation ("tired" vs
// "tierd" should resolve to the same tag, not fork it). Only a genuinely
// new tag requires the one extra binary classification tap
// (`availability` | `motivation`); a reused/fuzzy-matched tag always
// inherits its existing classification and is never re-prompted.

export type TagClassification = 'availability' | 'motivation'

export interface Tag {
  id: string
  user_id: string
  label: string
  classification: TagClassification
  created_at: string
}

const DISINTEREST_LABEL = 'disinterest'
const DISINTEREST_CLASSIFICATION: TagClassification = 'motivation'

// Below this normalized-similarity, two labels are treated as different
// tags rather than a typo of one another. Picked to catch adjacent-letter
// typos/transpositions ("tired"/"tierd") without collapsing genuinely
// distinct short words into each other.
const FUZZY_MATCH_THRESHOLD = 0.7

const POSTGRES_UNIQUE_VIOLATION = '23505'

export function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Optimal string alignment distance: Levenshtein (insert/delete/substitute)
 * plus adjacent-transposition as a single edit. The transposition case is
 * what makes "tired" -> "tierd" read as a 1-edit typo instead of a 2-edit
 * near-miss, which is the difference between it fuzzy-matching at a sane
 * threshold or not.
 */
function editDistance(a: string, b: string): number {
  const rows = a.length + 1
  const cols = b.length + 1
  const d: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0))

  for (let i = 0; i < rows; i++) d[i][0] = i
  for (let j = 0; j < cols; j++) d[0][j] = j

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(
        d[i - 1][j] + 1, // deletion
        d[i][j - 1] + 1, // insertion
        d[i - 1][j - 1] + cost, // substitution
      )
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + cost) // transposition
      }
    }
  }

  return d[a.length][b.length]
}

/** Case/whitespace-insensitive exact match, or close enough to be a typo of one another. */
export function labelsFuzzyMatch(a: string, b: string): boolean {
  const na = normalizeLabel(a)
  const nb = normalizeLabel(b)
  if (na === nb) return true
  if (na.length === 0 || nb.length === 0) return false

  const distance = editDistance(na, nb)
  const maxLen = Math.max(na.length, nb.length)
  return 1 - distance / maxLen >= FUZZY_MATCH_THRESHOLD
}

/**
 * Ensures the `disinterest` tag (motivation-classified, CONTEXT.md §9a)
 * exists for this user before any other tag-repository read/write runs.
 * Idempotent and safe to call on every invocation — a no-op once the row
 * exists, so "seeded on first use" falls out of calling this at the top of
 * every other exported function rather than needing a separate migration
 * step (tags are scoped per-user and users are minted dynamically via
 * anonymous auth, so there's no fixed set of rows a SQL seed could target).
 */
export async function ensureSeedTags(client: SupabaseClient, userId: string): Promise<void> {
  const { data: existing, error } = await client
    .from('tags')
    .select('id, label')
    .eq('user_id', userId)
  if (error) throw error

  const alreadySeeded = (existing ?? []).some((t) => labelsFuzzyMatch(t.label, DISINTEREST_LABEL))
  if (alreadySeeded) return

  const { error: insertError } = await client.from('tags').insert({
    user_id: userId,
    label: DISINTEREST_LABEL,
    classification: DISINTEREST_CLASSIFICATION,
  })
  // Two concurrent first-uses can both pass the check above; the unique
  // (user_id, label) constraint is the real guard, so a duplicate-key error
  // here just means the other caller won the race — not a real failure.
  if (insertError && insertError.code !== POSTGRES_UNIQUE_VIOLATION) throw insertError
}

/** The dropdown source: every tag this user has ever created, alphabetical. */
export async function listTags(client: SupabaseClient, userId: string): Promise<Tag[]> {
  await ensureSeedTags(client, userId)

  const { data, error } = await client
    .from('tags')
    .select('*')
    .eq('user_id', userId)
    .order('label', { ascending: true })
  if (error) throw error
  return data ?? []
}

export interface ResolveTagInput {
  label: string
  /** Required only when `label` doesn't fuzzy-match an existing tag. */
  classification?: TagClassification
}

export interface ResolveTagResult {
  tag: Tag
  created: boolean
}

/**
 * Resolves a user-entered label to a `tags` row — fuzzy-matched against
 * this user's existing tags first (CONTEXT.md §9a). A match (exact or
 * fuzzy) always wins and inherits its existing classification, regardless
 * of whatever `classification` was passed. A genuinely new label requires
 * `classification` and fails validation without one.
 */
export async function resolveTag(
  client: SupabaseClient,
  userId: string,
  input: ResolveTagInput,
): Promise<ResolveTagResult> {
  await ensureSeedTags(client, userId)

  const normalized = normalizeLabel(input.label)
  if (!normalized) throw new Error('tag label must not be empty')

  const { data: existing, error } = await client
    .from('tags')
    .select('*')
    .eq('user_id', userId)
  if (error) throw error

  const match = (existing ?? []).find((t) => labelsFuzzyMatch(t.label, input.label))
  if (match) return { tag: match, created: false }

  if (!input.classification) {
    throw new Error(
      `classification is required to create a new tag ("${input.label}" did not match an existing tag)`,
    )
  }

  const { data: created, error: insertError } = await client
    .from('tags')
    .insert({
      user_id: userId,
      label: input.label.trim(),
      classification: input.classification,
    })
    .select()
    .single()
  if (insertError) throw insertError
  return { tag: created as Tag, created: true }
}
