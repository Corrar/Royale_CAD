import { describe, expect, it } from 'vitest'
import { typeOf } from '../entity/registry'
import type { Arc, Circle, Entity, Line, Polyline } from '../entity/types'
import { intersect } from './intersect'
import type { Vec2 } from './vec'

let id = 1
const line = (x0: number, y0: number, x1: number, y1: number): Line => ({ type: 'line', id: id++, layer: 0, x0, y0, x1, y1 })
const circle = (cx: number, cy: number, r: number): Circle => ({ type: 'circle', id: id++, layer: 0, cx, cy, r })
const arc = (cx: number, cy: number, r: number, a0: number, a1: number): Arc => ({ type: 'arc', id: id++, layer: 0, cx, cy, r, a0, a1 })
const poly = (pts: number[], bulges: number[] | null, closed = false): Polyline =>
  ({ type: 'polyline', id: id++, layer: 0, pts: new Float64Array(pts), bulges: bulges && new Float64Array(bulges), closed })

const sorted = (ps: Vec2[]): number[][] => ps.map((p) => [p.x, p.y].map((v) => Math.round(v * 1e9) / 1e9 + 0)).sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!)

describe('intersect', () => {
  it('two crossing lines meet once', () => {
    expect(sorted(intersect(line(0, 0, 10, 10), line(0, 10, 10, 0)))).toEqual([[5, 5]])
  })

  it('parallel and collinear lines have no intersection', () => {
    expect(intersect(line(0, 0, 10, 0), line(0, 1, 10, 1))).toEqual([])
    expect(intersect(line(0, 0, 10, 0), line(5, 0, 15, 0))).toEqual([])
  })

  it('lines that stop short do not meet; touching at an end does', () => {
    expect(intersect(line(0, 0, 4, 4), line(0, 10, 10, 0))).toEqual([])
    expect(sorted(intersect(line(0, 0, 5, 5), line(0, 10, 10, 0)))).toEqual([[5, 5]])
    expect(sorted(intersect(line(0, 0, 10, 0), line(10, 0, 10, 5)))).toEqual([[10, 0]])
  })

  it('a line through a circle meets it twice; a tangent once', () => {
    expect(sorted(intersect(line(-10, 0, 10, 0), circle(0, 0, 5)))).toEqual([[-5, 0], [5, 0]])
    expect(sorted(intersect(line(-10, 5, 10, 5), circle(0, 0, 5)))).toEqual([[0, 5]])
    expect(intersect(line(-10, 6, 10, 6), circle(0, 0, 5))).toEqual([])
  })

  it('two circles meet twice, once when tangent, never when apart or nested', () => {
    expect(sorted(intersect(circle(0, 0, 5), circle(8, 0, 5)))).toEqual([[4, -3], [4, 3]])
    expect(sorted(intersect(circle(0, 0, 5), circle(10, 0, 5)))).toEqual([[5, 0]])
    expect(sorted(intersect(circle(0, 0, 5), circle(3, 0, 2)))).toEqual([[5, 0]]) // internally tangent
    expect(intersect(circle(0, 0, 5), circle(20, 0, 5))).toEqual([])
    expect(intersect(circle(0, 0, 5), circle(1, 0, 2))).toEqual([])
    expect(intersect(circle(0, 0, 5), circle(0, 0, 5))).toEqual([]) // coincident: no finite set
  })

  it('an arc only counts its own sweep', () => {
    const upper = arc(0, 0, 5, 0, Math.PI)
    expect(sorted(intersect(line(0, -10, 0, 10), upper))).toEqual([[0, 5]])
    expect(intersect(line(-10, -3, 10, -3), upper)).toEqual([])
    expect(sorted(intersect(upper, circle(8, 0, 5)))).toEqual([[4, 3]])
    expect(sorted(intersect(upper, arc(0, 0, 5, Math.PI, 2 * Math.PI)))).toEqual([])
  })

  it('polylines meet piece by piece, without repeating a shared vertex', () => {
    const zig = poly([0, 0, 10, 0, 10, 10], null)
    expect(sorted(intersect(zig, line(5, -5, 5, 5)))).toEqual([[5, 0]])
    // Along the first piece (collinear: nothing) and through the foot of the second.
    expect(sorted(intersect(zig, line(0, 0, 20, 0)))).toEqual([[10, 0]])
    // A line through the shared vertex (10, 0) of two pieces: one point.
    expect(sorted(intersect(zig, line(5, -5, 15, 5)))).toEqual([[10, 0]])
    // A bulged piece is an arc.
    const bump = poly([-5, 0, 5, 0], [-1, 0])
    expect(sorted(intersect(bump, line(0, -10, 0, 10)))).toEqual([[0, 5]])
  })

  it('stays exact at UTM magnitudes', () => {
    const x = 7_400_000
    const y = 9_100_000
    const p = sorted(intersect(line(x, y, x + 0.004, y + 0.004), line(x, y + 0.004, x + 0.004, y)))
    expect(p).toHaveLength(1)
    expect(Math.abs(p[0]![0]! - (x + 0.002))).toBeLessThan(1e-8)
    const tangent = intersect(line(x - 10, y + 0.5, x + 10, y + 0.5), circle(x, y, 0.5))
    expect(tangent).toHaveLength(1)
  })

  it('every point returned lies on both entities, within tolerance', () => {
    let s = 7
    const rand = (): number => ((s = (s * 16807) % 2147483647) / 2147483647) * 20 - 10
    const make = (): Entity => {
      const k = Math.abs(rand()) / 10
      if (k < 0.3) return line(rand(), rand(), rand(), rand())
      if (k < 0.5) return circle(rand(), rand(), 0.5 + Math.abs(rand()))
      if (k < 0.75) return arc(rand(), rand(), 0.5 + Math.abs(rand()), rand(), rand())
      return poly([rand(), rand(), rand(), rand(), rand(), rand()], [rand() / 10, 0, rand() / 10], rand() > 0)
    }
    let found = 0
    for (let i = 0; i < 2000; i++) {
      const a = make()
      const b = make()
      for (const p of intersect(a, b)) {
        found++
        expect(typeOf(a).distance(a, p)).toBeLessThan(1e-7)
        expect(typeOf(b).distance(b, p)).toBeLessThan(1e-7)
      }
    }
    expect(found).toBeGreaterThan(500)
  })
})
