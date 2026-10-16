import { arcBBox, arcDistance, arcSweep } from '../geom/curve'
import { SNAP, type Arc, type EntityType } from './types'

export const arcType: EntityType<Arc> = {
  type: 'arc',
  bbox: (e) => arcBBox(e.cx, e.cy, e.r, e.a0, arcSweep(e.a0, e.a1)),
  primitives: (e, _tol, out) => out.arc(e.cx, e.cy, e.r, e.a0, arcSweep(e.a0, e.a1)),
  distance: (e, p) => arcDistance(p.x, p.y, e.cx, e.cy, e.r, e.a0, arcSweep(e.a0, e.a1)),
  snapPoints(e, modes, out) {
    const at = (a: number, mode: number): void => out(e.cx + e.r * Math.cos(a), e.cy + e.r * Math.sin(a), mode)
    if (modes & SNAP.END) {
      at(e.a0, SNAP.END)
      at(e.a1, SNAP.END)
    }
    if (modes & SNAP.MID) at(e.a0 + arcSweep(e.a0, e.a1) / 2, SNAP.MID)
    if (modes & SNAP.CEN) out(e.cx, e.cy, SNAP.CEN)
  },
  validate: (e) => (e.r > 0 ? undefined : `arc radius must be > 0, got ${e.r}`),
}
