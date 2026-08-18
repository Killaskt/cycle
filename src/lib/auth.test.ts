import { createClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { capacitorStorage } from './capacitorStorage'
import { initAuthSession } from './auth'

// Integration test against the local Docker Supabase stack
// (.claude/skills/local-supabase-stack/SKILL.md) — no mocking of GoTrue.
// Requires `npx supabase start` to already be running, and
// `enable_anonymous_sign_ins = true` in supabase/config.toml.

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

function createTestClient() {
  return createClient(url, anonKey, {
    auth: {
      storage: capacitorStorage,
      autoRefreshToken: false,
      persistSession: true,
    },
  })
}

describe('initAuthSession (integration, local Supabase)', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('creates a new anonymous session when none exists', async () => {
    const client = createTestClient()

    const session = await initAuthSession(client)

    expect(session.user.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(session.user.is_anonymous).toBe(true)
  })

  it('reuses a persisted session on a later call instead of creating a new anonymous user', async () => {
    const client1 = createTestClient()
    const session1 = await initAuthSession(client1)

    // Simulate an app relaunch: a fresh client instance reading from the
    // same Preferences-backed storage that persisted the first session.
    const client2 = createTestClient()
    const signInSpy = vi.spyOn(client2.auth, 'signInAnonymously')

    const session2 = await initAuthSession(client2)

    expect(session2.user.id).toBe(session1.user.id)
    expect(signInSpy).not.toHaveBeenCalled()
  })
})
