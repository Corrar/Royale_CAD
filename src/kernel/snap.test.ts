import { describe, expect, it } from 'vitest'
import { createDocument, type Draft } from './document'
import type { Entity } from './entity/types'
import { SNAP, snap, snapPointsOf } from './snap'
import { createSpatialIndex } from './spatial'
import type { ViewState } from './view'

// 10 px per unit, so a 10 px aperture is 1 unit.
const VIEW: ViewState = { cx: 0, cy: 0, scale: 10, width: 800, height: 600, dpr: 1 }
const ALL = SNAP.END | SNAP.MID | SNAP.CEN

function setup(drafts: Draft[]) {
  const doc = createDocument()
  const es: Entity[] = []
  doc.transact('a', (tx) => {
    for (const d of drafts) es.push(tx.add(d))
  })
  return { doc, index: createSpatialIndex(doc), ids: es.map((e) => e.id) }
}

const r9 = (v: number): number => Math.round(v * 1e9) / 1e9 + 0
const line = (x0: number, y0: number, x1: number, y1: number): Draft => ({ type: 'line', layer: 0, x0, y0, x1, y1 })

describe('snapPointsOf', () => {
  const pts = (d: Draft, modes = ALL): [number, number, number][] => {
    const { doc, ids } = setup([d])
    const out: [number, number, number][] = []
    snapPointsOf(doc.get(ids[0]!)!, modes, (x, y, mode) => out.push([Math.round(x * 1e9) / 1e9 + 0, Math.round(y * 1e9) / 1e9 + 0, mode]))
    return out
  }

  it('line: both ends and the middle', () => {
    expect(pts(line(0, 0, 4, 2))).toEqual([[0, 0, SNAP.END], [4, 2, SNAP.END], [2, 1, SNAP.MID]])
    expect(pts(line(0, 0, 4, 2), SNAP.MID)).toEqual([[2, 1, SNAP.MID]])
  })

  it('circle: the centre only', () => {
    expect(pts({ type: 'circle', layer: 0, cx: 3, cy: 4, r: 2 })).toEqual([[3, 4, SNAP.CEN]])
  })

  it('QUA: the quadrant points a circle, an arc or a bulged piece passes through', () => {
    expect(pts({ type: 'circle', layer: 0, cx: 3, cy: 4, r: 2 }, SNAP.QUA)).toEqual([[5, 4, SNAP.QUA], [3, 6, SNAP.QUA], [1, 4, SNAP.QUA], [3, 2, SNAP.QUA]])
    expect(pts({ type: 'arc', layer: 0, cx: 0, cy: 0, r: 2, a0: -0.1, a1: Math.PI / 2 - 0.1 }, SNAP.QUA)).toEqual([[2, 0, SNAP.QUA]])
    const p: Draft = { type: 'polyline', layer: 0, pts: new Float64Array([0, 0, 2, 0]), bulges: new Float64Array([1, 0]), closed: false }
    // The half circle below (0,0)–(2,0): both ends are quadrant points too.
    expect(pts(p, SNAP.QUA)).toEqual([[2, 0, SNAP.QUA], [0, 0, SNAP.QUA], [1, -1, SNAP.QUA]])
  })

  it('arc: both ends, the middle of the arc and the centre', () => {
    expect(pts({ type: 'arc', layer: 0, cx: 0, cy: 0, r: 2, a0: 0, a1: Math.PI })).toEqual([
      [2, 0, SNAP.END],
      [-2, 0, SNAP.END],
      [0, 2, SNAP.MID],
      [0, 0, SNAP.CEN],
    ])
  })

  it('polyline: every vertex, the middle of every piece, the centre of bulged pieces', () => {
    const p: Draft = { type: 'polyline', layer: 0, pts: new Float64Array([0, 0, 2, 0, 2, 2]), bulges: new Float64Array([1, 0, 0]), closed: false }
    expect(pts(p)).toEqual([
      [0, 0, SNAP.END],
      [2, 0, SNAP.END],
      [2, 2, SNAP.END],
      [1, -1, SNAP.MID], // bulge 1 from (0,0) to (2,0): the half circle below
      [2, 1, SNAP.MID],
      [1, 0, SNAP.CEN],
    ])
  })
})

describe('snap', () => {
  it('is null when nothing is within the aperture', () => {
    const { doc, index } = setup([line(0, 0, 10, 0)])
    expect(snap(doc, index, { x: 3, y: 2 }, VIEW, ALL, 10)).toBeNull()
  })

  it('takes the point nearest to the cursor in pixels', () => {
    const { doc, index, ids } = setup([line(0, 0, 10, 0), line(10.5, 0, 20, 0)])
    expect(snap(doc, index, { x: 10.3, y: 0.2 }, VIEW, ALL, 10)).toEqual({ p: { x: 10.5, y: 0 }, mode: SNAP.END, id: ids[1] })
    expect(snap(doc, index, { x: 10.2, y: 0.2 }, VIEW, ALL, 10)).toEqual({ p: { x: 10, y: 0 }, mode: SNAP.END, id: ids[0] })
  })

  it('a tie goes by priority: END, then MID, then CEN', () => {
    // The end of one line is the middle of the other and the centre of a circle.
    const { doc, index, ids } = setup([
      { type: 'circle', layer: 0, cx: 5, cy: 0, r: 0.5 },
      line(-5, 0, 15, 0),
      line(5, 0, 5, 9),
    ])
    expect(snap(doc, index, { x: 5.2, y: 0.1 }, VIEW, ALL, 10)).toMatchObject({ p: { x: 5, y: 0 }, mode: SNAP.END, id: ids[2] })
    expect(snap(doc, index, { x: 5.2, y: 0.1 }, VIEW, SNAP.MID | SNAP.CEN, 10)).toMatchObject({ mode: SNAP.MID, id: ids[1] })
  })

  it('CEN fires with the cursor over the curve, even far from the centre', () => {
    const { doc, index, ids } = setup([{ type: 'circle', layer: 0, cx: 0, cy: 0, r: 20 }])
    expect(snap(doc, index, { x: 20.3, y: 0 }, VIEW, SNAP.CEN, 10)).toEqual({ p: { x: 0, y: 0 }, mode: SNAP.CEN, id: ids[0] })
    // Inside the circle but away from the curve: nothing.
    expect(snap(doc, index, { x: 10, y: 0 }, VIEW, SNAP.CEN, 10)).toBeNull()
  })

  it('snaps to the ends of an arc, and skips hidden layers', () => {
    const { doc, index, ids } = setup([{ type: 'arc', layer: 0, cx: 0, cy: 0, r: 5, a0: 0, a1: Math.PI / 2 }])
    const hit = snap(doc, index, { x: 0.2, y: 4.9 }, VIEW, SNAP.END, 10)!
    expect([hit.mode, hit.id]).toEqual([SNAP.END, ids[0]])
    expect(hit.p.x).toBeCloseTo(0, 12) // cos(π/2) is 6e-17 in f64
    expect(hit.p.y).toBe(5)
    doc.layers.update(0, { visible: false })
    expect(snap(doc, index, { x: 0.2, y: 4.9 }, VIEW, SNAP.END, 10)).toBeNull()
  })

  it('the aperture follows the zoom', () => {
    const { doc, index } = setup([line(0, 0, 10, 0)])
    const far = { x: 10.5, y: 0 } // 5 px at scale 10, 50 px at scale 100
    expect(snap(doc, index, far, VIEW, ALL, 10)).not.toBeNull()
    expect(snap(doc, index, far, { ...VIEW, scale: 100 }, ALL, 10)).toBeNull()
  })

  it('INT: where two objects near the cursor cross; an end there wins the tie', () => {
    const { doc, index, ids } = setup([line(-10, 0, 10, 0), { type: 'circle', layer: 0, cx: 0, cy: 0, r: 5 }, line(5, 0, 5, -9)])
    const hit = snap(doc, index, { x: 4.6, y: 0.3 }, VIEW, SNAP.INT, 10)!
    expect([r9(hit.p.x), r9(hit.p.y), hit.mode]).toEqual([5, 0, SNAP.INT])
    expect(snap(doc, index, { x: 4.6, y: 0.3 }, VIEW, SNAP.INT | SNAP.END, 10)).toMatchObject({ p: { x: 5, y: 0 }, mode: SNAP.END, id: ids[2] })
    // Far from any crossing: nothing.
    expect(snap(doc, index, { x: 8, y: 0.2 }, VIEW, SNAP.INT, 10)).toBeNull()
  })

  it('PER: the foot of the perpendicular from the base, with the cursor over the object', () => {
    const { doc, index, ids } = setup([line(0, 0, 10, 0), { type: 'circle', layer: 0, cx: 0, cy: 20, r: 5 }])
    expect(snap(doc, index, { x: 8, y: 0.3 }, VIEW, SNAP.PER, 10, { x: 3, y: 7 })).toEqual({ p: { x: 3, y: 0 }, mode: SNAP.PER, id: ids[0] })
    expect(snap(doc, index, { x: 8, y: 0.3 }, VIEW, SNAP.PER, 10)).toBeNull() // no base, no perpendicular
    // The foot past the end of the line is not on it.
    expect(snap(doc, index, { x: 8, y: 0.3 }, VIEW, SNAP.PER, 10, { x: 13, y: 7 })).toBeNull()
    // On a circle, along the line through the centre: the side nearer the cursor.
    const hit = snap(doc, index, { x: 0.4, y: 15.2 }, VIEW, SNAP.PER, 10, { x: 0, y: 40 })!
    expect([hit.p.x, hit.p.y, hit.mode, hit.id]).toEqual([0, 15, SNAP.PER, ids[1]])
  })

  it('INS: the insertion point of a block reference, ranked after QUA', () => {
    const block = { name: 'B', x: 0, y: 0, entities: [{ type: 'line', layer: 0, x0: 0, y0: 0, x1: 1, y1: 0 }] } as const
    const { doc, index, ids } = setup([{ type: 'insert', layer: 0, block, x: 2, y: 3, sx: 1, sy: 1, rotation: 0, cols: 1, rows: 1, dx: 0, dy: 0 }])
    // At the insertion point END (the line's start) is there too and wins; INS alone answers when asked alone.
    expect(snap(doc, index, { x: 2.1, y: 3 }, VIEW, SNAP.INS | SNAP.END, 10)).toMatchObject({ p: { x: 2, y: 3 }, mode: SNAP.END })
    expect(snap(doc, index, { x: 2.1, y: 3 }, VIEW, SNAP.INS, 10)).toMatchObject({ p: { x: 2, y: 3 }, mode: SNAP.INS, id: ids[0] })
  })

  it('NEA on a free curve (ellipse) lands on it at any zoom, not on a coarse flattening of it', () => {
    const { doc, index, ids } = setup([{ type: 'ellipse', layer: 0, cx: 0, cy: 0, mx: 1e6, my: 0, ratio: 0.5, t0: 0, t1: 0 }])
    // 1000 px per unit at a point of the ellipse; the cursor a few px off it.
    const t = 0.7
    const x = 1e6 * Math.cos(t)
    const y = 5e5 * Math.sin(t) + 0.004
    const deep: ViewState = { cx: x, cy: y, scale: 1000, width: 800, height: 600, dpr: 1 }
    const hit = snap(doc, index, { x, y }, deep, SNAP.NEA, 10)!
    expect(hit).toMatchObject({ mode: SNAP.NEA, id: ids[0] })
    expect(Math.abs(Math.hypot(hit.p.x / 1e6, hit.p.y / 5e5) - 1)).toBeLessThan(1e-11)
  })

  it('NEA: the nearest point of the object, only when no other snap is in reach', () => {
    const { doc, index, ids } = setup([line(0, 0, 10, 0), { type: 'arc', layer: 0, cx: 0, cy: 10, r: 2, a0: 0, a1: Math.PI }])
    const onLine = snap(doc, index, { x: 3.3, y: 0.4 }, VIEW, SNAP.NEA | SNAP.END, 10)!
    expect([r9(onLine.p.x), onLine.p.y, onLine.mode, onLine.id]).toEqual([3.3, 0, SNAP.NEA, ids[0]])
    expect(snap(doc, index, { x: 0.6, y: 0.2 }, VIEW, SNAP.NEA | SNAP.END, 10)).toMatchObject({ p: { x: 0, y: 0 }, mode: SNAP.END })
    const hit = snap(doc, index, { x: 0, y: 12.5 }, VIEW, SNAP.NEA, 10)!
    expect([hit.p.x, hit.p.y, hit.id]).toEqual([0, 12, ids[1]])
  })

  it('no modes, no snap', () => {
    const { doc, index } = setup([line(0, 0, 10, 0)])
    expect(snap(doc, index, { x: 0, y: 0 }, VIEW, 0, 10)).toBeNull()
  })
})
