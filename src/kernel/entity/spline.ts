import { nurbsEval, nurbsDomain, nurbsPieces, nurbsProblem, flattenPieces } from '../geom/curve'
import { applyAffine, type BBox } from '../geom/vec'
import { DEFAULT_TOL, freeCurve } from './free'
import { SNAP, type EntityType, type Spline } from './types'

// Entities never change: what is worked out once from one is kept with it.
const piecesCache = new WeakMap<Spline, Float64Array[]>()
const bboxCache = new WeakMap<Spline, BBox>()

const piecesOf = (e: Spline): Float64Array[] => {
  let p = piecesCache.get(e)
  if (!p) piecesCache.set(e, (p = nurbsPieces(e)))
  return p
}

/** The diagonal of the control points' box: the curve lies in their hull. */
function sizeOf(e: Spline): number {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < e.ctrl.length; i += 2) {
    minX = Math.min(minX, e.ctrl[i]!)
    maxX = Math.max(maxX, e.ctrl[i]!)
    minY = Math.min(minY, e.ctrl[i + 1]!)
    maxY = Math.max(maxY, e.ctrl[i + 1]!)
  }
  return Math.hypot(maxX - minX, maxY - minY)
}

export const splineType: EntityType<Spline> = {
  type: 'spline',
  ...freeCurve(piecesOf, sizeOf),
  bbox(e) {
    let b = bboxCache.get(e)
    if (b) return b
    // A flattening's box, grown by its tolerance: it holds the curve.
    const tol = DEFAULT_TOL * sizeOf(e)
    b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
    const box = b
    flattenPieces(piecesOf(e), tol > 0 ? tol : 1, null, (x0, y0, x1, y1) => {
      box.minX = Math.min(box.minX, x0, x1)
      box.minY = Math.min(box.minY, y0, y1)
      box.maxX = Math.max(box.maxX, x0, x1)
      box.maxY = Math.max(box.maxY, y0, y1)
    })
    b = { minX: b.minX - tol, minY: b.minY - tol, maxX: b.maxX + tol, maxY: b.maxY + tol }
    bboxCache.set(e, b)
    return b
  },
  transform(e, m) {
    const ctrl = new Float64Array(e.ctrl.length)
    for (let i = 0; i < ctrl.length; i += 2) {
      const p = applyAffine(m, e.ctrl[i]!, e.ctrl[i + 1]!)
      ctrl[i] = p.x
      ctrl[i + 1] = p.y
    }
    return { ...e, ctrl }
  },
  snapPoints(e, modes, out) {
    if (!(modes & SNAP.END)) return
    const [a, b] = nurbsDomain(e)
    const s = nurbsEval(e, a)
    const t = nurbsEval(e, b)
    out(s.x, s.y, SNAP.END)
    out(t.x, t.y, SNAP.END)
  },
  validate: (e) => nurbsProblem(e) ?? undefined,
}
