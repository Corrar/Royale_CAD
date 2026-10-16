import { arcDistance, arcSweep, bulgeToArc, type ArcGeom } from '../geom/curve'
import { TAU, normAngle } from '../geom/tol'
import { segmentDistance, type Vec2 } from '../geom/vec'
import { typeOf } from './registry'
import type { Arc, Circle, Entity, Line, Polyline } from './types'

/**
 * A curve walked by a parameter u from 0 to `end`: a line by the fraction of its length, an arc by the angle turned
 * from a0, a circle by its angle, a polyline by piece index plus the fraction of that piece. TRIM and EXTEND work
 * on parameters, the same way for every type.
 */
export interface Path {
  readonly end: number
  /** A closed path wraps around: u and u + end are the same point. */
  readonly closed: boolean
  /** The parameter of the point of the path nearest p. Past the end of a line or an arc, u < 0 or u > end. */
  param(p: Vec2): number
  /** How far u moves for the length tolerance, near u. */
  slack(u: number): number
  /**
   * The piece from u0 to u1, with u0 < u1 inside [0, end]; on a closed path u1 may pass end, by less than a turn.
   * Same id, layer and color: a circle gives an arc, a polyline an open polyline.
   */
  slice(u0: number, u1: number): Entity
}

/**
 * Lengths below this count as zero: past the rounding of an intersection computed near the entity (relative to
 * its size), and of its coordinates (relative to their magnitude).
 */
function lengthTol(e: Entity): number {
  const b = typeOf(e).bbox(e)
  const mag = Math.max(Math.abs(b.minX), Math.abs(b.maxX), Math.abs(b.minY), Math.abs(b.maxY))
  return 1e-8 * Math.max(1, Math.hypot(b.maxX - b.minX, b.maxY - b.minY), 1e-6 * mag)
}

/** a + u·(b − a), exact at u = 0 and u = 1. */
const lerp = (a: number, b: number, u: number): number => (u <= 0.5 ? a + u * (b - a) : b - (1 - u) * (b - a))

function linePath(e: Line, tol: number): Path {
  const dx = e.x1 - e.x0
  const dy = e.y1 - e.y0
  const len2 = dx * dx + dy * dy
  return {
    end: 1,
    closed: false,
    param: (p) => (len2 > 0 ? ((p.x - e.x0) * dx + (p.y - e.y0) * dy) / len2 : 0),
    slack: () => tol / Math.sqrt(len2),
    slice: (u0, u1) => ({ ...e, x0: lerp(e.x0, e.x1, u0), y0: lerp(e.y0, e.y1, u0), x1: lerp(e.x0, e.x1, u1), y1: lerp(e.y0, e.y1, u1) }),
  }
}

function arcPath(e: Arc, tol: number): Path {
  const sweep = arcSweep(e.a0, e.a1)
  return {
    end: sweep,
    closed: false,
    param(p) {
      const s = normAngle(Math.atan2(p.y - e.cy, p.x - e.cx) - e.a0)
      return s > sweep && s - sweep > TAU - s ? s - TAU : s
    },
    slack: () => tol / e.r,
    slice: (u0, u1) => ({ ...e, a0: u0 === 0 ? e.a0 : normAngle(e.a0 + u0), a1: u1 === sweep ? e.a1 : normAngle(e.a0 + u1) }),
  }
}

function circlePath(e: Circle, tol: number): Path {
  return {
    end: TAU,
    closed: true,
    param: (p) => normAngle(Math.atan2(p.y - e.cy, p.x - e.cx)),
    slack: () => tol / e.r,
    slice(u0, u1) {
      const { type: _type, ...rest } = e
      return { ...rest, type: 'arc', a0: normAngle(u0), a1: normAngle(u1) }
    },
  }
}

function polylinePath(e: Polyline, tol: number): Path {
  const { pts, bulges } = e
  const n = pts.length >> 1
  const m = e.closed ? n : n - 1
  const vertex = (k: number): Vec2 => ({ x: pts[2 * (k % n)]!, y: pts[2 * (k % n) + 1]! })
  /** Piece i as an arc, or null when straight (as the polyline draws it). */
  const arcOf = (i: number): ArcGeom | null => {
    const b = bulges?.[i] ?? 0
    return b !== 0 ? bulgeToArc(vertex(i), vertex(i + 1), b) : null
  }
  /** The point at fraction f of piece k (k may pass m on a closed path). */
  const pointOn = (k: number, f: number): Vec2 => {
    if (f === 0) return vertex(k)
    if (f === 1) return vertex(k + 1)
    const a = arcOf(k % m)
    if (a) return { x: a.cx + a.r * Math.cos(a.a0 + f * a.sweep), y: a.cy + a.r * Math.sin(a.a0 + f * a.sweep) }
    const p = vertex(k)
    const q = vertex(k + 1)
    return { x: lerp(p.x, q.x, f), y: lerp(p.y, q.y, f) }
  }
  const pieceAt = (u: number): number => Math.min(Math.floor(u), e.closed ? Infinity : m - 1)
  const slack = (u: number): number => {
    const i = pieceAt(Math.max(0, u)) % m
    const a = arcOf(i)
    const p = vertex(i)
    const q = vertex(i + 1)
    return tol / Math.max(a ? a.r * Math.abs(a.sweep) : Math.hypot(q.x - p.x, q.y - p.y), tol)
  }
  return {
    end: m,
    closed: e.closed,
    param(p) {
      let best = 0
      let bestD = Infinity
      for (let i = 0; i < m; i++) {
        const a = arcOf(i)
        let f: number
        let d: number
        if (a) {
          const turn = Math.abs(a.sweep)
          const angle = Math.atan2(p.y - a.cy, p.x - a.cx)
          const s = a.sweep >= 0 ? normAngle(angle - a.a0) : normAngle(a.a0 - angle)
          f = s <= turn ? s / turn : s - turn < TAU - s ? 1 : 0
          d = arcDistance(p.x, p.y, a.cx, a.cy, a.r, a.a0, a.sweep)
        } else {
          const v = vertex(i)
          const w = vertex(i + 1)
          const dx = w.x - v.x
          const dy = w.y - v.y
          const len2 = dx * dx + dy * dy
          f = len2 > 0 ? Math.min(1, Math.max(0, ((p.x - v.x) * dx + (p.y - v.y) * dy) / len2)) : 0
          d = segmentDistance(p.x, p.y, v.x, v.y, w.x, w.y)
        }
        if (d < bestD) {
          bestD = d
          best = i + f
        }
      }
      return best
    },
    slack,
    slice(u0, u1) {
      // Ends within tolerance of a vertex are that vertex, so no sliver piece is left behind.
      const snap = (u: number): number => (Math.abs(u - Math.round(u)) <= slack(u) ? Math.round(u) : u)
      let u = snap(u0)
      const stop = snap(u1)
      const start = pointOn(pieceAt(u), u - pieceAt(u))
      const xy = [start.x, start.y]
      const bs: number[] = []
      while (u < stop) {
        const k = Math.floor(u)
        const v = Math.min(k + 1, stop)
        const p = pointOn(k, v - k)
        const b = bulges?.[k % m] ?? 0
        // A part of an arc piece turns by the same fraction of its angle: bulge = tan(angle / 4).
        bs.push(b === 0 || v - u === 1 ? b : Math.tan(Math.atan(b) * (v - u)))
        xy.push(p.x, p.y)
        u = v
      }
      bs.push(0)
      return { ...e, pts: new Float64Array(xy), bulges: bs.some((b) => b !== 0) ? new Float64Array(bs) : null, closed: false }
    },
  }
}

/** The path of a curve; null for what has no length to walk (a point, an opaque entity). */
export function pathOf(e: Entity): Path | null {
  // Ellipses and splines wait for TRIM and EXTEND support of their own; a block is not trimmed, as in AutoCAD.
  if (e.type === 'point' || e.type === 'opaque' || e.type === 'ellipse' || e.type === 'spline' || e.type === 'insert') return null
  const tol = lengthTol(e)
  switch (e.type) {
    case 'line':
      return linePath(e, tol)
    case 'arc':
      return arcPath(e, tol)
    case 'circle':
      return circlePath(e, tol)
    case 'polyline':
      return polylinePath(e, tol)
  }
}
