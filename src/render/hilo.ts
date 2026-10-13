/** Writes x as two f32: high part at out[i], residual at out[i + 1]. */
export function splitDouble(x: number, out: Float32Array, i: number): void {
  const hi = Math.fround(x)
  out[i] = hi
  out[i + 1] = x - hi
}
