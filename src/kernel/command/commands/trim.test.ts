import { describe, expect, it } from 'vitest'
import { typeOf } from '../../entity/registry'
import type { Arc, Entity, Polyline } from '../../entity/types'
import { arcSweep } from '../../geom/curve'
import { commandBench } from '../testing'

const r9 = (v: number): number => Math.round(v * 1e9) / 1e9 + 0
const arcs = (t: ReturnType<typeof commandBench>): Arc[] => [...t.doc.entities()].filter((e: Entity): e is Arc => e.type === 'arc')
const polylines = (t: ReturnType<typeof commandBench>): Polyline[] =>
  [...t.doc.entities()].filter((e: Entity): e is Polyline => e.type === 'polyline')
const on = (e: Entity, x: number, y: number): boolean => typeOf(e).distance(e, { x, y }) < 1e-9

/** A horizontal line crossed by two verticals at x = 3 and x = 7. */
function cross() {
  const t = commandBench()
  t.run('L⏎0,0⏎10,0⏎⏎')
  t.run('L⏎3,-5⏎3,5⏎⏎')
  t.run('L⏎7,-5⏎7,5⏎⏎')
  return t
}

describe('TRIM', () => {
  it('TR⏎⏎ and a click remove the piece between the neighbouring intersections', () => {
    const t = cross()
    t.run('TR⏎⏎')
    t.click(5, 0)
    t.run('⏎')
    expect(t.lines()).toEqual([[0, 0, 3, 0], [3, -5, 3, 5], [7, -5, 7, 5], [7, 0, 10, 0]])
  })

  it('a click past the last intersection removes the end piece; several clicks in one command', () => {
    const t = cross()
    t.run('TR⏎⏎')
    t.click(9, 0)
    t.click(3, 4) // the upper half of the left vertical
    t.run('⏎')
    expect(t.lines()).toEqual([[0, 0, 7, 0], [3, -5, 3, 0], [7, -5, 7, 5]])
    expect(t.doc.undo()).toBe('TRIM') // one step for the whole command
    expect(t.lines()).toHaveLength(3)
  })

  it('only the selected cutting edges cut', () => {
    const t = cross()
    t.run('TR⏎')
    t.click(7, 2) // the right vertical is the only edge
    t.run('⏎')
    t.click(2, 0)
    t.run('⏎')
    // A trimmed object keeps its id, so its place in the drawing order.
    expect(t.lines()).toEqual([[7, 0, 10, 0], [3, -5, 3, 5], [7, -5, 7, 5]])
  })

  it('a circle cut twice becomes an arc', () => {
    const t = commandBench()
    t.run('C⏎0,0⏎5⏎')
    t.run('L⏎-10,0⏎10,0⏎⏎')
    t.run('TR⏎⏎')
    t.click(0, 5) // the upper half goes
    t.run('⏎')
    const [a] = arcs(t)
    expect([a!.cx, a!.cy, a!.r]).toEqual([0, 0, 5])
    expect(r9(a!.a0)).toBe(r9(Math.PI))
    expect(r9(arcSweep(a!.a0, a!.a1))).toBe(r9(Math.PI))
  })

  it('an arc loses the piece around the click', () => {
    const t = commandBench()
    t.run('A⏎C⏎0,0⏎5,0⏎-5,0⏎') // upper half circle
    t.run('L⏎0,-10⏎0,10⏎⏎')
    t.run('TR⏎⏎')
    t.click(3, 4)
    t.run('⏎')
    const [a] = arcs(t)
    expect(r9(a!.a0)).toBe(r9(Math.PI / 2))
    expect(r9(arcSweep(a!.a0, a!.a1))).toBe(r9(Math.PI / 2))
  })

  it('a rectangle cut twice opens between the cuts', () => {
    const t = commandBench()
    t.run('REC⏎0,0⏎10,10⏎')
    t.run('L⏎5,-5⏎5,15⏎⏎')
    t.run('TR⏎⏎')
    t.click(10, 5) // the right half goes
    t.run('⏎')
    const [p] = polylines(t)
    expect(Array.from(p!.pts)).toEqual([5, 10, 0, 10, 0, 0, 5, 0])
    expect(p!.closed).toBe(false)
  })

  it('an arc piece of a polyline is cut on its circle', () => {
    const t = commandBench()
    t.run('PL⏎0,0⏎10,0⏎A⏎10,10⏎⏎') // then a half circle round (10,5), through (15,5)
    t.run('L⏎12,-20⏎12,20⏎⏎')
    t.run('TR⏎⏎')
    t.click(15, 5)
    t.run('⏎')
    const [a, b] = polylines(t)
    const h = Math.sqrt(21)
    expect(Array.from(a!.pts).map(r9)).toEqual([0, 0, 10, 0, 12, r9(5 - h)])
    expect(Array.from(b!.pts).map(r9)).toEqual([12, r9(5 + h), 10, 10])
    expect(on(a!, 10 + 5 * Math.cos(-1.4), 5 + 5 * Math.sin(-1.4))).toBe(true)
    expect(on(b!, 10 + 5 * Math.cos(1.4), 5 + 5 * Math.sin(1.4))).toBe(true)
    expect(on(a!, 15, 5) || on(b!, 15, 5)).toBe(false)
  })

  it('with no intersection nothing changes; Undo takes back the last trim', () => {
    const t = cross()
    t.run('L⏎20,20⏎30,20⏎⏎') // crosses nothing
    t.run('TR⏎⏎')
    t.click(40, 40) // no object there
    t.click(25, 20)
    t.click(3, 4)
    t.run('U⏎')
    t.run('⏎')
    expect(t.lines()).toEqual([[0, 0, 10, 0], [3, -5, 3, 5], [7, -5, 7, 5], [20, 20, 30, 20]])
    expect(t.interp.history).toContain('Object does not intersect a cutting edge.')
  })

  it('a click is never snapped away from the object', () => {
    const t = cross()
    t.interp.osnap = true
    t.run('TR⏎⏎')
    t.click(6.9, 0.05) // next to the end of nothing, but near the intersection (7, 0)
    t.run('⏎')
    expect(t.lines()).toContainEqual([0, 0, 3, 0])
    expect(t.lines()).toContainEqual([7, 0, 10, 0])
  })
})

describe('EXTEND', () => {
  it('takes the nearer end of a line to the nearest boundary', () => {
    const t = commandBench()
    t.run('L⏎0,0⏎2,0⏎⏎')
    t.run('L⏎5,-5⏎5,5⏎⏎')
    t.run('L⏎8,-5⏎8,5⏎⏎')
    t.run('EX⏎⏎')
    t.click(1.8, 0)
    t.run('⏎')
    expect(t.lines()[0]).toEqual([0, 0, 5, 0])
  })

  it('extends the end nearest to the click, the start included', () => {
    const t = commandBench()
    t.run('L⏎2,0⏎4,0⏎⏎')
    t.run('L⏎-1,-5⏎-1,5⏎⏎')
    t.run('EX⏎⏎')
    t.click(2.2, 0)
    t.run('⏎')
    expect(t.lines()[0]).toEqual([-1, 0, 4, 0])
  })

  it('extends an arc around its circle', () => {
    const t = commandBench()
    t.run('A⏎C⏎0,0⏎5,0⏎0,5⏎') // quarter from 0° to 90°
    t.run('L⏎-10,0⏎0,0⏎⏎') // the boundary: the negative x axis
    t.run('EX⏎⏎')
    t.click(1, 4.9)
    t.run('⏎')
    const [a] = arcs(t)
    expect(r9(a!.a0)).toBe(0)
    expect(r9(a!.a1)).toBe(r9(Math.PI))
  })

  it('extends the end piece of a polyline, straight or round its circle', () => {
    const t = commandBench()
    t.run('PL⏎0,0⏎2,0⏎2,2⏎⏎')
    t.run('L⏎-5,5⏎5,5⏎⏎')
    t.run('PL⏎0,-10⏎10,-10⏎A⏎10,0⏎⏎') // a half circle round (10,-5), ending at (10,0)
    t.run('L⏎7,-3⏎7,3⏎⏎')
    t.run('EX⏎⏎')
    t.click(2, 1.8)
    t.click(10, 0) // the end of the half circle: on round to x = 7
    t.run('⏎')
    const [p, q] = polylines(t)
    expect(Array.from(p!.pts)).toEqual([0, 0, 2, 0, 2, 5])
    expect(Array.from(q!.pts).map(r9)).toEqual([0, -10, 10, -10, 7, -1])
    expect(on(q!, 10 + 5 * Math.cos(2), -5 + 5 * Math.sin(2))).toBe(true)
  })

  it('with no boundary in the way nothing changes', () => {
    const t = commandBench()
    t.run('L⏎0,0⏎2,0⏎⏎')
    t.run('L⏎0,5⏎9,5⏎⏎')
    t.run('EX⏎⏎')
    t.click(1.8, 0)
    t.run('⏎')
    expect(t.lines()[0]).toEqual([0, 0, 2, 0])
    expect(t.interp.history).toContain('Object does not intersect an edge.')
  })
})
