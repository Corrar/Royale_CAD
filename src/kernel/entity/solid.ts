import { applyAffine, segmentDistance, triangleDistance } from '../geom/vec'
import { SNAP, type EntityType, type Solid } from './types'

type TriSink = (x0: number, y0: number, x1: number, y1: number, x2: number, y2: number) => void
type EdgeSink = (x0: number, y0: number, x1: number, y1: number) => void

/** Twice the signed area of (a, b, c): positive when c lies left of a → b. */
const turn = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)

/** Where the segments p-q and r-s cross, ends included; null when they do not (or run parallel). */
function crossing(px: number, py: number, qx: number, qy: number, rx: number, ry: number, sx: number, sy: number): [number, number] | null {
  const dx = qx - px
  const dy = qy - py
  const ex = sx - rx
  const ey = sy - ry
  const den = dx * ey - dy * ex
  if (den === 0) return null
  const t = ((rx - px) * ey - (ry - py) * ex) / den
  const u = ((rx - px) * dy - (ry - py) * dx) / den
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [px + t * dx, py + t * dy] : null
}

/**
 * The filled area as triangles. The quad 1-2-4-3 splits along 2-3, or along 1-4 when 2-3 runs outside it (a dent
 * at corner 1 or 4). Corners given round the outline make it cross itself: a bow tie, two triangles meeting where it
 * crosses, as AutoCAD shows it. A triangle repeats corner 3.
 */
function fill(e: Solid, out: TriSink): void {
  const { x0, y0, x1, y1, x2, y2, x3, y3 } = e
  if (x3 === x2 && y3 === y2) return out(x0, y0, x1, y1, x2, y2)
  if (turn(x1, y1, x2, y2, x0, y0) * turn(x1, y1, x2, y2, x3, y3) < 0) {
    out(x0, y0, x1, y1, x2, y2)
    return out(x1, y1, x3, y3, x2, y2)
  }
  if (turn(x0, y0, x3, y3, x1, y1) * turn(x0, y0, x3, y3, x2, y2) < 0) {
    out(x0, y0, x1, y1, x3, y3)
    return out(x0, y0, x3, y3, x2, y2)
  }
  // Neither diagonal is inside: 2-4 crosses 3-1, or 1-2 crosses 4-3.
  const a = crossing(x1, y1, x3, y3, x2, y2, x0, y0)
  if (a) {
    out(x0, y0, x1, y1, a[0], a[1])
    return out(a[0], a[1], x3, y3, x2, y2)
  }
  const b = crossing(x0, y0, x1, y1, x3, y3, x2, y2)
  if (b) {
    out(x1, y1, x3, y3, b[0], b[1])
    return out(b[0], b[1], x2, y2, x0, y0)
  }
  // The corners in a line: nothing to fill, but the split still draws it as thin as it is.
  out(x0, y0, x1, y1, x2, y2)
  out(x1, y1, x3, y3, x2, y2)
}

/** The outline 1-2-4-3, edge by edge: a triangle's has three, its repeated corner making none. */
function outline(e: Solid, out: EdgeSink): void {
  const xs = [e.x0, e.x1, e.x3, e.x2]
  const ys = [e.y0, e.y1, e.y3, e.y2]
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4
    if (xs[i] !== xs[j] || ys[i] !== ys[j]) out(xs[i]!, ys[i]!, xs[j]!, ys[j]!)
  }
}

export const solidType: EntityType<Solid> = {
  type: 'solid',
  bbox: (e) => ({
    minX: Math.min(e.x0, e.x1, e.x2, e.x3), minY: Math.min(e.y0, e.y1, e.y2, e.y3),
    maxX: Math.max(e.x0, e.x1, e.x2, e.x3), maxY: Math.max(e.y0, e.y1, e.y2, e.y3),
  }),
  primitives(e, _tol, out) {
    fill(e, (...c) => out.tri?.(...c))
    outline(e, (...s) => out.edge?.(...s))
  },
  // 0 inside the triangles; outside, the nearest of them is as near as the outline 1-2-4-3.
  distance(e, p) {
    let d = Infinity
    fill(e, (...c) => void (d = Math.min(d, triangleDistance(p.x, p.y, ...c))))
    return d
  },
  outlineDistance(e, p) {
    // Corner 1 too: corners all in one place make no edge.
    let d = Math.hypot(p.x - e.x0, p.y - e.y0)
    outline(e, (x0, y0, x1, y1) => void (d = Math.min(d, segmentDistance(p.x, p.y, x0, y0, x1, y1))))
    return d
  },
  transform(e, m) {
    const a = applyAffine(m, e.x0, e.y0)
    const b = applyAffine(m, e.x1, e.y1)
    const c = applyAffine(m, e.x2, e.y2)
    const d = applyAffine(m, e.x3, e.y3)
    return { ...e, x0: a.x, y0: a.y, x1: b.x, y1: b.y, x2: c.x, y2: c.y, x3: d.x, y3: d.y }
  },
  snapPoints(e, modes, out) {
    if (!(modes & SNAP.END)) return
    const seen: number[] = []
    for (const [x, y] of [[e.x0, e.y0], [e.x1, e.y1], [e.x2, e.y2], [e.x3, e.y3]] as const) {
      if (seen.some((v, i) => i % 2 === 0 && v === x && seen[i + 1] === y)) continue
      seen.push(x, y)
      out(x, y, SNAP.END)
    }
  },
  validate(e) {
    const finite = [e.x0, e.y0, e.x1, e.y1, e.x2, e.y2, e.x3, e.y3].every(Number.isFinite)
    return finite ? undefined : 'solid corners must be finite'
  },
}
