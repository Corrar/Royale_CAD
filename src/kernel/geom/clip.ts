import { TAU, normAngle } from './tol'
import type { BBox } from './vec'

/** Liang–Barsky: the part of the segment inside the closed box b, in the segment's direction, or null. */
export function clipSegment(b: BBox, x0: number, y0: number, x1: number, y1: number): [number, number, number, number] | null {
  const dx = x1 - x0
  const dy = y1 - y0
  let t0 = 0
  let t1 = 1
  const edge = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0
    const t = q / p
    if (p < 0) t0 = Math.max(t0, t)
    else t1 = Math.min(t1, t)
    return t0 <= t1
  }
  if (!(edge(-dx, x0 - b.minX) && edge(dx, b.maxX - x0) && edge(-dy, y0 - b.minY) && edge(dy, b.maxY - y0))) return null
  return [
    t0 === 0 ? x0 : x0 + t0 * dx,
    t0 === 0 ? y0 : y0 + t0 * dy,
    t1 === 1 ? x1 : x0 + t1 * dx,
    t1 === 1 ? y1 : y0 + t1 * dy,
  ]
}

/**
 * Pieces of the arc inside the closed box b, as flat pairs (start angle, sweep > 0), counter-clockwise and in
 * order along the arc. The sweep may be negative; a full circle comes back as one piece wherever it wraps.
 */
export function arcSpansInBox(b: BBox, cx: number, cy: number, r: number, a0: number, sweep: number): number[] {
  const start = sweep >= 0 ? a0 : a0 + sweep
  const len = Math.min(Math.abs(sweep), TAU)
  // Parameters (angle from start) where the circle meets the lines of the box edges.
  const ts = [0, len]
  const cut = (angle: number): void => {
    const t = normAngle(angle - start)
    if (t > 0 && t < len) ts.push(t)
  }
  for (const x of [b.minX, b.maxX]) {
    const d = x - cx
    if (Math.abs(d) > r) continue
    const h = Math.sqrt((r - d) * (r + d)) // r² − d² without cancellation
    cut(Math.atan2(h, d))
    cut(Math.atan2(-h, d))
  }
  for (const y of [b.minY, b.maxY]) {
    const d = y - cy
    if (Math.abs(d) > r) continue
    const h = Math.sqrt((r - d) * (r + d))
    cut(Math.atan2(d, h))
    cut(Math.atan2(d, -h))
  }
  ts.sort((p, q) => p - q)
  // Inside pieces as parameter pairs [ta, tb]; adjacent ones share an exact parameter.
  const pieces: number[] = []
  for (let i = 1; i < ts.length; i++) {
    const ta = ts[i - 1]!
    const tb = ts[i]!
    if (tb <= ta) continue
    const mid = start + (ta + tb) / 2
    const x = cx + r * Math.cos(mid)
    const y = cy + r * Math.sin(mid)
    if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY) continue
    if (pieces.length > 0 && pieces[pieces.length - 1] === ta) pieces[pieces.length - 1] = tb
    else pieces.push(ta, tb)
  }
  // A full circle wraps: a piece ending at 2π continues into the one starting at 0.
  const n = pieces.length
  if (len === TAU && n >= 4 && pieces[0] === 0 && pieces[n - 1] === len) {
    pieces[n - 1] = len + pieces[1]!
    pieces.splice(0, 2)
  }
  const out: number[] = []
  for (let i = 0; i < pieces.length; i += 2) out.push(start + pieces[i]!, pieces[i + 1]! - pieces[i]!)
  return out
}
