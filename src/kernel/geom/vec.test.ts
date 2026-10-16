import { describe, expect, it } from 'vitest'
import { triangleDistance } from './vec'

describe('triangleDistance', () => {
  it('is 0 inside and on the edges, either way round', () => {
    expect(triangleDistance(2, 1, 0, 0, 10, 0, 0, 10)).toBe(0)
    expect(triangleDistance(2, 1, 0, 0, 0, 10, 10, 0)).toBe(0)
    expect(triangleDistance(5, 5, 0, 0, 10, 0, 0, 10)).toBe(0)
    expect(triangleDistance(10, 0, 0, 0, 10, 0, 0, 10)).toBe(0)
  })

  it('outside, the distance to the nearest edge', () => {
    expect(triangleDistance(5, -3, 0, 0, 10, 0, 0, 10)).toBe(3)
    expect(triangleDistance(6, 6, 0, 0, 10, 0, 0, 10)).toBeCloseTo(Math.SQRT2, 12)
    expect(triangleDistance(13, -4, 0, 0, 10, 0, 0, 10)).toBe(5)
  })

  it('a flat triangle is its edges', () => {
    expect(triangleDistance(5, 2, 0, 0, 10, 0, 4, 0)).toBe(2)
    expect(triangleDistance(1, 1, 3, 4, 3, 4, 3, 4)).toBeCloseTo(Math.hypot(2, 3), 12)
  })
})
