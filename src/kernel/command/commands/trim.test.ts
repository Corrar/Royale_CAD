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
    t.click(40, 40) // no object there: a window, which meets none
    t.click(41, 41)
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

  it('a click right on a cut removes one piece only: the one after it, or before it at the end', () => {
    const t = commandBench()
    t.run('L⏎3,-5⏎3,5⏎⏎')
    t.run('L⏎7,-5⏎7,5⏎⏎')
    t.run('L⏎0,0⏎10,0⏎⏎')
    t.run('TR⏎⏎')
    t.click(3, 0)
    t.run('⏎')
    expect(t.lines()).toEqual([[3, -5, 3, 5], [7, -5, 7, 5], [0, 0, 3, 0], [7, 0, 10, 0]])
    const u = commandBench()
    u.run('L⏎7,-5⏎7,5⏎⏎')
    u.run('L⏎10,-5⏎10,5⏎⏎')
    u.run('L⏎0,0⏎10,0⏎⏎')
    u.run('TR⏎⏎')
    u.click(10, 0)
    u.run('⏎')
    expect(u.lines()).toEqual([[7, -5, 7, 5], [10, -5, 10, 5], [0, 0, 7, 0]])
  })

  it('Shift+click extends to the same edges instead (shift-select), and Undo takes it back', () => {
    const t = commandBench()
    t.run('L⏎0,0⏎8,0⏎⏎')
    t.run('L⏎4,-5⏎4,5⏎⏎')
    t.run('L⏎10,-5⏎10,5⏎⏎')
    t.run('TR⏎⏎')
    expect(t.interp.prompt).toBe('Select object to trim or shift-select to extend or [Undo]:')
    t.click(7, 0, true)
    expect(t.lines()[0]).toEqual([0, 0, 10, 0])
    t.run('U⏎')
    expect(t.lines()[0]).toEqual([0, 0, 8, 0])
    t.click(7, 0)
    t.run('⏎')
    expect(t.lines()[0]).toEqual([0, 0, 4, 0])
  })

  it('a pick on nothing opens a crossing window: every object it crosses is trimmed, in one step', () => {
    const t = commandBench()
    t.run('L⏎0,0⏎10,0⏎⏎')
    t.run('L⏎0,2⏎10,2⏎⏎')
    t.run('L⏎5,-5⏎5,5⏎⏎')
    t.run('TR⏎⏎')
    t.click(8, 3) // nothing there: the first corner
    expect(t.interp.prompt).toBe('Specify opposite corner:')
    t.click(7, -1)
    expect(t.lines()).toEqual([[0, 0, 5, 0], [0, 2, 5, 2], [5, -5, 5, 5]])
    t.run('U⏎')
    expect(t.lines()).toEqual([[0, 0, 10, 0], [0, 2, 10, 2], [5, -5, 5, 5]])
  })

  it('a crossing window trims each object where its edge first meets it, clockwise from the first corner', () => {
    const t = commandBench()
    t.run('L⏎0,0⏎10,0⏎⏎')
    t.run('L⏎5,-5⏎5,5⏎⏎')
    t.run('TR⏎⏎')
    t.click(6, 1) // from the top right: down its right side, then along the bottom
    t.click(4, -1)
    t.run('⏎')
    expect(t.lines()).toEqual([[0, 0, 5, 0], [5, 0, 5, 5]])
    const u = commandBench()
    u.run('L⏎0,0⏎10,0⏎⏎')
    u.run('L⏎5,-5⏎5,5⏎⏎')
    u.run('TR⏎⏎')
    u.click(4, -1) // from the bottom left, left to right, still crossing: up its left side, then along the top
    u.click(6, 1)
    u.run('⏎')
    expect(u.lines()).toEqual([[5, 0, 10, 0], [5, -5, 5, 0]])
  })

  it('a cut at a vertex that the next vertex repeats keeps the piece before it', () => {
    const t = commandBench()
    t.run('PL⏎0,0⏎10,0⏎10,0⏎10,10⏎⏎')
    t.run('L⏎10,0⏎15,-5⏎⏎') // touches the corner
    t.run('TR⏎⏎')
    t.click(10, 5)
    t.run('⏎')
    const [p] = polylines(t)
    expect(Array.from(p!.pts)).toEqual([0, 0, 10, 0])
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

  it('a flat arc end piece of a polyline reaches a boundary just past its end, the nearer of two', () => {
    const t = commandBench()
    // The end piece turns by 0.001 rad on a circle of radius 1000; its tolerance is a length, not that fraction of it.
    t.doc.transact('PL', (tx) => {
      tx.add({ type: 'polyline', layer: 0, pts: Float64Array.of(-999, 0, 0, 0, 1, 0), bulges: Float64Array.of(0, Math.tan(0.001 / 4), 0), closed: false })
    })
    t.run('L⏎1.005,-1⏎1.005,1⏎⏎')
    t.run('L⏎1.02,-1⏎1.02,1⏎⏎')
    t.run('EX⏎⏎')
    t.click(0.9, 0.0001)
    t.run('⏎')
    expect(t.interp.history).not.toContain('Object does not intersect an edge.')
    const [p] = polylines(t)
    // Round the same circle, centre (0.5, cy), to x = 1.005.
    const r = 0.5 / Math.sin(0.0005)
    const cy = r * Math.cos(0.0005)
    expect(p!.pts[4]).toBeCloseTo(1.005, 9)
    expect(Math.hypot(p!.pts[4]! - 0.5, p!.pts[5]! - cy)).toBeCloseTo(r, 9)
    expect(on(p!, 0.5, cy - r)).toBe(true)
  })

  it('takes the end of a polyline nearer the click along it, whatever the vertex count', () => {
    const t = commandBench()
    t.run('PL⏎0,0⏎100,0⏎100,1⏎100,2⏎100,3⏎⏎')
    t.run('L⏎-10,-10⏎-10,10⏎⏎') // left of the start
    t.run('L⏎90,10⏎110,10⏎⏎') // above the end
    t.run('EX⏎⏎')
    t.click(90, 0) // 90 from the start, 13 from the end
    t.run('⏎')
    const [p] = polylines(t)
    expect(Array.from(p!.pts)).toEqual([0, 0, 100, 0, 100, 1, 100, 2, 100, 10])
  })

  it('extends a polyline past repeated end vertices, which move with the end', () => {
    const t = commandBench()
    t.run('PL⏎0,0⏎0,0⏎10,0⏎10,0⏎⏎')
    t.run('L⏎20,-5⏎20,5⏎⏎')
    t.run('L⏎-20,-5⏎-20,5⏎⏎')
    t.run('EX⏎⏎')
    t.click(10.1, 0)
    t.click(-0.1, 0)
    t.run('⏎')
    const [p] = polylines(t)
    expect(Array.from(p!.pts)).toEqual([-20, 0, -20, 0, 20, 0, 20, 0])
  })

  it('Shift+click trims at the same edges instead (shift-select)', () => {
    const t = commandBench()
    t.run('L⏎0,0⏎10,0⏎⏎')
    t.run('L⏎6,-5⏎6,5⏎⏎')
    t.run('L⏎12,-5⏎12,5⏎⏎')
    t.run('EX⏎⏎')
    expect(t.interp.prompt).toBe('Select object to extend or shift-select to trim or [Undo]:')
    t.click(9, 0, true)
    t.run('⏎')
    expect(t.lines()[0]).toEqual([0, 0, 6, 0])
  })

  it('a pick on nothing opens a crossing window: every object it crosses is extended; with Shift, trimmed', () => {
    const t = commandBench()
    t.run('L⏎0,0⏎4,0⏎⏎')
    t.run('L⏎0,2⏎4,2⏎⏎')
    t.run('L⏎10,-5⏎10,5⏎⏎')
    t.run('EX⏎⏎')
    t.click(3, 3) // nothing there: the first corner
    expect(t.interp.prompt).toBe('Specify opposite corner:')
    t.click(3.5, -1)
    expect(t.lines()).toEqual([[0, 0, 10, 0], [0, 2, 10, 2], [10, -5, 10, 5]])
    t.click(12, 1)
    t.click(8, -1, true) // met first along the bottom, the boundary loses its piece below the lower line
    t.run('⏎')
    expect(t.lines()).toEqual([[0, 0, 10, 0], [0, 2, 10, 2], [10, 0, 10, 5]])
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
