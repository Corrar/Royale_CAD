import { createDocument, type Draft, type Tx } from '../kernel/document'
import type { Entity } from '../kernel/entity/types'
import type { Vec2 } from '../kernel/geom/vec'
import { pick } from '../kernel/pick'
import { createSpatialIndex } from '../kernel/spatial'
import { fit, type ViewState } from '../kernel/view'
import { createScene } from '../render/scene'
import { createWebGL2Backend } from '../render/webgl2/backend'
import { PICKBOX_PX } from './controller'
import { packRgba, readBackendTheme, readCssColor } from './theme'

const ORIGIN = { x: 7_400_000, y: 9_100_000 }
const SIZE = 2000
const BASELINE_FRAMES = 60
const WARMUP_FRAMES = 30
const MEASURED_FRAMES = 300

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

/** Median of the samples whose frame scale is >= 10x the base ('zoomedIn') or <= 1.5x ('allVisible'); 0 when none. */
export function regimeP50(
  samples: readonly number[], scales: readonly number[], baseScale: number, regime: 'zoomedIn' | 'allVisible',
): number {
  const picked = samples.filter((_, i) => {
    const ratio = scales[i]! / baseScale
    return regime === 'zoomedIn' ? ratio >= 10 : ratio <= 1.5
  })
  return picked.length === 0 ? 0 : percentile(sorted(picked), 0.5)
}

const ms = (x: number): number => (Number.isFinite(x) ? Math.round(x * 100) / 100 : 0)
const sorted = (xs: readonly number[]): number[] => [...xs].sort((a, b) => a - b)

const report = (result: object): void => console.log(`BENCH_RESULT ${JSON.stringify(result)}`)

function setupRender(canvas: HTMLCanvasElement) {
  const backend = createWebGL2Backend(canvas, readBackendTheme(canvas))
  const gl = canvas.getContext('webgl2')!
  const info = gl.getExtension('WEBGL_debug_renderer_info')
  const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'unknown'
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  const dpr = window.devicePixelRatio
  backend.resize(width, height, dpr)
  const base = fit(
    { cx: 0, cy: 0, scale: 1, width, height, dpr },
    { minX: ORIGIN.x, minY: ORIGIN.y, maxX: ORIGIN.x + SIZE, maxY: ORIGIN.y + SIZE },
    0,
  )
  const colors = { drawColor: packRgba(readCssColor(canvas, '--draw')), highlightColor: packRgba(readCssColor(canvas, '--accent')) }
  return { backend, gl, renderer, base, colors }
}

/** G1: frame time of n random segments through Document and Scene. Reports one BENCH_RESULT console line. */
export function runBench(canvas: HTMLCanvasElement, n: number): void {
  const { backend, gl, renderer, base, colors } = setupRender(canvas)
  const { dpr } = base

  const rand = mulberry32(1)
  const doc = createDocument()
  doc.transact('load', (tx) => {
    for (let i = 0; i < n; i++) {
      const x = ORIGIN.x + rand() * SIZE
      const y = ORIGIN.y + rand() * SIZE
      const len = 1 + rand() * 19
      const a = rand() * 2 * Math.PI
      tx.add({ type: 'line', layer: 0, x0: x, y0: y, x1: x + len * Math.cos(a), y1: y + len * Math.sin(a) })
    }
  })
  const scene = createScene(doc, backend, colors)
  // The rebuild (in slices on a scene this big) and the upload happen here, before any measured frame.
  do scene.draws(base)
  while (scene.building)

  const baseline: number[] = []
  const samples: number[] = []
  const intervals: number[] = []
  const scales: number[] = []
  let done = false
  const finish = (error?: string): void => {
    if (done) return
    done = true
    const s = sorted(samples)
    report({
      gate: 'g1', n, frames: samples.length, p50: ms(percentile(s, 0.5)), p95: ms(percentile(s, 0.95)), max: ms(s.at(-1) ?? 0),
      p50ZoomedIn: ms(regimeP50(samples, scales, base.scale, 'zoomedIn')), p50AllVisible: ms(regimeP50(samples, scales, base.scale, 'allVisible')),
      baselineP50: ms(percentile(sorted(baseline), 0.5)), intervalP95: ms(percentile(sorted(intervals), 0.95)), width: canvas.width, height: canvas.height, dpr, renderer,
      ...(error ? { error } : {}),
    })
  }

  // A hidden window stops requestAnimationFrame, so this event is the only way to notice.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') finish('window not visible')
  })

  // A GL error (e.g. OUT_OF_MEMORY on the big buffer) makes every draw fail fast and would pass the gate.
  const glError = (): string | undefined => {
    const code = gl.getError()
    return code === gl.NO_ERROR ? undefined : `gl error 0x${code.toString(16)}`
  }
  const sceneError = glError()
  if (sceneError) return finish(sceneError)

  const pixel = new Uint8Array(4)
  let k = 0
  let prev = 0
  const step = (): void => {
    if (done) return
    if (document.visibilityState !== 'visible') return finish('window not visible')
    const t0 = performance.now()
    const interval = t0 - prev
    prev = t0
    const m = k - BASELINE_FRAMES - WARMUP_FRAMES
    if (k < BASELINE_FRAMES) backend.frame(base, [])
    else {
      const view = benchView(Math.max(m, 0), MEASURED_FRAMES, base)
      backend.frame(view, scene.draws(view))
    }
    // Synchronous 1-pixel readback: returns only after the GPU ran the queued work. The sample includes the
    // scene's culling, that fixed readback cost (see baselineP50), and excludes window composition by Chromium and the OS.
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
    const cost = performance.now() - t0
    // With the context lost, frame returns early and readPixels does nothing: the samples would fall to ~0.
    if (gl.isContextLost()) return finish('webgl context lost')
    if (k < BASELINE_FRAMES) baseline.push(cost)
    else if (m >= 0) {
      samples.push(cost)
      intervals.push(interval)
      scales.push(benchView(m, MEASURED_FRAMES, base).scale)
      if (samples.length === MEASURED_FRAMES) return finish(glError())
    }
    k++
    requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

const REBUILD_ROUNDS = 5
const PICKS = 1000

/** A random entity of the G2 mix: 85% lines, 5% circles, 5% arcs, 5% polylines of 4 vertices, half with bulges. */
function g2Draft(rand: () => number): Draft {
  const x = ORIGIN.x + rand() * SIZE
  const y = ORIGIN.y + rand() * SIZE
  const k = rand()
  if (k < 0.85) return { type: 'line', layer: 0, x0: x, y0: y, x1: x + rand() * 20 - 10, y1: y + rand() * 20 - 10 }
  if (k < 0.9) return { type: 'circle', layer: 0, cx: x, cy: y, r: 0.5 + rand() * 10 }
  if (k < 0.95) return { type: 'arc', layer: 0, cx: x, cy: y, r: 0.5 + rand() * 10, a0: rand() * 6, a1: rand() * 6 }
  const pts = new Float64Array(8)
  for (let i = 0; i < 8; i += 2) {
    pts[i] = x + rand() * 10
    pts[i + 1] = y + rand() * 10
  }
  const bulges = rand() < 0.5 ? Float64Array.from({ length: 4 }, () => rand() - 0.5) : null
  return { type: 'polyline', layer: 0, pts, bulges, closed: rand() < 0.5 }
}

/** Where the pick bench aims at e (for an arc, its circle's 0° point, which may miss it). */
function onEntity(e: Entity): Vec2 {
  switch (e.type) {
    case 'line':
      return { x: e.x0, y: e.y0 }
    case 'polyline':
      return { x: e.pts[0]!, y: e.pts[1]! }
    case 'circle':
    case 'arc':
      return { x: e.cx + e.r, y: e.cy }
    case 'point':
      return { x: e.x, y: e.y }
    case 'opaque':
    case 'ellipse':
    case 'spline':
      throw new Error(`the bench makes no ${e.type} entities`)
  }
}

function shifted(e: Entity, d: number): Entity {
  switch (e.type) {
    case 'line':
      return { ...e, x0: e.x0 + d, x1: e.x1 + d }
    case 'circle':
    case 'arc':
      return { ...e, cx: e.cx + d }
    case 'polyline':
      return { ...e, pts: e.pts.map((v, i) => (i % 2 === 0 ? v + d : v)) }
    case 'point':
      return { ...e, x: e.x + d }
    case 'ellipse':
      return { ...e, cx: e.cx + d }
    case 'spline':
      return { ...e, ctrl: e.ctrl.map((v, i) => (i % 2 === 0 ? v + d : v)) }
    case 'opaque':
      return e
  }
}


/**
 * G2: n entities with the document, the spatial index and the scene alive. Index rebuild after edits (the one
 * met while drawing) and pick time at the full-extent view, where the pick box holds the most candidates. The
 * main process adds the memory, measured after a full collection: the JS heap and the ArrayBuffers apart.
 */
export function runBenchG2(canvas: HTMLCanvasElement, n: number): void {
  const { backend, renderer, base, colors } = setupRender(canvas)
  const rand = mulberry32(2)
  const doc = createDocument()
  const index = createSpatialIndex(doc)
  const scene = createScene(doc, backend, colors)
  const time = (fn: () => void): number => {
    const t0 = performance.now()
    fn()
    return performance.now() - t0
  }
  const nowhere = { minX: 0, minY: 0, maxX: 0, maxY: 0 }

  const loadMs = time(() => doc.transact('load', (tx: Tx) => {
    for (let i = 0; i < n; i++) tx.add(g2Draft(rand))
  }))
  const sceneMs = time(() => {
    do scene.draws(base)
    while (scene.building)
  })
  // A tree this big is built in steps (between frames, in the app): here all at once, timed.
  const coldBuildMs = time(() => {
    do index.build(() => true)
    while (index.building)
  })

  // Each round moves 2% of the drawing: past the dirty limit, so the next query rebuilds by merging.
  const ids = Array.from(doc.entities(), (e) => e.id)
  const rebuilds: number[] = []
  for (let round = 0; round <= REBUILD_ROUNDS; round++) {
    doc.transact('move', (tx) => {
      for (let i = 0; i < n / 50; i++) tx.replace(shifted(doc.get(ids[Math.floor(rand() * ids.length)]!)!, 0.5))
    })
    const ms = time(() => index.query(nowhere))
    if (round > 0) rebuilds.push(ms) // round 0 warms the merge path up
  }

  const tol = PICKBOX_PX / base.scale
  const picks: number[] = []
  let hits = 0
  for (let i = 0; i < PICKS; i++) {
    const e = doc.get(ids[Math.floor(rand() * ids.length)]!)!
    const p = onEntity(e)
    let id: number | null = null
    picks.push(time(() => (id = pick(doc, index, { x: p.x + tol / 2, y: p.y }, tol))))
    if (id !== null) hits++
  }
  const r = sorted(rebuilds)
  const pk = sorted(picks)
  // Kept alive after the report, so the main process measures the heap that holds them. A global: the minifier
  // drops a module variable that is never read, and the collector then frees everything.
  ;(globalThis as Record<string, unknown>).g2Retained = [doc, index, scene]
  report({
    gate: 'g2', n,
    loadMs: ms(loadMs), sceneMs: ms(sceneMs), coldBuildMs: ms(coldBuildMs),
    rebuildP50Ms: ms(percentile(r, 0.5)), rebuildMaxMs: ms(r.at(-1)!), coldBuilds: index.coldBuilds, indexRebuilds: index.rebuilds,
    pickP50Ms: ms(percentile(pk, 0.5)), pickP95Ms: Math.round(percentile(pk, 0.95) * 1000) / 1000, pickMaxMs: ms(pk.at(-1)!), pickHits: hits,
    renderer,
  })
}
