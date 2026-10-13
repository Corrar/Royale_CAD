import { fit, type ViewState } from '../kernel/view'
import { SEGMENT_STRIDE, writeSegment, writeStyle } from '../render/backend'
import { createWebGL2Backend } from '../render/webgl2/backend'

const ORIGIN = { x: 7_400_000, y: 9_100_000 }
const SIZE = 2000
const BASELINE_FRAMES = 60
const WARMUP_FRAMES = 30
const MEASURED_FRAMES = 300
// Above this the frame-rate limit is still on (the display is 120 Hz, so vsync would give ~8.3 ms).
const BASELINE_LIMIT_MS = 5

/** `sorted` ascending, p in [0, 1], linear interpolation between ranks. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN
  const rank = p * (sorted.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.min(lo + 1, sorted.length - 1)
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo)
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Frame i of a zoom from the base framing to 20x and back, with a circular pan. */
export function benchView(i: number, frames: number, base: ViewState): ViewState {
  const zoom = 20 ** (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / frames))
  const pan = (4 * Math.PI * i) / frames
  return {
    ...base,
    scale: base.scale * zoom,
    cx: ORIGIN.x + SIZE / 2 + 600 * Math.cos(pan),
    cy: ORIGIN.y + SIZE / 2 + 600 * Math.sin(pan),
  }
}

const ms = (x: number): number => (Number.isFinite(x) ? Math.round(x * 100) / 100 : 0)
const sorted = (xs: readonly number[]): number[] => [...xs].sort((a, b) => a - b)

/** Reports through one console line starting with BENCH_RESULT; the main process parses it. */
export function runBench(canvas: HTMLCanvasElement, n: number): void {
  const backend = createWebGL2Backend(canvas)
  const gl = canvas.getContext('webgl2')!
  const info = gl.getExtension('WEBGL_debug_renderer_info')
  const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'unknown'

  const width = canvas.clientWidth
  const height = canvas.clientHeight
  const dpr = window.devicePixelRatio
  backend.resize(width, height, dpr)

  const rand = mulberry32(1)
  const buf = new ArrayBuffer(n * SEGMENT_STRIDE)
  const f32 = new Float32Array(buf)
  const u32 = new Uint32Array(buf)
  for (let i = 0; i < n; i++) {
    const x = ORIGIN.x + rand() * SIZE
    const y = ORIGIN.y + rand() * SIZE
    const len = 1 + rand() * 19
    const a = rand() * 2 * Math.PI
    writeSegment(f32, u32, i, x, y, x + len * Math.cos(a), y + len * Math.sin(a), 0)
  }
  const batch = backend.createBatch('segment', n)
  backend.writeBatch(batch, 0, f32)
  const styles = new Uint32Array(2)
  writeStyle(styles, 0, 0xf2f4f5ff, 1, true)
  backend.setStyleTable(styles)

  const base = fit(
    { cx: 0, cy: 0, scale: 1, width, height, dpr },
    { minX: ORIGIN.x, minY: ORIGIN.y, maxX: ORIGIN.x + SIZE, maxY: ORIGIN.y + SIZE },
    0,
  )
  const draws = [{ batch, first: 0, count: n }]

  const baseline: number[] = []
  const samples: number[] = []
  let done = false
  const report = (error?: string): void => {
    if (done) return
    done = true
    const s = sorted(samples)
    const result = {
      n, frames: samples.length, p50: ms(percentile(s, 0.5)), p95: ms(percentile(s, 0.95)), max: ms(s.at(-1) ?? 0),
      baselineP50: ms(percentile(sorted(baseline), 0.5)), width: canvas.width, height: canvas.height, dpr, renderer,
      ...(error ? { error } : {}),
    }
    console.log(`BENCH_RESULT ${JSON.stringify(result)}`)
  }

  // A hidden window stops requestAnimationFrame, so this event is the only way to notice.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') report('window not visible')
  })

  let k = 0
  let prev = 0
  const step = (): void => {
    if (done) return
    if (document.visibilityState !== 'visible') return report('window not visible')
    const t = performance.now()
    const dt = t - prev
    prev = t
    if (k < BASELINE_FRAMES) {
      if (k > 0) baseline.push(dt)
      backend.frame(base, [])
    } else {
      if (k === BASELINE_FRAMES && percentile(sorted(baseline), 0.5) > BASELINE_LIMIT_MS) {
        return report('frame rate limit still on')
      }
      const m = k - BASELINE_FRAMES - WARMUP_FRAMES
      if (m >= 0) samples.push(dt)
      backend.frame(benchView(Math.max(m, 0), MEASURED_FRAMES, base), draws)
      if (samples.length === MEASURED_FRAMES) return report()
    }
    k++
    requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}
