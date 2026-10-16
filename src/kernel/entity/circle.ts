import { TAU } from '../geom/tol'
import type { Circle, EntityType } from './types'

export const circleType: EntityType<Circle> = {
  type: 'circle',
  bbox: (e) => ({ minX: e.cx - e.r, minY: e.cy - e.r, maxX: e.cx + e.r, maxY: e.cy + e.r }),
  primitives: (e, _tol, out) => out.arc(e.cx, e.cy, e.r, 0, TAU),
  distance: (e, p) => Math.abs(Math.hypot(p.x - e.cx, p.y - e.cy) - e.r),
}
