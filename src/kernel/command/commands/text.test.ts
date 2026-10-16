import { describe, expect, it } from 'vitest'
import type { Text } from '../../entity/types'
import { commandBench } from '../testing'

const texts = (t: ReturnType<typeof commandBench>): Text[] => [...t.doc.entities()].filter((e): e is Text => e.type === 'text')
const round = (v: number): number => Math.round(v * 1e9) / 1e9 + 0

describe('TEXT', () => {
  it('places a line of text at its start point with the height and rotation given', () => {
    const t = commandBench()
    t.run('TEXT⏎10,20⏎5⏎30⏎Hello world⏎⏎')
    const [a, more] = texts(t)
    expect(more).toBeUndefined()
    expect(a).toMatchObject({ value: 'Hello world', x: 10, y: 20, height: 5, halign: 0, valign: 0, widthFactor: 1, oblique: 0 })
    expect(a!.rotation).toBeCloseTo(Math.PI / 6, 15)
    expect(t.interp.command).toBeNull()
  })

  it('each Enter starts the next line below; an empty line ends, and one undo takes them all', () => {
    const t = commandBench()
    t.run('TEXT⏎0,0⏎3⏎90⏎A⏎B⏎⏎')
    const [a, b] = texts(t)
    expect([a!.value, b!.value]).toEqual(['A', 'B'])
    // Down the page of a text turned 90° is +x, by 5/3 of the height.
    expect([round(b!.x), round(b!.y)]).toEqual([5, 0])
    t.doc.undo()
    expect(t.doc.size).toBe(0)
  })

  it('remembers the height (TEXTSIZE, 2.5 at first) and the rotation as the defaults', () => {
    const t = commandBench()
    t.run('TEXT⏎0,0⏎')
    expect(t.interp.prompt).toBe('Specify height <2.5000>:')
    t.run('⏎')
    expect(t.interp.prompt).toBe('Specify rotation angle of text <0>:')
    t.run('⏎X⏎⏎TEXT⏎0,0⏎7⏎45⏎Y⏎⏎TEXT⏎5,5⏎⏎⏎Z⏎⏎')
    const [x, y, z] = texts(t)
    expect([x!.height, x!.rotation]).toEqual([2.5, 0])
    expect(y!.height).toBe(7)
    expect([z!.height, round(z!.rotation)]).toEqual([7, round(Math.PI / 4)])
  })

  it('takes the text as typed, spaces and codes included', () => {
    const t = commandBench()
    t.run('TEXT⏎0,0⏎⏎⏎')
    expect(t.interp.request).toMatchObject({ kind: 'text', spaces: true })
    t.run('  two  spaces⏎45%%d⏎⏎')
    expect(texts(t).map((e) => e.value)).toEqual(['  two  spaces', '45%%d'])
  })

  it('Justify places the text by the point the option names', () => {
    const t = commandBench()
    t.run('TEXT⏎J⏎MC⏎5,5⏎2⏎0⏎Hi⏎⏎')
    t.run('TEXT⏎J⏎M⏎5,5⏎2⏎0⏎Hi⏎⏎')
    t.run('TEXT⏎J⏎r⏎5,5⏎2⏎0⏎Hi⏎⏎')
    t.run('TEXT⏎J⏎BL⏎5,5⏎2⏎0⏎Hi⏎⏎')
    expect(texts(t).map((e) => [e.halign, e.valign, e.x, e.y])).toEqual([[1, 2, 5, 5], [4, 0, 5, 5], [2, 0, 5, 5], [0, 1, 5, 5]])
  })

  it('Align runs between two points without a height; Fit asks for one', () => {
    const t = commandBench()
    t.run('TEXT⏎J⏎A⏎0,0⏎10,0⏎Hi⏎⏎')
    t.run('TEXT⏎J⏎F⏎0,10⏎10,10⏎3⏎Hi⏎⏎')
    const [a, f] = texts(t)
    expect(a).toMatchObject({ halign: 3, x: 0, y: 0, x2: 10, y2: 0 })
    expect(f).toMatchObject({ halign: 5, x: 0, y: 10, x2: 10, y2: 10, height: 3 })
  })

  it('refuses a second endpoint on the first', () => {
    const t = commandBench()
    t.run('TEXT⏎J⏎A⏎0,0⏎0,0⏎')
    expect(t.interp.history.at(-1)).toBe('The endpoints must differ.')
    expect(t.interp.prompt).toBe('Specify second endpoint of text baseline:')
  })
})
