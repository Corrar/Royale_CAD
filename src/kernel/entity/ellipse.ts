import { arcSweep, ellipsePieces, onArc } from '../geom/curve'
import { normAngle } from '../geom/tol'
import { affineDet, applyAffine, type BBox } from '../geom/vec'
import { freeCurve } from './free'
import { SNAP, type Ellipse, type EntityType } from './types'

const sweepOf = (e: Ellipse): number => arcSweep(e.t0, e.t1)
const majorOf = (e: Ellipse): number => Math.hypot(e.mx, e.my)
const at = (e: Ellipse, t: number): [number, number] => [
  e.cx + e.mx * Math.cos(t) - e.ratio * e.my * Math.sin(t),
  e.cy + e.my * Math.cos(t) + e.ratio * e.mx * Math.sin(t),
]

export const ellipseType: EntityType<Ellipse> = {
  type: 'ellipse',
  ...freeCurve((e: Ellipse) => ellipsePieces(e.cx, e.cy, e.mx, e.my, e.ratio, e.t0, sweepOf(e)), majorOf),
  bbox(e) {
    const sweep = sweepOf(e)
    const b: BBox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
    const add = (t: number): void => {
      const [x, y] = at(e, t)
      b.minX = Math.min(b.minX, x)
      b.minY = Math.min(b.minY, y)
      b.maxX = Math.max(b.maxX, x)
      b.maxY = Math.max(b.maxY, y)
    }
    add(e.t0)
    add(e.t0 + sweep)
    // Where x or y turns: dx/dt = 0 and dy/dt = 0, each twice around.
    const tx = Math.atan2(-e.ratio * e.my, e.mx)
    const ty = Math.atan2(e.ratio * e.mx, e.my)
    for (const t of [tx, tx + Math.PI, ty, ty + Math.PI]) if (onArc(normAngle(t), e.t0, sweep)) add(t)
    return b
  },
  transform(e, m) {
    const c = applyAffine(m, e.cx, e.cy)
    // The axis is a direction: the linear part alone takes it, as points far from the origin would round it.
    const moved = { ...e, cx: c.x, cy: c.y, mx: m.a * e.mx + m.c * e.my, my: m.b * e.mx + m.d * e.my }
    if (affineDet(m) >= 0) return moved
    // Mirrored, the minor axis flips: counter-clockwise, the arc now runs over the opposite parameters.
    const t0 = normAngle(-e.t1)
    return { ...moved, t0, t1: e.t0 === e.t1 ? t0 : normAngle(-e.t0) }
  },
  snapPoints(e, modes, out) {
    const sweep = sweepOf(e)
    if (modes & SNAP.END && e.t0 !== e.t1) {
      out(...at(e, e.t0), SNAP.END)
      out(...at(e, e.t1), SNAP.END)
    }
    if (modes & SNAP.CEN) out(e.cx, e.cy, SNAP.CEN)
    if (modes & SNAP.QUA) {
      const quarters: [number, number, number][] = [
        [0, e.cx + e.mx, e.cy + e.my],
        [Math.PI / 2, e.cx - e.ratio * e.my, e.cy + e.ratio * e.mx],
        [Math.PI, e.cx - e.mx, e.cy - e.my],
        [(3 * Math.PI) / 2, e.cx + e.ratio * e.my, e.cy - e.ratio * e.mx],
      ]
      for (const [t, x, y] of quarters) if (onArc(t, e.t0, sweep)) out(x, y, SNAP.QUA)
    }
  },
  validate(e) {
    if (!(majorOf(e) > 0)) return 'ellipse major axis must not be zero'
    if (!(e.ratio > 0 && e.ratio <= 1)) return `ellipse axis ratio must be in (0, 1], got ${e.ratio}`
    return undefined
  },
}
