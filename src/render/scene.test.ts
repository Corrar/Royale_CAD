import { describe, expect, it } from 'vitest'
import { trueColor } from '../kernel/color'
import { createDocument, type Document, type Draft } from '../kernel/document'
import { typeOf } from '../kernel/entity/registry'
import type { Entity } from '../kernel/entity/types'
import type { ViewState } from '../kernel/view'
import { ARC_STRIDE, SEGMENT_STRIDE, STYLE_WORDS, arcSubdiv, type Draw, type RenderBackend } from './backend'
import { createScene } from './scene'

const DRAW = 0xf2f4f5ff
const HIGHLIGHT = 0x67e8f9ff
const OPTS = { drawColor: DRAW, highlightColor: HIGHLIGHT }

type Kind = 'segment' | 'arc'
interface FakeBatch { kind: Kind; capacity: number; bytes: Uint8Array }
const strideOf = (k: Kind): number => (k === 'segment' ? SEGMENT_STRIDE : ARC_STRIDE)

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
        : { kind: 'arc', v: [hilo(0), hilo(2), f32[w + 4]!, f32[w + 5]!, f32[w + 6]!], style: u32[w + 7]! },
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

function setup(doc: Document = createDocument()) {
  const f = fakeBackend()
  const scene = createScene(doc, f.backend, OPTS)
  return { doc, f, scene }
}

describe('createScene', () => {
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
  })

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
    })
    scene.setHighlight([1])
    const v = view(50, 50, 4)
    const before = drawn(f, scene.draws(v))
    f.restore()
    expect(drawn(f, scene.draws(v))).toEqual(before)
  })

  it('dispose destroys every batch and stops listening', () => {
    const { doc, f, scene } = setup()
    doc.transact('a', (tx) => {
      tx.add(line(0, 0, 1, 1))
      tx.add({ type: 'circle', layer: 0, cx: 0, cy: 0, r: 1 })
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
