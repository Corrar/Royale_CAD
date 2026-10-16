import { flattenPieces, piecesNearest } from '../geom/curve'
import type { BBox, Vec2 } from '../geom/vec'
import type { Entity, EntityType, PrimSink } from './types'

/** The chordal error of a free curve drawn without a tolerance (picks, snaps, previews), relative to its size. */
export const DEFAULT_TOL = 1e-4

/**
 * What every curve flattened on the CPU shares, from its rational Bézier pieces and its size: chords to a tolerance
 * (only near clip when given), and a distance and nearest point exact at any zoom.
 */
export function freeCurve<E extends Entity>(
  pieces: (e: E) => readonly Float64Array[],
  size: (e: E) => number,
): Pick<EntityType<E>, 'primitives' | 'free' | 'distance' | 'nearest'> {
  return {
    free: true,
    primitives(e: E, tol: number, out: PrimSink, clip?: BBox) {
      flattenPieces(pieces(e), tol > 0 ? tol : DEFAULT_TOL * size(e), clip ?? null, (x0, y0, x1, y1) => out.segment(x0, y0, x1, y1))
    },
    distance: (e: E, p: Vec2) => piecesNearest(pieces(e), p.x, p.y, size(e)).d,
    nearest(e: E, p: Vec2) {
      const n = piecesNearest(pieces(e), p.x, p.y, size(e))
      return { x: n.x, y: n.y }
    },
  }
}
