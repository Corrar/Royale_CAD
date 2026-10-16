import { describe, expect, it } from 'vitest'
import { arcSweep } from '../geom/curve'
import { pathOf as pathOrNull } from './path'
import { typeOf } from './registry'
import type { Arc, Circle, Entity, Line, Polyline } from './types'

const pathOf = (e: Entity) => pathOrNull(e)!
const r9 = (v: number): number => Math.round(v * 1e9) / 1e9 + 0
const on = (e: Entity, x: number, y: number): boolean => typeOf(e).distance(e, { x, y }) < 1e-9

const line: Line = { type: 'line', id: 1, layer: 0, x0: 0.1, y0: 0.2, x1: 0.3, y1: 0.7 }
const arc: Arc = { type: 'arc', id: 2, layer: 0, cx: 0, cy: 0, r: 5, a0: 0, a1: Math.PI / 2 }
const circle: Circle = { type: 'circle', id: 3, layer: 0, color: 1, cx: 0, cy: 0, r: 5 }
const square: Polyline = { type: 'polyline', id: 4, layer: 0, pts: new Float64Array([0, 0, 10, 0, 10, 10, 0, 10]), bulges: null, closed: true }

describe('pathOf', () => {
  it('a line runs from 0 to 1; its slices keep the exact ends', () => {
    const p = pathOf(line)
    expect([p.end, p.closed]).toEqual([1, false])
    expect(r9(p.param({ x: 0.2, y: 0.45 }))).toBe(0.5)
    expect(p.param({ x: 0.1 - 0.2, y: 0.2 - 0.5 })).toBeLessThan(0) // past the start
    const s = p.slice(0.5, 1) as Line
    expect([s.x1, s.y1]).toEqual([0.3, 0.7])
    expect(p.slice(0, 0.5)).toMatchObject({ x0: 0.1, y0: 0.2, id: 1 })
  })

  it('an arc runs by the angle turned from a0; past an end the nearer side of the gap', () => {
    const p = pathOf(arc)
    expect(r9(p.end)).toBe(r9(Math.PI / 2))
    expect(r9(p.param({ x: 0, y: -5 }))).toBe(r9(-Math.PI / 2)) // a quarter before the start
    expect(r9(p.param({ x: -5, y: 0.01 }))).toBeGreaterThan(r9(Math.PI / 2)) // nearer the end
    const s = p.slice(Math.PI / 4, Math.PI / 2) as Arc
    expect(r9(s.a0)).toBe(r9(Math.PI / 4))
    expect(s.a1).toBe(arc.a1)
  })

  it('a circle wraps; a slice of it is an arc that keeps id and color', () => {
    const p = pathOf(circle)
    expect(p.closed).toBe(true)
    const s = p.slice(3 * Math.PI / 2, 5 * Math.PI / 2) as Arc
    expect(s).toMatchObject({ type: 'arc', id: 3, color: 1, r: 5 })
    expect(r9(s.a0)).toBe(r9(3 * Math.PI / 2))
    expect(r9(arcSweep(s.a0, s.a1))).toBe(r9(Math.PI))
  })

  it('a closed polyline sliced across its start opens there', () => {
    const p = pathOf(square)
    expect(p.end).toBe(4)
    expect(r9(p.param({ x: 10, y: 5 }))).toBe(1.5)
    const s = p.slice(2.5, 4.5) as Polyline
    expect(Array.from(s.pts)).toEqual([5, 10, 0, 10, 0, 0, 5, 0])
    expect(s.closed).toBe(false)
    expect(s.bulges).toBeNull()
  })

  it('a bulged piece sliced keeps its circle: each part is the arc between the cut points', () => {
    // From (0,0) to (10,0), a counter-clockwise half circle below the chord, then a straight piece.
    const bump: Polyline = { type: 'polyline', id: 5, layer: 0, pts: new Float64Array([0, 0, 10, 0, 10, 5]), bulges: new Float64Array([1, 0, 0]), closed: false }
    const p = pathOf(bump)
    expect(r9(p.param({ x: 5, y: -5 }))).toBe(0.5)
    const s = p.slice(0.5, 1.5) as Polyline
    expect(Array.from(s.pts).map(r9)).toEqual([5, -5, 10, 0, 10, 2.5])
    expect(r9(s.bulges![0]!)).toBe(r9(Math.tan(Math.PI / 8))) // a quarter turn
    expect(on(s, 5 + 5 * Math.SQRT1_2, -5 * Math.SQRT1_2)).toBe(true)
  })
})
