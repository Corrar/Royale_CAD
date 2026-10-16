import { describe, expect, it } from 'vitest'
import { typeOf } from '../../entity/registry'
import type { Arc, Entity, Polyline } from '../../entity/types'
import { arcThrough } from '../../geom/curve'
import { commandBench } from '../testing'

const only = <T extends Entity['type']>(t: ReturnType<typeof commandBench>, type: T): Extract<Entity, { type: T }>[] =>
  [...t.doc.entities()].filter((e): e is Extract<Entity, { type: T }> => e.type === type)

const onEntity = (e: Entity, x: number, y: number): boolean => typeOf(e).distance(e, { x, y }) < 1e-9

describe('arcThrough', () => {
  it('is the circle through three points, turning from the first through the second', () => {
    const ccw = arcThrough({ x: 5, y: 0 }, { x: 0, y: 5 }, { x: -5, y: 0 })!
    expect([ccw.cx, ccw.cy, ccw.r].map((v) => Math.round(v * 1e12) / 1e12 + 0)).toEqual([0, 0, 5])
    expect(ccw.sweep).toBeCloseTo(Math.PI, 12)
    const cw = arcThrough({ x: -5, y: 0 }, { x: 0, y: 5 }, { x: 5, y: 0 })!
    expect(cw.sweep).toBeCloseTo(-Math.PI, 12)
    expect(arcThrough({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 })).toBeNull()
  })
})

describe('ARC', () => {
  it('by three points passes through all three, either way round', () => {
    const t = commandBench()
    t.run('A⏎10,0⏎0,10⏎-10,0⏎')
    t.run('A⏎-10,20⏎0,30⏎10,20⏎')
    const arcs = only(t, 'arc')
    expect(arcs).toHaveLength(2)
    for (const [a, pts] of [[arcs[0]!, [[10, 0], [0, 10], [-10, 0]]], [arcs[1]!, [[-10, 20], [0, 30], [10, 20]]]] as const) {
      for (const [x, y] of pts) expect(onEntity(a, x, y)).toBe(true)
    }
    // The clockwise one is stored counter-clockwise, from its end to its start.
    expect(onEntity(arcs[1]!, 0, 10)).toBe(false)
  })

  it('by centre, start and end runs counter-clockwise', () => {
    const t = commandBench()
    t.run('A⏎C⏎0,0⏎5,0⏎0,9⏎')
    const a = only(t, 'arc')[0] as Arc
    expect([a.cx, a.cy, a.r]).toEqual([0, 0, 5])
    expect(a.a0).toBe(0)
    expect(a.a1).toBeCloseTo(Math.PI / 2, 12)
  })

  it('refuses collinear points and asks again', () => {
    const t = commandBench()
    t.run('A⏎0,0⏎1,1⏎2,2⏎')
    expect(t.interp.history.at(-1)).toBe('The points are collinear.')
    t.run('2,0⏎')
    expect(only(t, 'arc')).toHaveLength(1)
  })
})

describe('PLINE', () => {
  it('PL with C closes; the result is one polyline and one undo step', () => {
    const t = commandBench()
    t.run('PL⏎0,0⏎10,0⏎10,5⏎C⏎')
    const [p] = only(t, 'polyline') as Polyline[]
    expect(Array.from(p!.pts)).toEqual([0, 0, 10, 0, 10, 5])
    expect(p!.closed).toBe(true)
    expect(t.doc.size).toBe(1)
    expect(t.doc.undo()).toBe('PLINE')
    expect(t.doc.size).toBe(0)
  })

  it('Undo takes back the last vertex; Enter ends an open polyline', () => {
    const t = commandBench()
    t.run('PL⏎0,0⏎10,0⏎10,5⏎U⏎20,0⏎⏎')
    const [p] = only(t, 'polyline') as Polyline[]
    expect(Array.from(p!.pts)).toEqual([0, 0, 10, 0, 20, 0])
    expect(p!.closed).toBe(false)
  })

  it('Arc continues tangent to the last piece; Line goes back to lines', () => {
    const t = commandBench()
    t.run('PL⏎0,0⏎10,0⏎A⏎10,10⏎L⏎0,10⏎⏎')
    const [p] = only(t, 'polyline') as Polyline[]
    expect(Array.from(p!.pts)).toEqual([0, 0, 10, 0, 10, 10, 0, 10])
    // From (10,0) heading +x to (10,10): a counter-clockwise half circle, bulge 1.
    expect(Array.from(p!.bulges!).map((b) => Math.round(b * 1e12) / 1e12)).toEqual([0, 1, 0, 0])
    expect(onEntity(p!, 15, 5)).toBe(true)
  })

  it('Esc keeps the polyline drawn so far, as AutoCAD does', () => {
    const t = commandBench()
    t.run('PL⏎0,0⏎10,0⏎10,5⏎')
    t.interp.cancel()
    const [p] = only(t, 'polyline') as Polyline[]
    expect(Array.from(p!.pts)).toEqual([0, 0, 10, 0, 10, 5])
    t.run('PL⏎3,3⏎')
    t.interp.cancel() // a single vertex is not a polyline
    expect(only(t, 'polyline')).toHaveLength(1)
  })
})

describe('RECTANG', () => {
  it('REC makes a closed polyline of 4 vertices', () => {
    const t = commandBench()
    t.run('REC⏎0,0⏎@10,5⏎')
    const [p] = only(t, 'polyline') as Polyline[]
    expect(Array.from(p!.pts)).toEqual([0, 0, 10, 0, 10, 5, 0, 5])
    expect(p!.closed).toBe(true)
  })

  it('works from any corner, and refuses a flat rectangle', () => {
    const t = commandBench()
    t.run('REC⏎10,5⏎0,0⏎')
    expect(Array.from((only(t, 'polyline')[0] as Polyline).pts)).toEqual([10, 5, 0, 5, 0, 0, 10, 0])
    t.run('REC⏎0,0⏎10,0⏎')
    expect(t.interp.history.at(-1)).toBe('The rectangle has no area.')
    t.run('10,1⏎')
    expect(only(t, 'polyline')).toHaveLength(2)
  })
})
