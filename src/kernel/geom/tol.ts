export const EPS = 1e-9
export const TAU = 2 * Math.PI

/** Equality used across the kernel: |a − b| ≤ 1e-9 · max(1, |a|, |b|). */
export const eq = (a: number, b: number): boolean => Math.abs(a - b) <= EPS * Math.max(1, Math.abs(a), Math.abs(b))

/** Angle in [0, 2π). */
export function normAngle(a: number): number {
  const t = a - TAU * Math.floor(a / TAU)
  return t >= TAU ? 0 : t // a tiny negative input rounds up to exactly 2π
}
