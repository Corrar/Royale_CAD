import { arcBBox, arcDistance, bulgeToArc } from '../geom/curve'
import { bboxAdd, emptyBBox, segmentDistance } from '../geom/vec'
import type { EntityType, Polyline, PrimSink } from './types'

/** Emits each piece in vertex order; the closing piece last. */
function pieces(e: Polyline, out: PrimSink): void {
  const { pts, bulges } = e
  const n = pts.length >> 1
  const count = e.closed ? n : n - 1
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % n
    const x0 = pts[2 * i]!
    const y0 = pts[2 * i + 1]!
    const x1 = pts[2 * j]!
    const y1 = pts[2 * j + 1]!
    const bulge = bulges?.[i] ?? 0
    const arc = bulge !== 0 ? bulgeToArc({ x: x0, y: y0 }, { x: x1, y: y1 }, bulge) : null
    if (arc) out.arc(arc.cx, arc.cy, arc.r, arc.a0, arc.sweep)
    else out.segment(x0, y0, x1, y1)
  }
}

export const polylineType: EntityType<Polyline> = {
  type: 'polyline',
  bbox(e) {
    const b = emptyBBox()
    for (let i = 0; i + 1 < e.pts.length; i += 2) bboxAdd(b, e.pts[i]!, e.pts[i + 1]!)
    if (!e.bulges) return b
    pieces(e, {
      segment() {},
      arc(cx, cy, r, a0, sweep) {
        const a = arcBBox(cx, cy, r, a0, sweep)
        bboxAdd(b, a.minX, a.minY)
        bboxAdd(b, a.maxX, a.maxY)
      },
    })
    return b
  },
  primitives: (e, _tol, out) => pieces(e, out),
  distance(e, p) {
    let d = e.pts.length >= 2 ? Math.hypot(p.x - e.pts[0]!, p.y - e.pts[1]!) : Infinity
    pieces(e, {
      segment(x0, y0, x1, y1) {
        d = Math.min(d, segmentDistance(p.x, p.y, x0, y0, x1, y1))
      },
      arc(cx, cy, r, a0, sweep) {
        d = Math.min(d, arcDistance(p.x, p.y, cx, cy, r, a0, sweep))
      },
    })
    return d
  },
  validate(e) {
    if (e.pts.length < 2 || e.pts.length % 2 !== 0) return `polyline vertices must be x, y pairs, at least one; got ${e.pts.length} numbers`
    if (e.bulges && e.bulges.length !== e.pts.length / 2) return `polyline bulges must have one entry per vertex`
    if (e.bulges?.some((b) => !Number.isFinite(b))) return `polyline bulges must be finite`
    return undefined
  },
}
