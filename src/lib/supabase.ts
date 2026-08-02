import { createClient } from '@supabase/supabase-js'
import { capacitorStorage } from './capacitorStorage'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  throw new Error(
    'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set — see .env.example. ' +
      'Local dev/test values come from `supabase start` output, never the hosted project (docs/adr/0002).',
  )
}

export const supabase = createClient(url, anonKey, {
  auth: {
    storage: capacitorStorage,
    autoRefreshToken: true,
    persistSession: true,
  },
})
