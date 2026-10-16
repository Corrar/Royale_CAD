import { arcBBox, arcDistance, arcQuadrants, arcSweep } from '../geom/curve'
import { normAngle } from '../geom/tol'
import { affineDet, applyAffine } from '../geom/vec'
import { SNAP, type Arc, type EntityType } from './types'

export const arcType: EntityType<Arc> = {
  type: 'arc',
  bbox: (e) => arcBBox(e.cx, e.cy, e.r, e.a0, arcSweep(e.a0, e.a1)),
  primitives: (e, _tol, out) => out.arc(e.cx, e.cy, e.r, e.a0, arcSweep(e.a0, e.a1)),
  distance: (e, p) => arcDistance(p.x, p.y, e.cx, e.cy, e.r, e.a0, arcSweep(e.a0, e.a1)),
  transform(e, m) {
    const c = applyAffine(m, e.cx, e.cy)
    const angle = (a: number): number => {
      const p = applyAffine(m, e.cx + Math.cos(a), e.cy + Math.sin(a))
      return normAngle(Math.atan2(p.y - c.y, p.x - c.x))
    }
    const r = e.r * Math.sqrt(Math.abs(affineDet(m)))
    // A mirroring turns the run clockwise: the arc now runs counter-clockwise from the old end to the old start.
    const [a0, a1] = affineDet(m) >= 0 ? [angle(e.a0), angle(e.a1)] : [angle(e.a1), angle(e.a0)]
    // A full circle stays full whatever the rounding.
    return { ...e, cx: c.x, cy: c.y, r, a0, a1: e.a0 === e.a1 ? a0 : a1 }
  },
  snapPoints(e, modes, out) {
    const at = (a: number, mode: number): void => out(e.cx + e.r * Math.cos(a), e.cy + e.r * Math.sin(a), mode)
    if (modes & SNAP.END) {
      at(e.a0, SNAP.END)
      at(e.a1, SNAP.END)
    }
    if (modes & SNAP.MID) at(e.a0 + arcSweep(e.a0, e.a1) / 2, SNAP.MID)
    if (modes & SNAP.CEN) out(e.cx, e.cy, SNAP.CEN)
    if (modes & SNAP.QUA) arcQuadrants(e.cx, e.cy, e.r, e.a0, arcSweep(e.a0, e.a1), (x, y) => out(x, y, SNAP.QUA))
  },
  validate: (e) => (e.r > 0 ? undefined : `arc radius must be > 0, got ${e.r}`),
}
