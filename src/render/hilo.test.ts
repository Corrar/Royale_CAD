import { describe, expect, it } from 'vitest'
import { splitDouble } from './hilo'

function split(x: number): [number, number] {
  const out = new Float32Array(2)
  splitDouble(x, out, 0)
  return [out[0], out[1]]
}

// Simulates the shader: every f32 operation is rounded.
function relativeToEye(x: number, eye: number): number {
  const [hi, lo] = split(x)
  const [eyeHi, eyeLo] = split(eye)
  return Math.fround(Math.fround(hi - eyeHi) + Math.fround(lo - eyeLo))
}

describe('splitDouble', () => {
  it('keeps sub-unit precision relative to the eye at UTM magnitude', () => {
    const x = 7_400_000.001
    const eye = 7_399_999.25
    expect(Math.abs(relativeToEye(x, eye) - (x - eye))).toBeLessThan(1e-6)
  })

  it('beats the naive f32 subtraction in the same case', () => {
    const x = 7_400_000.001
    const eye = 7_399_999.25
    const naive = Math.fround(x) - Math.fround(eye)
    expect(Math.abs(naive - (x - eye))).toBeGreaterThan(1e-4)
  })

  it('stays within relative f32 error for a distant eye', () => {
    const x = 7_400_000.001
    const eye = 7_399_000.5
    expect(Math.abs(relativeToEye(x, eye) - (x - eye))).toBeLessThan(1e-4)
  })

  it('reconstructs x as hi + lo in f64', () => {
    for (const x of [7_400_000.001, 9_100_000.123, -7_400_000.001, 0.1, 0]) {
      const [hi, lo] = split(x)
      expect(Math.abs(hi + lo - x)).toBeLessThan(1e-7)
    }
  })

  it('is odd-symmetric and maps zero to zero', () => {
    const [hi, lo] = split(7_400_000.001)
    const [nhi, nlo] = split(-7_400_000.001)
    expect(nhi).toBe(-hi)
    expect(nlo).toBe(-lo)
    expect(split(0)).toEqual([0, 0])
  })

  it('writes only out[i] and out[i + 1]', () => {
    const out = new Float32Array(6).fill(99)
    splitDouble(7_400_000.001, out, 2)
    expect(Array.from(out.slice(0, 2))).toEqual([99, 99])
    expect(Array.from(out.slice(4))).toEqual([99, 99])
    expect(out[2]).not.toBe(99)
    expect(out[3]).not.toBe(99)
  })
})
