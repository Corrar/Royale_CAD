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

/**
 * An elliptical arc (DXF ELLIPSE): the points c + M cos t + ratio·J(M) sin t, J turning 90° counter-clockwise, for
 * t counter-clockwise from t0 to t1 (parameters, not angles); equal parameters make a whole ellipse.
 */
export interface Ellipse extends Base {
  readonly type: 'ellipse'
  readonly cx: number
  readonly cy: number
  /** The major axis, from the centre to its end. */
  readonly mx: number
  readonly my: number
  /** Minor over major axis, in (0, 1]. */
  readonly ratio: number
  readonly t0: number
  readonly t1: number
}

/** A NURBS curve in the plane (DXF SPLINE), as geom/curve's Nurbs. */
export interface Spline extends Base {
  readonly type: 'spline'
  readonly degree: number
  readonly knots: Float64Array
  /** Control points as x, y pairs. */
  readonly ctrl: Float64Array
  /** One per control point; null when all are 1. */
  readonly weights: Float64Array | null
  /** The DXF closed flag (the ends meet); the geometry is the knots and control points alone. */
  readonly closed: boolean
}

/** ByBlock, in a block's entities only: the color of the insert that shows them. */
export const BY_BLOCK = 0

/**
 * A block definition (DXF BLOCK): what inserts show, in its own coordinates. Never changes once made; inserts hold
 * it, not its name.
 */
export interface Block {
  readonly name: string
  /** The base point: where the insertion point of an insert lands. */
  readonly x: number
  readonly y: number
  /** On the document's layers; on layer 0 they take the insert's layer, and ByBlock (BY_BLOCK) its color. */
  readonly entities: readonly BlockEntity[]
}

/** An entity of a block: no id, it is not in the document. */
export type BlockEntity = Entity extends infer E ? (E extends Entity ? Omit<E, 'id'> : never) : never

/**
 * A block reference (DXF INSERT, and MINSERT's grid): the block moved so that its base point lands on (x, y),
 * scaled by sx, sy and turned by rotation (radians, counter-clockwise). A grid has cols × rows copies, dx and dy
 * apart along the turned axes.
 */
export interface Insert extends Base {
  readonly type: 'insert'
  readonly block: Block
  readonly x: number
  readonly y: number
  readonly sx: number
  readonly sy: number
  readonly rotation: number
  readonly cols: number
  readonly rows: number
  readonly dx: number
  readonly dy: number
  /** Its attributes (DXF ATTRIB), in the file's order: texts in the world, not in the block, moved with it. */
  readonly attribs?: readonly Attrib[]
}

/**
 * An attribute of an insert: a line of text named by its tag. On its own layer; ByBlock takes the insert's color.
 * A hidden one (DXF 70 bit 1) is kept, not shown.
 */
export interface Attrib extends Omit<Text, 'id'> {
  readonly tag: string
  readonly hidden: boolean
}

/**
 * A line of text (DXF TEXT, and ATTRIB values). value is the string as the file has it (%%c and the like kept);
 * height is the capital letters' height. halign: 0 left, 1 center, 2 right, 3 aligned, 4 middle, 5 fit; valign:
 * 0 baseline, 1 bottom, 2 middle, 3 top. (x, y) is the point the justification puts the text at (the start of the
 * baseline when left/baseline); aligned and fit run from (x, y) to (x2, y2), which otherwise repeat (x, y).
 */
export interface Text extends Base {
  readonly type: 'text'
  readonly value: string
  readonly x: number
  readonly y: number
  readonly x2: number
  readonly y2: number
  readonly height: number
  /** Radians, counter-clockwise. */
  readonly rotation: number
  readonly widthFactor: number
  /** Slant of the letters from upright, radians, positive to the right. */
  readonly oblique: number
  readonly halign: number
  readonly valign: number
  /** Drawn mirrored left to right (DXF 71 bit 2). */
  readonly backward: boolean
  /** Drawn mirrored top to bottom (DXF 71 bit 4). */
  readonly upsideDown: boolean
}

/**
 * Paragraphs of text in a box (DXF MTEXT). value keeps the file's formatting codes; the layout shows the text
 * without them, wrapped to width (0: no wrapping). attachment 1–9 is the box point at (x, y): top left, center,
 * right, then middle and bottom rows. spacing scales the default 5/3 of height between baselines.
 */
export interface MText extends Base {
  readonly type: 'mtext'
  readonly value: string
  readonly x: number
  readonly y: number
  readonly height: number
  readonly width: number
  readonly attachment: number
  readonly rotation: number
  readonly spacing: number
}

export type Entity = Line | Circle | Arc | Polyline | Point | Opaque | Ellipse | Spline | Insert | Text | MText

/** Object snap modes, as bits (AutoCAD's OSMODE uses its own values; these are ours). */
export const SNAP = { END: 1, MID: 2, CEN: 4, INT: 8, QUA: 16, PER: 32, NEA: 64, NOD: 128, INS: 256 } as const

/** Receives a snap point and the single mode it belongs to. */
export type SnapSink = (x: number, y: number, mode: number) => void

/** What the renderer draws. Arc sweep is signed (positive counter-clockwise); a full circle is 2π. */
export interface PrimSink {
  segment(x0: number, y0: number, x1: number, y1: number): void
  arc(cx: number, cy: number, r: number, a0: number, sweep: number): void
  /** The primitives that follow are on this layer, in this color (undefined: ByLayer): an insert's entities. */
  look?(layer: number, color: Color | undefined): void
  /**
   * A character (code point cp) whose baseline starts at (x, y); (ux, uy) is one capital height along the
   * baseline and (vx, vy) one capital height up (both already scaled, slanted or mirrored). The font's metrics are
   * in text/font.ts.
   */
  glyph?(cp: number, x: number, y: number, ux: number, uy: number, vx: number, vy: number): void
}

export interface EntityType<E extends Entity> {
  readonly type: E['type']
  bbox(e: E): BBox
  /**
   * tol: allowed chordal error in world units for curves flattened on the CPU, 0 for a default relative to the
   * curve's size; with clip, a flattened curve may leave out what cannot reach it. Exact primitives ignore both.
   */
  primitives(e: E, tol: number, out: PrimSink, clip?: BBox): void
  /** Drawn by curves flattened on the CPU (free): the scene flattens it again for the zoom, the visible part only. */
  free?(e: E): boolean
  distance(e: E, p: Vec2): number
  /** The point of e nearest p, where primitives at the default tolerance would not be exact enough. */
  nearest?(e: E, p: Vec2): Vec2
  /** The entity moved by m, same id: only similarities (move, rotate, mirror, uniform scale) are supported. */
  transform?(e: E, m: Affine): E
  /** Emits the snap points of the modes asked for (a bit set of SNAP). */
  snapPoints?(e: E, modes: number, out: SnapSink): void
  /** A message when the fields break the type's invariants; the document also rejects non-finite bboxes. */
  validate?(e: E): string | undefined
}
