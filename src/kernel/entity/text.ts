import { affineDet, applyAffine, segmentDistance, type Affine, type BBox, type Vec2 } from '../geom/vec'
import { normAngle } from '../geom/tol'
import { atFrame, layoutMText, layoutText, mirrorPlacement, type Laid } from '../text/layout'
import { SNAP, type EntityType, type MText, type PrimSink, type Text } from './types'

// Entities never change: a layout worked out once is kept with the entity.
const laid = new WeakMap<Text | MText, Laid>()
const layoutOf = (e: Text | MText): Laid => {
  let l = laid.get(e)
  if (!l) laid.set(e, (l = e.type === 'text' ? layoutText(e) : layoutMText(e)))
  return l
}

/** The corners of the laid-out box, in the world, in order round it. */
function corners(l: Laid): Vec2[] {
  const { frame: f, box: b } = l
  return [atFrame(f, b.x0, b.y0), atFrame(f, b.x1, b.y0), atFrame(f, b.x1, b.y1), atFrame(f, b.x0, b.y1)]
}

function bboxOf(e: Text | MText): BBox {
  const cs = corners(layoutOf(e))
  return {
    minX: Math.min(...cs.map((c) => c.x)), minY: Math.min(...cs.map((c) => c.y)),
    maxX: Math.max(...cs.map((c) => c.x)), maxY: Math.max(...cs.map((c) => c.y)),
  }
}

function glyphsOf(e: Text | MText, out: PrimSink): void {
  const { frame: f, glyphs, rules } = layoutOf(e)
  // Underlines, overlines and strike-throughs are lines.
  for (const r of rules) {
    const a = atFrame(f, r.x0, r.y)
    const b = atFrame(f, r.x1, r.y)
    out.segment(a.x, a.y, b.x, b.y)
  }
  if (!out.glyph) return
  for (const g of glyphs) {
    const p = atFrame(f, g.x, g.y)
    out.glyph(g.cp, p.x, p.y, f.ux, f.uy, f.vx, f.vy)
  }
}

/** 0 inside the box (text is picked by its box, as in AutoCAD), else the distance to its edges. */
function distanceOf(e: Text | MText, p: Vec2): number {
  const cs = corners(layoutOf(e))
  let inside = true
  let sign = 0
  let d = Infinity
  for (let i = 0; i < 4; i++) {
    const a = cs[i]!
    const b = cs[(i + 1) % 4]!
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
    if (cross !== 0) {
      if (sign === 0) sign = Math.sign(cross)
      else if (Math.sign(cross) !== sign) inside = false
    }
    d = Math.min(d, segmentDistance(p.x, p.y, a.x, a.y, b.x, b.y))
  }
  return inside ? 0 : d
}

/** The local point of the box (x, y) stands for, for a mirror to put it back. */
function anchorOf(l: Laid, x: number, y: number): Vec2 {
  const f = l.frame
  const det = f.ux * f.vy - f.uy * f.vx
  const dx = x - f.ox
  const dy = y - f.oy
  return { x: (dx * f.vy - dy * f.vx) / det, y: (f.ux * dy - f.uy * dx) / det }
}

/** The way text runs: aligned and fit from their first point to their second, as drawn, whatever their 50 says. */
function directionOf(e: Text | MText): number {
  const spanned = e.type === 'text' && (e.halign === 3 || e.halign === 5) && (e.x2 !== e.x || e.y2 !== e.y)
  return spanned ? Math.atan2(e.y2 - e.y, e.x2 - e.x) : e.rotation
}

/** A turn and uniform scale move the point and the rotation; a mirror keeps the text readable. */
function moved<E extends Text | MText>(e: E, m: Affine): { x: number; y: number; rotation: number; k: number } {
  const det = affineDet(m)
  const k = Math.sqrt(Math.abs(det))
  if (det > 0) {
    const p = applyAffine(m, e.x, e.y)
    return { x: p.x, y: p.y, rotation: normAngle(directionOf(e) + Math.atan2(m.b, m.a)), k }
  }
  const l = layoutOf(e)
  // A backward text reads against its rotation: place it by the way it reads, then turn back.
  const back = e.type === 'text' && e.backward ? Math.PI : 0
  const p = mirrorPlacement(l, anchorOf(l, e.x, e.y), m, directionOf(e) + back)
  return { ...p, rotation: normAngle(p.rotation + back), k }
}

export const textType: EntityType<Text> = {
  type: 'text',
  bbox: bboxOf,
  primitives: (e, _tol, out) => glyphsOf(e, out),
  distance: distanceOf,
  transform(e, m) {
    const { x, y, rotation, k } = moved(e, m)
    // Aligned and fit run between their points: the second follows the first along the new direction.
    const span = Math.hypot(e.x2 - e.x, e.y2 - e.y) * k
    const spanned = e.halign === 3 || e.halign === 5
    const [x2, y2] = spanned ? [x + span * Math.cos(rotation), y + span * Math.sin(rotation)] : [x, y]
    return { ...e, x, y, x2, y2, rotation, height: e.height * k }
  },
  snapPoints(e, modes, out) {
    if (modes & SNAP.INS) out(e.x, e.y, SNAP.INS)
  },
  validate(e) {
    if (!(e.height > 0)) return `text height must be > 0, got ${e.height}`
    if (!(e.widthFactor > 0)) return `text width factor must be > 0, got ${e.widthFactor}`
    return undefined
  },
}

export const mtextType: EntityType<MText> = {
  type: 'mtext',
  bbox: bboxOf,
  primitives: (e, _tol, out) => glyphsOf(e, out),
  distance: distanceOf,
  transform(e, m) {
    const { x, y, rotation, k } = moved(e, m)
    return { ...e, x, y, rotation, height: e.height * k, width: e.width * k }
  },
  snapPoints(e, modes, out) {
    if (modes & SNAP.INS) out(e.x, e.y, SNAP.INS)
  },
  validate(e) {
    if (!(e.height > 0)) return `text height must be > 0, got ${e.height}`
    if (!(Number.isInteger(e.attachment) && e.attachment >= 1 && e.attachment <= 9)) return `mtext attachment must be 1–9, got ${e.attachment}`
    if (!(e.width >= 0) || !(e.spacing > 0)) return 'mtext width must be ≥ 0 and its line spacing > 0'
    return undefined
  },
}
