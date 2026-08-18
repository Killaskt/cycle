import { useCallback, useEffect, useState } from 'react'
import * as Sentry from '@sentry/react'
import { initAuthSession } from './lib/auth'
import { supabase } from './lib/supabase'
import { Intake } from './screens/Intake'
import { Review } from './screens/Review'
import { System } from './screens/System'
import { Today } from './screens/Today'

type AppState =
  | { screen: 'loading' }
  | { screen: 'error'; message: string }
  | { screen: 'intake' }
  | { screen: 'system'; cycleId: string }
  | { screen: 'today'; cycleId: string }
  | { screen: 'review'; cycleId: string }

function App() {
  const [state, setState] = useState<AppState>({ screen: 'loading' })

  const loadCurrentCycle = useCallback(async () => {
    setState({ screen: 'loading' })
    try {
      await initAuthSession()
      const { data, error } = await supabase
        .from('cycles')
        .select('id, status')
        .in('status', ['draft', 'active'])
        .order('created_at', { ascending: false })
        .limit(1)

      if (error) throw error

      const cycle = data?.[0]
      if (!cycle) {
        setState({ screen: 'intake' })
      } else {
        setState(cycle.status === 'draft' ? { screen: 'system', cycleId: cycle.id } : { screen: 'today', cycleId: cycle.id })
      }
    } catch (err) {
      Sentry.captureException(err, {
        tags: { operation: 'load_current_cycle' },
      })
      setState({
        screen: 'error',
        message: err instanceof Error ? err.message : 'Unable to start Cycle.',
      })
    }
  }, [])

  useEffect(() => {
    loadCurrentCycle()
  }, [loadCurrentCycle])

  if (state.screen === 'loading') return <p>Loading Cycle...</p>
  if (state.screen === 'error') return <p role="alert">{state.message}</p>
  if (state.screen === 'intake') return <Intake onSubmitted={(cycleId) => setState({ screen: 'system', cycleId })} />
  if (state.screen === 'system') return <System cycleId={state.cycleId} onAccepted={(cycleId) => setState({ screen: 'today', cycleId })} />
  if (state.screen === 'today') return <Today cycleId={state.cycleId} onReview={(cycleId) => setState({ screen: 'review', cycleId })} />

  return <Review cycleId={state.cycleId} onClosed={() => loadCurrentCycle()} />
}

export default App
