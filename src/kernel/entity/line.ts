import { applyAffine, segmentDistance } from '../geom/vec'
import { SNAP, type EntityType, type Line } from './types'

export const lineType: EntityType<Line> = {
  type: 'line',
  bbox: (e) => ({ minX: Math.min(e.x0, e.x1), minY: Math.min(e.y0, e.y1), maxX: Math.max(e.x0, e.x1), maxY: Math.max(e.y0, e.y1) }),
  primitives: (e, _tol, out) => out.segment(e.x0, e.y0, e.x1, e.y1),
  distance: (e, p) => segmentDistance(p.x, p.y, e.x0, e.y0, e.x1, e.y1),
  transform(e, m) {
    const p = applyAffine(m, e.x0, e.y0)
    const q = applyAffine(m, e.x1, e.y1)
    return { ...e, x0: p.x, y0: p.y, x1: q.x, y1: q.y }
  },
  snapPoints(e, modes, out) {
    if (modes & SNAP.END) {
      out(e.x0, e.y0, SNAP.END)
      out(e.x1, e.y1, SNAP.END)
    }
    if (modes & SNAP.MID) out((e.x0 + e.x1) / 2, (e.y0 + e.y1) / 2, SNAP.MID)
  },
}
