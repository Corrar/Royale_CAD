import { arcBBox, arcDistance, arcSweep } from '../geom/curve'
import type { Arc, EntityType } from './types'

export const arcType: EntityType<Arc> = {
  type: 'arc',
  bbox: (e) => arcBBox(e.cx, e.cy, e.r, e.a0, arcSweep(e.a0, e.a1)),
  primitives: (e, _tol, out) => out.arc(e.cx, e.cy, e.r, e.a0, arcSweep(e.a0, e.a1)),
  distance: (e, p) => arcDistance(p.x, p.y, e.cx, e.cy, e.r, e.a0, arcSweep(e.a0, e.a1)),
  validate: (e) => (e.r > 0 ? undefined : `arc radius must be > 0, got ${e.r}`),
}
