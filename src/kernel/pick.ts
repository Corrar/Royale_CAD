import type { Document } from './document'
import { typeOf } from './entity/registry'
import type { Entity } from './entity/types'
import { arcTouchesBox, clipSegment, triangleTouchesBox } from './geom/clip'
import { bboxContains, type BBox, type Vec2 } from './geom/vec'
import type { SpatialIndex } from './spatial'
import { advanceOf, DESCENT } from './text/font'

/** Entities on hidden layers cannot be selected. Locked ones can; commands filter them. */
const selectable = (doc: Document, e: Entity): boolean => doc.layers.get(e.layer)?.visible === true

/**
 * The nearest selectable entity within tol (world units) of p, or null. A tie goes to the later entity. A fill is as
 * near as its outline: inside it, off the outline, it comes after anything within tol, as fills draw under the rest.
 */
export function pick(doc: Document, index: SpatialIndex, p: Vec2, tol: number): number | null {
  let best: number | null = null
  let bestD = Infinity
  for (const id of index.query({ minX: p.x - tol, minY: p.y - tol, maxX: p.x + tol, maxY: p.y + tol })) {
    const e = doc.get(id)
    if (!e || !selectable(doc, e)) continue
    const t = typeOf(e)
    const d = t.distance(e, p)
    // The outline is never nearer than the fill: past the best, it cannot win.
    if (d > tol || d > bestD) continue
    const o = t.outlineDistance ? t.outlineDistance(e, p) : d
    // Only the inside reaches p: as far as anything can be, so that the later of such fills wins the tie.
    const key = o <= tol ? o : Infinity
    if (best === null || key < bestD || (key === bestD && id > best)) {
      best = id
      bestD = key
    }
  }
  return best
}

/** Whether the parallelogram o + s·u + t·v (s, t in 0..1) reaches into the closed box b. */
function quadTouches(b: BBox, ox: number, oy: number, ux: number, uy: number, vx: number, vy: number): boolean {
  const xs = [ox, ox + ux, ox + ux + vx, ox + vx]
  const ys = [oy, oy + uy, oy + uy + vy, oy + vy]
  for (let i = 0; i < 4; i++) if (clipSegment(b, xs[i]!, ys[i]!, xs[(i + 1) % 4]!, ys[(i + 1) % 4]!)) return true
  // No edge reaches in: the box is wholly inside the quad, or apart. Its centre tells which.
  const det = ux * vy - uy * vx
  if (det === 0) return false
  const px = (b.minX + b.maxX) / 2 - ox
  const py = (b.minY + b.maxY) / 2 - oy
  const s = (px * vy - py * vx) / det
  const t = (ux * py - uy * px) / det
  return s >= 0 && s <= 1 && t >= 0 && t <= 1
}

/**
 * Whether any primitive of e reaches into the closed box b. A letter counts by its cell: advance by descent to cap; a
 * filled triangle by its fill.
 */
function touches(e: Entity, b: BBox): boolean {
  let hit = false
  typeOf(e).primitives(e, 0, {
    segment(x0, y0, x1, y1) {
      hit ||= clipSegment(b, x0, y0, x1, y1) !== null
    },
    arc(cx, cy, r, a0, sweep) {
      hit ||= arcTouchesBox(b, cx, cy, r, a0, sweep)
    },
    glyph(cp, x, y, ux, uy, vx, vy) {
      const w = advanceOf(cp)
      hit ||= quadTouches(b, x - DESCENT * vx, y - DESCENT * vy, w * ux, w * uy, (1 + DESCENT) * vx, (1 + DESCENT) * vy)
    },
    tri(x0, y0, x1, y1, x2, y2) {
      hit ||= triangleTouchesBox(b, x0, y0, x1, y1, x2, y2)
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
