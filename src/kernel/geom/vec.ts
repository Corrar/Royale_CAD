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
