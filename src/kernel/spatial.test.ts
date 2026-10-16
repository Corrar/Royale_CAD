import { describe, expect, it } from 'vitest'
import { createDocument, type Document, type Draft } from './document'
import { typeOf } from './entity/registry'
import type { Entity, Line } from './entity/types'
import { bboxIntersects, type BBox } from './geom/vec'
import { createSpatialIndex } from './spatial'

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

function randomDraft(rand: () => number): Draft {
  const x = 7_400_000 + rand() * 1000
  const y = 9_100_000 + rand() * 1000
  const k = rand()
  if (k < 0.6) return { type: 'line', layer: 0, x0: x, y0: y, x1: x + rand() * 30 - 15, y1: y + rand() * 30 - 15 }
  if (k < 0.8) return { type: 'circle', layer: 0, cx: x, cy: y, r: 0.1 + rand() * 10 }
  return { type: 'arc', layer: 0, cx: x, cy: y, r: 0.1 + rand() * 10, a0: rand() * 6, a1: rand() * 6 }
}

function randomBox(rand: () => number): BBox {
  const x = 7_400_000 - 20 + rand() * 1040
  const y = 9_100_000 - 20 + rand() * 1040
  const w = rand() < 0.1 ? 0 : rand() * 60
  return { minX: x, minY: y, maxX: x + w, maxY: y + rand() * 60 }
}

const brute = (doc: Document, b: BBox): number[] =>
  [...doc.entities()].filter((e) => bboxIntersects(typeOf(e).bbox(e), b)).map((e) => e.id).sort((p, q) => p - q)

const sorted = (xs: number[]): number[] => [...xs].sort((p, q) => p - q)

describe('createSpatialIndex', () => {
  it('leaves out entities without geometry, even from an infinite query', () => {
    const doc = createDocument()
    doc.transact('load', (tx) => {
      tx.add({ type: 'opaque', layer: 0, name: 'HATCH', raw: '' })
      tx.add({ type: 'line', layer: 0, x0: 0, y0: 0, x1: 1, y1: 1 })
    })
    const index = createSpatialIndex(doc)
    const all = { minX: -Infinity, minY: -Infinity, maxX: Infinity, maxY: Infinity }
    expect(index.query(all)).toEqual([2])
    doc.transact('more', (tx) => void tx.add({ type: 'opaque', layer: 0, name: 'DIMENSION', raw: '' }))
    expect(index.query(all)).toEqual([2])
    doc.transact('erase', (tx) => tx.remove(1))
    expect(index.query(all)).toEqual([2])
  })

  it('matches brute force on 10 000 random entities, before and after edits without a rebuild', () => {
    const rand = rng(7)
    const doc = createDocument()
    doc.transact('load', (tx) => {
      for (let i = 0; i < 10_000; i++) tx.add(randomDraft(rand))
    })
    const index = createSpatialIndex(doc)
    const boxes = Array.from({ length: 300 }, () => randomBox(rand))
    for (const b of boxes) expect(sorted(index.query(b))).toEqual(brute(doc, b))
    expect(index.rebuilds).toBe(1)

    const live = [...doc.entities()]
    doc.transact('edit', (tx) => {
      for (let i = 0; i < 200; i++) tx.add(randomDraft(rand))
      for (let i = 0; i < 200; i++) tx.remove(live[i * 37]!.id)
      for (let i = 0; i < 200; i++) {
        const e = live[i * 37 + 5] as Line
        if (e.type === 'line') tx.replace({ ...e, x1: e.x1 + 40, y1: e.y1 - 40 })
      }
    })
    doc.undo()
    doc.redo()
    for (const b of boxes) expect(sorted(index.query(b))).toEqual(brute(doc, b))
    expect(index.rebuilds).toBe(1)
  })

  it('rebuilds lazily once the dirty list passes its limit, and stays exact', () => {
    const rand = rng(3)
    const doc = createDocument()
    const index = createSpatialIndex(doc, { maxDirty: 50 })
    doc.transact('a', (tx) => {
      for (let i = 0; i < 40; i++) tx.add(randomDraft(rand))
    })
    const b = { minX: 7_400_000, minY: 9_100_000, maxX: 7_401_000, maxY: 9_101_000 }
    expect(sorted(index.query(b))).toEqual(brute(doc, b))
    expect(index.rebuilds).toBe(0)
    doc.transact('b', (tx) => {
      for (let i = 0; i < 40; i++) tx.add(randomDraft(rand))
    })
    expect(index.rebuilds).toBe(0) // edits alone never rebuild
    expect(sorted(index.query(b))).toEqual(brute(doc, b))
    expect(index.rebuilds).toBe(1)
  })

  it('rebuilds after edits by merging into the old order, and stays exact', () => {
    const rand = rng(11)
    const doc = createDocument()
    doc.transact('load', (tx) => {
      for (let i = 0; i < 5000; i++) tx.add(randomDraft(rand))
    })
    const index = createSpatialIndex(doc, { maxDirty: 100 })
    const boxes = Array.from({ length: 60 }, () => randomBox(rand))
    for (let round = 0; round < 8; round++) {
      const live = [...doc.entities()]
      doc.transact('edit', (tx) => {
        for (let i = 0; i < 60; i++) tx.add(randomDraft(rand))
        for (let i = 0; i < 60; i++) tx.remove(live[(round * 997 + i * 61) % live.length]!.id)
      })
      if (round % 3 === 2) doc.undo()
      for (const b of boxes) expect(sorted(index.query(b))).toEqual(brute(doc, b))
    }
    expect(index.rebuilds).toBe(8) // the first query builds cold, with round 0 already in
    expect(index.coldBuilds).toBe(1)

    // An edit outside the old frame forces a full sort.
    doc.transact('far', (tx) => {
      for (let i = 0; i < 150; i++) tx.add({ type: 'line', layer: 0, x0: 0, y0: i, x1: 1, y1: i })
    })
    const far = { minX: -1, minY: -1, maxX: 2, maxY: 200 }
    expect(sorted(index.query(far))).toEqual(brute(doc, far))
    expect(index.coldBuilds).toBe(2)
    for (const b of boxes) expect(sorted(index.query(b))).toEqual(brute(doc, b))
  })

  it('a bulk change skips the dirty list and is seen by the next query', () => {
    const rand = rng(5)
    const doc = createDocument()
    const index = createSpatialIndex(doc, { maxDirty: 10 })
    doc.transact('load', (tx) => {
      for (let i = 0; i < 2000; i++) tx.add(randomDraft(rand))
    })
    const b = { minX: 7_400_000, minY: 9_100_000, maxX: 7_400_500, maxY: 9_100_500 }
    expect(sorted(index.query(b))).toEqual(brute(doc, b))
    const live = [...doc.entities()]
    doc.transact('erase', (tx) => {
      for (let i = 0; i < 1500; i++) tx.remove(live[i]!.id)
    })
    expect(sorted(index.query(b))).toEqual(brute(doc, b))
    doc.undo()
    expect(sorted(index.query(b))).toEqual(brute(doc, b))
    expect(index.coldBuilds).toBe(index.rebuilds)
  })

  it('stays exact after the document is emptied and refilled (no tree shares arrays with the spare)', () => {
    const doc = createDocument()
    const index = createSpatialIndex(doc, { maxDirty: 4 })
    const lines = (n: number, dx: number): Draft[] =>
      Array.from({ length: n }, (_, i) => ({ type: 'line', layer: 0, x0: dx + i, y0: i % 50, x1: dx + i + 0.5, y1: (i % 50) + 0.5 }))
    const all = { minX: -1e9, minY: -1e9, maxX: 1e9, maxY: 1e9 }
    const check = (b: BBox): void => expect(sorted(index.query(b))).toEqual(brute(doc, b))
    doc.transact('load', (tx) => {
      for (const d of lines(100, 0)) tx.add(d)
    })
    check(all)
    doc.transact('erase all', (tx) => {
      for (const e of [...doc.entities()]) tx.remove(e.id)
    })
    check(all)
    doc.undo()
    check(all)
    // Inside the old frame, so the next rebuild merges into the old order.
    doc.transact('more', (tx) => {
      for (const d of lines(5, 0.25)) tx.add(d)
    })
    check(all)
    check({ minX: 10, minY: 10, maxX: 20, maxY: 20 })
    const ids = index.query(all)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('matches brute force under random edits that sometimes empty the document', () => {
    const rand = rng(21)
    const doc = createDocument()
    const index = createSpatialIndex(doc, { maxDirty: 30 })
    const boxes = Array.from({ length: 20 }, () => randomBox(rand))
    for (let round = 0; round < 60; round++) {
      const k = rand()
      const live = [...doc.entities()]
      if (k < 0.1 && live.length > 0) {
        doc.transact('erase all', (tx) => {
          for (const e of live) tx.remove(e.id)
        })
      } else if (k < 0.25) doc.undo()
      else if (k < 0.3) doc.redo()
      else {
        doc.transact('edit', (tx) => {
          const n = Math.floor(rand() * 80)
          for (let i = 0; i < n; i++) tx.add(randomDraft(rand))
          for (let i = 0; i < Math.min(live.length, Math.floor(rand() * 40)); i++) {
            const e = live[Math.floor(rand() * live.length)]!
            if (doc.get(e.id)) tx.remove(e.id)
          }
        })
      }
      for (const b of boxes) expect(sorted(index.query(b))).toEqual(brute(doc, b))
    }
  })

  it('handles the empty document and a document emptied after a build', () => {
    const doc = createDocument()
    const index = createSpatialIndex(doc, { maxDirty: 0 })
    const everything = { minX: -1e9, minY: -1e9, maxX: 1e9, maxY: 1e9 }
    expect(index.query(everything)).toEqual([])
    let e!: Entity
    doc.transact('a', (tx) => {
      e = tx.add({ type: 'line', layer: 0, x0: 0, y0: 0, x1: 1, y1: 1 })
    })
    expect(index.query(everything)).toEqual([e.id])
    doc.transact('b', (tx) => tx.remove(e.id))
    expect(index.query(everything)).toEqual([])
  })

  it('touching boxes count as intersecting', () => {
    const doc = createDocument()
    let e!: Entity
    doc.transact('a', (tx) => {
      e = tx.add({ type: 'line', layer: 0, x0: 0, y0: 0, x1: 10, y1: 0 })
    })
    const index = createSpatialIndex(doc)
    expect(index.query({ minX: 10, minY: 0, maxX: 11, maxY: 1 })).toEqual([e.id])
    expect(index.query({ minX: 10.001, minY: 0, maxX: 11, maxY: 1 })).toEqual([])
  })

  it('dispose stops listening to the document', () => {
    const doc = createDocument()
    const index = createSpatialIndex(doc)
    index.dispose()
    doc.transact('a', (tx) => void tx.add({ type: 'line', layer: 0, x0: 0, y0: 0, x1: 1, y1: 1 }))
    expect(() => index.query({ minX: 0, minY: 0, maxX: 1, maxY: 1 })).toThrow(/disposed/)
  })
})
