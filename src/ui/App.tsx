import { useEffect, useState } from 'react'
import { runBench, runBenchG2 } from '../app/bench'
import { startApp, type AppSession } from '../app/controller'
import { GLYPH_CAP_PX, textFont } from '../app/glyph-raster'
import { CommandLine } from './CommandLine'
import { LayerPanel } from './LayerPanel'
import { StatusBar } from './StatusBar'
import { TitleBar } from './TitleBar'
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
    // Text is drawn in the bundled Inter: start once it has loaded (or failed to), so no glyph is drawn in a fallback.
    let s: AppSession | null = null
    let gone = false
    void document.fonts.load(textFont(GLYPH_CAP_PX)).catch(() => []).then(() => {
      if (gone) return
      s = startApp(canvas, overlay)
      setSession(s)
    })
    return () => {
      gone = true
      s?.dispose()
      setSession(null)
    }
  }, [])

  return (
    <>
      <canvas id="viewport" aria-label="Drawing viewport" />
      <canvas id="overlay" aria-hidden="true" />
      {session?.file ? <TitleBar store={session.file} /> : <header className="titlebar">Royale CAD</header>}
      {session && <CommandLine store={session.commandLine} onToggleHistory={session.toggleHistory} />}
      {session && <StatusBar store={session.status} onToggle={session.toggle} />}
      {session && <LayerPanel store={session.layers} actions={session.layerActions} />}
    </>
  )
}
