import { createClient } from '@supabase/supabase-js'

const url = process.env.VITE_SUPABASE_URL
const anonKey = process.env.VITE_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  throw new Error('VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set')
}

const client = createClient(url, anonKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
})

const { data, error } = await client.auth.signInAnonymously({
  options: {
    data: { release_preflight: true },
  },
})

if (error) {
  throw new Error(`Hosted Supabase anonymous auth preflight failed: ${error.message}`)
}

if (!data.session?.user.is_anonymous) {
  throw new Error('Hosted Supabase anonymous auth preflight returned no anonymous session')
}

console.log('Hosted Supabase anonymous auth preflight passed')