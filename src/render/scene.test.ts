import { describe, expect, it, vi } from 'vitest'
import { colorRgb, trueColor } from '../kernel/color'
import { createDocument, type Document, type Draft } from '../kernel/document'
import { typeOf } from '../kernel/entity/registry'
import { BY_BLOCK, type Block, type Ellipse, type Entity } from '../kernel/entity/types'
import { segmentDistance } from '../kernel/geom/vec'
import type { ViewState } from '../kernel/view'
import { ARC_STRIDE, GLYPH_STRIDE, SEGMENT_STRIDE, STYLE_WORDS, TRI_STRIDE, arcSubdiv, type Draw, type RenderBackend } from './backend'
import { createScene } from './scene'

const DRAW = 0xf2f4f5ff
const HIGHLIGHT = 0x67e8f9ff
// Rebuilds all at once unless a test asks for slices.
const OPTS = { drawColor: DRAW, highlightColor: HIGHLIGHT, sliceFrom: Infinity }

type Kind = 'segment' | 'arc' | 'glyph' | 'tri'
interface FakeBatch { kind: Kind; capacity: number; bytes: Uint8Array }
const STRIDE: Record<Kind, number> = { segment: SEGMENT_STRIDE, arc: ARC_STRIDE, glyph: GLYPH_STRIDE, tri: TRI_STRIDE }
const strideOf = (k: Kind): number => STRIDE[k]

/** Keeps every batch's bytes like the GPU would, and logs the calls. */
function fakeBackend() {
  const batches = new Map<number, FakeBatch>()
  const log: string[] = []
  const writes: { batch: number; first: number; count: number }[] = []
  let styles = new Uint32Array(0)
  let next = 1
  const restoreListeners = new Set<() => void>()
  const backend: RenderBackend = {
    createBatch(kind, capacity) {
      const id = next++
      batches.set(id, { kind, capacity, bytes: new Uint8Array(capacity * strideOf(kind)) })
      log.push('create')
      return id
    },
    writeBatch(id, first, view) {
      const b = batches.get(id)
      if (!b) throw new Error(`unknown batch ${id}`)
      const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
      const s = strideOf(b.kind)
      if (bytes.length % s !== 0 || first < 0 || first + bytes.length / s > b.capacity) throw new RangeError('bad write')
      b.bytes.set(bytes, first * s)
      writes.push({ batch: id, first, count: bytes.length / s })
      log.push('write')
    },
    destroyBatch(id) {
      if (!batches.delete(id)) throw new Error(`unknown batch ${id}`)
      log.push('destroy')
    },
    setStyleTable(t) {
      styles = t.slice()
      log.push('styles')
    },
    frame() {},
    resize() {},
    setGrid() {},
    setGlyphs() {
      log.push('glyphs')
    },
    onRestore(fn) {
      restoreListeners.add(fn)
      return () => restoreListeners.delete(fn)
    },
  }
  /** What a context loss and restore do: every batch comes back zeroed, then the listeners run. */
  const restore = (): void => {
    for (const b of batches.values()) b.bytes.fill(0)
    for (const fn of [...restoreListeners]) fn()
  }
  return { backend, batches, log, writes, styles: () => styles, restore, restoreListeners }
}

interface Instance { kind: Kind; v: number[]; style: number }

function decode(b: FakeBatch, first = 0, count = b.capacity): Instance[] {
  const f32 = new Float32Array(b.bytes.buffer)
  const u32 = new Uint32Array(b.bytes.buffer)
  const words = strideOf(b.kind) / 4
  const out: Instance[] = []
  for (let i = first; i < first + count; i++) {
    const w = i * words
    const hilo = (k: number): number => f32[w + k]! + f32[w + k + 1]!
    out.push(
      b.kind === 'segment'
        ? { kind: 'segment', v: [hilo(0), hilo(2), hilo(4), hilo(6)], style: u32[w + 8]! }
        : b.kind === 'arc'
          ? { kind: 'arc', v: [hilo(0), hilo(2), f32[w + 4]!, f32[w + 5]!, f32[w + 6]!], style: u32[w + 7]! }
          : b.kind === 'tri'
            ? { kind: 'tri', v: [hilo(0), hilo(2), hilo(4), hilo(6), hilo(8), hilo(10)], style: u32[w + 12]! }
            : { kind: 'glyph', v: [hilo(0), hilo(2), f32[w + 4]!, f32[w + 5]!, f32[w + 6]!, f32[w + 7]!, u32[w + 8]!], style: u32[w + 9]! },
    )
  }
  return out
}

const drawn = (f: ReturnType<typeof fakeBackend>, draws: readonly Draw[]): Instance[] =>
  draws.flatMap((d) => decode(f.batches.get(d.batch)!, d.first, d.count)).filter((i) => i.style !== 0)

const view = (cx: number, cy: number, scale: number, width = 800, height = 600): ViewState => ({ cx, cy, scale, width, height, dpr: 1 })
const FAR = view(-1e9, -1e9, 1e-3) // sees nothing of the test data, so nothing gets clipped

const line = (x0: number, y0: number, x1: number, y1: number, extra: Partial<Draft> = {}): Draft =>
  ({ type: 'line', layer: 0, x0, y0, x1, y1, ...extra }) as Draft
/** A SOLID by its corners in DXF order. */
const solid = (c: readonly number[], extra: Partial<Draft> = {}): Draft =>
  ({ type: 'solid', layer: 0, x0: c[0]!, y0: c[1]!, x1: c[2]!, y1: c[3]!, x2: c[4]!, y2: c[5]!, x3: c[6]!, y3: c[7]!, ...extra }) as Draft

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function setup(doc: Document = createDocument(), sliceFrom = Infinity) {
  const f = fakeBackend()
  const scene = createScene(doc, f.backend, { ...OPTS, sliceFrom })
  return { doc, f, scene }
}

describe('createScene', () => {
  it('rebuilds a big drawing in slices: the old draws stay until the new pools are whole', () => {
    const { doc, f, scene } = setup(createDocument(), 20_000)
    doc.transact('small', (tx) => void tx.add(line(0, 0, 1, 1)))
    const all = view(500, 500, 0.5, 2000, 2000)
    expect(drawn(f, scene.draws(all))).toHaveLength(1)
    const rand = rng(3)
    doc.append(Array.from({ length: 120_000 }, () => line(rand() * 1000, rand() * 1000, rand() * 1000, rand() * 1000)))
    let frames = 0
    let first: Instance[] | null = null
    do {
      const d = scene.draws(all)
      first ??= drawn(f, d)
      frames++
    } while (scene.building)
    expect(frames).toBeGreaterThan(1)
    expect(first).toHaveLength(1) // the drawing as it was, while the rebuild ran
    expect(drawn(f, scene.draws(all))).toHaveLength(120_001)
  })

  it('a change during a sliced rebuild drops it, with its batches, and a new one begins', () => {
    const { doc, f, scene } = setup(createDocument(), 20_000)
    const rand = rng(5)
    doc.append(Array.from({ length: 110_000 }, () => line(rand() * 1000, rand() * 1000, rand() * 1000, rand() * 1000)))
    const all = view(500, 500, 0.5, 2000, 2000)
    // Slices until the rebuild has made some batches.
    do scene.draws(all)
    while (scene.building && f.batches.size === 0)
    const made = f.batches.size
    doc.transact('add', (tx) => void tx.add(line(0, 0, 2, 2)))
    expect(made).toBeGreaterThan(0)
    expect(f.batches.size).toBe(0) // nothing was drawn before; the dropped rebuild left no batch
    expect(scene.building).toBe(true) // the caller keeps the frames coming for the next one
    do scene.draws(all)
    while (scene.building)
    expect(drawn(f, scene.draws(all))).toHaveLength(110_001)
  })

  it('build() carries a sliced rebuild without frames: it begins on a call without changes', () => {
    const { doc, f, scene } = setup(createDocument(), 20_000)
    const rand = rng(11)
    doc.append(Array.from({ length: 100_000 }, () => line(rand() * 1000, rand() * 1000, rand() * 1000, rand() * 1000)))
    scene.build(8)
    expect(f.log).not.toContain('create') // the change came since the last call: not yet
    let calls = 0
    while (scene.building) {
      scene.build(8)
      calls++
    }
    expect(calls).toBeGreaterThan(1)
    expect(drawn(f, scene.draws(view(500, 500, 0.5, 2000, 2000)))).toHaveLength(100_000)
  })

  it('the slices of a file (Document.append) skip the open pools and wait for one rebuild', () => {
    const { doc, f, scene } = setup(createDocument(), 1)
    const rand = rng(9)
    const all = view(500, 500, 0.5, 2000, 2000)
    const now = vi.spyOn(performance, 'now').mockReturnValue(0)
    try {
      for (let k = 0; k < 3; k++) {
        doc.append(Array.from({ length: 512 }, () => line(rand() * 1000, rand() * 1000, rand() * 1000, rand() * 1000)))
        expect(drawn(f, scene.draws(all))).toEqual([])
      }
      expect(f.log).not.toContain('create')
      expect(drawn(f, scene.draws(all))).toHaveLength(3 * 512)
    } finally {
      now.mockRestore()
    }
  })

  it('a sliced rebuild waits for a frame without changes: a file read in slices makes no batch to drop', () => {
    const { doc, f, scene } = setup(createDocument(), 20_000)
    const rand = rng(7)
    const lines = (n: number): Draft[] => Array.from({ length: n }, () => line(rand() * 1000, rand() * 1000, rand() * 1000, rand() * 1000))
    doc.append(lines(100_000))
    const all = view(500, 500, 0.5, 2000, 2000)
    // The clock stands still: a rebuild that begins ends in the same frame, batches and all.
    const now = vi.spyOn(performance, 'now').mockReturnValue(0)
    try {
      for (let k = 0; k < 5; k++) {
        doc.append(lines(512))
        scene.draws(all)
        expect(scene.building).toBe(true)
      }
      expect(f.log).not.toContain('create')
      scene.draws(all) // the first frame without a change
      expect(scene.building).toBe(false)
    } finally {
      now.mockRestore()
    }
    expect(drawn(f, scene.draws(all))).toHaveLength(100_000 + 5 * 512)
  })

  it('adding one entity is one write', () => {
    const { doc, f, scene } = setup()
    scene.draws(FAR)
    f.writes.length = 0
    doc.transact('add', (tx) => void tx.add(line(0, 0, 1, 1)))
    scene.draws(FAR)
    expect(f.writes).toHaveLength(1)
    expect(f.writes[0]!.count).toBe(1)
  })

  it('a bulk load writes each batch once', () => {
    const { doc, f, scene } = setup()
    const rand = rng(1)
    doc.transact('load', (tx) => {
      for (let i = 0; i < 30_000; i++) tx.add(line(rand() * 100, rand() * 100, rand() * 100, rand() * 100))
      for (let i = 0; i < 3000; i++) tx.add({ type: 'circle', layer: 0, cx: rand() * 100, cy: rand() * 100, r: 0.5 + rand() * 30 })
    })
    scene.draws(FAR)
    const creates = f.log.filter((x) => x === 'create').length
    expect(f.writes).toHaveLength(creates)
    expect(creates).toBeLessThan(10)
  })

  it('removing an entity hides its slot with styleId 0, and the next add reuses the slot', () => {
    const { doc, f, scene } = setup()
    let a!: Entity
    doc.transact('a', (tx) => {
      tx.add(line(5, 5, 6, 6))
      a = tx.add(line(0, 0, 1, 1))
    })
    scene.draws(FAR)
    const slotOfA = f.writes.at(-1)!.first + 1
    f.writes.length = 0
    doc.transact('erase', (tx) => tx.remove(a.id))
    scene.draws(FAR)
    expect(f.writes).toHaveLength(1)
    expect(f.writes[0]!.first).toBe(slotOfA)
    const batch = f.batches.get(f.writes[0]!.batch)!
    expect(decode(batch, slotOfA, 1)[0]!.style).toBe(0)
    f.writes.length = 0
    doc.transact('b', (tx) => void tx.add(line(2, 2, 3, 3)))
    scene.draws(FAR)
    expect(f.writes.map((w) => w.first)).toEqual([slotOfA])
    expect(decode(batch, slotOfA, 1)[0]!.v).toEqual([2, 2, 3, 3])
  })

  it('changing a layer color or visibility only re-uploads the style table', () => {
    const { doc, f, scene } = setup()
    doc.transact('a', (tx) => void tx.add(line(0, 0, 1, 1)))
    const draws = scene.draws(view(0.5, 0.5, 100))
    const style = drawn(f, draws)[0]!.style
    const row = (): [number, number] => [f.styles()[style * STYLE_WORDS]!, f.styles()[style * STYLE_WORDS + 1]!]
    expect(row()[0]).toBe(DRAW)
    f.log.length = 0
    doc.layers.update(0, { color: 1 })
    scene.draws(view(0.5, 0.5, 100))
    expect(f.log).toEqual(['styles'])
    expect(row()[0]).toBe(0xff0000ff)
    expect(row()[1] >> 16).toBe(1)
    doc.layers.update(0, { visible: false })
    scene.draws(view(0.5, 0.5, 100))
    expect(row()[1] >> 16).toBe(0)
    expect(f.log).toEqual(['styles', 'styles'])
  })

  it('an entity color overrides its layer; ACI 7 takes the drawing color', () => {
    const { doc, f, scene } = setup()
    doc.layers.add({ name: 'Red', color: 1, visible: true, locked: false })
    doc.transact('a', (tx) => {
      tx.add(line(0, 0, 1, 0))
      tx.add(line(0, 1, 1, 1, { layer: 1 }))
      tx.add(line(0, 2, 1, 2, { layer: 1, color: trueColor(0x12, 0x34, 0x56) }))
      tx.add(line(0, 3, 1, 3, { layer: 1, color: 7 }))
    })
    const colors = drawn(f, scene.draws(view(0.5, 1.5, 100)))
      .sort((p, q) => p.v[1]! - q.v[1]!)
      .map((i) => f.styles()[i.style * STYLE_WORDS])
    expect(colors).toEqual([DRAW, 0xff0000ff, 0x123456ff, DRAW])
  })

  it('a rebuild frees the style rows of colors no longer in use', () => {
    const { doc, f, scene } = setup()
    doc.transact('load', (tx) => {
      for (let i = 0; i < 20_000; i++) tx.add(line(i, 0, i, 1, { color: trueColor(i & 255, (i >> 8) & 255, 7) }))
    })
    scene.draws(FAR)
    expect(f.styles().length / STYLE_WORDS).toBe(20_002)
    doc.transact('erase', (tx) => {
      for (const e of [...doc.entities()]) tx.remove(e.id)
    })
    doc.transact('reload', (tx) => {
      for (let i = 0; i < 20_000; i++) tx.add(line(i, 0, i, 1))
    })
    const draws = scene.draws(view(10_000, 0, 0.03)) // 800 px cover 26 667 units
    expect(f.styles().length / STYLE_WORDS).toBe(3) // hidden, highlight, layer 0 by layer
    expect(drawn(f, draws)).toHaveLength(20_000)
    expect(new Set(drawn(f, draws).map((i) => f.styles()[i.style * STYLE_WORDS]))).toEqual(new Set([DRAW]))
  })

  it('culls the batches outside the view and merges adjacent ones', () => {
    const { doc, f, scene } = setup()
    const rand = rng(2)
    doc.transact('load', (tx) => {
      for (let i = 0; i < 30_000; i++) {
        const x = rand() * 100
        const y = rand() * 100
        tx.add(line(x, y, x + rand(), y + rand()))
        tx.add(line(1e5 + x, 1e5 + y, 1e5 + x + rand(), 1e5 + y + rand()))
      }
    })
    const both = scene.draws(view(5e4, 5e4, 600 / 2e5))
    expect(both).toHaveLength(1)
    expect(drawn(f, both)).toHaveLength(60_000)
    const near = scene.draws(view(50, 50, 4))
    const seen = drawn(f, near)
    expect(seen.filter((i) => i.v[0]! < 1000)).toHaveLength(30_000)
    expect(seen.filter((i) => i.v[0]! > 1000).length).toBeLessThan(2048)
    expect(near.length).toBeLessThanOrEqual(3)
  })

  it('groups arcs by radius band and sizes subdiv for the zoom', () => {
    const { doc, scene } = setup()
    doc.transact('a', (tx) => {
      tx.add({ type: 'circle', layer: 0, cx: 0, cy: 0, r: 1.5 })
      tx.add({ type: 'arc', layer: 0, cx: 0, cy: 0, r: 1000, a0: 0, a1: 1 })
    })
    for (const scale of [0.01, 1, 50]) {
      const subdivs = scene.draws(view(0, 0, scale, 1e5, 1e5)).map((d) => d.subdiv).sort((p, q) => p! - q!)
      expect(subdivs).toEqual([arcSubdiv(2 * scale), arcSubdiv(1024 * scale)])
    }
  })

  it('stays in sync with the document through edits, undo, redo and layer changes', () => {
    const { doc, f, scene } = setup()
    const rand = rng(3)
    const randomDraft = (): Draft => {
      const x = rand() * 1000
      const y = rand() * 1000
      const k = rand()
      if (k < 0.5) return line(x, y, x + rand() * 10, y + rand() * 10, { layer: rand() < 0.3 ? 1 : 0 })
      if (k < 0.7) return { type: 'circle', layer: 0, cx: x, cy: y, r: 0.1 + rand() * 50, ...(rand() < 0.2 ? { color: 3 } : {}) }
      if (k < 0.85) return { type: 'arc', layer: 1, cx: x, cy: y, r: 0.1 + rand() * 50, a0: rand() * 6, a1: rand() * 6 }
      if (k < 0.9) return solid([x, y, x + rand() * 9, y, x, y + rand() * 9, x + rand() * 9, y + rand() * 9], { layer: rand() < 0.5 ? 1 : 0 })
      const n = 2 + Math.floor(rand() * 4)
      const pts = new Float64Array(2 * n).map((_, i) => (i % 2 ? y : x) + rand() * 20)
      const bulges = rand() < 0.5 ? new Float64Array(n).map(() => (rand() < 0.5 ? 0 : rand() * 2 - 1)) : null
      return { type: 'polyline', layer: 0, pts, bulges, closed: rand() < 0.5 }
    }
    doc.layers.add({ name: 'One', color: 5, visible: true, locked: false })
    doc.transact('load', (tx) => {
      for (let i = 0; i < 20_000; i++) tx.add(randomDraft())
    })

    const check = (): void => {
      scene.draws(FAR)
      const styles = f.styles()
      const got: string[] = []
      for (const b of f.batches.values()) {
        for (const i of decode(b)) {
          if (i.style === 0) continue
          got.push(`${i.kind} ${styles[i.style * STYLE_WORDS]} ${styles[i.style * STYLE_WORDS + 1]! >> 16} ${i.v.map((v) => v.toFixed(3)).join(' ')}`)
        }
      }
      const want: string[] = []
      for (const e of doc.entities()) {
        const layer = doc.layers.get(e.layer)!
        const c = e.color ?? layer.color
        const rgba = c === 7 ? DRAW : c === 3 ? 0x00ff00ff : c === 5 ? 0x0000ffff : NaN
        const head = (kind: string): string => `${kind} ${rgba} ${layer.visible ? 1 : 0}`
        typeOf(e).primitives(e, 0, {
          segment: (...v) => want.push(`${head('segment')} ${v.map((x) => x.toFixed(3)).join(' ')}`),
          arc: (cx, cy, r, a0, sweep) =>
            want.push(`${head('arc')} ${[cx, cy, Math.fround(r), Math.fround(a0), Math.fround(sweep)].map((x) => x.toFixed(3)).join(' ')}`),
          tri: (...v) => want.push(`${head('tri')} ${v.map((x) => x.toFixed(3)).join(' ')}`),
        })
      }
      expect(got.sort()).toEqual(want.sort())
    }

    check()
    for (let round = 0; round < 25; round++) {
      const live = [...doc.entities()]
      doc.transact('edit', (tx) => {
        const touched = new Set<number>()
        for (let i = 0; i < 40; i++) tx.add(randomDraft())
        for (let i = 0; i < 40; i++) {
          const e = live[Math.floor(rand() * live.length)]!
          if (touched.has(e.id)) continue
          touched.add(e.id)
          if (rand() < 0.5) tx.remove(e.id)
          else tx.replace({ ...(randomDraft() as Entity), id: e.id })
        }
      })
      if (round % 4 === 1) doc.undo()
      if (round % 4 === 2) {
        doc.undo()
        doc.redo()
      }
      if (round === 10) doc.layers.update(1, { visible: false })
      if (round === 15) doc.layers.update(0, { color: 3 })
      if (round === 20) {
        // Big enough to rebuild everything.
        doc.transact('bulk', (tx) => {
          for (let i = 0; i < 20_000; i++) tx.add(randomDraft())
        })
      }
      check()
    }
    // About 4 s alone (25 rounds checked one by one, 20 000 entities in the last ones): the 5 s default is too close
    // under load.
  }, 30_000)

  it('re-emits primitives too big for f32 clipped to the view, in f64', () => {
    const { doc, f, scene } = setup()
    const r = 1e4 + 0.2
    doc.transact('a', (tx) => {
      tx.add(line(-1e4, 0.1, 1e4, 0.1))
      tx.add({ type: 'circle', layer: 0, cx: 0, cy: -1e4, r })
    })
    const v = view(0, 0, 1000, 1000, 800)
    const inView = (x: number, y: number): boolean => Math.abs(x) < 0.51 && Math.abs(y) < 0.41
    const clipped = drawn(f, scene.draws(v)).filter((i) => i.kind === 'segment' && inView(i.v[0]!, i.v[1]!) && inView(i.v[2]!, i.v[3]!))
    const flat = clipped.filter((i) => Math.abs(i.v[1]! - 0.1) < 1e-9 && Math.abs(i.v[3]! - 0.1) < 1e-9)
    expect(flat).toHaveLength(1)
    expect(Math.abs(flat[0]!.v[2]! - flat[0]!.v[0]!)).toBeGreaterThan(1) // spans the whole view
    const onCircle = clipped.filter((i) => i !== flat[0])
    expect(onCircle.length).toBeGreaterThan(0)
    for (const i of onCircle) {
      const [x0, y0, x1, y1] = i.v as [number, number, number, number]
      for (const [x, y] of [[x0, y0], [x1, y1], [(x0 + x1) / 2, (y0 + y1) / 2]] as const) {
        // Ends on the circle; the chord's middle within the 0.25 px sagitta.
        expect(Math.abs(Math.hypot(x, y + 1e4) - r)).toBeLessThan(0.25 / 1000 + 1e-6)
      }
    }
    // At a normal zoom nothing is re-emitted.
    const plain = scene.draws(view(0, 0, 0.01))
    expect(drawn(f, plain).filter((i) => i.kind === 'segment')).toHaveLength(1)
  })

  it('draws the highlighted entities last, in the highlight style, and follows their edits', () => {
    const { doc, f, scene } = setup()
    const ids: number[] = []
    doc.transact('a', (tx) => {
      ids.push(tx.add(line(0, 0, 1, 0)).id)
      ids.push(tx.add({ type: 'circle', layer: 0, cx: 0, cy: 0, r: 1 }).id)
      ids.push(tx.add(line(0, 1, 1, 1)).id)
    })
    const v = view(0, 0, 100)
    expect(drawn(f, scene.draws(v)).some((i) => i.style === 1)).toBe(false)
    scene.setHighlight([ids[1]!, ids[2]!, 999])
    const draws = scene.draws(v)
    const all = drawn(f, draws)
    const top = all.slice(-2)
    expect(top.map((i) => i.style)).toEqual([1, 1])
    expect(top.map((i) => i.kind).sort()).toEqual(['arc', 'segment'])
    expect(all.filter((i) => i.style === 1)).toHaveLength(2)
    expect([f.styles()[STYLE_WORDS], f.styles()[STYLE_WORDS + 1]! >> 16]).toEqual([HIGHLIGHT, 1])

    const moved = { ...doc.get(ids[2]!)!, y0: 3, y1: 3 } as Entity
    doc.transact('move', (tx) => tx.replace(moved))
    const after = drawn(f, scene.draws(v)).filter((i) => i.style === 1 && i.kind === 'segment')
    expect(after.map((i) => i.v)).toEqual([[0, 3, 1, 3]])
    doc.transact('erase', (tx) => tx.remove(ids[1]!))
    expect(drawn(f, scene.draws(v)).filter((i) => i.style === 1).map((i) => i.kind)).toEqual(['segment'])
    doc.layers.update(0, { visible: false })
    expect(drawn(f, scene.draws(v)).filter((i) => i.style === 1)).toEqual([])
  })

  describe('free curves (ellipse, spline)', () => {
    const ELLIPSE = { type: 'ellipse', layer: 0, cx: 0, cy: 0, mx: 1000, my: 0, ratio: 0.5, t0: 0, t1: 0 } as const
    /** How far (x, y) lies from the drawn segments. */
    const fromDrawn = (is: Instance[], x: number, y: number): number => Math.min(...is.map((i) => segmentDistance(x, y, i.v[0]!, i.v[1]!, i.v[2]!, i.v[3]!)))

    it('are chords within 0.25 px at the zoom, of the part near the view only', () => {
      const { doc, f, scene } = setup()
      doc.transact('draw', (tx) => void tx.add(ELLIPSE))
      for (const v of [view(1000, 0, 10), view(0, 0, 0.3), view(-1000, 0, 1000)]) {
        const is = drawn(f, scene.draws(v))
        expect(is.length).toBeGreaterThan(0)
        expect(is.every((i) => i.kind === 'segment')).toBe(true)
        // Every chord end on the ellipse (f32 hi/lo: to ~1e-9 relative).
        for (const i of is) for (const [x, y] of [[i.v[0]!, i.v[1]!], [i.v[2]!, i.v[3]!]]) expect(Math.hypot(x! / 1000, y! / 500)).toBeCloseTo(1, 7)
        // The visible part of the curve is within a quarter pixel of them.
        const halfW = 400 / v.scale
        for (let k = 0; k <= 2000; k++) {
          const t = (2 * Math.PI * k) / 2000
          const x = 1000 * Math.cos(t)
          const y = 500 * Math.sin(t)
          if (Math.abs(x - v.cx) > halfW || Math.abs(y - v.cy) > 300 / v.scale) continue
          expect(fromDrawn(is, x, y) * v.scale).toBeLessThanOrEqual(0.25 + 1e-6)
        }
        // Zoomed in, only what is near the view.
        if (v.scale >= 10) expect(Math.max(...is.map((i) => Math.abs(i.v[0]! - v.cx)))).toBeLessThan(4 * halfW)
      }
    })

    it('panning within the flattened region reuses it; leaving it or another zoom band flattens again', () => {
      const { doc, f, scene } = setup()
      doc.transact('draw', (tx) => void tx.add(ELLIPSE))
      scene.draws(view(1000, 0, 10))
      const writes = (): number => f.log.filter((c) => c === 'write').length
      const before = writes()
      scene.draws(view(1010, 5, 10))
      expect(writes()).toBe(before)
      scene.draws(view(1000, 70, 10))
      expect(writes()).toBe(before + 1)
      scene.draws(view(990, 70, 40))
      expect(writes()).toBe(before + 2)
    })

    it('follow edits, erasing and the highlight; a big rebuild leaves them right', () => {
      const { doc, f, scene } = setup()
      let id = 0
      let s = 0
      doc.transact('draw', (tx) => {
        id = tx.add(ELLIPSE).id
        s = tx.add({ type: 'spline', layer: 0, degree: 2, closed: false, knots: Float64Array.of(0, 0, 0, 1, 1, 1), ctrl: Float64Array.of(0, 0, 100, 200, 200, 0), weights: null }).id
      })
      const v = view(0, 0, 0.3)
      expect(drawn(f, scene.draws(v)).some((i) => i.style === 1)).toBe(false)
      scene.setHighlight([s])
      const hl = drawn(f, scene.draws(v)).filter((i) => i.style === 1)
      expect(hl.length).toBeGreaterThan(0)
      expect(hl.every((i) => Math.max(i.v[1]!, i.v[3]!) <= 100 + 1e-6 && Math.min(i.v[0]!, i.v[2]!) >= -1e-6)).toBe(true)
      doc.transact('move', (tx) => tx.replace({ ...(doc.get(id) as Ellipse), cx: 5000 }))
      const moved = drawn(f, scene.draws(v)).filter((i) => i.style !== 1)
      expect(Math.min(...moved.map((i) => Math.min(i.v[0]!, i.v[2]!)))).toBeGreaterThan(-1e-6)
      // Many lines force a full rebuild: the curves are still there, and still highlighted.
      doc.transact('many', (tx) => {
        for (let k = 0; k < 20_000; k++) tx.add(line(k, -10, k, -11))
      })
      const after = drawn(f, scene.draws(v))
      expect(after.filter((i) => i.style === 1).length).toBe(hl.length)
      doc.transact('erase', (tx) => {
        tx.remove(id)
        tx.remove(s)
      })
      expect(drawn(f, scene.draws(v)).filter((i) => i.v[1]! > -5 || i.style === 1)).toEqual([])
    })
  })

  it('an insert draws its block, each primitive in the style of the layer and color it resolves to', () => {
    const { doc, f, scene } = setup()
    const walls = doc.layers.add({ name: 'Walls', color: 1, visible: true, locked: false })
    const plan = doc.layers.add({ name: 'Plan', color: 3, visible: true, locked: false })
    const block: Block = {
      name: 'B', x: 0, y: 0,
      entities: [
        { type: 'line', layer: 0, color: BY_BLOCK, x0: 0, y0: 0, x1: 1, y1: 0 },
        { type: 'circle', layer: walls, color: 5, cx: 0, cy: 0, r: 1 },
        { type: 'line', layer: walls, x0: 0, y0: 1, x1: 1, y1: 1 },
        { type: 'line', layer: 0, x0: 0, y0: 2, x1: 1, y1: 2 },
      ],
    }
    doc.transact('draw', (tx) => void tx.add({ type: 'insert', layer: plan, color: 2, block, x: 10, y: 0, sx: 1, sy: 1, rotation: 0, cols: 1, rows: 1, dx: 0, dy: 0 }))
    const rgba = (i: Instance): number => f.styles()[i.style * STYLE_WORDS]!
    const aci = (n: number): number => ((colorRgb(n) << 8) | 0xff) >>> 0
    const is = drawn(f, scene.draws(view(10, 0, 10)))
    const line = (y: number): Instance => is.find((i) => i.kind === 'segment' && i.v[1] === y)!
    expect(rgba(line(0))).toBe(aci(2)) // ByBlock: the insert's yellow
    expect(rgba(is.find((i) => i.kind === 'arc')!)).toBe(aci(5))
    expect(rgba(line(1))).toBe(aci(1)) // ByLayer on Walls: red
    expect(rgba(line(2))).toBe(aci(3)) // layer 0 ByLayer: the insert's layer, and that layer's green
    expect(line(0).v).toEqual([10, 0, 11, 0])
    // Unevenly scaled, the circle is chords from the free layer.
    doc.transact('stretch', (tx) => tx.replace({ ...(doc.get(1) as Entity & { sx: number }), sx: 3 } as Entity))
    const stretched = drawn(f, scene.draws(view(10, 0, 10)))
    expect(stretched.some((i) => i.kind === 'arc')).toBe(false)
    expect(stretched.filter((i) => rgba(i) === aci(5)).length).toBeGreaterThan(8)
  })

  it('text draws a glyph instance per letter from the atlas, highlighted on top, and inside a free insert too', () => {
    const doc = createDocument()
    const f = fakeBackend()
    const indexed: number[] = []
    let pending = false
    const glyphs = {
      index: (cp: number) => (indexed.includes(cp) || (indexed.push(cp), (pending = true)), indexed.indexOf(cp)),
      take: () => (pending ? ((pending = false), { width: 1, height: 1, data: new Uint8Array(1), table: new Float32Array(8 * indexed.length) }) : null),
    }
    const scene = createScene(doc, f.backend, { ...OPTS, glyphs })
    const text = { type: 'text', layer: 0, value: 'HI', x: 10, y: 20, x2: 10, y2: 20, height: 2, rotation: 0, widthFactor: 1, oblique: 0, halign: 0, valign: 0, backward: false, upsideDown: false } as const
    let id = 0
    doc.transact('t', (tx) => void (id = tx.add(text).id))
    const v = view(10, 20, 10)
    const is = drawn(f, scene.draws(v)).filter((i) => i.kind === 'glyph')
    expect(is.map((i) => [i.v[0], i.v[1], i.v[2], i.v[5], i.v[6]])).toEqual([[10, 20, 2, 2, 0], [10 + 2 * 1.012, 20, 2, 2, 1]].map((g) => [g[0], g[1], g[2], g[3], g[4]]))
    expect(f.log).toContain('glyphs')
    scene.setHighlight([id])
    const hl = drawn(f, scene.draws(v)).filter((i) => i.kind === 'glyph' && i.style === 1)
    expect(hl).toHaveLength(2)
    // A free insert (an ellipse makes it one) shows its text through the free layer.
    const block = { name: 'B', x: 0, y: 0, entities: [text, { type: 'ellipse', layer: 0, cx: 0, cy: 0, mx: 1, my: 0, ratio: 0.5, t0: 0, t1: 0 }] } as unknown as Block
    doc.transact('i', (tx) => void tx.add({ type: 'insert', layer: 0, block, x: 100, y: 0, sx: 1, sy: 1, rotation: 0, cols: 1, rows: 1, dx: 0, dy: 0 }))
    const inside = drawn(f, scene.draws(view(110, 20, 10))).filter((i) => i.kind === 'glyph')
    expect(inside.some((i) => i.v[0] === 110 && i.v[1] === 20)).toBe(true)
  })

  it('a solid draws its triangles filled in its style, highlighted on top; out of view they are culled', () => {
    const { doc, f, scene } = setup()
    let id = 0
    doc.transact('s', (tx) => void (id = tx.add(solid([0, 0, 10, 0, 0, 10, 10, 10], { color: 1 })).id))
    const v = view(5, 5, 10)
    const is = drawn(f, scene.draws(v))
    expect(is.map((i) => i.v)).toEqual([[0, 0, 10, 0, 0, 10], [10, 0, 10, 10, 0, 10]])
    expect(is.every((i) => i.kind === 'tri' && f.styles()[i.style * STYLE_WORDS] === 0xff0000ff)).toBe(true)
    expect(drawn(f, scene.draws(view(500, 500, 10)))).toEqual([])
    scene.setHighlight([id])
    const all = drawn(f, scene.draws(v))
    expect(all.slice(-2).map((i) => [i.kind, i.style])).toEqual([['tri', 1], ['tri', 1]])
    doc.transact('erase', (tx) => tx.remove(id))
    expect(drawn(f, scene.draws(v))).toEqual([])
  })

  it('fills draw first, under the lines added before them, live and after a rebuild', () => {
    const { doc, f, scene } = setup()
    doc.transact('a', (tx) => void tx.add(line(0, 5, 10, 5)))
    const v = view(5, 5, 10)
    scene.draws(v)
    doc.transact('b', (tx) => void tx.add(solid([0, 0, 10, 0, 0, 10, 10, 10])))
    expect(drawn(f, scene.draws(v)).map((i) => i.kind)).toEqual(['tri', 'tri', 'segment'])
    doc.append(Array.from({ length: 20_000 }, (_, k) => line(k, -10, k, -11)))
    expect(drawn(f, scene.draws(v)).filter((i) => i.v[1]! >= 0).map((i) => i.kind)).toEqual(['tri', 'tri', 'segment'])
  })

  it('a big load packs solids along the Hilbert curve, culled bucket by bucket', () => {
    const { doc, f, scene } = setup()
    const rand = rng(4)
    const drafts: Draft[] = []
    for (let i = 0; i < 20_000; i++) {
      const x = rand() * 100
      const y = rand() * 100
      drafts.push(solid([x, y, x + 1, y, x, y + 1, x + 1, y + 1]), solid([1e5 + x, 1e5 + y, 1e5 + x + 1, 1e5 + y, 1e5 + x, 1e5 + y + 1, 1e5 + x, 1e5 + y + 1]))
    }
    doc.append(drafts)
    const both = drawn(f, scene.draws(view(5e4, 5e4, 600 / 2e5)))
    expect(both).toHaveLength(3 * 20_000)
    const near = drawn(f, scene.draws(view(50, 50, 4)))
    expect(near.filter((i) => i.v[0]! < 1000)).toHaveLength(2 * 20_000)
    expect(near.filter((i) => i.v[0]! > 1000).length).toBeLessThan(2048)
  })

  it('a solid in a free insert shows through the free layer, highlighted too', () => {
    const { doc, f, scene } = setup()
    const block = {
      name: 'B', x: 0, y: 0,
      entities: [solid([0, 0, 2, 0, 0, 2, 0, 2], { color: 3 }), { type: 'ellipse', layer: 0, cx: 0, cy: 0, mx: 1, my: 0, ratio: 0.5, t0: 0, t1: 0 }],
    } as unknown as Block
    let id = 0
    doc.transact('i', (tx) => void (id = tx.add({ type: 'insert', layer: 0, block, x: 100, y: 0, sx: 2, sy: 1, rotation: 0, cols: 1, rows: 1, dx: 0, dy: 0 }).id))
    const v = view(101, 1, 10)
    const tris = drawn(f, scene.draws(v)).filter((i) => i.kind === 'tri')
    expect(tris.map((i) => i.v)).toEqual([[100, 0, 104, 0, 100, 2]])
    expect(f.styles()[tris[0]!.style * STYLE_WORDS]).toBe(0x00ff00ff)
    scene.setHighlight([id])
    const top = drawn(f, scene.draws(v)).filter((i) => i.kind === 'tri')
    expect(top.map((i) => i.style === 1)).toEqual([false, true])
  })

  it('a highlighted primitive too big for f32 is re-emitted on top, in the highlight style', () => {
    const { doc, f, scene } = setup()
    let id = 0
    doc.transact('a', (tx) => {
      id = tx.add(line(-1e4, 0.1, 1e4, 0.1)).id
    })
    scene.setHighlight([id])
    const v = view(0, 0, 1000, 1000, 800)
    const draws = scene.draws(v)
    const lastDraw = drawn(f, draws.slice(-1))
    expect(lastDraw).toHaveLength(1)
    expect(lastDraw[0]!.style).toBe(1)
    expect(Math.abs(lastDraw[0]!.v[0]!)).toBeLessThan(1)
    // The plain copy comes before the highlight.
    const plain = drawn(f, draws).filter((i) => i.style !== 1 && Math.abs(i.v[0]!) < 1)
    expect(plain).toHaveLength(1)
  })

  it('after a context restore the next frame uploads everything again', () => {
    const { doc, f, scene } = setup()
    const rand = rng(9)
    doc.transact('load', (tx) => {
      for (let i = 0; i < 20_000; i++) tx.add(line(rand() * 100, rand() * 100, rand() * 100, rand() * 100))
    })
    doc.transact('more', (tx) => {
      tx.add({ type: 'circle', layer: 0, cx: 1, cy: 1, r: 1 })
      tx.add(line(0, 0, 5, 5))
      tx.add(solid([50, 50, 52, 50, 50, 52, 52, 52]))
    })
    scene.setHighlight([1])
    const v = view(50, 50, 4)
    const before = drawn(f, scene.draws(v))
    f.restore()
    expect(drawn(f, scene.draws(v))).toEqual(before)
  })

  it('dispose destroys every batch and stops listening', () => {
    const { doc, f, scene } = setup()
    const block = { name: 'B', x: 0, y: 0, entities: [solid([0, 0, 1, 0, 0, 1, 0, 1]), { type: 'ellipse', layer: 0, cx: 0, cy: 0, mx: 1, my: 0, ratio: 0.5, t0: 0, t1: 0 }] } as unknown as Block
    doc.transact('a', (tx) => {
      tx.add(line(0, 0, 1, 1))
      tx.add({ type: 'circle', layer: 0, cx: 0, cy: 0, r: 1 })
      tx.add({ type: 'insert', layer: 0, block, x: 1, y: 0, sx: 1, sy: 1, rotation: 0, cols: 1, rows: 1, dx: 0, dy: 0 })
    })
    scene.setHighlight([1, 2])
    const draws = scene.draws(view(1, 0, 1e6)) // on the circle's edge, with a radius of 1e6 px: it gets clipped
    expect(new Set(draws.map((d) => d.batch)).size).toBeGreaterThan(1)
    expect(f.batches.size).toBeGreaterThanOrEqual(5) // segments, arcs, highlight segments and arcs, clip
    scene.dispose()
    expect(f.batches.size).toBe(0)
    expect(f.restoreListeners.size).toBe(0)
    doc.transact('b', (tx) => void tx.add(line(0, 0, 1, 1)))
    expect(f.batches.size).toBe(0)
  })
})
