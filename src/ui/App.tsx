import { useEffect } from 'react'
import { startApp } from '../app/controller'
import './App.css'

export function App() {
  useEffect(() => {
    const canvas = document.getElementById('viewport')
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('#viewport not found')
    return startApp(canvas)
  }, [])

  return (
    <>
      <canvas id="viewport" aria-label="Drawing viewport" />
      <header className="titlebar">Royale CAD</header>
    </>
  )
}
