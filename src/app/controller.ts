import { fit, type ViewState } from '../kernel/view'
import { SEGMENT_STRIDE, writeSegment, writeStyle } from '../render/backend'
import { createWebGL2Backend } from '../render/webgl2/backend'

// Temporary demo scene (removed in T13): a triangle a few millimetres wide at UTM coordinates.
const A = { x: 7_400_000.001, y: 9_100_000.001 }
const B = { x: 7_400_000.005, y: 9_100_000.001 }
const C = { x: 7_400_000.003, y: 9_100_000.004 }

export function startApp(canvas: HTMLCanvasElement): () => void {
  const backend = createWebGL2Backend(canvas)

  const buf = new ArrayBuffer(3 * SEGMENT_STRIDE)
  const f32 = new Float32Array(buf)
  const u32 = new Uint32Array(buf)
  writeSegment(f32, u32, 0, A.x, A.y, B.x, B.y, 0)
  writeSegment(f32, u32, 1, B.x, B.y, C.x, C.y, 0)
  writeSegment(f32, u32, 2, C.x, C.y, A.x, A.y, 0)
  const batch = backend.createBatch('segment', 3)
  backend.writeBatch(batch, 0, f32)

  const styles = new Uint32Array(2)
  writeStyle(styles, 0, 0xf2f4f5ff, 1.5, true) // mirrors --draw in tokens.css
  backend.setStyleTable(styles)

  const bbox = { minX: A.x, minY: A.y, maxX: B.x, maxY: C.y }
  const render = (): void => {
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    const dpr = window.devicePixelRatio
    backend.resize(width, height, dpr)
    const view: ViewState = fit({ cx: 0, cy: 0, scale: 1, width, height, dpr }, bbox, 64)
    backend.frame(view, [{ batch, first: 0, count: 3 }])
  }

  const observer = new ResizeObserver(render)
  observer.observe(canvas)
  render()

  return () => {
    observer.disconnect()
    backend.dispose()
  }
}
