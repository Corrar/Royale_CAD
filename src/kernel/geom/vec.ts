export interface Vec2 { x: number; y: number }
export interface BBox { minX: number; minY: number; maxX: number; maxY: number }

/** The identity of bboxUnion: grows with bboxAdd. */
export const emptyBBox = (): BBox => ({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity })

export function bboxAdd(b: BBox, x: number, y: number): void {
  if (x < b.minX) b.minX = x
  if (x > b.maxX) b.maxX = x
  if (y < b.minY) b.minY = y
  if (y > b.maxY) b.maxY = y
}

export function bboxUnion(a: BBox, b: BBox): BBox {
  return { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) }
}

/** Closed boxes: touching edges intersect. */
export const bboxIntersects = (a: BBox, b: BBox): boolean =>
  a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY

export const bboxContains = (outer: BBox, inner: BBox): boolean =>
  outer.minX <= inner.minX && inner.maxX <= outer.maxX && outer.minY <= inner.minY && inner.maxY <= outer.maxY

export const bboxFinite = (b: BBox): boolean =>
  Number.isFinite(b.minX) && Number.isFinite(b.minY) && Number.isFinite(b.maxX) && Number.isFinite(b.maxY)

/** Distance from (px, py) to the segment (x0, y0)-(x1, y1), clamped to its ends. */
export function segmentDistance(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0
  const dy = y1 - y0
  const len2 = dx * dx + dy * dy
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((px - x0) * dx + (py - y0) * dy) / len2)) : 0
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy))
}

/** x' = a·x + c·y + e, y' = b·x + d·y + f. */
export interface Affine { a: number; b: number; c: number; d: number; e: number; f: number }

export const applyAffine = (m: Affine, x: number, y: number): Vec2 => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f })

/** Negative for a mirroring. */
export const affineDet = (m: Affine): number => m.a * m.d - m.b * m.c

/** cos and sin of an angle in degrees, exact on the axes. */
export function unitDeg(deg: number): [number, number] {
  const q = deg / 90
  if (Number.isInteger(q)) {
    const k = ((q % 4) + 4) % 4
    return [[1, 0, -1, 0][k]!, [0, 1, 0, -1][k]!]
  }
  const a = (deg * Math.PI) / 180
  return [Math.cos(a), Math.sin(a)]
}

export const translation = (dx: number, dy: number): Affine => ({ a: 1, b: 0, c: 0, d: 1, e: dx, f: dy })

/** Rotation about p by deg degrees, counter-clockwise. */
export function rotation(p: Vec2, deg: number): Affine {
  const [c, s] = unitDeg(deg)
  return { a: c, b: s, c: -s, d: c, e: p.x - c * p.x + s * p.y, f: p.y - s * p.x - c * p.y }
}

export const scaling = (p: Vec2, k: number): Affine => ({ a: k, b: 0, c: 0, d: k, e: p.x - k * p.x, f: p.y - k * p.y })

/** Reflection across the line through p and q. */
export function mirroring(p: Vec2, q: Vec2): Affine {
  const dx = q.x - p.x
  const dy = q.y - p.y
  const len2 = dx * dx + dy * dy
  const a = (dx * dx - dy * dy) / len2
  const b = (2 * dx * dy) / len2
  // The reflection matrix [a b; b −a], fixing p.
  return { a, b, c: b, d: -a, e: p.x - a * p.x - b * p.y, f: p.y - b * p.x + a * p.y }
}
