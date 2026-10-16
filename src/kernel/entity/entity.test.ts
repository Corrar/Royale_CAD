import { describe, expect, it } from 'vitest'
import { TAU } from '../geom/tol'
import { mirroring, rotation, scaling, translation } from '../geom/vec'
import { register, typeOf } from './registry'
import { SNAP, type Arc, type Circle, type Entity, type Line, type Opaque, type Point, type Polyline, type PrimSink } from './types'

const deg = (d: number): number => (d * Math.PI) / 180

const line: Line = { type: 'line', id: 1, layer: 0, x0: 0, y0: 0, x1: 10, y1: 0 }
const circle: Circle = { type: 'circle', id: 2, layer: 0, cx: 5, cy: 6, r: 2 }
const arc: Arc = { type: 'arc', id: 3, layer: 0, cx: 0, cy: 0, r: 1, a0: deg(350), a1: deg(10) }
const poly = (pts: number[], bulges: number[] | null, closed = false): Polyline => ({
  type: 'polyline', id: 4, layer: 0, pts: new Float64Array(pts), bulges: bulges && new Float64Array(bulges), closed,
})

type Prim = ['segment', ...number[]] | ['arc', ...number[]]
function prims(e: Entity): Prim[] {
  const out: Prim[] = []
  const sink: PrimSink = {
    segment: (...a) => out.push(['segment', ...a]),
    arc: (...a) => out.push(['arc', ...a]),
  }
  typeOf(e).primitives(e, 0, sink)
  return out
}
const round = (xs: readonly (string | number)[]): (string | number)[] =>
  xs.map((v) => (typeof v === 'number' ? Math.round(v * 1e9) / 1e9 + 0 : v))

describe('registry', () => {
  it('resolves every built-in type', () => {
    for (const e of [line, circle, arc, poly([0, 0, 1, 1], null)]) expect(typeOf(e).type).toBe(e.type)
  })

  it('point: a dot, found by NOD, moved by transforms', () => {
    const p: Point = { type: 'point', id: 5, layer: 0, x: 3, y: 4 }
    expect(typeOf(p).bbox(p)).toEqual({ minX: 3, minY: 4, maxX: 3, maxY: 4 })
    expect(prims(p)).toEqual([['segment', 3, 4, 3, 4]])
    expect(typeOf(p).distance(p, { x: 0, y: 0 })).toBe(5)
    const found: number[][] = []
    typeOf(p).snapPoints!(p, SNAP.NOD | SNAP.END, (x, y, mode) => found.push([x, y, mode]))
    expect(found).toEqual([[3, 4, SNAP.NOD]])
    expect(typeOf(p).transform!(p, { a: 1, b: 0, c: 0, d: 1, e: 1, f: 2 })).toEqual({ ...p, x: 4, y: 6 })
  })

  it('opaque: no geometry, never near anything', () => {
    const o: Opaque = { type: 'opaque', id: 6, layer: 0, name: 'HATCH', raw: '  0\nHATCH\n' }
    expect(typeOf(o).bbox(o)).toEqual({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity })
    expect(prims(o)).toEqual([])
    expect(typeOf(o).distance(o, { x: 0, y: 0 })).toBe(Infinity)
    expect(typeOf(o).transform).toBeUndefined()
  })

  it('refuses a second registration of a type and unknown types', () => {
    expect(() => register(typeOf(line))).toThrow(/already registered/)
    expect(() => typeOf({ ...line, type: 'nope' } as unknown as Entity)).toThrow(/unregistered/)
  })
})

describe('line', () => {
  it('bbox, one segment, distance beyond the ends', () => {
    const l: Line = { ...line, x0: 4, y0: 9, x1: -2, y1: 3 }
    expect(typeOf(l).bbox(l)).toEqual({ minX: -2, minY: 3, maxX: 4, maxY: 9 })
    expect(prims(l)).toEqual([['segment', 4, 9, -2, 3]])
    expect(typeOf(line).distance(line, { x: 13, y: 4 })).toBe(5)
    expect(typeOf(line).distance(line, { x: 5, y: -2 })).toBe(2)
  })
})

describe('circle', () => {
  it('bbox, one full arc, distance from inside and outside', () => {
    expect(typeOf(circle).bbox(circle)).toEqual({ minX: 3, minY: 4, maxX: 7, maxY: 8 })
    expect(prims(circle)).toEqual([['arc', 5, 6, 2, 0, TAU]])
    expect(typeOf(circle).distance(circle, { x: 5, y: 6 })).toBe(2)
    expect(typeOf(circle).distance(circle, { x: 10, y: 6 })).toBe(3)
  })
})

describe('arc', () => {
  it('bbox includes 0° when the arc crosses it', () => {
    const b = typeOf(arc).bbox(arc)
    expect(b.maxX).toBe(1)
    expect(b.minX).toBeCloseTo(Math.cos(deg(10)), 12)
    expect(b.maxY - b.minY).toBeCloseTo(2 * Math.sin(deg(10)), 12)
  })

  it('emits a counter-clockwise sweep from a0 to a1', () => {
    expect(round(prims(arc)[0]!)).toEqual(round(['arc', 0, 0, 1, deg(350), deg(20)]))
  })

  it('distance is radial within the sweep and to an end outside it', () => {
    expect(typeOf(arc).distance(arc, { x: 3, y: 0 })).toBeCloseTo(2, 12)
    const end = { x: Math.cos(deg(10)), y: Math.sin(deg(10)) }
    expect(typeOf(arc).distance(arc, { x: 0, y: 2 })).toBeCloseTo(Math.hypot(end.x, 2 - end.y), 12)
  })

  it('keeps its angles through a move or a scale far from the origin, and turns them exactly with a rotation or a mirror', () => {
    const a: Arc = { type: 'arc', id: 3, layer: 0, cx: 500000.125, cy: 7400000.5, r: 1000, a0: 0.3, a1: 1.7 }
    const moved = typeOf(a).transform!(a, translation(1, 1)) as Arc
    expect([moved.a0, moved.a1]).toEqual([0.3, 1.7])
    const scaled = typeOf(a).transform!(a, scaling({ x: 500000, y: 7400000 }, 3)) as Arc
    expect([scaled.a0, scaled.a1, scaled.r]).toEqual([0.3, 1.7, 3000])
    const turned = typeOf(a).transform!(a, rotation({ x: 500000, y: 7400000 }, 90)) as Arc
    expect(Math.abs(turned.a0 - (0.3 + Math.PI / 2))).toBeLessThan(1e-15)
    expect(Math.abs(turned.a1 - (1.7 + Math.PI / 2))).toBeLessThan(1e-15)
    const mirrored = typeOf(a).transform!(a, mirroring({ x: 500000, y: 7400000 }, { x: 500000, y: 7400001 })) as Arc
    expect(Math.abs(mirrored.a0 - (Math.PI - 1.7))).toBeLessThan(1e-15)
    expect(Math.abs(mirrored.a1 - (Math.PI - 0.3))).toBeLessThan(1e-15)
  })
})

describe('polyline', () => {
  it('bulge 1 becomes a semicircle below a left-to-right chord', () => {
    const p = poly([0, 0, 2, 0], [1, 0])
    expect(round(prims(p)[0]!)).toEqual(round(['arc', 1, 0, 1, Math.PI, Math.PI]))
    const b = typeOf(p).bbox(p)
    expect(round([b.minX, b.minY, b.maxX, b.maxY])).toEqual([0, -1, 2, 0])
    expect(typeOf(p).distance(p, { x: 1, y: 0 })).toBeCloseTo(1, 12)
    expect(typeOf(p).distance(p, { x: 1, y: -3 })).toBeCloseTo(2, 12)
  })

  it('open: one piece per pair of vertices; closed adds the closing piece', () => {
    const pts = [0, 0, 10, 0, 10, 5]
    expect(prims(poly(pts, null))).toEqual([['segment', 0, 0, 10, 0], ['segment', 10, 0, 10, 5]])
    expect(prims(poly(pts, null, true)).at(-1)).toEqual(['segment', 10, 5, 0, 0])
    // (2, 3) is 3 from the first piece and 4/√5 from the closing piece (10, 5)-(0, 0).
    expect(typeOf(poly(pts, null)).distance(poly(pts, null), { x: 2, y: 3 })).toBeCloseTo(3, 12)
    expect(typeOf(poly(pts, null, true)).distance(poly(pts, null, true), { x: 2, y: 3 })).toBeCloseTo(4 / Math.sqrt(5), 12)
  })

  it('mixes straight and bulged pieces, the closing one included', () => {
    const p = poly([0, 0, 2, 0, 2, 2], [0, 0, -1], true)
    const kinds = prims(p).map((x) => x[0])
    expect(kinds).toEqual(['segment', 'segment', 'arc'])
    const b = typeOf(p).bbox(p)
    // The closing piece runs from (2, 2) to (0, 0) clockwise around (1, 1): it bulges to the lower right.
    expect(round([b.minX, b.minY, b.maxX, b.maxY])).toEqual(round([0, 1 - Math.SQRT2, 1 + Math.SQRT2, 2]))
  })

  it('widths: kept by a move, a turn or a mirror, scaled by a scale; one start and end width per vertex', () => {
    const p: Polyline = { ...poly([0, 0, 10, 0], null), widths: new Float64Array([0.5, 1, 0, 0]), startWidth: 0.2, endWidth: 0.3 }
    for (const m of [translation(3, 4), rotation({ x: 1, y: 2 }, 90), mirroring({ x: 0, y: 0 }, { x: 1, y: 1 })]) {
      const q = typeOf(p).transform!(p, m) as Polyline
      expect([Array.from(q.widths!), q.startWidth, q.endWidth]).toEqual([[0.5, 1, 0, 0], 0.2, 0.3])
    }
    const s = typeOf(p).transform!(p, scaling({ x: 5, y: 5 }, 3)) as Polyline
    expect([Array.from(s.widths!), s.startWidth, s.endWidth]).toEqual([[1.5, 3, 0, 0], 0.2 * 3, 0.3 * 3])
    expect(typeOf(p).transform!(poly([0, 0, 1, 1], null), scaling({ x: 0, y: 0 }, 2))).not.toHaveProperty('widths')
    expect(typeOf(p).validate!({ ...p, widths: new Float64Array([1, 1]) })).toMatch(/width/)
  })

  it('a single vertex has a point bbox, no pieces and a point distance', () => {
    const p = poly([3, 4], null)
    expect(typeOf(p).bbox(p)).toEqual({ minX: 3, minY: 4, maxX: 3, maxY: 4 })
    expect(prims(p)).toEqual([])
    expect(typeOf(p).distance(p, { x: 0, y: 0 })).toBe(5)
  })
})
