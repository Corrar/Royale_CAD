import type { Color } from '../color'
import type { Affine, BBox, Vec2 } from '../geom/vec'

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

/** A point object (DXF POINT): drawn as a dot, found by NOD. */
export interface Point extends Base {
  readonly type: 'point'
  readonly x: number
  readonly y: number
}

/**
 * What the reader keeps without understanding it (HATCH, DIMENSION, paper space, 3D…): never drawn, indexed nor
 * picked, and written back exactly as read. Its bbox is empty.
 */
export interface Opaque extends Base {
  readonly type: 'opaque'
  /** The DXF entity name, as read (HATCH, INSERT…). */
  readonly name: string
  /** Its DXF text, from its 0 line through its data and any entities that follow it (VERTEX, ATTRIB, SEQEND). */
  readonly raw: string
}

export type Entity = Line | Circle | Arc | Polyline | Point | Opaque

/** Object snap modes, as bits (AutoCAD's OSMODE uses its own values; these are ours). */
export const SNAP = { END: 1, MID: 2, CEN: 4, INT: 8, QUA: 16, PER: 32, NEA: 64, NOD: 128 } as const

/** Receives a snap point and the single mode it belongs to. */
export type SnapSink = (x: number, y: number, mode: number) => void

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
  /** The entity moved by m, same id: only similarities (move, rotate, mirror, uniform scale) are supported. */
  transform?(e: E, m: Affine): E
  /** Emits the snap points of the modes asked for (a bit set of SNAP). */
  snapPoints?(e: E, modes: number, out: SnapSink): void
  /** A message when the fields break the type's invariants; the document also rejects non-finite bboxes. */
  validate?(e: E): string | undefined
}
