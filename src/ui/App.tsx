import { useEffect, useState } from 'react'
import { runBench, runBenchG2 } from '../app/bench'
import { startApp, type AppSession } from '../app/controller'
import { CommandLine } from './CommandLine'
import { StatusBar } from './StatusBar'
import './App.css'

export function App() {
  const [session, setSession] = useState<AppSession | null>(null)

  useEffect(() => {
    const canvas = document.getElementById('viewport')
    const overlay = document.getElementById('overlay')
    if (!(canvas instanceof HTMLCanvasElement) || !(overlay instanceof HTMLCanvasElement)) throw new Error('#viewport or #overlay not found')
    const params = new URLSearchParams(location.search)
    const raw = params.get('bench')
    const n = raw !== null && /^\d+$/.test(raw) ? Number(raw) : NaN
    if (n >= 1 && n <= 5_000_000) {
      if (params.get('gate') === 'g2') runBenchG2(canvas, n)
      else runBench(canvas, n)
      return
    }
    const s = startApp(canvas, overlay)
    setSession(s)
    return () => {
      s.dispose()
      setSession(null)
    }
  }, [])

  return (
    <>
      <canvas id="viewport" aria-label="Drawing viewport" />
      <canvas id="overlay" aria-hidden="true" />
      <header className="titlebar">Royale CAD</header>
      {session && <CommandLine store={session.commandLine} onToggleHistory={session.toggleHistory} />}
      {session && <StatusBar store={session.status} onToggle={session.toggle} />}
    </>
  )
}
