import { TAU } from '../geom/tol'
import { affineDet, applyAffine } from '../geom/vec'
import { SNAP, type Circle, type EntityType } from './types'

export const circleType: EntityType<Circle> = {
  type: 'circle',
  bbox: (e) => ({ minX: e.cx - e.r, minY: e.cy - e.r, maxX: e.cx + e.r, maxY: e.cy + e.r }),
  primitives: (e, _tol, out) => out.arc(e.cx, e.cy, e.r, 0, TAU),
  distance: (e, p) => Math.abs(Math.hypot(p.x - e.cx, p.y - e.cy) - e.r),
  transform(e, m) {
    const c = applyAffine(m, e.cx, e.cy)
    return { ...e, cx: c.x, cy: c.y, r: e.r * Math.sqrt(Math.abs(affineDet(m))) }
  },
  snapPoints(e, modes, out) {
    if (modes & SNAP.CEN) out(e.cx, e.cy, SNAP.CEN)
  },
  validate: (e) => (e.r > 0 ? undefined : `circle radius must be > 0, got ${e.r}`),
}
