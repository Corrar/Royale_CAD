import { typeOf } from '../entity/registry'
import type { Entity } from '../entity/types'
import { arcBBox, onArc } from './curve'
import { EPS, TAU } from './tol'
import { bboxIntersects, type BBox, type Vec2 } from './vec'

/** A primitive in local coordinates: a segment, or a circle with the sweep that bounds it (an arc). */
type Prim = { kind: 'seg'; x0: number; y0: number; x1: number; y1: number } | { kind: 'arc'; cx: number; cy: number; r: number; a0: number; sweep: number }

/** The primitives of e, moved by (−ox, −oy); with near, only those whose box reaches it. */
function primsOf(e: Entity, ox: number, oy: number, near: BBox | undefined): Prim[] {
  const out: Prim[] = []
  const reaches = (b: BBox): boolean => !near || bboxIntersects(b, near)
  typeOf(e).primitives(e, 0, {
    segment(x0, y0, x1, y1) {
      if (reaches({ minX: Math.min(x0, x1), minY: Math.min(y0, y1), maxX: Math.max(x0, x1), maxY: Math.max(y0, y1) })) {
        out.push({ kind: 'seg', x0: x0 - ox, y0: y0 - oy, x1: x1 - ox, y1: y1 - oy })
      }
    },
    arc(cx, cy, r, a0, sweep) {
      if (reaches(arcBBox(cx, cy, r, a0, sweep))) out.push({ kind: 'arc', cx: cx - ox, cy: cy - oy, r, a0, sweep })
    },
  }, near)
  return out
}

/** Length tolerance for features of size L (local coordinates): the kernel's relative EPS. */
const tolOf = (L: number): number => EPS * Math.max(1, L)

function onSegment(s: Extract<Prim, { kind: 'seg' }>, t: number, tol: number): boolean {
  const len = Math.hypot(s.x1 - s.x0, s.y1 - s.y0)
  const k = len > 0 ? tol / len : 0
  return t >= -k && t <= 1 + k
}

function onArcAt(a: Extract<Prim, { kind: 'arc' }>, x: number, y: number, tol: number): boolean {
  if (Math.abs(a.sweep) >= TAU) return true
  const angle = Math.atan2(y - a.cy, x - a.cx)
  // Widen the sweep by the angle the tolerance subtends, so an end that touches counts.
  const slack = tol / a.r
  return a.sweep >= 0 ? onArc(angle, a.a0 - slack, a.sweep + 2 * slack) : onArc(angle, a.a0 + slack, a.sweep - 2 * slack)
}

function segSeg(a: Extract<Prim, { kind: 'seg' }>, b: Extract<Prim, { kind: 'seg' }>, tol: number, out: Vec2[]): void {
  const dax = a.x1 - a.x0
  const day = a.y1 - a.y0
  const dbx = b.x1 - b.x0
  const dby = b.y1 - b.y0
  const den = dax * dby - day * dbx
  // Parallel, collinear included: no isolated point.
  if (Math.abs(den) <= EPS * Math.hypot(dax, day) * Math.hypot(dbx, dby)) return
  const ex = b.x0 - a.x0
  const ey = b.y0 - a.y0
  const t = (ex * dby - ey * dbx) / den
  const u = (ex * day - ey * dax) / den
  if (onSegment(a, t, tol) && onSegment(b, u, tol)) out.push({ x: a.x0 + t * dax, y: a.y0 + t * day })
}

function segArc(s: Extract<Prim, { kind: 'seg' }>, c: Extract<Prim, { kind: 'arc' }>, tol: number, out: Vec2[]): void {
  const dx = s.x1 - s.x0
  const dy = s.y1 - s.y0
  const len = Math.hypot(dx, dy)
  if (len === 0) return
  // Foot of the perpendicular from the centre, then ± along the line.
  const ux = dx / len
  const uy = dy / len
  const t0 = (c.cx - s.x0) * ux + (c.cy - s.y0) * uy
  const fx = s.x0 + t0 * ux
  const fy = s.y0 + t0 * uy
  const dist = Math.hypot(fx - c.cx, fy - c.cy)
  if (dist > c.r + tol) return
  const h = dist >= c.r - tol ? 0 : Math.sqrt((c.r - dist) * (c.r + dist))
  for (const k of h === 0 ? [0] : [-h, h]) {
    const x = fx + k * ux
    const y = fy + k * uy
    if (onSegment(s, (t0 + k) / len, tol) && onArcAt(c, x, y, tol)) out.push({ x, y })
  }
}

function arcArc(a: Extract<Prim, { kind: 'arc' }>, b: Extract<Prim, { kind: 'arc' }>, tol: number, out: Vec2[]): void {
  const dx = b.cx - a.cx
  const dy = b.cy - a.cy
  const d = Math.hypot(dx, dy)
  // Concentric (the same circle or none in common) and apart: no isolated point.
  if (d <= tol || d > a.r + b.r + tol || d < Math.abs(a.r - b.r) - tol) return
  const along = (a.r * a.r - b.r * b.r + d * d) / (2 * d)
  const h2 = a.r * a.r - along * along
  // Tangent when the half chord is what a change of radius by tol would open: h² ≤ 2·r·tol.
  const h = h2 <= 2 * tol * Math.max(a.r, b.r) ? 0 : Math.sqrt(h2)
  const mx = a.cx + (along * dx) / d
  const my = a.cy + (along * dy) / d
  for (const k of h === 0 ? [0] : [-h, h]) {
    const x = mx - (k * dy) / d
    const y = my + (k * dx) / d
    if (onArcAt(a, x, y, tol) && onArcAt(b, x, y, tol)) out.push({ x, y })
  }
}

/**
 * The isolated points where a and b meet: crossings, tangencies and touching ends. Overlaps (collinear lines,
 * coincident arcs) have no isolated point and give none. Computed relative to a local origin, so UTM-sized
 * coordinates keep their small digits.
 */
/**
 * The points where a and b cross or touch. With near, only those the pieces reaching the box can make: the
 * pieces of two long polylines are paired only where it matters (an aperture, say).
 */
export function intersect(a: Entity, b: Entity, near?: BBox): Vec2[] {
  const box = typeOf(a).bbox(a)
  const ox = box.minX
  const oy = box.minY
  const pa = primsOf(a, ox, oy, near)
  const pb = primsOf(b, ox, oy, near)
  const found: Vec2[] = []
  for (const p of pa) {
    for (const q of pb) {
      const size = Math.max(
        p.kind === 'seg' ? Math.hypot(p.x1 - p.x0, p.y1 - p.y0) : p.r,
        q.kind === 'seg' ? Math.hypot(q.x1 - q.x0, q.y1 - q.y0) : q.r,
      )
      const tol = tolOf(size)
      if (p.kind === 'seg' && q.kind === 'seg') segSeg(p, q, tol, found)
      else if (p.kind === 'seg' && q.kind === 'arc') segArc(p, q, tol, found)
      else if (p.kind === 'arc' && q.kind === 'seg') segArc(q, p, tol, found)
      else if (p.kind === 'arc' && q.kind === 'arc') arcArc(p, q, tol, found)
    }
  }
  // Pieces sharing a vertex find the same point twice.
  const out: Vec2[] = []
  for (const f of found) {
    const tol = tolOf(Math.hypot(f.x, f.y))
    if (!out.some((g) => Math.hypot(g.x - f.x, g.y - f.y) <= 10 * tol)) out.push(f)
  }
  return out.map((p) => ({ x: p.x + ox, y: p.y + oy }))
}
