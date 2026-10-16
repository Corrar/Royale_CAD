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

  it('no modes, no snap', () => {
    const { doc, index } = setup([line(0, 0, 10, 0)])
    expect(snap(doc, index, { x: 0, y: 0 }, VIEW, 0, 10)).toBeNull()
  })
})
