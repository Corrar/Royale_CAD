import { describe, expect, it } from 'vitest'
import type { Arc, Entity } from '../../entity/types'
import { commandBench } from '../testing'

const r9 = (v: number): number => Math.round(v * 1e9) / 1e9 + 0
const arcs = (t: ReturnType<typeof commandBench>): Arc[] => [...t.doc.entities()].filter((e: Entity): e is Arc => e.type === 'arc')

describe('OFFSET', () => {
  it('a line by a distance, to the side of the point given; several in one command', () => {
    const t = commandBench()
    t.run('L⏎0,0⏎10,0⏎⏎')
    t.run('O⏎2⏎')
    t.click(5, 0)
    t.click(5, 3)
    t.click(5, 0)
    t.click(4, -7)
    t.run('⏎')
    expect(t.lines()).toEqual([[0, 0, 10, 0], [0, 2, 10, 2], [0, -2, 10, -2]])
    expect(t.doc.undo()).toBe('OFFSET')
    expect(t.lines()).toHaveLength(1)
  })

  it('Through passes the copy through the point', () => {
    const t = commandBench()
    t.run('L⏎0,0⏎10,0⏎⏎')
    t.run('O⏎T⏎')
    t.click(5, 0)
    t.click(3, 7)
    t.run('⏎')
    expect(t.lines()).toContainEqual([0, 7, 10, 7])
  })

  it('a circle grows outwards and shrinks inwards', () => {
    const t = commandBench()
    t.run('C⏎0,0⏎5⏎')
    t.run('O⏎2⏎')
    t.click(5, 0)
    t.click(1.5, 0.5)
    t.click(0, 5)
    t.click(0, 9)
    t.run('⏎')
    expect(t.circles()).toEqual([[0, 0, 5], [0, 0, 3], [0, 0, 7]])
  })

  it('refuses a radius that would not be positive', () => {
    const t = commandBench()
    t.run('C⏎0,0⏎2⏎')
    t.run('O⏎3⏎')
    t.click(2, 0)
    t.click(1.5, 0.5)
    expect(t.interp.history.at(-1)).toBe('Cannot offset: the radius would be zero or less.')
    expect(t.circles()).toEqual([[0, 0, 2]])
  })

  it('an arc keeps its angles', () => {
    const t = commandBench()
    t.run('A⏎C⏎0,0⏎5,0⏎0,5⏎')
    t.run('O⏎1⏎')
    t.click(5 * Math.SQRT1_2, 5 * Math.SQRT1_2)
    t.click(5, 5)
    t.run('⏎')
    const [a, b] = arcs(t)
    expect([b!.cx, b!.cy, b!.r]).toEqual([0, 0, 6])
    expect([r9(b!.a0), r9(b!.a1)]).toEqual([r9(a!.a0), r9(a!.a1)])
  })

  it('takes the distance from two points, and offers it next time', () => {
    const t = commandBench()
    t.run('L⏎0,0⏎10,0⏎⏎')
    t.run('O⏎0,0⏎3,4⏎')
    t.click(5, 0)
    t.click(2, 1.5) // clear of the snaps at (0,0) and (5,0)
    t.run('⏎')
    expect(t.lines()).toContainEqual([0, 5, 10, 5])
    t.run('O⏎')
    expect(t.interp.prompt).toBe('Specify offset distance or [Through] <5.0000>:')
    t.run('⏎')
    expect(t.interp.prompt).toBe('Select object to offset or [Exit/Undo] <Exit>:')
  })

  it('Undo takes back the last offset of the command; refuses a zero distance', () => {
    const t = commandBench()
    t.run('L⏎0,0⏎10,0⏎⏎')
    t.run('O⏎0⏎')
    expect(t.interp.history.at(-1)).toBe('Value must be positive and nonzero.')
    t.run('1⏎')
    t.click(5, 0)
    t.click(2, 1.5) // clear of the snaps at (0,0) and (5,0)
    expect(t.lines()).toHaveLength(2)
    t.run('U⏎')
    t.run('⏎')
    expect(t.lines()).toEqual([[0, 0, 10, 0]])
  })

  it('leaves polylines for later, with a message', () => {
    const t = commandBench()
    t.run('REC⏎0,0⏎10,10⏎')
    t.run('O⏎1⏎')
    t.click(5, 0)
    expect(t.interp.history.at(-1)).toBe('Polylines cannot be offset yet.')
    expect(t.doc.size).toBe(1)
  })
})
