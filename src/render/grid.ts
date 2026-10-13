import type { Vec2 } from '../kernel/geom/vec'
import type { ViewState } from '../kernel/view'

export const GRID_MIN_PX = 10

export interface GridParams {
  step: number
  spacingPx: number
  t: number
  fade: number
  blend: number
  phaseMinor: Vec2
  phaseMajor: Vec2
}

const smoothstep = (a: number, b: number, x: number): number => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return k * k * (3 - 2 * k)
}

// Positive modulo, in f64: this is why the phase cannot be computed in the shader.
const phase = (c: number, step: number, scale: number): number => (((c % step) + step) % step) * scale

export function gridParams(view: ViewState): GridParams {
  const { scale } = view
  let k = Math.ceil(Math.log10(GRID_MIN_PX / scale))
  // log10 rounding can be off by one right at a power of ten.
  if (10 ** k * scale < GRID_MIN_PX) k++
  else if (10 ** (k - 1) * scale >= GRID_MIN_PX) k--
  const step = 10 ** k
  const spacingPx = step * scale
  const t = Math.min(1, Math.max(0, Math.log10(spacingPx) - 1))
  const major = step * 10
  return {
    step,
    spacingPx,
    t,
    fade: smoothstep(0, 0.3, t),
    blend: smoothstep(0.7, 1, t),
    phaseMinor: { x: phase(view.cx, step, scale), y: phase(view.cy, step, scale) },
    phaseMajor: { x: phase(view.cx, major, scale), y: phase(view.cy, major, scale) },
  }
}
