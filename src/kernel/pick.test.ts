import { describe, expect, it } from 'vitest'
import { createDocument, type Draft } from './document'
import type { Block, Entity } from './entity/types'
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
/** A SOLID by its corners in DXF order. */
const solid = (...c: number[]): Draft => ({ type: 'solid', layer: 0, x0: c[0]!, y0: c[1]!, x1: c[2]!, y1: c[3]!, x2: c[4]!, y2: c[5]!, x3: c[6]!, y3: c[7]! })

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

  it('a solid is picked anywhere on its fill', () => {
    const { doc, index, ids } = setup([solid(0, 0, 100, 0, 0, 100, 100, 100)])
    expect(pick(doc, index, { x: 50, y: 50 }, 1)).toBe(ids[0])
    expect(pick(doc, index, { x: 101.5, y: 50 }, 1)).toBeNull()
  })

  it('a line or text over a fill is picked before it, drawn before or after; inside, the fill only when nothing else is near', () => {
    const text: Draft = {
      type: 'text', layer: 0, value: 'HH', x: 20, y: 20, x2: 20, y2: 20, height: 5, rotation: 0, widthFactor: 1, oblique: 0,
      halign: 0, valign: 0, backward: false, upsideDown: false,
    }
    const { doc, index, ids } = setup([line(10, 50, 90, 50), solid(0, 0, 100, 0, 0, 100, 100, 100), line(50, 10, 50, 40), text])
    expect(pick(doc, index, { x: 30, y: 50.05 }, 1)).toBe(ids[0])
    expect(pick(doc, index, { x: 50.05, y: 30 }, 1)).toBe(ids[2])
    expect(pick(doc, index, { x: 22, y: 22 }, 1)).toBe(ids[3])
    expect(pick(doc, index, { x: 70, y: 70 }, 1)).toBe(ids[1])
    // Near its outline, a fill is as near as the outline: nearer than a line further off.
    const edge = setup([solid(0, 0, 100, 0, 0, 100, 100, 100), line(98, 0, 98, 100)])
    expect(pick(edge.doc, edge.index, { x: 99.8, y: 50 }, 1)).toBe(edge.ids[0])
    expect(pick(edge.doc, edge.index, { x: 98.5, y: 50 }, 1)).toBe(edge.ids[1])
  })

  it('inside overlapping fills, the later one; a fill in a block counts by its outline too, however scaled', () => {
    const square: Draft = solid(0, 0, 10, 0, 0, 10, 10, 10)
    const block: Block = { name: 'S', x: 0, y: 0, entities: [square] }
    const insert = (x: number, sx: number): Draft =>
      ({ type: 'insert', layer: 0, block, x, y: 0, sx, sy: 1, rotation: 0, cols: 1, rows: 1, dx: 0, dy: 0 }) as Draft
    const { doc, index, ids } = setup([solid(0, 0, 50, 0, 0, 50, 50, 50), solid(20, 20, 60, 20, 20, 60, 60, 60), line(30, 5, 30, 15), insert(100, 1), insert(200, 3), line(105, 5, 106, 5), line(215, 5, 216, 5)])
    expect(pick(doc, index, { x: 30, y: 30 }, 1)).toBe(ids[1])
    expect(pick(doc, index, { x: 10, y: 10 }, 1)).toBe(ids[0])
    expect(pick(doc, index, { x: 30.5, y: 10 }, 1)).toBe(ids[2])
    expect(pick(doc, index, { x: 105.5, y: 5.2 }, 1)).toBe(ids[5])
    expect(pick(doc, index, { x: 215.5, y: 5.2 }, 1)).toBe(ids[6])
    expect(pick(doc, index, { x: 215.5, y: 3 }, 1)).toBe(ids[4])
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

  it('crossing takes curves that touch the box at a single point', () => {
    const { doc, index, ids } = setup([
      { type: 'circle', layer: 0, cx: -5, cy: 5, r: 5 }, // tangent to the left edge at (0, 5)
      { type: 'arc', layer: 0, cx: 15, cy: 10, r: 5, a0: Math.PI, a1: 1.5 * Math.PI }, // starts on the corner (10, 10)
      { type: 'circle', layer: 0, cx: 13, cy: 13, r: Math.hypot(3, 3) }, // passes through the corner (10, 10) from outside
      { type: 'circle', layer: 0, cx: -6, cy: 5, r: 5 }, // misses by 1
    ])
    expect(pickBox(doc, index, box, true)).toEqual([ids[0], ids[1], ids[2]])
  })

  it('crossing takes text whose letters reach into the box, and text inside a block', () => {
    const text = (x: number, y: number, value: string): Draft => ({
      type: 'text', layer: 0, value, x, y, x2: x, y2: y, height: 1, rotation: 0, widthFactor: 1, oblique: 0,
      halign: 0, valign: 0, backward: false, upsideDown: false,
    })
    const { doc, index, ids } = setup([
      text(-2, 4, 'HH'), // its second H crosses the left edge
      text(-5, 4, 'H'), // ends before the box
      text(9.8, 9.9, 'H'), // the box's corner (10, 10) falls inside the letter
      { type: 'insert', layer: 0, block: { name: 'T', x: 0, y: 0, entities: [text(0, 0, 'H')] }, x: 9.5, y: -0.5, sx: 1, sy: 1, rotation: 0, cols: 1, rows: 1, dx: 0, dy: 0 } as Draft,
    ])
    expect(pickBox(doc, index, box, true)).toEqual([ids[0], ids[2], ids[3]])
  })

  it('ignores entities on hidden layers', () => {
    const { doc, index, ids } = setup([line(1, 1, 2, 2), line(3, 3, 4, 4, 1)])
    expect(pickBox(doc, index, box, true)).toEqual([ids[0]])
  })

  it('crossing takes a solid whose fill reaches into the box, even one that covers it whole', () => {
    const { doc, index, ids } = setup([
      solid(-100, -100, 100, -100, 0, 100, 0, 100), // a triangle around the box
      solid(9, 13, 13, 9, 9, 13, 9, 13), // flat, its box over the corner (10, 10), missing it
      solid(8, 11.5, 11.5, 8, 15, 15, 15, 15), // the edge from (8, 11.5) to (11.5, 8) cuts the corner
      solid(8, 14, 14, 8, 20, 20, 20, 20), // its edge passes the corner by
      { type: 'insert', layer: 0, block: { name: 'S', x: 0, y: 0, entities: [solid(0, 0, 3, 0, 0, 3, 3, 3)] }, x: -1, y: -1, sx: 1, sy: 1, rotation: 0, cols: 1, rows: 1, dx: 0, dy: 0 } as Draft,
    ])
    expect(pickBox(doc, index, box, true)).toEqual([ids[0], ids[2], ids[4]])
    expect(pickBox(doc, index, box, false)).toEqual([])
  })
})
