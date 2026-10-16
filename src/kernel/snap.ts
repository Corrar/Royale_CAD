import type { Document } from './document'
import { typeOf } from './entity/registry'
import { SNAP, type Entity, type SnapSink } from './entity/types'
import { arcDistance, onArc } from './geom/curve'
import { intersect } from './geom/intersect'
import { segmentDistance, type Vec2 } from './geom/vec'
import type { SpatialIndex } from './spatial'
import type { ViewState } from './view'

export { SNAP } from './entity/types'

/** AutoCAD's APERTURE default: the snap target's half size, CSS px. */
export const APERTURE_PX = 10

/** When two snap points are equally near, the earlier mode wins. */
const PRIORITY = [SNAP.END, SNAP.MID, SNAP.CEN, SNAP.INT, SNAP.QUA, SNAP.INS, SNAP.PER, SNAP.NEA, SNAP.NOD]
const rank = (mode: number): number => PRIORITY.indexOf(mode as (typeof PRIORITY)[number])

export interface SnapHit { p: Vec2; mode: number; id: number }

export function snapPointsOf(e: Entity, modes: number, out: SnapSink): void {
  typeOf(e).snapPoints?.(e, modes, out)
}

/** Past this many objects under the cursor, INT only pairs the nearest: the pairs grow with the square. */
const INT_MAX = 32

/**
 * Calls out with the feet of the perpendiculars from b to the pieces of e within r of the cursor (on them, not
 * their extensions). A foot at b itself is no perpendicular: b lies on e there.
 */
function feet(e: Entity, b: Vec2, cursor: Vec2, r: number, out: (x: number, y: number) => void): void {
  const same = Math.max(r * 1e-6, 1e-9 * Math.max(1, Math.abs(b.x), Math.abs(b.y)))
  const foot = (x: number, y: number): void => {
    if (Math.hypot(x - b.x, y - b.y) > same) out(x, y)
  }
  typeOf(e).primitives(e, 0, {
    segment(x0, y0, x1, y1) {
      if (segmentDistance(cursor.x, cursor.y, x0, y0, x1, y1) > r) return
      const dx = x1 - x0
      const dy = y1 - y0
      const len2 = dx * dx + dy * dy
      if (len2 === 0) return
      const t = ((b.x - x0) * dx + (b.y - y0) * dy) / len2
      if (t >= 0 && t <= 1) foot(x0 + t * dx, y0 + t * dy)
    },
    arc(cx, cy, radius, a0, sweep) {
      if (arcDistance(cursor.x, cursor.y, cx, cy, radius, a0, sweep) > r) return
      // Along the line through the centre and b, on both sides; b at the centre is perpendicular everywhere.
      const d = Math.hypot(b.x - cx, b.y - cy)
      if (d === 0) return
      for (const k of [radius / d, -radius / d]) {
        const x = cx + (b.x - cx) * k
        const y = cy + (b.y - cy) * k
        if (onArc(Math.atan2(y - cy, x - cx), a0, sweep)) foot(x, y)
      }
    },
  })
}

/**
 * Whether the cursor is over the arc piece of e centred at (x, y), for CEN: a polyline's fillet answers only
 * where the cursor is on it. An entity with no arc piece of that centre (an ellipse) is over it when d ≤ r.
 */
function overCentre(e: Entity, x: number, y: number, cursor: Vec2, r: number, d: number): boolean {
  let any = false
  let over = false
  const tie = 1e-9 * Math.max(1, Math.abs(x), Math.abs(y))
  typeOf(e).primitives(e, 0, {
    segment() {},
    arc(cx, cy, radius, a0, sweep) {
      if (Math.abs(cx - x) > tie || Math.abs(cy - y) > tie) return
      any = true
      over ||= arcDistance(cursor.x, cursor.y, cx, cy, radius, a0, sweep) <= r
    },
  })
  return any ? over : d <= r
}

/** The point of e nearest p. */
function nearest(e: Entity, p: Vec2): Vec2 {
  // A free curve knows its own, exact at any zoom; its primitives are only close to it.
  const own = typeOf(e).nearest
  if (own) return own(e, p)
  let best: Vec2 = p
  let bestD = Infinity
  const take = (x: number, y: number): void => {
    const d = Math.hypot(x - p.x, y - p.y)
    if (d < bestD) {
      best = { x, y }
      bestD = d
    }
  }
  typeOf(e).primitives(e, 0, {
    segment(x0, y0, x1, y1) {
      const dx = x1 - x0
      const dy = y1 - y0
      const len2 = dx * dx + dy * dy
      const t = len2 > 0 ? Math.min(1, Math.max(0, ((p.x - x0) * dx + (p.y - y0) * dy) / len2)) : 0
      take(x0 + t * dx, y0 + t * dy)
    },
    arc(cx, cy, r, a0, sweep) {
      const d = Math.hypot(p.x - cx, p.y - cy)
      if (d > 0 && onArc(Math.atan2(p.y - cy, p.x - cx), a0, sweep)) take(cx + ((p.x - cx) * r) / d, cy + ((p.y - cy) * r) / d)
      take(cx + r * Math.cos(a0), cy + r * Math.sin(a0))
      take(cx + r * Math.cos(a0 + sweep), cy + r * Math.sin(a0 + sweep))
    },
  })
  // No piece (a polyline of one vertex): the nearest point of its box, which is that vertex.
  if (bestD === Infinity) {
    const b = typeOf(e).bbox(e)
    if (b.minX <= b.maxX) take(Math.min(b.maxX, Math.max(b.minX, p.x)), Math.min(b.maxY, Math.max(b.minY, p.y)))
  }
  return best
}

/**
 * The snap point nearest to the cursor, in pixels, among the modes asked for; null when none is within the
 * aperture. A point counts when it lies within the aperture, except CEN and PER, which count when the cursor is
 * over the curve (the centre of a big circle, or the foot of a perpendicular, is far from where one points).
 * PER needs `base`, the point the perpendicular comes from. NEA, the nearest point of the curve, would beat every
 * other mode on distance, so it only answers when no other mode does. NOD snaps to point objects: none exist yet.
 */
export function snap(doc: Document, index: SpatialIndex, cursor: Vec2, view: ViewState, modes: number, aperturePx: number, base?: Vec2 | null): SnapHit | null {
  if (modes === 0) return null
  const r = aperturePx / view.scale
  // Distances this close are a tie, settled by the mode's priority: rounding must not decide between them.
  const tie = r * 1e-9
  let best: SnapHit | null = null
  let bestD = Infinity
  let bestRank = Infinity
  const consider = (x: number, y: number, mode: number, id: number): void => {
    const d = Math.hypot(x - cursor.x, y - cursor.y)
    const k = rank(mode)
    if (d < bestD - tie || (d <= bestD + tie && k < bestRank)) {
      best = { p: { x, y }, mode, id }
      bestD = d
      bestRank = k
    }
  }
  const pointModes = modes & ~(SNAP.PER | SNAP.NEA | SNAP.INT)
  const over: { e: Entity; d: number }[] = []
  for (const id of index.query({ minX: cursor.x - r, minY: cursor.y - r, maxX: cursor.x + r, maxY: cursor.y + r })) {
    const e = doc.get(id)
    if (!e || doc.layers.get(e.layer)?.visible !== true) continue
    const d = typeOf(e).distance(e, cursor)
    if (d <= r) over.push({ e, d })
    if (pointModes) {
      snapPointsOf(e, pointModes, (x, y, mode) => {
        if (mode === SNAP.CEN ? !overCentre(e, x, y, cursor, r, d) : Math.hypot(x - cursor.x, y - cursor.y) > r) return
        consider(x, y, mode, id)
      })
    }
    if (modes & SNAP.PER && base && d <= r) feet(e, base, cursor, r, (x, y) => consider(x, y, SNAP.PER, id))
  }
  // An intersection within the aperture lies on two curves that pass within it, on pieces that reach it.
  if (modes & SNAP.INT && over.length > 1) {
    const aperture = { minX: cursor.x - r, minY: cursor.y - r, maxX: cursor.x + r, maxY: cursor.y + r }
    const near = over.sort((a, b) => a.d - b.d || a.e.id - b.e.id).slice(0, INT_MAX)
    for (let i = 0; i < near.length; i++) {
      for (let j = i + 1; j < near.length; j++) {
        for (const p of intersect(near[i]!.e, near[j]!.e, aperture)) {
          if (Math.hypot(p.x - cursor.x, p.y - cursor.y) <= r) consider(p.x, p.y, SNAP.INT, Math.min(near[i]!.e.id, near[j]!.e.id))
        }
      }
    }
  }
  if (!best && modes & SNAP.NEA && over.length > 0) {
    const { e } = over.reduce((a, b) => (b.d < a.d || (b.d === a.d && b.e.id > a.e.id) ? b : a))
    const p = nearest(e, cursor)
    consider(p.x, p.y, SNAP.NEA, e.id)
  }
  return best
}
