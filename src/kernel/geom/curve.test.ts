import { describe, expect, it } from 'vitest'
import { arcBBox, arcDistance, arcSweep, bezierEval, bezierFlatten, bezierSplit, bulgeToArc, ellipsePieces, flattenPieces, nurbsEval, piecesNearest, nurbsFlatten, nurbsPieces, nurbsProblem, onArc, type Nurbs } from './curve'
import { TAU, eq, normAngle } from './tol'
import { segmentDistance } from './vec'

const deg = (d: number): number => (d * Math.PI) / 180

describe('tolerance and angles', () => {
  it('eq is relative for large magnitudes and absolute near zero', () => {
    expect(eq(7_400_000, 7_400_000 + 1e-3)).toBe(true)
    expect(eq(7_400_000, 7_400_000 + 1e-2)).toBe(false)
    expect(eq(0, 1e-10)).toBe(true)
    expect(eq(0, 1e-8)).toBe(false)
  })

  it('normAngle maps to [0, 2π)', () => {
    expect(normAngle(-Math.PI / 2)).toBeCloseTo((3 * Math.PI) / 2, 12)
    expect(normAngle(5 * Math.PI)).toBeCloseTo(Math.PI, 12)
    expect(normAngle(TAU)).toBe(0)
    expect(normAngle(-1e-17)).toBe(0)
  })

  it('arcSweep is counter-clockwise in (0, 2π], equal angles giving a full circle', () => {
    expect(arcSweep(deg(350), deg(10))).toBeCloseTo(deg(20), 12)
    expect(arcSweep(deg(10), deg(350))).toBeCloseTo(deg(340), 12)
    expect(arcSweep(1, 1)).toBe(TAU)
  })

  it('onArc accepts negative sweeps', () => {
    expect(onArc(deg(45), 0, deg(90))).toBe(true)
    expect(onArc(deg(-45), 0, deg(90))).toBe(false)
    expect(onArc(deg(-45), 0, deg(-90))).toBe(true)
    expect(onArc(deg(200), 0, TAU)).toBe(true)
  })
})

describe('segmentDistance', () => {
  it('is perpendicular inside the span and to the nearest end beyond it', () => {
    expect(segmentDistance(5, 3, 0, 0, 10, 0)).toBe(3)
    expect(segmentDistance(13, 4, 0, 0, 10, 0)).toBe(5)
    expect(segmentDistance(-3, -4, 0, 0, 10, 0)).toBe(5)
    expect(segmentDistance(3, 4, 0, 0, 0, 0)).toBe(5)
  })
})

describe('bulgeToArc', () => {
  it('bulge 1 is a semicircle, counter-clockwise from the start', () => {
    const a = bulgeToArc({ x: 0, y: 0 }, { x: 2, y: 0 }, 1)!
    expect(a.cx).toBeCloseTo(1, 12)
    expect(a.cy).toBeCloseTo(0, 12)
    expect(a.r).toBeCloseTo(1, 12)
    expect(a.a0).toBeCloseTo(Math.PI, 12)
    expect(a.sweep).toBeCloseTo(Math.PI, 12)
  })

  it('negative bulge turns clockwise', () => {
    const a = bulgeToArc({ x: 0, y: 0 }, { x: 2, y: 0 }, -1)!
    expect(a.sweep).toBeCloseTo(-Math.PI, 12)
    // Mid-angle of a clockwise half turn from π lies at π/2: the top.
    expect(a.cy + a.r * Math.sin(a.a0 + a.sweep / 2)).toBeCloseTo(1, 12)
  })

  it('ends on both vertices for any bulge', () => {
    for (const b of [0.01, 0.3, -0.7, 1, 2.5, -4]) {
      const p = { x: 7_400_000.25, y: 9_100_000.5 }
      const q = { x: 7_400_003, y: 9_100_001 }
      const a = bulgeToArc(p, q, b)!
      const end = a.a0 + a.sweep
      expect(Math.abs(a.cx + a.r * Math.cos(a.a0) - p.x)).toBeLessThan(1e-8)
      expect(Math.abs(a.cy + a.r * Math.sin(a.a0) - p.y)).toBeLessThan(1e-8)
      expect(Math.abs(a.cx + a.r * Math.cos(end) - q.x)).toBeLessThan(1e-8)
      expect(Math.abs(a.cy + a.r * Math.sin(end) - q.y)).toBeLessThan(1e-8)
      expect(a.sweep).toBeCloseTo(4 * Math.atan(b), 12)
    }
  })

  it('a quarter turn has its centre on the corner', () => {
    const a = bulgeToArc({ x: 1, y: 0 }, { x: 0, y: 1 }, Math.tan(Math.PI / 8))!
    expect(a.cx).toBeCloseTo(0, 12)
    expect(a.cy).toBeCloseTo(0, 12)
    expect(a.r).toBeCloseTo(1, 12)
  })

  it('treats a bulge too small to bend the chord measurably as straight', () => {
    // Below 1e-8 the sagitta (|bulge|·chord/2) is smaller than the rounding error of an arc with that radius.
    expect(bulgeToArc({ x: 0, y: 0 }, { x: 10, y: 0 }, 1e-15)).toBeNull()
    expect(bulgeToArc({ x: 0, y: 0 }, { x: 10, y: 0 }, -5e-9)).toBeNull()
    const a = bulgeToArc({ x: 0, y: 0 }, { x: 10, y: 0 }, 2e-8)!
    expect(Math.abs(a.cx + a.r * Math.cos(a.a0))).toBeLessThan(1e-6)
  })

  it('is null for a zero bulge or a zero chord', () => {
    expect(bulgeToArc({ x: 0, y: 0 }, { x: 1, y: 0 }, 0)).toBeNull()
    expect(bulgeToArc({ x: 1, y: 1 }, { x: 1, y: 1 }, 1)).toBeNull()
  })
})

describe('arcBBox', () => {
  it('includes the quadrant point when the arc crosses 0°', () => {
    const b = arcBBox(0, 0, 1, deg(350), deg(20))
    expect(b.maxX).toBe(1)
    expect(b.minX).toBeCloseTo(Math.cos(deg(10)), 12)
    expect(b.minY).toBeCloseTo(-Math.sin(deg(10)), 12)
    expect(b.maxY).toBeCloseTo(Math.sin(deg(10)), 12)
  })

  it('is the full square for a circle and handles negative sweeps', () => {
    expect(arcBBox(5, 6, 2, 0, TAU)).toEqual({ minX: 3, minY: 4, maxX: 7, maxY: 8 })
    const b = arcBBox(0, 0, 1, 0, -Math.PI / 2)
    expect([b.minX, b.minY, b.maxX, b.maxY].map((v) => Math.round(v * 1e12) / 1e12)).toEqual([0, -1, 1, 0])
  })
})

describe('arcDistance', () => {
  it('is radial inside the sweep and to the nearest end outside it', () => {
    expect(arcDistance(0, 3, 0, 0, 1, 0, Math.PI)).toBeCloseTo(2, 12)
    expect(arcDistance(0, -3, 0, 0, 1, 0, Math.PI)).toBeCloseTo(Math.hypot(1, 3), 12)
    expect(arcDistance(0, 0, 0, 0, 1, 0, TAU)).toBe(1)
  })
})

/** The distance from (x, y) to the polyline pts (x, y pairs). */
function toPolyline(pts: Float64Array, x: number, y: number): number {
  let d = Infinity
  for (let i = 0; i + 3 < pts.length; i += 2) d = Math.min(d, segmentDistance(x, y, pts[i]!, pts[i + 1]!, pts[i + 2]!, pts[i + 3]!))
  return d
}

const S_CURVE = [0, 0, 3, 10, 7, -10, 10, 0]
const W = Math.SQRT1_2
/** The unit circle as a rational quadratic NURBS: nine control points, four arcs of 90°. */
const CIRCLE: Nurbs = {
  degree: 2,
  knots: [0, 0, 0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 1, 1, 1],
  ctrl: [1, 0, 1, 1, 0, 1, -1, 1, -1, 0, -1, -1, 0, -1, 1, -1, 1, 0],
  weights: [1, W, 1, W, 1, W, 1, W, 1],
}

describe('Bézier', () => {
  it('bezierEval: the ends exactly, and known midpoints', () => {
    expect(bezierEval([0, 0, 1, 2, 2, 0], 0.5)).toEqual({ x: 1, y: 1 })
    const c = [0, 0, 0, 1, 1, 1, 1, 0]
    expect(bezierEval(c, 0)).toEqual({ x: 0, y: 0 })
    expect(bezierEval(c, 1)).toEqual({ x: 1, y: 0 })
    const m = bezierEval(c, 0.5)
    expect(m.x).toBeCloseTo(0.5, 15)
    expect(m.y).toBeCloseTo(0.75, 15)
  })

  it('bezierSplit: each half retraces its part of the curve, and they meet', () => {
    const [a, b] = bezierSplit(S_CURVE, 0.3)
    for (const s of [0, 0.2, 0.5, 0.9, 1]) {
      const pa = bezierEval(a, s)
      const qa = bezierEval(S_CURVE, 0.3 * s)
      expect(Math.hypot(pa.x - qa.x, pa.y - qa.y)).toBeLessThan(1e-12)
      const pb = bezierEval(b, s)
      const qb = bezierEval(S_CURVE, 0.3 + 0.7 * s)
      expect(Math.hypot(pb.x - qb.x, pb.y - qb.y)).toBeLessThan(1e-12)
    }
    expect([a[6], a[7]]).toEqual([b[0], b[1]])
  })

  it('bezierFlatten: the curve stays within tol of the polyline, with more points as tol shrinks', () => {
    let last = 0
    for (const tol of [0.1, 0.01, 0.001]) {
      const pts = bezierFlatten(S_CURVE, tol)
      expect([pts[0], pts[1], pts.at(-2), pts.at(-1)]).toEqual([0, 0, 10, 0])
      for (let k = 0; k <= 1000; k++) {
        const p = bezierEval(S_CURVE, k / 1000)
        expect(toPolyline(pts, p.x, p.y)).toBeLessThanOrEqual(tol)
      }
      expect(pts.length).toBeGreaterThan(last)
      last = pts.length
    }
    expect(bezierFlatten([0, 0, 1, 0, 2, 0, 3, 0], 0.001)).toEqual(new Float64Array([0, 0, 3, 0]))
    // On its chord's line but past its end: not flat.
    const back = bezierFlatten([0, 0, 2, 0, 1, 0], 0.001)
    expect(Math.max(...back.filter((_, i) => i % 2 === 0))).toBeCloseTo(4 / 3, 2)
  })
})

describe('NURBS', () => {
  it('nurbsEval: one span with end knots of full multiplicity is the Bézier curve', () => {
    const s: Nurbs = { degree: 3, knots: [0, 0, 0, 0, 1, 1, 1, 1], ctrl: S_CURVE, weights: null }
    for (const t of [0, 0.1, 0.37, 0.5, 0.99, 1]) {
      const p = nurbsEval(s, t)
      const q = bezierEval(S_CURVE, t)
      expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeLessThan(1e-12)
    }
  })

  it('nurbsEval: the rational circle keeps its radius everywhere', () => {
    for (let k = 0; k <= 100; k++) {
      const p = nurbsEval(CIRCLE, k / 100)
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(1, 12)
    }
    const end = nurbsEval(CIRCLE, 1)
    expect(end.x).toBeCloseTo(1, 15)
    expect(end.y).toBeCloseTo(0, 15)
  })

  it('nurbsFlatten: the circle closes, its vertices are on it, and no chord strays more than tol', () => {
    const tol = 1e-3
    const pts = nurbsFlatten(CIRCLE, tol)
    expect(pts[0]).toBeCloseTo(pts.at(-2)!, 12)
    expect(pts[1]).toBeCloseTo(pts.at(-1)!, 12)
    for (let i = 0; i < pts.length; i += 2) expect(Math.hypot(pts[i]!, pts[i + 1]!)).toBeCloseTo(1, 12)
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const half = Math.hypot(pts[i + 2]! - pts[i]!, pts[i + 3]! - pts[i + 1]!) / 2
      expect(1 - Math.sqrt(1 - half * half)).toBeLessThanOrEqual(tol)
    }
    expect(pts.length / 2).toBeLessThan(200)
  })

  it('nurbsFlatten: unclamped knots and inner knots, within tol over the whole domain', () => {
    const cases: [Nurbs, number, number][] = [
      // A uniform cubic B-spline: its domain is [3, 4], away from the control polygon's ends.
      [{ degree: 3, knots: [0, 1, 2, 3, 4, 5, 6, 7], ctrl: [0, 0, 1, 3, 3, 3, 4, 0], weights: null }, 3, 4],
      [{ degree: 2, knots: [0, 0, 0, 1, 2, 2, 2], ctrl: [0, 0, 2, 4, 5, -1, 8, 2], weights: [1, 3, 0.5, 1] }, 0, 2],
      [{ degree: 3, knots: [0, 0, 0, 0, 0.3, 0.3, 0.7, 1, 1, 1, 1], ctrl: [0, 0, 1, 5, 4, 6, 6, -2, 9, 1, 12, 0, 13, 4], weights: null }, 0, 1],
    ]
    for (const [s, a, b] of cases) {
      const tol = 1e-4
      const pts = nurbsFlatten(s, tol)
      const first = nurbsEval(s, a)
      const end = nurbsEval(s, b)
      expect(Math.hypot(pts[0]! - first.x, pts[1]! - first.y)).toBeLessThan(1e-12)
      expect(Math.hypot(pts.at(-2)! - end.x, pts.at(-1)! - end.y)).toBeLessThan(1e-12)
      for (let k = 0; k <= 2000; k++) {
        const p = nurbsEval(s, a + ((b - a) * k) / 2000)
        expect(toPolyline(pts, p.x, p.y)).toBeLessThanOrEqual(tol)
      }
    }
  })

  it('nurbsProblem says what is wrong with a curve, and the functions refuse it', () => {
    const ok: Nurbs = { degree: 2, knots: [0, 0, 0, 1, 1, 1], ctrl: [0, 0, 1, 1, 2, 0], weights: null }
    expect(nurbsProblem(ok)).toBeNull()
    expect(nurbsProblem({ ...ok, degree: 0 })).toMatch(/degree/)
    expect(nurbsProblem({ ...ok, knots: [0, 0, 0, 1, 1] })).toMatch(/need 6 knots/)
    expect(nurbsProblem({ ...ok, knots: [0, 0, 1, 0.5, 1, 1] })).toMatch(/decrease/)
    expect(nurbsProblem({ ...ok, weights: [1, 0, 1] })).toMatch(/weight/)
    expect(nurbsProblem({ ...ok, knots: [0, 0, 0, 1, 2, 3] })).toBeNull() // unclamped at the end
    expect(nurbsProblem({ ...ok, knots: [1, 1, 1, 1, 1, 1] })).toMatch(/empty domain/)
    expect(nurbsProblem({ ...ok, ctrl: [0, 0, NaN, 1, 2, 0] })).toMatch(/finite/)
    expect(() => nurbsEval({ ...ok, weights: [1, -1, 1] }, 0.5)).toThrow(RangeError)
    expect(() => nurbsFlatten(ok, 0)).toThrow(RangeError)
  })

  it('nurbsFlatten: degree 1 is its control polygon', () => {
    const s: Nurbs = { degree: 1, knots: [0, 0, 1, 2, 3, 3], ctrl: [0, 0, 1, 1, 2, 0, 3, 1], weights: null }
    expect(nurbsFlatten(s, 0.01)).toEqual(new Float64Array([0, 0, 1, 1, 2, 0, 3, 1]))
  })
})

describe('pieces and chords', () => {
  const chordsOf = (pieces: Float64Array[], tol: number, clip: Parameters<typeof flattenPieces>[2] = null): number[][] => {
    const out: number[][] = []
    flattenPieces(pieces, tol, clip, (x0, y0, x1, y1) => out.push([x0, y0, x1, y1]))
    return out
  }

  it('flattenPieces: the chords of the whole curve join end to end, as nurbsFlatten has them', () => {
    const chords = chordsOf(nurbsPieces(CIRCLE), 1e-3)
    const pts = nurbsFlatten(CIRCLE, 1e-3)
    expect(chords).toHaveLength(pts.length / 2 - 1)
    chords.forEach((c, k) => expect(c).toEqual([pts[2 * k], pts[2 * k + 1], pts[2 * k + 2], pts[2 * k + 3]]))
  })

  it('flattenPieces: with a clip, only the parts that can reach it, at the same tolerance', () => {
    const clip = { minX: 0.9, minY: -0.1, maxX: 1.1, maxY: 0.1 }
    const all = chordsOf(nurbsPieces(CIRCLE), 1e-6)
    const near = chordsOf(nurbsPieces(CIRCLE), 1e-6, clip)
    expect(near.length).toBeGreaterThan(0)
    expect(near.length).toBeLessThan(all.length / 4)
    // Every chord that touches the clip is still there.
    const touches = (c: number[]): boolean => Math.max(c[0]!, c[2]!) >= clip.minX && Math.min(c[1]!, c[3]!) <= clip.maxY && Math.max(c[1]!, c[3]!) >= clip.minY
    for (const c of all.filter(touches)) expect(near).toContainEqual(c)
  })

  it('ellipsePieces: every chord end on the ellipse, chords within tol, from the start to the end of the sweep', () => {
    const [cx, cy, mx, my, ratio] = [7_400_000, 9_100_000, 30, 40, 0.4]
    const len = Math.hypot(mx, my)
    const at = (t: number): [number, number] => [cx + mx * Math.cos(t) - ratio * my * Math.sin(t), cy + my * Math.cos(t) + ratio * mx * Math.sin(t)]
    for (const [t0, sweep] of [[0.3, 2.5], [5, -4], [0, 2 * Math.PI]] as const) {
      const tol = 1e-4
      const chords = chordsOf(ellipsePieces(cx, cy, mx, my, ratio, t0, sweep), tol)
      for (const c of chords) {
        for (const [x, y] of [[c[0]!, c[1]!], [c[2]!, c[3]!]]) {
          const u = ((x - cx) * mx + (y - cy) * my) / (len * len)
          const v = (-(x - cx) * my + (y - cy) * mx) / (ratio * len * len)
          expect(u * u + v * v).toBeCloseTo(1, 9)
        }
      }
      const [sx, sy] = at(t0)
      const [ex, ey] = at(t0 + sweep)
      expect(Math.hypot(chords[0]![0]! - sx, chords[0]![1]! - sy)).toBeLessThan(1e-6)
      expect(Math.hypot(chords.at(-1)![2]! - ex, chords.at(-1)![3]! - ey)).toBeLessThan(1e-6)
      for (let k = 0; k <= 500; k++) {
        const [x, y] = at(t0 + (sweep * k) / 500)
        const d = Math.min(...chords.map((c) => segmentDistance(x, y, c[0]!, c[1]!, c[2]!, c[3]!)))
        expect(d).toBeLessThanOrEqual(tol * (1 + 1e-6))
      }
    }
  })
})

describe('piecesNearest', () => {
  it('finds the nearest point of a curve to far better than a coarse flattening, near and far, at any scale', () => {
    // A circle of radius 1e6 around (7.4e6, 9.1e6): the exact answer is known.
    const [cx, cy, R] = [7_400_000, 9_100_000, 1e6]
    const pieces = ellipsePieces(cx, cy, R, 0, 1, 0.2, 5)
    const near = R + 0.001
    for (const [x, y] of [[cx + near * Math.cos(1), cy + near * Math.sin(1)], [cx, cy + 3 * R], [cx + 0.5 * R, cy + 0.5 * R], [cx + R * Math.cos(3), cy + R * Math.sin(3) - 0.25]]) {
      const n = piecesNearest(pieces, x!, y!, R)
      const d = Math.abs(Math.hypot(x! - cx, y! - cy) - R)
      expect(Math.abs(n.d - d)).toBeLessThanOrEqual(1e-6 * Math.max(d, 1))
      expect(Math.abs(Math.hypot(n.x - cx, n.y - cy) - R)).toBeLessThanOrEqual(1e-6 * Math.max(d, 1))
    }
    // Past the end of the arc, the end is nearest.
    const end = piecesNearest(pieces, cx + R * 1.1, cy - 0.01, R)
    expect(Math.hypot(end.x - (cx + R * Math.cos(0.2)), end.y - (cy + R * Math.sin(0.2)))).toBeLessThan(1e-3)
  })
})
