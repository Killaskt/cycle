import { createClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import {
  SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL,
} from '../test/integration/localSupabase'
import { ensureSeedTags, labelsFuzzyMatch, listTags, normalizeLabel, resolveTag } from './tagRepository'

// Pure-function tests: no DB, no network — ticket 004 DoD's fuzzy-match
// behavior in isolation from the Supabase round-trip.
describe('normalizeLabel', () => {
  it('trims, lowercases, and collapses internal whitespace', () => {
    expect(normalizeLabel('  Tired   Out  ')).toBe('tired out')
  })
})

describe('labelsFuzzyMatch', () => {
  it('matches an exact label case/whitespace-insensitively', () => {
    expect(labelsFuzzyMatch('Tired', '  tired ')).toBe(true)
  })

  it('matches a near-duplicate typo ("tired" vs "tierd")', () => {
    expect(labelsFuzzyMatch('tired', 'tierd')).toBe(true)
  })

  it('does not match genuinely different short words', () => {
    expect(labelsFuzzyMatch('tired', 'busy')).toBe(false)
  })

  it('does not match unrelated multi-word labels', () => {
    expect(labelsFuzzyMatch('not feeling it', 'too busy today')).toBe(false)
  })
})

// Integration tests against the local Docker Supabase stack
// (.claude/skills/local-supabase-stack/SKILL.md) — real Postgres, real RLS.
// Requires `npx supabase start` to already be running.

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

async function mintUser(label: string) {
  const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`
  const password = 'password123!'
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (error || !data.user) throw error ?? new Error('createUser returned no user')

  // persistSession: false — jsdom gives the whole test file one shared
  // localStorage, so concurrently-signed-in clients would clobber each
  // other's sessions otherwise (KNOWN_ISSUES.md — ticket 001).
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { error: signInError } = await client.auth.signInWithPassword({ email, password })
  if (signInError) throw signInError

  return { userId: data.user.id, client }
}

describe('tagRepository (integration, local Supabase)', () => {
  it('creation: a genuinely new label requires and stores a classification', async () => {
    const user = await mintUser('tag-create')

    await expect(
      resolveTag(user.client, user.userId, { label: 'running solo' }),
    ).rejects.toThrow(/classification is required/)

    const { tag, created } = await resolveTag(user.client, user.userId, {
      label: 'running solo',
      classification: 'availability',
    })
    expect(created).toBe(true)
    expect(tag.label).toBe('running solo')
    expect(tag.classification).toBe('availability')
  })

  it('fuzzy-match: a near-duplicate label resolves to the existing tag, not a new row', async () => {
    const user = await mintUser('tag-fuzzy')

    const { tag: original } = await resolveTag(user.client, user.userId, {
      label: 'tired',
      classification: 'motivation',
    })

    const { tag: matched, created } = await resolveTag(user.client, user.userId, {
      label: 'tierd', // typo of 'tired'
    })

    expect(created).toBe(false)
    expect(matched.id).toBe(original.id)

    const all = await listTags(user.client, user.userId)
    expect(all.filter((t) => labelsFuzzyMatch(t.label, 'tired'))).toHaveLength(1)
  })

  it('reuse: selecting an existing tag never re-prompts for classification', async () => {
    const user = await mintUser('tag-reuse')

    const { tag: original } = await resolveTag(user.client, user.userId, {
      label: 'not feeling it',
      classification: 'motivation',
    })

    // Exact re-selection with no classification supplied must succeed, not
    // throw — this is the "never re-prompted" contract.
    const { tag: reused, created } = await resolveTag(user.client, user.userId, {
      label: 'not feeling it',
    })

    expect(created).toBe(false)
    expect(reused.id).toBe(original.id)
    expect(reused.classification).toBe('motivation')
  })

  it('seed: disinterest exists with classification motivation after first tag-repository use for a fresh user', async () => {
    const user = await mintUser('tag-seed')

    const tags = await listTags(user.client, user.userId)
    const disinterest = tags.find((t) => t.label === 'disinterest')

    expect(disinterest).toBeTruthy()
    expect(disinterest?.classification).toBe('motivation')
  })

  it('seed: ensureSeedTags is idempotent — a second call does not duplicate the row', async () => {
    const user = await mintUser('tag-seed-idempotent')

    await ensureSeedTags(user.client, user.userId)
    await ensureSeedTags(user.client, user.userId)

    const tags = await listTags(user.client, user.userId)
    expect(tags.filter((t) => t.label === 'disinterest')).toHaveLength(1)
  })
})
