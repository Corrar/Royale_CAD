import { TAU, normAngle } from './tol'
import { bboxAdd, segmentDistance, type BBox, type Vec2 } from './vec'

/** sweep is signed: positive turns counter-clockwise from a0. */
export interface ArcGeom { cx: number; cy: number; r: number; a0: number; sweep: number }

/** Counter-clockwise sweep from a0 to a1 in (0, 2π]; equal angles mean a full circle. */
export function arcSweep(a0: number, a1: number): number {
  const s = normAngle(a1 - a0)
  return s === 0 ? TAU : s
}

/** Whether direction a lies on the arc that starts at a0 and turns by sweep (either sign). */
export function onArc(a: number, a0: number, sweep: number): boolean {
  if (Math.abs(sweep) >= TAU) return true
  return sweep >= 0 ? normAngle(a - a0) <= sweep : normAngle(a0 - a) <= -sweep
}

export function arcBBox(cx: number, cy: number, r: number, a0: number, sweep: number): BBox {
  const b: BBox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  bboxAdd(b, cx + r * Math.cos(a0), cy + r * Math.sin(a0))
  bboxAdd(b, cx + r * Math.cos(a0 + sweep), cy + r * Math.sin(a0 + sweep))
  // The quadrant points are exact, so a circle gives an exact square.
  if (onArc(0, a0, sweep)) bboxAdd(b, cx + r, cy)
  if (onArc(Math.PI / 2, a0, sweep)) bboxAdd(b, cx, cy + r)
  if (onArc(Math.PI, a0, sweep)) bboxAdd(b, cx - r, cy)
  if (onArc((3 * Math.PI) / 2, a0, sweep)) bboxAdd(b, cx, cy - r)
  return b
}

/** The quadrant points (0°, 90°, 180°, 270°) the arc passes through, in that order; exact, not via cos/sin. */
export function arcQuadrants(cx: number, cy: number, r: number, a0: number, sweep: number, out: (x: number, y: number) => void): void {
  if (onArc(0, a0, sweep)) out(cx + r, cy)
  if (onArc(Math.PI / 2, a0, sweep)) out(cx, cy + r)
  if (onArc(Math.PI, a0, sweep)) out(cx - r, cy)
  if (onArc((3 * Math.PI) / 2, a0, sweep)) out(cx, cy - r)
}

export function arcDistance(px: number, py: number, cx: number, cy: number, r: number, a0: number, sweep: number): number {
  const dx = px - cx
  const dy = py - cy
  if (onArc(Math.atan2(dy, dx), a0, sweep)) return Math.abs(Math.hypot(dx, dy) - r)
  const a1 = a0 + sweep
  return Math.min(
    Math.hypot(px - cx - r * Math.cos(a0), py - cy - r * Math.sin(a0)),
    Math.hypot(px - cx - r * Math.cos(a1), py - cy - r * Math.sin(a1)),
  )
}

/**
 * Below this a bulge is straight. Treating it so errs by the sagitta, |bulge|·chord/2; keeping the arc errs by
 * the rounding of a centre ~chord/(4·|bulge|) away, ~chord·1e-16/|bulge|. The two meet near 1.5e-8.
 */
export const STRAIGHT_BULGE = 1e-8

/**
 * Arc from a to b for a polyline bulge (tan of a quarter of the included angle, positive counter-clockwise).
 * Null when the piece is straight: a bulge under STRAIGHT_BULGE, or a zero chord.
 */
export function bulgeToArc(a: Vec2, b: Vec2, bulge: number): ArcGeom | null {
  const dx = b.x - a.x
  const dy = b.y - a.y
  if (!(Math.abs(bulge) >= STRAIGHT_BULGE) || (dx === 0 && dy === 0)) return null
  // The centre sits on the chord's perpendicular bisector at (c/2)·cot(θ/2), with cot(θ/2) = (1 − bulge²) / (2·bulge).
  const k = (1 - bulge * bulge) / (4 * bulge)
  const cx = (a.x + b.x) / 2 - dy * k
  const cy = (a.y + b.y) / 2 + dx * k
  const r = (Math.hypot(dx, dy) * (1 + bulge * bulge)) / (4 * Math.abs(bulge))
  return { cx, cy, r, a0: Math.atan2(a.y - cy, a.x - cx), sweep: 4 * Math.atan(bulge) }
}

/**
 * The arc from p1 through p2 to p3: sweep positive when that turn is counter-clockwise. Null when the points are
 * collinear (or two coincide). Computed from p1, so large coordinates keep their small digits.
 */
export function arcThrough(p1: Vec2, p2: Vec2, p3: Vec2): ArcGeom | null {
  const bx = p2.x - p1.x
  const by = p2.y - p1.y
  const cx = p3.x - p1.x
  const cy = p3.y - p1.y
  const d = 2 * (bx * cy - by * cx)
  const scale = Math.max(Math.hypot(bx, by), Math.hypot(cx, cy))
  if (!(Math.abs(d) > 1e-12 * scale * scale)) return null
  const b2 = bx * bx + by * by
  const c2 = cx * cx + cy * cy
  const ux = (cy * b2 - by * c2) / d
  const uy = (bx * c2 - cx * b2) / d
  const a0 = Math.atan2(-uy, -ux)
  const a3 = Math.atan2(cy - uy, cx - ux)
  const sweep = d > 0 ? normAngle(a3 - a0) : -normAngle(a0 - a3)
  return { cx: p1.x + ux, cy: p1.y + uy, r: Math.hypot(ux, uy), a0, sweep }
}

// --- Bézier and NURBS ------------------------------------------------------------------------------------------

/**
 * A NURBS curve in the plane. The knots are non-decreasing, as many as the control points plus degree + 1; the
 * curve runs over [knots[degree], knots[knots.length − degree − 1]] (nurbsDomain).
 */
export interface Nurbs {
  degree: number
  knots: ArrayLike<number>
  /** Control points as x, y pairs. */
  ctrl: ArrayLike<number>
  /** One per control point, each > 0; null when all are 1. */
  weights: ArrayLike<number> | null
}

/** Halvings of one flat piece at most: 2^30 pieces would be far below any tolerance that makes sense. */
const MAX_DEPTH = 30

const lerp = (a: number, b: number, t: number): number => (1 - t) * a + t * b

/** De Casteljau on points of `dim` numbers each: the two halves at t, which share the point at t. */
function splitAt(p: Float64Array, dim: number, t: number): [Float64Array, Float64Array] {
  const n = p.length / dim
  const left = new Float64Array(p.length)
  const right = new Float64Array(p.length)
  const v = p.slice()
  // Round r leaves n − r points in v; the first goes left, the last right.
  for (let r = 0; r < n; r++) {
    for (let d = 0; d < dim; d++) {
      left[r * dim + d] = v[d]!
      right[(n - 1 - r) * dim + d] = v[(n - 1 - r) * dim + d]!
    }
    for (let i = 0; i < (n - 1 - r) * dim; i++) v[i] = lerp(v[i]!, v[i + dim]!, t)
  }
  return [left, right]
}

/** The point at t ∈ [0, 1] of the Bézier curve with control points ctrl (x, y pairs); degree = points − 1. */
export function bezierEval(ctrl: ArrayLike<number>, t: number): Vec2 {
  const v = Float64Array.from(ctrl)
  for (let n = v.length >> 1; n > 1; n--) for (let i = 0; i < 2 * (n - 1); i++) v[i] = lerp(v[i]!, v[i + 2]!, t)
  return { x: v[0]!, y: v[1]! }
}

/** The control points of the parts [0, t] and [t, 1] of a Bézier curve. */
export function bezierSplit(ctrl: ArrayLike<number>, t: number): [Float64Array, Float64Array] {
  return splitAt(Float64Array.from(ctrl), 2, t)
}

/** Receives a chord of a flattened curve. */
export type ChordSink = (x0: number, y0: number, x1: number, y1: number) => void

/**
 * Flattens a rational Bézier piece given as (wx, wy, w) triples into chords. Flat when every control point is
 * within tol of the chord: with positive weights the curve lies in their convex hull, so it is within tol of the
 * chord too. A part whose control points all lie outside clip is left out, for the same reason.
 */
function chordsOf(p: Float64Array, tol: number, clip: BBox | null, out: ChordSink, depth: number): void {
  const n = p.length / 3
  if (clip) {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (let i = 0; i < n; i++) {
      const x = p[3 * i]! / p[3 * i + 2]!
      const y = p[3 * i + 1]! / p[3 * i + 2]!
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
    if (maxX < clip.minX || minX > clip.maxX || maxY < clip.minY || minY > clip.maxY) return
  }
  const x0 = p[0]! / p[2]!
  const y0 = p[1]! / p[2]!
  const x1 = p[3 * n - 3]! / p[3 * n - 1]!
  const y1 = p[3 * n - 2]! / p[3 * n - 1]!
  let flat = true
  for (let i = 1; i < n - 1 && flat; i++) flat = segmentDistance(p[3 * i]! / p[3 * i + 2]!, p[3 * i + 1]! / p[3 * i + 2]!, x0, y0, x1, y1) <= tol
  if (flat || depth >= MAX_DEPTH) return out(x0, y0, x1, y1)
  const [a, b] = splitAt(p, 3, 0.5)
  chordsOf(a, tol, clip, out, depth + 1)
  chordsOf(b, tol, clip, out, depth + 1)
}

/** Pushes the chords' far ends: a polyline after its first point. */
const pushEnds = (out: number[]): ChordSink => (_x0, _y0, x1, y1) => void out.push(x1, y1)

/**
 * The chords of rational Bézier pieces ((wx, wy, w) triples, in order along a curve) flattened to tol > 0, their
 * ends on the curve. With a clip, only the parts that can reach it.
 */
export function flattenPieces(pieces: readonly Float64Array[], tol: number, clip: BBox | null, out: ChordSink): void {
  checkTol(tol)
  for (const p of pieces) chordsOf(p, tol, clip, out, 0)
}

function checkTol(tol: number): void {
  if (!(tol > 0 && Number.isFinite(tol))) throw new RangeError(`flattening tolerance must be > 0, got ${tol}`)
}

/** A polyline (x, y pairs, ends included) within tol of the Bézier curve, its points on the curve. */
export function bezierFlatten(ctrl: ArrayLike<number>, tol: number): Float64Array {
  checkTol(tol)
  const n = ctrl.length >> 1
  const p = new Float64Array(3 * n)
  for (let i = 0; i < n; i++) p.set([ctrl[2 * i]!, ctrl[2 * i + 1]!, 1], 3 * i)
  const out = [ctrl[0]!, ctrl[1]!]
  chordsOf(p, tol, null, pushEnds(out), 0)
  return Float64Array.from(out)
}

/** Why s is not a NURBS curve these functions can take, or null. */
export function nurbsProblem(s: Nurbs): string | null {
  const p = s.degree
  const count = s.ctrl.length / 2
  if (!(Number.isInteger(p) && p >= 1)) return `degree must be an integer ≥ 1, got ${p}`
  if (!Number.isInteger(count) || count < p + 1) return `a curve of degree ${p} needs at least ${p + 1} control points, got ${count}`
  if (s.knots.length !== count + p + 1) return `${count} control points of degree ${p} need ${count + p + 1} knots, got ${s.knots.length}`
  for (let i = 0; i < s.ctrl.length; i++) if (!Number.isFinite(s.ctrl[i]!)) return 'a control point is not a finite number'
  for (let i = 0; i < s.knots.length; i++) {
    if (!Number.isFinite(s.knots[i]!)) return 'a knot is not a finite number'
    if (i > 0 && s.knots[i]! < s.knots[i - 1]!) return 'the knots decrease'
  }
  if (s.weights) {
    if (s.weights.length !== count) return `${count} control points need ${count} weights, got ${s.weights.length}`
    for (let i = 0; i < count; i++) if (!(s.weights[i]! > 0 && Number.isFinite(s.weights[i]!))) return 'a weight is not a number > 0'
  }
  const [a, b] = nurbsDomain(s)
  if (!(a < b)) return 'the curve has an empty domain'
  return null
}

function checkNurbs(s: Nurbs): void {
  const problem = nurbsProblem(s)
  if (problem) throw new RangeError(problem)
}

/** The parameter range the curve runs over. */
export const nurbsDomain = (s: Nurbs): [number, number] => [s.knots[s.degree]!, s.knots[s.knots.length - s.degree - 1]!]

/** The control points as (wx, wy, w) triples. */
function homogeneous(s: Nurbs): Float64Array {
  const n = s.ctrl.length >> 1
  const pw = new Float64Array(3 * n)
  for (let i = 0; i < n; i++) {
    const w = s.weights ? s.weights[i]! : 1
    pw[3 * i] = s.ctrl[2 * i]! * w
    pw[3 * i + 1] = s.ctrl[2 * i + 1]! * w
    pw[3 * i + 2] = w
  }
  return pw
}

/**
 * The knot span holding u, k with knots[k] ≤ u < knots[k + 1], among p … last (the last control point's index);
 * at the domain's end, the last span that is not empty.
 */
function spanOf(U: ArrayLike<number>, p: number, last: number, u: number): number {
  if (u >= U[last + 1]!) {
    let k = last
    while (k > p && !(U[k]! < U[k + 1]!)) k--
    return k
  }
  let lo = p
  let hi = last + 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (U[mid]! <= u) lo = mid
    else hi = mid
  }
  return lo
}

/** The point at u of the curve (de Boor's algorithm, on the weighted points); u is clamped to the domain. */
export function nurbsEval(s: Nurbs, u: number): Vec2 {
  checkNurbs(s)
  const p = s.degree
  const U = s.knots
  const pw = homogeneous(s)
  const [a, b] = nurbsDomain(s)
  u = Math.min(b, Math.max(a, u))
  const k = spanOf(U, p, pw.length / 3 - 1, u)
  const d = pw.slice(3 * (k - p), 3 * (k + 1))
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const i = j + k - p
      const alpha = (u - U[i]!) / (U[i + p + 1 - r]! - U[i]!)
      for (let c = 0; c < 3; c++) d[3 * j + c] = (1 - alpha) * d[3 * (j - 1) + c]! + alpha * d[3 * j + c]!
    }
  }
  return { x: d[3 * p]! / d[3 * p + 2]!, y: d[3 * p + 1]! / d[3 * p + 2]! }
}

/**
 * The curve as rational Bézier pieces of (wx, wy, w) triples, in order over the domain. Every knot of the domain
 * is inserted (Boehm) until it appears degree times: each non-empty span then has a Bézier piece of its own.
 */
export function nurbsPieces(s: Nurbs): Float64Array[] {
  checkNurbs(s)
  const p = s.degree
  const U = Array.from(s.knots)
  let pw = homogeneous(s)
  const [a, b] = nurbsDomain(s)
  const values = [...new Set(U.filter((v) => v >= a && v <= b))]
  for (const v of values) {
    for (let mult = U.filter((x) => x === v).length; mult < p; mult++) {
      const last = pw.length / 3 - 1
      // The span v falls in; at the end, the last one before it.
      let k = last
      while (v < b ? U[k]! > v : U[k]! >= v) k--
      const q = new Float64Array(pw.length + 3)
      q.set(pw.subarray(0, 3 * (k - p + 1)))
      for (let i = k - p + 1; i <= k; i++) {
        const t = (v - U[i]!) / (U[i + p]! - U[i]!)
        for (let c = 0; c < 3; c++) q[3 * i + c] = t * pw[3 * i + c]! + (1 - t) * pw[3 * (i - 1) + c]!
      }
      q.set(pw.subarray(3 * k), 3 * (k + 1))
      U.splice(k + 1, 0, v)
      pw = q
    }
  }
  const pieces: Float64Array[] = []
  const last = pw.length / 3 - 1
  for (let k = p; k <= last; k++) if (U[k]! < U[k + 1]!) pieces.push(pw.slice(3 * (k - p), 3 * (k + 1)))
  return pieces
}

/** A polyline (x, y pairs, ends included) within tol of the curve over its whole domain, its points on the curve. */
export function nurbsFlatten(s: Nurbs, tol: number): Float64Array {
  checkTol(tol)
  const pieces = nurbsPieces(s)
  const first = pieces[0]!
  const out = [first[0]! / first[2]!, first[1]! / first[2]!]
  flattenPieces(pieces, tol, null, pushEnds(out))
  return Float64Array.from(out)
}

/**
 * The elliptical arc c + M cos t + ratio·J(M) sin t (J turns 90° counter-clockwise), t from t0 turning by sweep
 * (signed), as rational quadratic Bézier pieces of at most 90° each: exact, the image of circular arcs.
 */
export function ellipsePieces(cx: number, cy: number, mx: number, my: number, ratio: number, t0: number, sweep: number): Float64Array[] {
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9))
  const h = sweep / n / 2
  const w = Math.cos(h)
  // (u, v) on the unit circle to the plane.
  const ax = (u: number, v: number): number => cx + mx * u - ratio * my * v
  const ay = (u: number, v: number): number => cy + my * u + ratio * mx * v
  const pieces: Float64Array[] = []
  for (let k = 0; k < n; k++) {
    const a = t0 + 2 * h * k
    const b = a + 2 * h
    const m = a + h
    const [u0, v0] = [Math.cos(a), Math.sin(a)]
    const [u1, v1] = [Math.cos(m) / w, Math.sin(m) / w]
    const [u2, v2] = [Math.cos(b), Math.sin(b)]
    pieces.push(Float64Array.of(ax(u0, v0), ay(u0, v0), 1, w * ax(u1, v1), w * ay(u1, v1), w, ax(u2, v2), ay(u2, v2), 1))
  }
  return pieces
}

/**
 * The point of a curve given as rational Bézier pieces nearest (x, y), and its distance; size is the curve's scale.
 * A coarse flattening bounds the distance, then only the parts within that bound are flattened again, finer each
 * round: the answer is good to a millionth of the distance (or 1e-12 of size) at any zoom.
 */
export function piecesNearest(pieces: readonly Float64Array[], x: number, y: number, size: number): Vec2 & { d: number } {
  let best = { x, y, d: Infinity }
  const take: ChordSink = (x0, y0, x1, y1) => {
    const dx = x1 - x0
    const dy = y1 - y0
    const len2 = dx * dx + dy * dy
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - x0) * dx + (y - y0) * dy) / len2)) : 0
    const px = x0 + t * dx
    const py = y0 + t * dy
    const d = Math.hypot(px - x, py - y)
    if (d < best.d) best = { x: px, y: py, d }
  }
  let tol = 1e-3 * size
  let clip: BBox | null = null
  for (;;) {
    best = { x, y, d: Infinity }
    for (const p of pieces) chordsOf(p, tol, clip, take, 0)
    const want = Math.max(best.d * 1e-6, size * 1e-12)
    if (tol <= want) return best
    // Every chord point is within tol of the curve: the nearest point is within d + tol.
    const reach = best.d + tol
    clip = { minX: x - reach, minY: y - reach, maxX: x + reach, maxY: y + reach }
    tol = Math.max(want, tol * 1e-3)
  }
}
