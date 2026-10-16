import type { Color } from '../color'
import type { BBox, Vec2 } from '../geom/vec'

/**
 * Entities are immutable: never mutate one, nor its arrays, once it is in a document; replace it in a transaction.
 * Fixed-size geometry lives in number fields; variable-length vertex lists in Float64Array.
 */
export interface Base {
  readonly id: number
  readonly layer: number
  /** Absent: ByLayer. */
  readonly color?: Color
}

export interface Line extends Base {
  readonly type: 'line'
  readonly x0: number
  readonly y0: number
  readonly x1: number
  readonly y1: number
}

export interface Circle extends Base {
  readonly type: 'circle'
  readonly cx: number
  readonly cy: number
  readonly r: number
}

/** Counter-clockwise from a0 to a1 (radians); equal angles make a full circle. */
export interface Arc extends Base {
  readonly type: 'arc'
  readonly cx: number
  readonly cy: number
  readonly r: number
  readonly a0: number
  readonly a1: number
}

/**
 * pts holds x0, y0, x1, y1, …. bulges[i] shapes the piece from vertex i to the next (tan of a quarter of its
 * included angle, positive counter-clockwise); null when every piece is straight.
 */
export interface Polyline extends Base {
  readonly type: 'polyline'
  readonly pts: Float64Array
  readonly bulges: Float64Array | null
  readonly closed: boolean
}

export type Entity = Line | Circle | Arc | Polyline

/** What the renderer draws. Arc sweep is signed (positive counter-clockwise); a full circle is 2π. */
export interface PrimSink {
  segment(x0: number, y0: number, x1: number, y1: number): void
  arc(cx: number, cy: number, r: number, a0: number, sweep: number): void
}

export interface EntityType<E extends Entity> {
  readonly type: E['type']
  bbox(e: E): BBox
  /** tol: allowed chordal error in world units for curves flattened on the CPU; exact primitives ignore it. */
  primitives(e: E, tol: number, out: PrimSink): void
  distance(e: E, p: Vec2): number
  /** A message when the fields break the type's invariants; the document also rejects non-finite bboxes. */
  validate?(e: E): string | undefined
}
