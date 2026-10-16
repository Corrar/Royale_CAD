import { applyAffine } from '../geom/vec'
import { SNAP, type EntityType, type Point } from './types'

export const pointType: EntityType<Point> = {
  type: 'point',
  bbox: (e) => ({ minX: e.x, minY: e.y, maxX: e.x, maxY: e.y }),
  // A zero-length segment: the renderer draws it as a dot of the line width.
  primitives: (e, _tol, out) => out.segment(e.x, e.y, e.x, e.y),
  distance: (e, p) => Math.hypot(p.x - e.x, p.y - e.y),
  transform(e, m) {
    const p = applyAffine(m, e.x, e.y)
    return { ...e, x: p.x, y: p.y }
  },
  snapPoints(e, modes, out) {
    if (modes & SNAP.NOD) out(e.x, e.y, SNAP.NOD)
  },
}
