import { arcDistance, ellipsePieces, flattenPieces } from '../geom/curve'
import { TAU, normAngle } from '../geom/tol'
import { affineDet, applyAffine, bboxIntersects, segmentDistance, type Affine, type BBox, type Vec2 } from '../geom/vec'
import { DEFAULT_TOL } from './free'
import { typeOf } from './registry'
import { BY_BLOCK, SNAP, type Block, type BlockEntity, type Entity, type EntityType, type Insert, type PrimSink } from './types'

/** A block's entity as the entity types take it: they never read its id. */
const asEntity = (d: BlockEntity): Entity => d as unknown as Entity

/** The affine of copy (i, j): T(x, y) · R(rotation) · T(i·dx, j·dy) · S(sx, sy) · T(−base). */
function copyAffine(e: Insert, i: number, j: number): Affine {
  const c = Math.cos(e.rotation)
  const s = Math.sin(e.rotation)
  const a = c * e.sx
  const b = s * e.sx
  const cc = -s * e.sy
  const d = c * e.sy
  const ox = i * e.dx
  const oy = j * e.dy
  const { x: bx, y: by } = e.block
  return { a, b, c: cc, d, e: e.x + c * ox - s * oy - (a * bx + cc * by), f: e.y + s * ox + c * oy - (b * bx + d * by) }
}

/** The affines of every copy: one, or cols × rows for a grid. */
export function insertAffines(e: Insert): Affine[] {
  const out: Affine[] = []
  for (let i = 0; i < e.cols; i++) for (let j = 0; j < e.rows; j++) out.push(copyAffine(e, i, j))
  return out
}

/** A rotation, a uniform scale or a mirror, possibly together: circles stay circles. */
function similar(m: Affine): boolean {
  const k = Math.hypot(m.a, m.b, m.c, m.d)
  const tol = 1e-12 * k
  return (Math.abs(m.a - m.d) <= tol && Math.abs(m.b + m.c) <= tol) || (Math.abs(m.a + m.d) <= tol && Math.abs(m.b - m.c) <= tol)
}

/** The most m can stretch a length. */
const stretch = (m: Affine): number => Math.hypot(m.a, m.b, m.c, m.d)

function invert(m: Affine): Affine {
  const det = affineDet(m)
  const a = m.d / det
  const b = -m.b / det
  const c = -m.c / det
  const d = m.a / det
  return { a, b, c, d, e: -(a * m.e + c * m.f), f: -(b * m.e + d * m.f) }
}

/** The box of b's corners taken through m. */
function mapBox(m: Affine, b: BBox): BBox {
  const out = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  for (const [x, y] of [[b.minX, b.minY], [b.maxX, b.minY], [b.minX, b.maxY], [b.maxX, b.maxY]] as const) {
    const p = applyAffine(m, x, y)
    out.minX = Math.min(out.minX, p.x)
    out.minY = Math.min(out.minY, p.y)
    out.maxX = Math.max(out.maxX, p.x)
    out.maxY = Math.max(out.maxY, p.y)
  }
  return out
}

/**
 * A sink taking primitives in block coordinates to `out` in world coordinates through m. A similarity keeps an
 * arc an arc (a mirrored one turning the other way); any other affine makes it chords within tol (0: a default
 * relative to its size). Looks resolve against the insert: layer 0 takes its layer, ByBlock its color.
 */
function mapped(m: Affine, out: PrimSink, owner: Insert | BlockEntity, tol: number, clip: BBox | null): PrimSink {
  const det = affineDet(m)
  const k = Math.sqrt(Math.abs(det))
  const round = similar(m)
  return {
    segment(x0, y0, x1, y1) {
      const p = applyAffine(m, x0, y0)
      const q = applyAffine(m, x1, y1)
      out.segment(p.x, p.y, q.x, q.y)
    },
    arc(cx, cy, r, a0, sweep) {
      if (round) {
        const c = applyAffine(m, cx, cy)
        // A whole circle has no start worth keeping.
        if (Math.abs(sweep) >= TAU) return out.arc(c.x, c.y, r * k, 0, TAU)
        const start = normAngle(Math.atan2(m.b * Math.cos(a0) + m.d * Math.sin(a0), m.a * Math.cos(a0) + m.c * Math.sin(a0)))
        return out.arc(c.x, c.y, r * k, start, det > 0 ? sweep : -sweep)
      }
      const pieces = ellipsePieces(cx, cy, r, 0, 1, a0, sweep).map((p) => {
        const q = p.slice()
        for (let i = 0; i < q.length; i += 3) {
          const w = q[i + 2]!
          const t = applyAffine(m, q[i]! / w, q[i + 1]! / w)
          q[i] = t.x * w
          q[i + 1] = t.y * w
        }
        return q
      })
      flattenPieces(pieces, tol > 0 ? tol : DEFAULT_TOL * r * stretch(m), clip, (x0, y0, x1, y1) => out.segment(x0, y0, x1, y1))
    },
    look(layer, color) {
      out.look?.(layer === 0 ? owner.layer : layer, color === BY_BLOCK ? owner.color : color)
    },
  }
}

/** What an insert needs to know of its block, worked out once: its box, whether it holds arcs or free curves. */
interface BlockInfo { box: BBox; arcs: boolean; free: boolean }
const infos = new WeakMap<Block, BlockInfo>()

function infoOf(block: Block): BlockInfo {
  let info = infos.get(block)
  if (info) return info
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  let arcs = false
  let free = false
  for (const d of block.entities) {
    const e = asEntity(d)
    const t = typeOf(e)
    const b = t.bbox(e)
    box.minX = Math.min(box.minX, b.minX)
    box.minY = Math.min(box.minY, b.minY)
    box.maxX = Math.max(box.maxX, b.maxX)
    box.maxY = Math.max(box.maxY, b.maxY)
    if (e.type === 'insert') {
      const inner = infoOf(e.block)
      arcs ||= inner.arcs
      free ||= inner.free
    } else if (t.free?.(e)) free = true
    else if (!arcs) t.primitives(e, 0, { segment() {}, arc: () => void (arcs = true) })
  }
  infos.set(block, (info = { box, arcs, free }))
  return info
}

export const insertType: EntityType<Insert> = {
  type: 'insert',
  bbox(e) {
    const inner = infoOf(e.block).box
    const out = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
    if (!(inner.minX <= inner.maxX)) return out // nothing to show
    for (const m of insertAffines(e)) {
      const b = mapBox(m, inner)
      out.minX = Math.min(out.minX, b.minX)
      out.minY = Math.min(out.minY, b.minY)
      out.maxX = Math.max(out.maxX, b.maxX)
      out.maxY = Math.max(out.maxY, b.maxY)
    }
    return out
  },
  primitives(e, tol, out, clip) {
    for (const m of insertAffines(e)) {
      const sink = mapped(m, out, e, tol, clip ?? null)
      const local = clip ? mapBox(invert(m), clip) : undefined
      const t = tol > 0 ? tol / stretch(m) : 0
      for (const d of e.block.entities) {
        const inner = asEntity(d)
        if (local && !bboxIntersects(typeOf(inner).bbox(inner), local)) continue
        sink.look?.(d.layer, d.color)
        typeOf(inner).primitives(inner, t, sink, local)
      }
    }
  },
  free(e) {
    const info = infoOf(e.block)
    return info.free || (info.arcs && !similar(copyAffine(e, 0, 0)))
  },
  distance(e, p) {
    let best = Infinity
    const ms = insertAffines(e)
    if (ms.every(similar)) {
      for (const m of ms) {
        const q = applyAffine(invert(m), p.x, p.y)
        const k = Math.sqrt(Math.abs(affineDet(m)))
        for (const d of e.block.entities) best = Math.min(best, k * typeOf(asEntity(d)).distance(asEntity(d), q))
      }
      return best
    }
    insertType.primitives(e, 0, {
      segment: (x0, y0, x1, y1) => void (best = Math.min(best, segmentDistance(p.x, p.y, x0, y0, x1, y1))),
      arc: (cx, cy, r, a0, sweep) => void (best = Math.min(best, arcDistance(p.x, p.y, cx, cy, r, a0, sweep))),
    })
    return best
  },
  transform(e, m) {
    const det = affineDet(m)
    const k = Math.sqrt(Math.abs(det))
    const p = applyAffine(m, e.x, e.y)
    const angle = Math.atan2(m.b, m.a)
    // A turn adds to the rotation; a mirror reflects it and flips the Y scale (AutoCAD does the same).
    if (det > 0) return { ...e, x: p.x, y: p.y, rotation: normAngle(e.rotation + angle), sx: e.sx * k, sy: e.sy * k, dx: e.dx * k, dy: e.dy * k }
    return { ...e, x: p.x, y: p.y, rotation: normAngle(angle - e.rotation), sx: e.sx * k, sy: -e.sy * k, dx: e.dx * k, dy: -e.dy * k }
  },
  snapPoints(e, modes, out) {
    const inner = modes & ~SNAP.INS
    for (const m of insertAffines(e)) {
      if (modes & SNAP.INS) {
        const p = applyAffine(m, e.block.x, e.block.y)
        out(p.x, p.y, SNAP.INS)
      }
      // Quadrants are a circle's: not what an uneven scale makes of it.
      const asked = similar(m) ? inner : inner & ~SNAP.QUA
      if (!asked) continue
      for (const d of e.block.entities) {
        typeOf(asEntity(d)).snapPoints?.(asEntity(d), asked, (x, y, mode) => {
          const q = applyAffine(m, x, y)
          out(q.x, q.y, mode)
        })
      }
    }
  },
  validate(e) {
    if (!(e.sx !== 0 && e.sy !== 0 && Number.isFinite(e.sx) && Number.isFinite(e.sy))) return `insert scale must not be zero, got ${e.sx}, ${e.sy}`
    if (!(Number.isInteger(e.cols) && Number.isInteger(e.rows) && e.cols >= 1 && e.rows >= 1)) return `an insert has whole copies, got ${e.cols} × ${e.rows}`
    if (!(Number.isFinite(e.rotation) && Number.isFinite(e.dx) && Number.isFinite(e.dy))) return 'insert numbers must be finite'
    return undefined
  },
}

/** For tests and callers that need a point of an insert: where copy (i, j) puts the block's base. */
export const insertionPoint = (e: Insert, i = 0, j = 0): Vec2 => applyAffine(copyAffine(e, i, j), e.block.x, e.block.y)
