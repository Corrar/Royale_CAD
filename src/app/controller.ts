import { fit, type ViewState } from '../kernel/view'
import { ARC_STRIDE, SEGMENT_STRIDE, arcSubdiv, writeArc, writeSegment, writeStyle } from '../render/backend'
import { createWebGL2Backend } from '../render/webgl2/backend'
import { attachInput, FIT_MARGIN_PX } from './input'
import { packRgba, readBackendTheme, readCssColor } from './theme'

// Temporary demo scene (removed in T13): a triangle a few millimetres wide at UTM coordinates.
const A = { x: 7_400_000.001, y: 9_100_000.001 }
const B = { x: 7_400_000.005, y: 9_100_000.001 }
const C = { x: 7_400_000.003, y: 9_100_000.004 }

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

  const buf = new ArrayBuffer(3 * SEGMENT_STRIDE)
  const f32 = new Float32Array(buf)
  const u32 = new Uint32Array(buf)
  writeSegment(f32, u32, 0, A.x, A.y, B.x, B.y, 0)
  writeSegment(f32, u32, 1, B.x, B.y, C.x, C.y, 0)
  writeSegment(f32, u32, 2, C.x, C.y, A.x, A.y, 0)
  const batch = backend.createBatch('segment', 3)
  backend.writeBatch(batch, 0, f32)

  const arcBuf = new ArrayBuffer(3 * ARC_STRIDE)
  const af32 = new Float32Array(arcBuf)
  const au32 = new Uint32Array(arcBuf)
  writeArc(af32, au32, 0, 7_400_000.003, 9_100_000.0025, 0.0015, 0, 2 * Math.PI, 0)
  writeArc(af32, au32, 1, A.x, A.y, 0.002, 0, Math.PI / 2, 0)
  writeArc(af32, au32, 2, B.x, B.y, 0.002, Math.PI, -Math.PI / 2, 0)
  const arcs = backend.createBatch('arc', 3)
  backend.writeBatch(arcs, 0, af32)

  const styles = new Uint32Array(2)
  writeStyle(styles, 0, packRgba(readCssColor(canvas, '--draw')), 1.5, true)
  backend.setStyleTable(styles)

  const bbox = { minX: A.x, minY: A.y, maxX: B.x, maxY: C.y }
  let view: ViewState | null = null
  const loop = createFrameLoop(
    (cb) => requestAnimationFrame(cb),
    () => {
      if (view) {
        const subdiv = arcSubdiv(0.002 * view.scale * view.dpr) // largest radius in the batch, device px
        backend.frame(view, [{ batch, first: 0, count: 3 }, { batch: arcs, first: 0, count: 3, subdiv }])
      }
    },
  )

  const measure = (entries?: ResizeObserverEntry[]): void => {
    const dpr = window.devicePixelRatio
    // The device-pixel box is exact; clientWidth is an integer and is off by 1 px at fractional scales.
    const box = entries?.[0]?.devicePixelContentBoxSize?.[0]
    const width = box ? box.inlineSize / dpr : canvas.clientWidth
    const height = box ? box.blockSize / dpr : canvas.clientHeight
    backend.resize(width, height, dpr)
    view = view ? { ...view, width, height, dpr } : fit({ cx: 0, cy: 0, scale: 1, width, height, dpr }, bbox, FIT_MARGIN_PX)
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
    extents: () => bbox,
  })

  return () => {
    view = null // a frame still pending must not draw on a disposed backend
    detachInput()
    observer.disconnect()
    backend.dispose()
  }
}
