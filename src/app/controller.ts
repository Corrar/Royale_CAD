import { createDocument, docExtents, type Document } from '../kernel/document'
import { fit, type ViewState } from '../kernel/view'
import { createScene } from '../render/scene'
import { createWebGL2Backend } from '../render/webgl2/backend'
import { attachInput, FIT_MARGIN_PX } from './input'
import { packRgba, readBackendTheme, readCssColor } from './theme'

/** What an empty drawing frames: an A3 sheet in millimetres, like AutoCAD's metric limits. */
const DEFAULT_EXTENTS = { minX: 0, minY: 0, maxX: 420, maxY: 297 }

// Temporary demo drawing until the command line can draw (T19): shapes a few millimetres wide at UTM coordinates.
function seedDemo(doc: Document): void {
  const a = { x: 7_400_000.001, y: 9_100_000.001 }
  const b = { x: 7_400_000.005, y: 9_100_000.001 }
  const c = { x: 7_400_000.003, y: 9_100_000.004 }
  doc.transact('demo', (tx) => {
    for (const [p, q] of [[a, b], [b, c], [c, a]] as const) tx.add({ type: 'line', layer: 0, x0: p.x, y0: p.y, x1: q.x, y1: q.y })
    tx.add({ type: 'circle', layer: 0, cx: 7_400_000.003, cy: 9_100_000.0025, r: 0.0015 })
    tx.add({ type: 'arc', layer: 0, cx: a.x, cy: a.y, r: 0.002, a0: 0, a1: Math.PI / 2 })
    tx.add({ type: 'arc', layer: 0, cx: b.x, cy: b.y, r: 0.002, a0: Math.PI / 2, a1: Math.PI })
  })
}

export function createFrameLoop(
  requestFrame: (cb: () => void) => void,
  draw: () => void,
): { invalidate(): void; flush(): void } {
  let dirty = false
  let scheduled = false
  const run = (): void => {
    scheduled = false
    flush()
  }
  const flush = (): void => {
    if (!dirty) return
    dirty = false
    draw()
  }
  return {
    invalidate() {
      dirty = true
      if (scheduled) return
      scheduled = true
      requestFrame(run)
    },
    flush,
  }
}

export function startApp(canvas: HTMLCanvasElement): () => void {
  const backend = createWebGL2Backend(canvas, readBackendTheme(canvas))
  const doc = createDocument()
  seedDemo(doc)
  const scene = createScene(doc, backend, { drawColor: packRgba(readCssColor(canvas, '--draw')) })

  let view: ViewState | null = null
  const loop = createFrameLoop(
    (cb) => requestAnimationFrame(cb),
    () => {
      if (view) backend.frame(view, scene.draws(view))
    },
  )
  const offDoc = doc.onChange(() => loop.invalidate())
  const offLayers = doc.layers.onChange(() => loop.invalidate())

  const measure = (entries?: ResizeObserverEntry[]): void => {
    const dpr = window.devicePixelRatio
    // The device-pixel box is exact; clientWidth is an integer and is off by 1 px at fractional scales.
    const box = entries?.[0]?.devicePixelContentBoxSize?.[0]
    const width = box ? box.inlineSize / dpr : canvas.clientWidth
    const height = box ? box.blockSize / dpr : canvas.clientHeight
    backend.resize(width, height, dpr)
    view = view
      ? { ...view, width, height, dpr }
      : fit({ cx: 0, cy: 0, scale: 1, width, height, dpr }, docExtents(doc) ?? DEFAULT_EXTENTS, FIT_MARGIN_PX)
    // Resizing the buffer clears the canvas, so draw in the same task or it flashes.
    loop.invalidate()
    loop.flush()
  }
  const observer = new ResizeObserver((entries) => measure(entries))
  observer.observe(canvas, { box: 'device-pixel-content-box' })
  measure()

  const detachInput = attachInput(canvas, {
    getView: () => view!,
    setView: (v) => {
      view = v
      loop.invalidate()
    },
    extents: () => docExtents(doc),
  })

  return () => {
    view = null // a frame still pending must not draw on a disposed backend
    detachInput()
    observer.disconnect()
    offDoc()
    offLayers()
    scene.dispose()
    backend.dispose()
  }
}
