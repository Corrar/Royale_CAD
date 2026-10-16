import { describe, expect, it } from 'vitest'
import { nurbsEval } from '../geom/curve'
import { mirroring, rotation, segmentDistance, applyAffine, translation } from '../geom/vec'
import { typeOf } from './registry'
import { SNAP, type Ellipse, type Entity, type Spline } from './types'

/** The chords an entity draws with the default tolerance (tol 0), as [x0, y0, x1, y1]. */
function chords(e: Entity, tol = 0): number[][] {
  const out: number[][] = []
  typeOf(e).primitives(e, tol, {
    segment: (x0, y0, x1, y1) => out.push([x0, y0, x1, y1]),
    arc: () => {
      throw new Error('a free curve draws chords only')
    },
  })
  return out
}
const toChords = (cs: number[][], x: number, y: number): number => Math.min(...cs.map((c) => segmentDistance(x, y, c[0]!, c[1]!, c[2]!, c[3]!)))
const snaps = (e: Entity, modes: number): number[][] => {
  const out: number[][] = []
  typeOf(e).snapPoints!(e, modes, (x, y, mode) => out.push([Math.round(x * 1e9) / 1e9 + 0, Math.round(y * 1e9) / 1e9 + 0, mode]))
  return out
}

const ellipse = (t0: number, t1: number, extra: Partial<Ellipse> = {}): Ellipse => ({ type: 'ellipse', id: 1, layer: 0, cx: 10, cy: 20, mx: 6, my: 8, ratio: 0.5, t0, t1, ...extra })
/** The point at parameter t: c + M cos t + ratio·J(M) sin t. */
const on = (e: Ellipse, t: number): [number, number] => [e.cx + e.mx * Math.cos(t) - e.ratio * e.my * Math.sin(t), e.cy + e.my * Math.cos(t) + e.ratio * e.mx * Math.sin(t)]

describe('ellipse', () => {
  it('bbox: exact for the whole ellipse and for an arc', () => {
    const b = typeOf(ellipse(0, 0)).bbox(ellipse(0, 0))
    const hx = Math.sqrt(36 + 16)
    const hy = Math.sqrt(64 + 9)
    expect(b.minX).toBeCloseTo(10 - hx, 12)
    expect(b.maxX).toBeCloseTo(10 + hx, 12)
    expect(b.minY).toBeCloseTo(20 - hy, 12)
    expect(b.maxY).toBeCloseTo(20 + hy, 12)
    const e = ellipse(5.5, 2)
    const a = typeOf(e).bbox(e)
    const s = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
    for (let k = 0; k <= 20000; k++) {
      const [x, y] = on(e, 5.5 + ((2 * Math.PI - 5.5 + 2) * k) / 20000)
      s.minX = Math.min(s.minX, x)
      s.minY = Math.min(s.minY, y)
      s.maxX = Math.max(s.maxX, x)
      s.maxY = Math.max(s.maxY, y)
    }
    for (const k of ['minX', 'minY', 'maxX', 'maxY'] as const) expect(a[k]).toBeCloseTo(s[k], 6)
  })

  it('draws chords from start to end within 1e-4 of its size by default, finer when asked', () => {
    const e = ellipse(0.5, 4)
    for (const [tol, err] of [[0, 1e-3], [1e-6, 1e-6]] as const) {
      const cs = chords(e, tol)
      expect(cs[0]!.slice(0, 2).map((v, i) => v - on(e, 0.5)[i]!).every((d) => Math.abs(d) < 1e-9)).toBe(true)
      expect(cs.at(-1)!.slice(2).map((v, i) => v - on(e, 4)[i]!).every((d) => Math.abs(d) < 1e-9)).toBe(true)
      for (let k = 0; k <= 400; k++) expect(toChords(cs, ...on(e, 0.5 + (3.5 * k) / 400))).toBeLessThanOrEqual(err)
    }
  })

  it('distance: exact along the major axis, and to the nearest end past the arc', () => {
    const e = ellipse(0, 0)
    expect(typeOf(e).distance(e, { x: 10 + 9, y: 20 + 12 })).toBeCloseTo(5, 9)
    const arc = ellipse(0.5, 1)
    const [ex, ey] = on(arc, 0.5)
    expect(typeOf(arc).distance(arc, { x: 10 + 6 * 1.5, y: 20 + 8 * 1.5 })).toBeCloseTo(Math.hypot(19 - ex, 32 - ey), 9)
  })

  it('a mirror or a rotation moves every point of the curve with it', () => {
    const e = ellipse(0.5, 4)
    for (const m of [mirroring({ x: 0, y: 0 }, { x: 1, y: 2 }), rotation({ x: 3, y: -1 }, 70)]) {
      const t = typeOf(e).transform!(e, m)
      const cs = chords(t, 1e-7)
      for (let k = 0; k <= 50; k++) {
        const p = applyAffine(m, ...on(e, 0.5 + (3.5 * k) / 50))
        expect(toChords(cs, p.x, p.y)).toBeLessThan(1e-6)
      }
      expect(t.ratio).toBe(0.5)
    }
    const whole = typeOf(ellipse(0, 0)).transform!(ellipse(0, 0), mirroring({ x: 0, y: 0 }, { x: 0, y: 1 }))
    expect(whole.t0).toBe(whole.t1)
  })

  it('keeps its axis through a move far from the origin, and turns it exactly with a rotation', () => {
    const e = ellipse(0.5, 4, { cx: 500000.125, cy: 7400000.5, mx: 600.3, my: 800.7 })
    const moved = typeOf(e).transform!(e, translation(1, 1)) as Ellipse
    expect([moved.mx, moved.my]).toEqual([600.3, 800.7])
    const turned = typeOf(e).transform!(e, rotation({ x: 500000, y: 7400000 }, 90)) as Ellipse
    expect([turned.mx, turned.my]).toEqual([-800.7, 600.3])
  })

  it('snaps: END at both ends of an arc only, CEN, and QUA at the axis ends the arc passes', () => {
    expect(snaps(ellipse(0, 0), SNAP.END)).toEqual([])
    expect(snaps(ellipse(0, 0), SNAP.CEN)).toEqual([[10, 20, SNAP.CEN]])
    expect(snaps(ellipse(0, 0), SNAP.QUA)).toEqual([[16, 28, SNAP.QUA], [6, 23, SNAP.QUA], [4, 12, SNAP.QUA], [14, 17, SNAP.QUA]])
    const e = ellipse(0.5, 2)
    const round = (p: [number, number]): number[] => p.map((v) => Math.round(v * 1e9) / 1e9 + 0)
    expect(snaps(e, SNAP.END)).toEqual([[...round(on(e, 0.5)), SNAP.END], [...round(on(e, 2)), SNAP.END]])
    expect(snaps(e, SNAP.QUA)).toEqual([[6, 23, SNAP.QUA]])
  })

  it('validate: a positive major axis and a ratio in (0, 1]', () => {
    expect(typeOf(ellipse(0, 0)).validate!(ellipse(0, 0))).toBeUndefined()
    expect(typeOf(ellipse(0, 0)).validate!(ellipse(0, 0, { ratio: 0 }))).toMatch(/ratio/)
    expect(typeOf(ellipse(0, 0)).validate!(ellipse(0, 0, { ratio: 1.5 }))).toMatch(/ratio/)
    expect(typeOf(ellipse(0, 0)).validate!(ellipse(0, 0, { mx: 0, my: 0 }))).toMatch(/axis/)
  })
})

const spline = (extra: Partial<Spline> = {}): Spline => ({
  type: 'spline', id: 2, layer: 0, degree: 3, closed: false,
  knots: Float64Array.of(0, 0, 0, 0, 1, 2, 3, 3, 3, 3), ctrl: Float64Array.of(0, 0, 3, 5, 7, 4, 9, -2, 12, 1, 14, 6), weights: null, ...extra,
})

describe('spline', () => {
  it('bbox holds the curve, close to it; chords within 1e-4 of its size by default', () => {
    const s = spline({ weights: Float64Array.of(1, 2, 0.5, 1, 3, 1) })
    const b = typeOf(s).bbox(s)
    const tight = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
    const cs = chords(s)
    for (let k = 0; k <= 3000; k++) {
      const p = nurbsEval(s, (3 * k) / 3000)
      expect(p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY).toBe(true)
      tight.minX = Math.min(tight.minX, p.x)
      tight.minY = Math.min(tight.minY, p.y)
      tight.maxX = Math.max(tight.maxX, p.x)
      tight.maxY = Math.max(tight.maxY, p.y)
      expect(toChords(cs, p.x, p.y)).toBeLessThanOrEqual(1e-4 * Math.hypot(14, 8))
    }
    for (const k of ['minX', 'minY', 'maxX', 'maxY'] as const) expect(Math.abs(b[k] - tight[k])).toBeLessThan(1e-2)
  })

  it('distance agrees with dense sampling', () => {
    const s = spline()
    for (const p of [{ x: 3, y: 5 }, { x: 9, y: -2 }, { x: 20, y: 20 }, { x: 7, y: 2 }]) {
      let d = Infinity
      for (let k = 0; k <= 30000; k++) {
        const q = nurbsEval(s, (3 * k) / 30000)
        d = Math.min(d, Math.hypot(q.x - p.x, q.y - p.y))
      }
      expect(Math.abs(typeOf(s).distance(s, p) - d)).toBeLessThan(2e-6 * Math.max(d, 1))
    }
  })

  it('a transform moves the control points: the curve follows', () => {
    const s = spline()
    const m = rotation({ x: 1, y: 1 }, 33)
    const t = typeOf(s).transform!(s, m)
    for (const u of [0, 0.4, 1.7, 3]) {
      const a = applyAffine(m, nurbsEval(s, u).x, nurbsEval(s, u).y)
      const b = nurbsEval(t, u)
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1e-9)
    }
    expect(t.knots).toBe(s.knots)
  })

  it('snaps END at its ends; validate says what is wrong', () => {
    expect(snaps(spline(), SNAP.END | SNAP.CEN)).toEqual([[0, 0, SNAP.END], [14, 6, SNAP.END]])
    expect(typeOf(spline()).validate!(spline())).toBeUndefined()
    expect(typeOf(spline()).validate!(spline({ knots: Float64Array.of(0, 0, 0, 1, 2, 3, 3, 3) }))).toMatch(/knots/)
  })
})
