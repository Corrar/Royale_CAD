import { TAU, normAngle } from './tol'
import { bboxAdd, type BBox, type Vec2 } from './vec'

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
 * Arc from a to b for a polyline bulge (tan of a quarter of the included angle, positive counter-clockwise).
 * Null when the piece is straight: zero bulge or zero chord.
 */
export function bulgeToArc(a: Vec2, b: Vec2, bulge: number): ArcGeom | null {
  const dx = b.x - a.x
  const dy = b.y - a.y
  if (bulge === 0 || (dx === 0 && dy === 0)) return null
  // The centre sits on the chord's perpendicular bisector at (c/2)·cot(θ/2), with cot(θ/2) = (1 − bulge²) / (2·bulge).
  const k = (1 - bulge * bulge) / (4 * bulge)
  const cx = (a.x + b.x) / 2 - dy * k
  const cy = (a.y + b.y) / 2 + dx * k
  const r = (Math.hypot(dx, dy) * (1 + bulge * bulge)) / (4 * Math.abs(bulge))
  return { cx, cy, r, a0: Math.atan2(a.y - cy, a.x - cx), sweep: 4 * Math.atan(bulge) }
}
