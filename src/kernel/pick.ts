import type { Document } from './document'
import { typeOf } from './entity/registry'
import type { Entity } from './entity/types'
import { arcSpansInBox, clipSegment } from './geom/clip'
import { bboxContains, type BBox, type Vec2 } from './geom/vec'
import type { SpatialIndex } from './spatial'

/** Entities on hidden layers cannot be selected. Locked ones can; commands filter them. */
const selectable = (doc: Document, e: Entity): boolean => doc.layers.get(e.layer)?.visible === true

/** The nearest selectable entity within tol (world units) of p, or null. A tie goes to the later entity. */
export function pick(doc: Document, index: SpatialIndex, p: Vec2, tol: number): number | null {
  let best: number | null = null
  let bestD = Infinity
  for (const id of index.query({ minX: p.x - tol, minY: p.y - tol, maxX: p.x + tol, maxY: p.y + tol })) {
    const e = doc.get(id)
    if (!e || !selectable(doc, e)) continue
    const d = typeOf(e).distance(e, p)
    if (d > tol) continue
    if (d < bestD || (d === bestD && id > best!)) {
      best = id
      bestD = d
    }
  }
  return best
}

/** Whether any primitive of e reaches into the closed box b. */
function touches(e: Entity, b: BBox): boolean {
  let hit = false
  typeOf(e).primitives(e, 0, {
    segment(x0, y0, x1, y1) {
      hit ||= clipSegment(b, x0, y0, x1, y1) !== null
    },
    arc(cx, cy, r, a0, sweep) {
      hit ||= arcSpansInBox(b, cx, cy, r, a0, sweep).length > 0
    },
  })
  return hit
}

/** Window (crossing false): the selectable entities wholly inside b. Crossing: also those touching b. Ascending ids. */
export function pickBox(doc: Document, index: SpatialIndex, b: BBox, crossing: boolean): number[] {
  const out: number[] = []
  for (const id of index.query(b)) {
    const e = doc.get(id)
    if (!e || !selectable(doc, e)) continue
    if (bboxContains(b, typeOf(e).bbox(e)) || (crossing && touches(e, b))) out.push(id)
  }
  return out.sort((p, q) => p - q)
}
