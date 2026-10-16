import { describe, expect, it } from 'vitest'
import { createDocument, type Draft } from './document'
import type { Entity } from './entity/types'
import { pick, pickBox } from './pick'
import { createSpatialIndex } from './spatial'

function setup(drafts: Draft[]) {
  const doc = createDocument()
  doc.layers.add({ name: 'Off', color: 1, visible: false, locked: false })
  const es: Entity[] = []
  doc.transact('a', (tx) => {
    for (const d of drafts) es.push(tx.add(d))
  })
  return { doc, index: createSpatialIndex(doc), ids: es.map((e) => e.id) }
}

const line = (x0: number, y0: number, x1: number, y1: number, layer = 0): Draft => ({ type: 'line', layer, x0, y0, x1, y1 })

describe('pick', () => {
  it('chooses the nearest of overlapping entities', () => {
    const { doc, index, ids } = setup([line(0, 0, 10, 0), line(0, 1, 10, 1), { type: 'circle', layer: 0, cx: 5, cy: 0.5, r: 3 }])
    expect(pick(doc, index, { x: 5, y: 0.2 }, 1)).toBe(ids[0])
    expect(pick(doc, index, { x: 5, y: 0.8 }, 1)).toBe(ids[1])
    expect(pick(doc, index, { x: 8.1, y: 0.5 }, 1)).toBe(ids[2])
  })

  it('is null beyond the tolerance', () => {
    const { doc, index } = setup([line(0, 0, 10, 0)])
    expect(pick(doc, index, { x: 5, y: 1.5 }, 1)).toBeNull()
    expect(pick(doc, index, { x: 12, y: 0 }, 1)).toBeNull()
  })

  it('a tie goes to the entity drawn later', () => {
    const { doc, index, ids } = setup([line(0, 0, 10, 0), line(0, 0, 10, 0)])
    expect(pick(doc, index, { x: 5, y: 0.1 }, 1)).toBe(ids[1])
  })

  it('ignores entities on hidden layers', () => {
    const { doc, index, ids } = setup([line(0, 0, 10, 0), line(0, 0.1, 10, 0.1, 1)])
    expect(pick(doc, index, { x: 5, y: 0.1 }, 1)).toBe(ids[0])
  })
})

describe('pickBox', () => {
  const box = { minX: 0, minY: 0, maxX: 10, maxY: 10 }

  it('window takes only what lies wholly inside', () => {
    const { doc, index, ids } = setup([line(1, 1, 9, 9), line(5, 5, 15, 5), { type: 'circle', layer: 0, cx: 5, cy: 5, r: 4 }])
    expect(pickBox(doc, index, box, false)).toEqual([ids[0], ids[2]])
  })

  it('crossing also takes what touches the box', () => {
    const { doc, index, ids } = setup([line(1, 1, 9, 9), line(5, 5, 15, 5), line(10, 10, 20, 20)])
    expect(pickBox(doc, index, box, true)).toEqual(ids)
  })

  it('crossing needs the geometry to touch, not just the bbox', () => {
    const { doc, index, ids } = setup([
      line(8, 14, 14, 8), // its bbox overlaps the box's corner, the line misses it
      { type: 'circle', layer: 0, cx: 5, cy: 5, r: 20 }, // encloses the box without touching it
      { type: 'arc', layer: 0, cx: 5, cy: 5, r: 7.5, a0: Math.PI / 6, a1: Math.PI / 3 }, // passes outside the corner
      { type: 'arc', layer: 0, cx: 12, cy: 5, r: 3, a0: 2, a1: 4.3 }, // crosses the right edge
    ])
    expect(pickBox(doc, index, box, true)).toEqual([ids[3]])
  })

  it('ignores entities on hidden layers', () => {
    const { doc, index, ids } = setup([line(1, 1, 2, 2), line(3, 3, 4, 4, 1)])
    expect(pickBox(doc, index, box, true)).toEqual([ids[0]])
  })
})
