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

  it('INT near two long polylines looks only at the pieces in reach: fast, and right', () => {
    const n = 5000
    const wave = (dy: number): Draft => {
      const pts = new Float64Array(2 * n)
      for (let k = 0; k < n; k++) {
        pts[2 * k] = k * 0.1 - 250
        pts[2 * k + 1] = dy + (k % 2 === 0 ? 0 : 0.01)
      }
      return { type: 'polyline', layer: 0, pts, bulges: null, closed: false }
    }
    // A third, steep polyline crosses the two near the cursor.
    const cross: Draft = { type: 'polyline', layer: 0, pts: Float64Array.of(0.03, -5, 0.03, 5), bulges: null, closed: false }
    const { doc, index } = setup([wave(0), wave(0.5), cross])
    const t0 = performance.now()
    const hit = snap(doc, index, { x: 0.05, y: 0.02 }, VIEW, SNAP.INT, 10)
    expect(performance.now() - t0).toBeLessThan(200)
    expect(hit).toMatchObject({ mode: SNAP.INT })
    expect(hit!.p.x).toBeCloseTo(0.03, 9)
  })

  it('INT: where a polyline crosses itself, open or closed, and at its corners, as separate lines would', () => {
    const app = SNAP.END | SNAP.MID | SNAP.CEN | SNAP.INT | SNAP.PER
    const open = setup([{ type: 'polyline', layer: 0, pts: Float64Array.of(0, 0, 10, 10, 10, 0, 0, 6), bulges: null, closed: false }])
    for (const modes of [SNAP.INT, app]) {
      const hit = snap(open.doc, open.index, { x: 3.8, y: 3.7 }, VIEW, modes, 10)!
      expect([r9(hit.p.x), r9(hit.p.y), hit.mode, hit.id]).toEqual([3.75, 3.75, SNAP.INT, open.ids[0]])
    }
    // A bow tie, closed: its first and third sides cross.
    const bow = setup([{ type: 'polyline', layer: 0, pts: Float64Array.of(0, 0, 10, 6, 10, 0, 0, 10), bulges: null, closed: true }])
    const hit = snap(bow.doc, bow.index, { x: 6.3, y: 3.7 }, VIEW, SNAP.INT, 10)!
    expect([r9(hit.p.x), r9(hit.p.y), hit.mode]).toEqual([6.25, 3.75, SNAP.INT])
    // A corner is where two of its pieces meet; END, asked too, wins the tie there.
    expect(snap(open.doc, open.index, { x: 9.7, y: 9.6 }, VIEW, SNAP.INT, 10)).toMatchObject({ p: { x: 10, y: 10 }, mode: SNAP.INT })
    expect(snap(open.doc, open.index, { x: 9.7, y: 9.6 }, VIEW, app, 10)).toMatchObject({ p: { x: 10, y: 10 }, mode: SNAP.END })
    // A lone line or circle never meets itself.
    const lone = setup([line(0, 0, 10, 0), { type: 'circle', layer: 0, cx: 0, cy: 20, r: 5 }])
    expect(snap(lone.doc, lone.index, { x: 4, y: 0.2 }, VIEW, SNAP.INT, 10)).toBeNull()
    expect(snap(lone.doc, lone.index, { x: 5, y: 20.2 }, VIEW, SNAP.INT, 10)).toBeNull()
  })

  it('PER: no zero-length perpendicular when the base lies on the object', () => {
    const { doc, index } = setup([line(0, 0, 10, 0)])
    expect(snap(doc, index, { x: 3, y: 0.05 }, VIEW, SNAP.PER, 10, { x: 0, y: 0 })).toBeNull()
    expect(snap(doc, index, { x: 3, y: 0.05 }, VIEW, SNAP.PER, 10, { x: 4, y: 0 })).toBeNull()
    expect(snap(doc, index, { x: 3, y: 0.05 }, VIEW, SNAP.PER, 10, { x: 4, y: 2 })).toMatchObject({ p: { x: 4, y: 0 }, mode: SNAP.PER })
  })

  it('PER and CEN on a polyline answer for the piece under the cursor only', () => {
    // A rectangle: the foot on the left side is nearer the cursor than the one on the bottom it is over.
    const rect: Draft = { type: 'polyline', layer: 0, pts: Float64Array.of(0, 0, 10, 0, 10, 10, 0, 10), bulges: null, closed: true }
    const a = setup([rect])
    expect(snap(a.doc, a.index, { x: 1.6, y: 0.05 }, VIEW, SNAP.PER, 10, { x: 5, y: 1 })).toMatchObject({ p: { x: 5, y: 0 }, mode: SNAP.PER })
    // A rounded rectangle: over a straight side, no fillet's centre.
    const t = Math.tan(Math.PI / 8)
    const rounded: Draft = {
      type: 'polyline', layer: 0, closed: true,
      pts: Float64Array.of(1, 0, 19, 0, 20, 1, 20, 9, 19, 10, 1, 10, 0, 9, 0, 1),
      bulges: Float64Array.of(0, t, 0, t, 0, t, 0, t),
    }
    const b = setup([rounded])
    expect(snap(b.doc, b.index, { x: 6, y: 0.1 }, VIEW, SNAP.CEN, 10)).toBeNull()
    expect(snap(b.doc, b.index, { x: 19.75, y: 0.3 }, VIEW, SNAP.CEN, 10)).toMatchObject({ p: { x: 19, y: 1 }, mode: SNAP.CEN })
  })

  it('NEA on a single-vertex polyline is the vertex', () => {
    const { doc, index } = setup([{ type: 'polyline', layer: 0, pts: Float64Array.of(1, 1), bulges: null, closed: false }])
    expect(snap(doc, index, { x: 1.3, y: 1.2 }, VIEW, SNAP.NEA, 10)).toMatchObject({ p: { x: 1, y: 1 }, mode: SNAP.NEA })
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

  it('NEA and PER on a solid find its outline within the aperture; a line over it, the line', () => {
    const fill: Draft = { type: 'solid', layer: 0, x0: 0, y0: 0, x1: 20, y1: 0, x2: 0, y2: 20, x3: 20, y3: 20 }
    const { doc, index, ids } = setup([line(2, 10, 18, 10), fill])
    // Near the outline, on it; deep inside, off the line and the outline, nothing.
    const edge = snap(doc, index, { x: 19.6, y: 5 }, VIEW, SNAP.NEA, 10)!
    expect([edge.p.x, edge.p.y, edge.id]).toEqual([20, 5, ids[1]])
    expect(snap(doc, index, { x: 6, y: 4 }, VIEW, SNAP.NEA, 10)).toBeNull()
    // Not the diagonal (20, 0)-(0, 20) that splits the fill.
    expect(snap(doc, index, { x: 13, y: 7.4 }, VIEW, SNAP.NEA, 10)).toBeNull()
    const over = snap(doc, index, { x: 7, y: 10.5 }, VIEW, SNAP.NEA, 10)!
    expect([over.p.x, over.p.y, over.id]).toEqual([7, 10, ids[0]])
    // In a block too.
    const block = { name: 'S', x: 0, y: 0, entities: [{ ...fill, layer: 0 }] }
    const ins = setup([{ type: 'insert', layer: 0, block, x: 100, y: 0, sx: 1, sy: 1, rotation: 0, cols: 1, rows: 1, dx: 0, dy: 0 } as Draft])
    expect(snap(ins.doc, ins.index, { x: 110, y: 19.5 }, VIEW, SNAP.NEA, 10)).toMatchObject({ p: { x: 110, y: 20 } })
    // PER: feet on the outline edges under the cursor, not on the diagonal.
    const per = snap(doc, index, { x: 19.8, y: 6 }, VIEW, SNAP.PER, 10, { x: 30, y: 4 })!
    expect([per.p.x, per.p.y, per.mode]).toEqual([20, 4, SNAP.PER])
    expect(snap(doc, index, { x: 13, y: 7.4 }, VIEW, SNAP.PER, 10, { x: 30, y: 4 })).toBeNull()
  })

  it('no modes, no snap', () => {
    const { doc, index } = setup([line(0, 0, 10, 0)])
    expect(snap(doc, index, { x: 0, y: 0 }, VIEW, 0, 10)).toBeNull()
  })
})
