import { describe, expect, it } from 'vitest'
import { typeOf } from '../../entity/registry'
import type { Arc, Entity, Polyline } from '../../entity/types'
import { arcSweep } from '../../geom/curve'
import { mirroring, rotation, scaling, translation } from '../../geom/vec'
import { commandBench } from '../testing'

const r9 = (v: number): number => Math.round(v * 1e9) / 1e9 + 0

const arc: Arc = { type: 'arc', id: 1, layer: 0, cx: 0, cy: 0, r: 5, a0: 0, a1: Math.PI / 2 }

describe('entity transforms', () => {
  it('mirroring an arc reverses its run and keeps its geometry', () => {
    const m = typeOf(arc).transform!(arc, mirroring({ x: 0, y: 0 }, { x: 0, y: 1 })) as Arc // across the Y axis
    // The quarter from 0° to 90° becomes the quarter from 90° to 180°, still counter-clockwise.
    expect([m.cx, m.cy, m.r].map(r9)).toEqual([0, 0, 5])
    expect(r9(m.a0)).toBe(r9(Math.PI / 2))
    expect(r9(arcSweep(m.a0, m.a1))).toBe(r9(Math.PI / 2))
    for (const [x, y] of [[-5, 0], [0, 5], [-5 * Math.SQRT1_2, 5 * Math.SQRT1_2]]) expect(typeOf(m).distance(m, { x: x!, y: y! })).toBeLessThan(1e-9)
    expect(m.id).toBe(arc.id)
  })

  it('a 360° rotation gives back the original, within tolerance', () => {
    const p: Polyline = { type: 'polyline', id: 2, layer: 0, pts: new Float64Array([7_400_000, 9_100_000, 7_400_010, 9_100_000, 7_400_010, 9_100_005]), bulges: new Float64Array([0.5, 0, 0]), closed: true }
    const turned = typeOf(p).transform!(p, rotation({ x: 7_400_003, y: 9_100_001 }, 360)) as Polyline
    turned.pts.forEach((v, i) => expect(Math.abs(v - p.pts[i]!)).toBeLessThan(1e-6))
    expect(Array.from(turned.bulges!)).toEqual([0.5, 0, 0])
  })

  it('mirroring a polyline negates its bulges; scaling scales radii', () => {
    const p: Polyline = { type: 'polyline', id: 3, layer: 0, pts: new Float64Array([0, 0, 2, 0]), bulges: new Float64Array([1, 0]), closed: false }
    const m = typeOf(p).transform!(p, mirroring({ x: 0, y: 0 }, { x: 1, y: 0 })) as Polyline
    expect(Array.from(m.bulges!)).toEqual([-1, -0])
    const c = typeOf(arc).transform!(arc, scaling({ x: 1, y: 1 }, 2)) as Arc
    expect([c.cx, c.cy, c.r]).toEqual([-1, -1, 10])
  })

  it('rotations by multiples of 90° are exact', () => {
    const m = rotation({ x: 0, y: 0 }, 90)
    expect([m.a, m.b, m.c, m.d]).toEqual([0, 1, -1, 0])
    expect(translation(3, 4)).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 3, f: 4 })
  })
})

describe('MOVE, COPY, ROTATE, MIRROR, SCALE', () => {
  const setup = () => {
    const t = commandBench()
    t.run('L⏎0,0⏎10,0⏎⏎')
    t.run('C⏎20,0⏎2⏎')
    return t
  }

  it('MOVE by base point and second point, as one undo step; the selection is cleared', () => {
    const t = setup()
    t.run('M⏎ALL⏎⏎0,0⏎5,5⏎')
    expect(t.lines()).toEqual([[5, 5, 15, 5]])
    expect(t.circles()).toEqual([[25, 5, 2]])
    expect(t.selection.ids.size).toBe(0)
    expect(t.doc.undo()).toBe('MOVE')
    expect(t.lines()).toEqual([[0, 0, 10, 0]])
  })

  it('MOVE with Enter at the second point takes the first as the displacement; pre-selection skips the prompt', () => {
    const t = setup()
    t.click(5, 0)
    t.run('M⏎3,-1⏎⏎')
    expect(t.lines()).toEqual([[3, -1, 13, -1]])
    expect(t.circles()).toEqual([[20, 0, 2]])
  })

  it('COPY places copies until Enter', () => {
    const t = setup()
    t.click(5, 0)
    t.run('CO⏎0,0⏎0,10⏎0,20⏎@0,10⏎⏎')
    expect(t.lines()).toEqual([[0, 0, 10, 0], [0, 10, 10, 10], [0, 20, 10, 20], [0, 30, 10, 30]])
    expect(t.doc.undo()).toBe('COPY')
    expect(t.lines()).toHaveLength(1)
  })

  it('COPY with Enter at the first second point copies once by the base point taken as the displacement', () => {
    const t = setup()
    t.click(5, 0)
    t.run('CO⏎5,5⏎')
    expect(t.interp.prompt).toBe('Specify second point or <use first point as displacement>:')
    t.run('⏎')
    expect(t.lines()).toEqual([[0, 0, 10, 0], [5, 5, 15, 5]])
    expect(t.interp.command).toBeNull()
  })

  it('MOVE and COPY take Enter or Displacement at the base point, then the displacement itself', () => {
    const t = setup()
    t.click(5, 0)
    t.run('M⏎')
    expect(t.interp.prompt).toBe('Specify base point or [Displacement] <Displacement>:')
    t.run('⏎')
    expect(t.interp.prompt).toBe('Specify displacement <0.0000, 0.0000>:')
    t.run('3,4⏎')
    expect(t.lines()).toEqual([[3, 4, 13, 4]])
    t.click(8, 4)
    t.run('M⏎⏎') // the last displacement is the default
    expect(t.interp.prompt).toBe('Specify displacement <3.0000, 4.0000>:')
    t.run('⏎')
    expect(t.lines()).toEqual([[6, 8, 16, 8]])
    t.click(11, 8)
    t.run('CO⏎D⏎0,-8⏎')
    expect(t.lines()).toEqual([[6, 8, 16, 8], [6, 0, 16, 0]])
    expect(t.interp.command).toBeNull()
  })

  it('ROTATE about a base point by an angle in degrees, or towards a picked point', () => {
    const t = setup()
    t.click(5, 0)
    t.run('RO⏎0,0⏎90⏎')
    expect(t.lines()).toEqual([[0, 0, 0, 10]])
    t.click(0, 5)
    t.run('RO⏎0,0⏎')
    t.click(-3, 0) // the base-to-point direction, 180°, is the angle
    expect(t.lines()).toEqual([[0, 0, 0, -10]])
  })

  it('MIRROR keeps the source by default, or erases it on Yes', () => {
    const t = setup()
    t.click(20, 2)
    t.run('MI⏎0,0⏎0,10⏎⏎')
    expect(t.circles()).toEqual([[20, 0, 2], [-20, 0, 2]])
    t.click(5, 0)
    t.run('MI⏎0,-5⏎10,-5⏎Y⏎')
    expect(t.lines()).toEqual([[0, -10, 10, -10]])
  })

  it('SCALE about a base point by a factor', () => {
    const t = setup()
    t.run('SC⏎ALL⏎⏎0,0⏎0.5⏎')
    expect(t.lines()).toEqual([[0, 0, 5, 0]])
    expect(t.circles()).toEqual([[10, 0, 1]])
    t.run('SC⏎ALL⏎⏎0,0⏎0⏎')
    expect(t.interp.history.at(-1)).toBe('Value must be positive and nonzero.')
  })

  it('ROTATE offers the last angle and SCALE the last factor (1 at first), as AutoCAD does', () => {
    const t = setup()
    t.run('RO⏎ALL⏎⏎0,0⏎90⏎')
    t.run('RO⏎ALL⏎⏎0,0⏎')
    expect(t.interp.prompt).toBe('Specify rotation angle <90>:')
    t.run('⏎')
    expect(t.lines()).toEqual([[0, 0, -10, 0]])
    t.run('SC⏎ALL⏎⏎0,0⏎')
    expect(t.interp.prompt).toBe('Specify scale factor <1.0000>:')
    t.run('2⏎')
    t.run('SC⏎ALL⏎⏎0,0⏎⏎')
    expect(t.lines()).toEqual([[0, 0, -40, 0]])
  })

  it('skips entities on locked layers', () => {
    const t = setup()
    const locked = t.doc.layers.add({ name: 'Locked', color: 1, visible: true, locked: true })
    const circle = [...t.doc.entities()].find((e: Entity) => e.type === 'circle')!
    t.doc.transact('to locked', (tx) => tx.replace({ ...circle, layer: locked }))
    t.run('M⏎ALL⏎⏎0,0⏎1,0⏎')
    expect(t.lines()).toEqual([[1, 0, 11, 0]])
    expect(t.circles()).toEqual([[20, 0, 2]])
    expect(t.interp.history).toContain('1 was on a locked layer.')
  })
})
