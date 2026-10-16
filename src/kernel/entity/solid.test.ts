import { describe, expect, it } from 'vitest'
import { mirroring, translation } from '../geom/vec'
import { typeOf } from './registry'
import { SNAP, type Entity, type Solid } from './types'

/** Corners in DXF order: (x0, y0) … (x3, y3). */
const solid = (...c: number[]): Solid => ({ type: 'solid', id: 1, layer: 0, x0: c[0]!, y0: c[1]!, x1: c[2]!, y1: c[3]!, x2: c[4]!, y2: c[5]!, x3: c[6]!, y3: c[7]! })

const tris = (e: Entity): number[][] => {
  const out: number[][] = []
  typeOf(e).primitives(e, 0, { segment() {}, arc() {}, tri: (...a) => out.push(a) })
  return out
}
const snaps = (e: Entity, modes: number): number[][] => {
  const out: number[][] = []
  typeOf(e).snapPoints!(e, modes, (x, y, mode) => out.push([x, y, mode]))
  return out
}

describe('solid', () => {
  // The square [0, 10]²: corners 3 and 4 swap against the outline (0,0)-(10,0)-(10,10)-(0,10).
  const square = solid(0, 0, 10, 0, 0, 10, 10, 10)

  it('a quad fills as the triangles 1-2-3 and 2-4-3; its box holds the corners', () => {
    expect(tris(square)).toEqual([[0, 0, 10, 0, 0, 10], [10, 0, 10, 10, 0, 10]])
    expect(typeOf(square).bbox(square)).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 })
  })

  it('a triangle repeats corner 3: one triangle, END at its three corners', () => {
    const t = solid(0, 0, 4, 0, 2, 3, 2, 3)
    expect(tris(t)).toEqual([[0, 0, 4, 0, 2, 3]])
    expect(snaps(t, SNAP.END | SNAP.MID)).toEqual([[0, 0, SNAP.END], [4, 0, SNAP.END], [2, 3, SNAP.END]])
    expect(snaps(square, SNAP.END)).toEqual([[0, 0, SNAP.END], [10, 0, SNAP.END], [0, 10, SNAP.END], [10, 10, SNAP.END]])
    expect(snaps(square, SNAP.MID | SNAP.CEN)).toEqual([])
  })

  it('distance: 0 inside, else to the outline 1-2-4-3', () => {
    for (const p of [{ x: 5, y: 5 }, { x: 9, y: 9 }, { x: 1, y: 1 }, { x: 10, y: 3 }]) expect(typeOf(square).distance(square, p)).toBe(0)
    expect(typeOf(square).distance(square, { x: 5, y: -3 })).toBe(3)
    expect(typeOf(square).distance(square, { x: 12, y: 5 })).toBe(2)
    expect(typeOf(square).distance(square, { x: 13, y: 14 })).toBe(5)
  })

  it('corners given round the outline make a bow tie, as AutoCAD shows it: two triangles meeting where it crosses', () => {
    const tie = solid(0, 0, 10, 0, 10, 10, 0, 10) // the outline 1-2-4-3 crosses itself at (5, 5)
    expect(tris(tie)).toEqual([[0, 0, 10, 0, 5, 5], [5, 5, 0, 10, 10, 10]])
    expect(typeOf(tie).distance(tie, { x: 5, y: 2 })).toBe(0)
    expect(typeOf(tie).distance(tie, { x: 8, y: 5 })).toBeCloseTo(3 / Math.SQRT2, 12)
    const other = solid(0, 0, 10, 10, 0, 10, 10, 0) // 1-2 crosses 4-3
    expect(tris(other)).toEqual([[10, 10, 10, 0, 5, 5], [5, 5, 0, 10, 0, 0]])
  })

  it('its outline 1-2-4-3 comes after the triangles, as edges; the outline distance is to them, inside too', () => {
    const edges = (e: Entity): number[][] => {
      const out: number[][] = []
      typeOf(e).primitives(e, 0, { segment() {}, arc() {}, tri: () => out.push([]), edge: (...a) => out.push(a) })
      return out
    }
    expect(edges(square)).toEqual([[], [], [0, 0, 10, 0], [10, 0, 10, 10], [10, 10, 0, 10], [0, 10, 0, 0]])
    expect(edges(solid(0, 0, 4, 0, 2, 3, 2, 3))).toEqual([[], [0, 0, 4, 0], [4, 0, 2, 3], [2, 3, 0, 0]])
    expect(typeOf(square).outlineDistance!(square, { x: 3, y: 6 })).toBe(3)
    expect(typeOf(square).outlineDistance!(square, { x: 5, y: -3 })).toBe(3)
    const dot = solid(1, 1, 1, 1, 1, 1, 1, 1)
    expect(edges(dot)).toEqual([[]])
    expect(typeOf(dot).outlineDistance!(dot, { x: 4, y: 5 })).toBe(5)
  })

  it('a dent at corner 1 or 4 splits along 1-4, which stays inside', () => {
    const dent = solid(0, 0, 10, 0, 0, 10, 4, 4)
    expect(tris(dent)).toEqual([[0, 0, 10, 0, 4, 4], [0, 0, 4, 4, 0, 10]])
    expect(typeOf(dent).distance(dent, { x: 6, y: 3 })).toBeCloseTo(2 / Math.hypot(6, 4), 12)
  })

  it('MOVE and MIRROR take each corner through the affine; validate wants finite corners', () => {
    expect(typeOf(square).transform!(square, translation(3, -1))).toEqual(solid(3, -1, 13, -1, 3, 9, 13, 9))
    const m = typeOf(square).transform!(square, mirroring({ x: 20, y: 0 }, { x: 20, y: 1 }))
    expect(m).toEqual(solid(40, 0, 30, 0, 40, 10, 30, 10))
    expect(tris(m)).toEqual([[40, 0, 30, 0, 40, 10], [30, 0, 30, 10, 40, 10]])
    expect(typeOf(square).validate!(square)).toBeUndefined()
    expect(typeOf(square).validate!({ ...square, y3: NaN })).toMatch(/finite/)
    expect(typeOf(square).validate!({ ...square, x1: Infinity })).toMatch(/finite/)
  })
})
