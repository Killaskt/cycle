import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { supabase } from './supabase'

// First-launch anonymous sign-in, upgradeable later via linkIdentity()
// (docs/adr/0003-anonymous-to-permanent-auth.md). Safe to call on every
// app start: if a session is already persisted (via `capacitorStorage`),
// it's reused as-is and no new anonymous user is created.
export async function initAuthSession(client: SupabaseClient = supabase): Promise<Session> {
  const { data: getSessionData, error: getSessionError } = await client.auth.getSession()
  if (getSessionError) throw getSessionError
  if (getSessionData.session) return getSessionData.session

  const { data: signInData, error: signInError } = await client.auth.signInAnonymously()
  if (signInError) throw signInError
  if (!signInData.session) {
    throw new Error('signInAnonymously() succeeded but returned no session')
  }
  return signInData.session
}
