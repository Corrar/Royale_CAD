import { useEffect } from 'react'
import { runBench } from '../app/bench'
import { startApp } from '../app/controller'
import './App.css'

export function App() {
  useEffect(() => {
    const canvas = document.getElementById('viewport')
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('#viewport not found')
    const raw = new URLSearchParams(location.search).get('bench')
    const n = raw !== null && /^\d+$/.test(raw) ? Number(raw) : NaN
    if (n >= 1 && n <= 5_000_000) {
      runBench(canvas, n)
      return
    }
    return startApp(canvas)
  }, [])

  return (
    <>
      <canvas id="viewport" aria-label="Drawing viewport" />
      <header className="titlebar">Royale CAD</header>
    </>
  )
}
