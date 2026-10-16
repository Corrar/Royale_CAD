import type { Document } from './document'
import { typeOf } from './entity/registry'
import { SNAP, type Entity, type SnapSink } from './entity/types'
import type { Vec2 } from './geom/vec'
import type { SpatialIndex } from './spatial'
import type { ViewState } from './view'

export { SNAP } from './entity/types'

/** AutoCAD's APERTURE default: the snap target's half size, CSS px. */
export const APERTURE_PX = 10

/** When two snap points are equally near, the earlier mode wins. */
const PRIORITY = [SNAP.END, SNAP.MID, SNAP.CEN, SNAP.INT, SNAP.QUA, SNAP.PER, SNAP.NEA, SNAP.NOD]
const rank = (mode: number): number => PRIORITY.indexOf(mode as (typeof PRIORITY)[number])

export interface SnapHit { p: Vec2; mode: number; id: number }

export function snapPointsOf(e: Entity, modes: number, out: SnapSink): void {
  typeOf(e).snapPoints?.(e, modes, out)
}

/**
 * The snap point nearest to the cursor, in pixels, among the modes asked for; null when none is within the
 * aperture. A point counts when it lies within the aperture, except CEN, which counts when the curve does (the
 * centre of a big circle is far from where one points at it).
 */
export function snap(doc: Document, index: SpatialIndex, cursor: Vec2, view: ViewState, modes: number, aperturePx: number): SnapHit | null {
  if (modes === 0) return null
  const r = aperturePx / view.scale
  let best: SnapHit | null = null
  let bestD = Infinity
  let bestRank = Infinity
  for (const id of index.query({ minX: cursor.x - r, minY: cursor.y - r, maxX: cursor.x + r, maxY: cursor.y + r })) {
    const e = doc.get(id)
    if (!e || doc.layers.get(e.layer)?.visible !== true) continue
    const onCurve = (modes & SNAP.CEN) !== 0 && typeOf(e).distance(e, cursor) <= r
    snapPointsOf(e, modes, (x, y, mode) => {
      const d = Math.hypot(x - cursor.x, y - cursor.y)
      if (mode === SNAP.CEN ? !onCurve : d > r) return
      const k = rank(mode)
      if (d < bestD || (d === bestD && k < bestRank)) {
        best = { p: { x, y }, mode, id }
        bestD = d
        bestRank = k
      }
    })
  }
  return best
}
