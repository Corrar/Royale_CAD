import type { BBox, Vec2 } from './geom/vec'

export interface ViewState { cx: number; cy: number; scale: number; width: number; height: number; dpr: number }

export const MIN_SCALE = 1e-6
export const MAX_SCALE = 1e6

const clampScale = (s: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))

export function worldToScreen(v: ViewState, x: number, y: number): Vec2 {
  return { x: v.width / 2 + (x - v.cx) * v.scale, y: v.height / 2 - (y - v.cy) * v.scale }
}

export function screenToWorld(v: ViewState, sx: number, sy: number): Vec2 {
  return { x: v.cx + (sx - v.width / 2) / v.scale, y: v.cy - (sy - v.height / 2) / v.scale }
}

export function zoomAt(v: ViewState, sx: number, sy: number, factor: number): ViewState {
  if (!Number.isFinite(factor) || factor <= 0) return v
  const scale = clampScale(v.scale * factor)
  const w = screenToWorld(v, sx, sy)
  return {
    ...v,
    scale,
    cx: w.x - (sx - v.width / 2) / scale,
    cy: w.y + (sy - v.height / 2) / scale,
  }
}

export function panBy(v: ViewState, dxPx: number, dyPx: number): ViewState {
  return { ...v, cx: v.cx - dxPx / v.scale, cy: v.cy + dyPx / v.scale }
}

export function fit(v: ViewState, bbox: BBox, marginPx: number): ViewState {
  const w = bbox.maxX - bbox.minX
  const h = bbox.maxY - bbox.minY
  const ratios: number[] = []
  if (w > 0) ratios.push(Math.max(1, v.width - 2 * marginPx) / w)
  if (h > 0) ratios.push(Math.max(1, v.height - 2 * marginPx) / h)
  return {
    ...v,
    cx: (bbox.minX + bbox.maxX) / 2,
    cy: (bbox.minY + bbox.maxY) / 2,
    scale: ratios.length > 0 ? clampScale(Math.min(...ratios)) : v.scale,
  }
}
