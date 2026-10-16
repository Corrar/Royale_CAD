import { describe, expect, it } from 'vitest'
import { FIT_MARGIN_PX, fit, screenToWorld } from '../../view'
import { commandBench } from '../testing'

describe('LINE', () => {
  it('L⏎0,0⏎10,0⏎@0,5⏎C⏎ draws a closed triangle', () => {
    const t = commandBench()
    t.run('L⏎0,0⏎10,0⏎@0,5⏎C⏎')
    expect(t.lines()).toEqual([[0, 0, 10, 0], [10, 0, 10, 5], [10, 5, 0, 0]])
    expect(t.interp.command).toBeNull()
  })

  it('Undo inside LINE takes back the last segment and continues from its start', () => {
    const t = commandBench()
    t.run('L⏎0,0⏎10,0⏎10,5⏎U⏎0,5⏎⏎')
    expect(t.lines()).toEqual([[0, 0, 10, 0], [10, 0, 0, 5]])
    t.run('L⏎0,0⏎u⏎')
    expect(t.interp.history.at(-1)).toBe('All segments already undone.')
  })

  it('offers Close only after two segments', () => {
    const t = commandBench()
    t.run('L⏎0,0⏎1,0⏎')
    expect(t.interp.prompt).toBe('Specify next point or [Undo]:')
    t.run('1,1⏎')
    expect(t.interp.prompt).toBe('Specify next point or [Close/Undo]:')
  })
})

describe('CIRCLE', () => {
  it('C⏎0,0⏎5⏎ and C⏎0,0⏎D⏎10⏎ give radius 5', () => {
    const t = commandBench()
    t.run('C⏎0,0⏎5⏎')
    t.run('C⏎0,0⏎D⏎10⏎')
    expect(t.circles()).toEqual([[0, 0, 5], [0, 0, 5]])
  })

  it('offers the last radius as the default and refuses a non-positive one', () => {
    const t = commandBench()
    t.run('C⏎0,0⏎2⏎')
    t.run('C⏎9,9⏎')
    expect(t.interp.prompt).toBe('Specify radius of circle or [Diameter] <2>:')
    t.run('0⏎')
    expect(t.interp.history.at(-1)).toBe('Value must be positive and nonzero.')
    t.run('⏎')
    expect(t.circles()).toEqual([[0, 0, 2], [9, 9, 2]])
  })
})

describe('undo', () => {
  it('each command is one undo step; U and REDO walk them', () => {
    const t = commandBench()
    t.run('L⏎0,0⏎1,0⏎2,0⏎⏎')
    t.run('C⏎0,0⏎1⏎')
    t.run('U⏎')
    expect(t.interp.history.at(-1)).toBe('CIRCLE')
    expect(t.circles()).toEqual([])
    t.run('U⏎')
    expect(t.lines()).toEqual([])
    t.run('U⏎')
    expect(t.interp.history.at(-1)).toBe('Everything has been undone.')
    t.run('REDO⏎')
    expect(t.lines()).toHaveLength(2)
  })

  it('UNDO takes a count, 1 by default', () => {
    const t = commandBench()
    for (let i = 0; i < 3; i++) t.run(`C⏎${i},0⏎1⏎`)
    t.run('UNDO⏎2⏎')
    expect(t.circles()).toHaveLength(1)
    t.run('UNDO⏎⏎')
    expect(t.circles()).toHaveLength(0)
  })
})

describe('selection and ERASE', () => {
  function threeLines() {
    const t = commandBench()
    t.run('L⏎0,0⏎10,0⏎⏎')
    t.run('L⏎0,5⏎10,5⏎⏎')
    t.run('L⏎20,0⏎20,10⏎⏎')
    return t
  }

  it('E with a pre-selection erases at once', () => {
    const t = threeLines()
    t.click(5, 0)
    expect(t.selection.ids.size).toBe(1)
    t.run('E⏎')
    expect(t.lines()).toEqual([[0, 5, 10, 5], [20, 0, 20, 10]])
    expect(t.selection.ids.size).toBe(0)
    expect(t.interp.command).toBeNull()
  })

  it('E⏎, clicks and ⏎ erase what was clicked; U brings it back', () => {
    const t = threeLines()
    t.run('E⏎')
    expect(t.interp.prompt).toBe('Select objects:')
    t.click(5, 0)
    t.click(5, 5)
    t.click(5, 5, true) // Shift removes
    t.click(20, 3)
    expect(t.interp.history.slice(-3)).toEqual(['1 found', '1 found, removed', '1 found'])
    t.run('⏎')
    expect(t.lines()).toEqual([[0, 5, 10, 5]])
    t.run('U⏎')
    expect(t.lines()).toHaveLength(3)
  })

  it('a window from the left takes what lies inside; from the right, what it crosses', () => {
    const t = threeLines()
    t.click(-1, -1) // empty: first corner
    expect(t.interp.corner).toEqual({ x: -1, y: -1 })
    t.click(11, 6)
    expect(t.selection.ids.size).toBe(2)
    t.interp.cancel()
    expect(t.selection.ids.size).toBe(0)
    t.click(21, 4) // right to left: crossing, reaches the vertical line at x = 20
    t.click(15, 6)
    expect(t.selection.ids.size).toBe(1)
    t.run('E⏎')
    expect(t.lines()).toEqual([[0, 0, 10, 0], [0, 5, 10, 5]])
  })

  it('ALL at the selection prompt takes everything', () => {
    const t = threeLines()
    t.run('E⏎ALL⏎⏎')
    expect(t.lines()).toEqual([])
  })

  it('Esc idle drops a window being dragged first, then the selection', () => {
    const t = threeLines()
    t.click(5, 0)
    t.click(30, 30)
    t.interp.cancel()
    expect(t.interp.corner).toBeNull()
    expect(t.selection.ids.size).toBe(1)
    t.interp.cancel()
    expect(t.selection.ids.size).toBe(0)
  })

  it('skips entities on locked layers', () => {
    const t = threeLines()
    const locked = t.doc.layers.add({ name: 'Locked', color: 1, visible: true, locked: true })
    const first = [...t.doc.entities()][0]!
    t.doc.transact('move to layer', (tx) => tx.replace({ ...first, layer: locked }))
    t.run('E⏎ALL⏎⏎')
    expect(t.lines()).toEqual([[0, 0, 10, 0]])
    expect(t.interp.history).toContain('1 was on a locked layer.')
  })
})

describe('ZOOM and PAN', () => {
  it('Z⏎E⏎ frames the extents', () => {
    const t = commandBench()
    t.run('L⏎0,0⏎100,50⏎⏎')
    const before = t.view()
    t.run('Z⏎E⏎')
    expect(t.view()).toEqual(fit(before, { minX: 0, minY: 0, maxX: 100, maxY: 50 }, FIT_MARGIN_PX))
  })

  it('a scale factor zooms about the centre; a window frames its corners', () => {
    const t = commandBench()
    t.run('Z⏎2x⏎')
    expect(t.view().scale).toBe(20)
    t.run('Z⏎0.5⏎')
    expect(t.view().scale).toBe(10)
    t.run('Z⏎0,0⏎40,30⏎')
    const v = t.view()
    const corner = screenToWorld(v, 0, v.height)
    expect(corner.x).toBeCloseTo(0, 12)
    expect(corner.y).toBeCloseTo(0, 12)
    expect(v.scale).toBe(20)
    t.run('Z⏎W⏎0,0⏎80,60⏎')
    expect(t.view().scale).toBe(10)
  })

  it('PAN moves the drawing by a displacement', () => {
    const t = commandBench()
    t.run('P⏎0,0⏎10,5⏎')
    expect([t.view().cx, t.view().cy]).toEqual([-10, -5])
    t.run('P⏎3,4⏎⏎')
    expect([t.view().cx, t.view().cy]).toEqual([-13, -9])
  })

  it('view commands leave no undo step', () => {
    const t = commandBench()
    t.run('C⏎0,0⏎1⏎')
    t.run('Z⏎E⏎')
    t.run('P⏎1,1⏎⏎')
    expect(t.doc.undo()).toBe('CIRCLE')
  })
})

describe('object snap and ORTHO', () => {
  it('a click near an end lands exactly on it (OSNAP on); typed points are never snapped', () => {
    const t = commandBench()
    t.run('L⏎0,0⏎10,0⏎⏎')
    t.interp.osnap = true
    t.run('L⏎')
    t.click(10.05, 0.03) // within 10 px at scale 10
    t.click(10.02, 5)
    t.run('10.05,0.03⏎⏎')
    expect(t.lines()).toEqual([[0, 0, 10, 0], [10, 0, 10.02, 5], [10.02, 5, 10.05, 0.03]])
  })

  it('OSNAP off: clicks land where they are', () => {
    const t = commandBench()
    t.run('L⏎0,0⏎10,0⏎⏎')
    t.interp.osnap = false
    t.run('L⏎')
    t.click(10.05, 0.03)
    t.run('⏎')
    t.interp.cursor = { x: 10.05, y: 0.03 }
    expect(t.interp.tracked).toEqual({ p: { x: 10.05, y: 0.03 }, snap: null })
  })

  it('tracks the snap under the cursor while a point is asked for, not at the Command prompt', () => {
    const t = commandBench()
    t.run('L⏎0,0⏎10,0⏎⏎')
    t.interp.osnap = true
    t.interp.cursor = { x: 5.1, y: 0.2 }
    expect(t.interp.tracked).toEqual({ p: { x: 5.1, y: 0.2 }, snap: null })
    t.run('L⏎')
    expect(t.interp.tracked).toEqual({ p: { x: 5, y: 0 }, snap: { p: { x: 5, y: 0 }, mode: 2, id: 1 } })
  })

  it('ORTHO: L⏎0,0⏎, cursor at (3,1), 10⏎ ends at (10,0); clicks are squared to the base too', () => {
    const t = commandBench()
    t.interp.ortho = true
    t.run('L⏎0,0⏎')
    t.interp.cursor = { x: 3, y: 1 }
    t.run('10⏎')
    t.click(12, 7) // from (10, 0): |dy| > |dx|, so vertical
    t.run('⏎')
    expect(t.lines()).toEqual([[0, 0, 10, 0], [10, 0, 10, 7]])
  })

  it('OSNAP wins over ORTHO, and both toggles notify', () => {
    const t = commandBench()
    t.run('C⏎5,5⏎1⏎')
    let n = 0
    t.interp.onChange(() => n++)
    expect(t.interp.osnap).toBe(true) // on by default, as in AutoCAD
    t.interp.osnap = false
    t.interp.ortho = true
    t.interp.ortho = true // no change, no notice
    t.interp.osnap = true
    expect(n).toBe(3)
    t.run('L⏎0,0⏎')
    t.click(5.95, 5.1) // on the circle: CEN, off the ortho line
    t.run('⏎')
    expect(t.lines()).toEqual([[0, 0, 5, 5]])
  })
})
