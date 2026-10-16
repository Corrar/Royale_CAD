import { arcDistance, ellipsePieces, flattenPieces } from '../geom/curve'
import { TAU, normAngle } from '../geom/tol'
import { affineDet, applyAffine, bboxIntersects, segmentDistance, triangleDistance, type Affine, type BBox, type Vec2 } from '../geom/vec'
import { advanceOf, DESCENT } from '../text/font'
import { DEFAULT_TOL } from './free'
import { typeOf } from './registry'
import { BY_BLOCK, SNAP, type Attrib, type Block, type BlockEntity, type Entity, type EntityType, type Insert, type PrimSink } from './types'

/** A block's entity as the entity types take it: they never read its id. */
const asEntity = (d: BlockEntity): Entity => d as unknown as Entity

/** The attributes shown: not hidden. */
const shown = (e: Insert): readonly Attrib[] => (e.attribs ? e.attribs.filter((a) => !a.hidden) : [])

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

/** The distance from p to the parallelogram o + s·u + t·v (s, t in 0..1): 0 inside. */
function quadDistance(p: Vec2, ox: number, oy: number, ux: number, uy: number, vx: number, vy: number): number {
  const det = ux * vy - uy * vx
  const px = p.x - ox
  const py = p.y - oy
  const s = (px * vy - py * vx) / det
  const t = (ux * py - uy * px) / det
  if (s >= 0 && s <= 1 && t >= 0 && t <= 1) return 0
  const xs = [ox, ox + ux, ox + ux + vx, ox + vx]
  const ys = [oy, oy + uy, oy + uy + vy, oy + vy]
  let d = Infinity
  for (let i = 0; i < 4; i++) d = Math.min(d, segmentDistance(p.x, p.y, xs[i]!, ys[i]!, xs[(i + 1) % 4]!, ys[(i + 1) % 4]!))
  return d
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
    glyph(cp, x, y, ux, uy, vx, vy) {
      // Letters take the whole affine, stretch and slant included.
      const p = applyAffine(m, x, y)
      out.glyph?.(cp, p.x, p.y, m.a * ux + m.c * uy, m.b * ux + m.d * uy, m.a * vx + m.c * vy, m.b * vx + m.d * vy)
    },
    tri(x0, y0, x1, y1, x2, y2) {
      // An affine keeps a triangle a triangle, whatever it does.
      const a = applyAffine(m, x0, y0)
      const b = applyAffine(m, x1, y1)
      const c = applyAffine(m, x2, y2)
      out.tri?.(a.x, a.y, b.x, b.y, c.x, c.y)
    },
    edge(x0, y0, x1, y1) {
      const p = applyAffine(m, x0, y0)
      const q = applyAffine(m, x1, y1)
      out.edge?.(p.x, p.y, q.x, q.y)
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

/** The distance from p to what e shows; with outline, its fills are as near as their outlines (outlineDistance). */
function reach(e: Insert, p: Vec2, outline: boolean): number {
  const of = (d: Entity, q: Vec2): number => {
    const t = typeOf(d)
    return outline && t.outlineDistance ? t.outlineDistance(d, q) : t.distance(d, q)
  }
  let best = Infinity
  for (const a of shown(e)) best = Math.min(best, of(asEntity(a), p))
  const ms = insertAffines(e)
  if (ms.every(similar)) {
    for (const m of ms) {
      const q = applyAffine(invert(m), p.x, p.y)
      const k = Math.sqrt(Math.abs(affineDet(m)))
      for (const d of e.block.entities) best = Math.min(best, k * of(asEntity(d), q))
    }
    return best
  }
  insertType.primitives(e, 0, {
    segment: (x0, y0, x1, y1) => void (best = Math.min(best, segmentDistance(p.x, p.y, x0, y0, x1, y1))),
    arc: (cx, cy, r, a0, sweep) => void (best = Math.min(best, arcDistance(p.x, p.y, cx, cy, r, a0, sweep))),
    tri(...c) {
      if (!outline) best = Math.min(best, triangleDistance(p.x, p.y, ...c))
    },
    edge(x0, y0, x1, y1) {
      if (outline) best = Math.min(best, segmentDistance(p.x, p.y, x0, y0, x1, y1))
    },
    // A letter counts by its cell, advance by descent to cap, as crossing selection takes it.
    glyph(cp, x, y, ux, uy, vx, vy) {
      const w = advanceOf(cp)
      best = Math.min(best, quadDistance(p, x - DESCENT * vx, y - DESCENT * vy, w * ux, w * uy, (1 + DESCENT) * vx, (1 + DESCENT) * vy))
    },
  })
  return best
}

export const insertType: EntityType<Insert> = {
  type: 'insert',
  bbox(e) {
    const inner = infoOf(e.block).box
    const out = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
    const add = (b: BBox): void => {
      out.minX = Math.min(out.minX, b.minX)
      out.minY = Math.min(out.minY, b.minY)
      out.maxX = Math.max(out.maxX, b.maxX)
      out.maxY = Math.max(out.maxY, b.maxY)
    }
    // An empty block shows nothing; its attributes still do.
    if (inner.minX <= inner.maxX) for (const m of insertAffines(e)) add(mapBox(m, inner))
    for (const a of shown(e)) add(typeOf(asEntity(a)).bbox(asEntity(a)))
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
    for (const a of shown(e)) {
      out.look?.(a.layer, a.color === BY_BLOCK ? e.color : a.color)
      typeOf(asEntity(a)).primitives(asEntity(a), tol, out, clip)
    }
  },
  free(e) {
    const info = infoOf(e.block)
    return info.free || (info.arcs && !similar(copyAffine(e, 0, 0)))
  },
  distance: (e, p) => reach(e, p, false),
  outlineDistance: (e, p) => reach(e, p, true),
  transform(e, m) {
    const det = affineDet(m)
    const k = Math.sqrt(Math.abs(det))
    const p = applyAffine(m, e.x, e.y)
    const angle = Math.atan2(m.b, m.a)
    // Attributes are texts in the world: they move as texts do (a mirror keeps them readable).
    const attribs = e.attribs && { attribs: e.attribs.map((a) => ({ ...(typeOf(asEntity(a)).transform!(asEntity(a), m) as unknown as Attrib), tag: a.tag, hidden: a.hidden })) }
    // A turn adds to the rotation; a mirror reflects it and flips the Y scale (AutoCAD does the same).
    if (det > 0) return { ...e, ...attribs, x: p.x, y: p.y, rotation: normAngle(e.rotation + angle), sx: e.sx * k, sy: e.sy * k, dx: e.dx * k, dy: e.dy * k }
    return { ...e, ...attribs, x: p.x, y: p.y, rotation: normAngle(angle - e.rotation), sx: e.sx * k, sy: -e.sy * k, dx: e.dx * k, dy: -e.dy * k }
  },
  snapPoints(e, modes, out) {
    const inner = modes & ~SNAP.INS
    // Each attribute's own insertion point.
    if (modes & SNAP.INS) for (const a of shown(e)) typeOf(asEntity(a)).snapPoints?.(asEntity(a), SNAP.INS, out)
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
