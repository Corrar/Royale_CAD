import { createDocument, docExtents, type Document } from '../kernel/document'
import { pick } from '../kernel/pick'
import { createSelection } from '../kernel/selection'
import { createSpatialIndex } from '../kernel/spatial'
import { FIT_MARGIN_PX, fit, screenToWorld, type ViewState } from '../kernel/view'
import { createScene } from '../render/scene'
import { createWebGL2Backend } from '../render/webgl2/backend'
import { attachInput } from './input'
import { packRgba, readBackendTheme, readCssColor } from './theme'

/** Half side of the pick box, CSS px. */
export const PICKBOX_PX = 5

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
  const scene = createScene(doc, backend, {
    drawColor: packRgba(readCssColor(canvas, '--draw')),
    highlightColor: packRgba(readCssColor(canvas, '--accent')),
  })
  const index = createSpatialIndex(doc)
  const selection = createSelection()

  let view: ViewState | null = null
  const loop = createFrameLoop(
    (cb) => requestAnimationFrame(cb),
    () => {
      if (view) backend.frame(view, scene.draws(view))
    },
  )
  const offDoc = doc.onChange((c) => {
    if (c.removed.length > 0) selection.remove(c.removed.map((e) => e.id))
    loop.invalidate()
  })
  const offLayers = doc.layers.onChange(() => loop.invalidate())
  const offRestore = backend.onRestore(() => loop.invalidate())
  const offSelection = selection.onChange(() => {
    scene.setHighlight(selection.ids)
    loop.invalidate()
  })
  // Temporary until the input router (T19) owns the keyboard.
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') selection.clear()
  }
  window.addEventListener('keydown', onKey)

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
    pick: (sx, sy, shift) => {
      const v = view!
      const id = pick(doc, index, screenToWorld(v, sx, sy), PICKBOX_PX / v.scale)
      if (id === null) return
      if (shift) selection.remove([id])
      else selection.add([id])
    },
  })

  return () => {
    view = null // a frame still pending must not draw on a disposed backend
    detachInput()
    observer.disconnect()
    window.removeEventListener('keydown', onKey)
    offDoc()
    offLayers()
    offRestore()
    offSelection()
    index.dispose()
    scene.dispose()
    backend.dispose()
  }
}
