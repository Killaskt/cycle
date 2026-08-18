import { describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import {
  SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL,
} from './localSupabase'

// Ticket 001 DoD: insert a row as user A (minted via service-role key),
// confirm a client authenticated as user B cannot read it.

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

  // persistSession: false — otherwise every client in this process shares
  // jsdom's single localStorage under the same default storage key, and
  // each sign-in clobbers the others' sessions (see the GoTrueClient
  // "Multiple GoTrueClient instances" warning). Each minted user needs its
  // own isolated in-memory session.
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { error: signInError } = await client.auth.signInWithPassword({ email, password })
  if (signInError) throw signInError

  return { userId: data.user.id, client }
}

describe('RLS: cross-user isolation', () => {
  it('user A can read their own cycle', async () => {
    const userA = await mintUser('rls-a-own')

    const { data: inserted, error: insertError } = await userA.client
      .from('cycles')
      .insert({ user_id: userA.userId, timeframe_days: 14, wake_time: '06:30' })
      .select()
      .single()
    expect(insertError).toBeNull()
    expect(inserted).toBeTruthy()

    const { data: rows, error: readError } = await userA.client
      .from('cycles')
      .select()
      .eq('id', inserted!.id)
    expect(readError).toBeNull()
    expect(rows).toHaveLength(1)
  })

  it('user B cannot read a cycle inserted by user A', async () => {
    const userA = await mintUser('rls-a')
    const userB = await mintUser('rls-b')

    const { data: cycle, error: insertError } = await userA.client
      .from('cycles')
      .insert({ user_id: userA.userId, timeframe_days: 14, wake_time: '06:30' })
      .select()
      .single()
    expect(insertError).toBeNull()
    expect(cycle).toBeTruthy()

    const { data: rows, error: readError } = await userB.client
      .from('cycles')
      .select()
      .eq('id', cycle!.id)

    // RLS filters rows rather than raising an error.
    expect(readError).toBeNull()
    expect(rows).toHaveLength(0)
  })

  it('user B cannot insert a cycle claiming to be user A', async () => {
    const userA = await mintUser('rls-a-spoof')
    const userB = await mintUser('rls-b-spoof')

    const { error: insertError } = await userB.client
      .from('cycles')
      .insert({ user_id: userA.userId, timeframe_days: 14, wake_time: '06:30' })
      .select()
      .single()

    // WITH CHECK (auth.uid() = user_id) should reject this.
    expect(insertError).not.toBeNull()
  })
})
