import { describe, expect, it } from 'vitest'
import { textType } from '../../entity/text'
import type { Text } from '../../entity/types'
import { widthOf } from '../../text/layout'
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

  it('takes a justification at the first prompt, without Justify, as AutoCAD does', () => {
    const t = commandBench()
    t.run('TEXT⏎')
    // Only Justify shows; the options it lists are taken all the same.
    expect(t.interp.prompt).toBe('Specify start point of text or [Justify]:')
    t.run('MC⏎')
    expect(t.interp.prompt).toBe('Specify middle-center point of text:')
    t.run('5,5⏎2⏎0⏎Hi⏎⏎DT⏎c⏎5,5⏎2⏎0⏎Hi⏎⏎DT⏎A⏎0,0⏎10,0⏎Hi⏎⏎')
    expect(texts(t).map((e) => [e.halign, e.valign])).toEqual([[1, 2], [1, 0], [3, 0]])
  })

  it('a click while the words are asked starts the next line there, as DTEXT does', () => {
    const t = commandBench()
    t.run('TEXT⏎0,0⏎2⏎0⏎A⏎')
    t.click(50, 40)
    expect(t.interp.history.at(-1)).toBe('Enter text:')
    expect(t.interp.prompt).toBe('Enter text:')
    t.run('B⏎C⏎⏎')
    const [, b, c] = texts(t)
    expect([b!.value, b!.x, b!.y]).toEqual(['B', 50, 40])
    expect([round(c!.x), round(c!.y)]).toEqual([50, round(40 - (2 * 5) / 3)])
  })

  it('Align: each line is as tall as its span makes it, kept so, and the next goes clear below it', () => {
    const t = commandBench()
    t.run('TEXT⏎J⏎A⏎0,0⏎100,0⏎Hi⏎There⏎⏎')
    t.run('TEXT⏎J⏎A⏎0,0⏎0,60⏎FLOOR PLAN⏎SCALE 1:50⏎⏎')
    const [hi, there, title, scale] = texts(t)
    // The height the layout gives an aligned line: its span over its width.
    expect(hi!.height).toBeCloseTo(100 / widthOf('Hi'), 9)
    expect(there!.height).toBeCloseTo(100 / widthOf('There'), 9)
    expect(textType.bbox(there!).maxY).toBeLessThan(textType.bbox(hi!).minY)
    // Turned 90°, down the page is +x.
    expect(title!.height).toBeCloseTo(60 / widthOf('FLOOR PLAN'), 9)
    expect(textType.bbox(scale!).minX).toBeGreaterThan(textType.bbox(title!).maxX)
  })

  it('Enter at the first prompt goes on below the last line, set as it was, even after another command', () => {
    const t = commandBench()
    t.run('TEXT⏎⏎')
    // With no line before, Enter is refused as ever.
    expect(t.interp.prompt).toBe('Specify start point of text or [Justify]:')
    t.interp.cancel()
    t.run('TEXT⏎J⏎MC⏎10,20⏎2⏎90⏎First⏎⏎LINE⏎0,0⏎1,1⏎⏎TEXT⏎⏎')
    expect(t.interp.prompt).toBe('Enter text:')
    t.run('Second⏎Third⏎⏎')
    const [, second, third] = texts(t)
    expect(second).toMatchObject({ value: 'Second', height: 2, halign: 1, valign: 2 })
    expect(round(second!.rotation)).toBe(round(Math.PI / 2))
    // Turned 90°, down the page is +x, 5/3 of the height a line.
    expect([round(second!.x), round(second!.y)]).toEqual([round(10 + 10 / 3), 20])
    expect([round(third!.x), round(third!.y)]).toEqual([round(10 + 20 / 3), 20])
  })

  it('Enter goes on below an aligned line between points moved down with it', () => {
    const t = commandBench()
    t.run('TEXT⏎J⏎A⏎0,0⏎30,0⏎Hi⏎⏎TEXT⏎⏎There⏎⏎')
    const [hi, there] = texts(t)
    expect(there).toMatchObject({ halign: 3, x: 0, x2: 30 })
    expect(there!.y2).toBe(there!.y)
    expect(textType.bbox(there!).maxY).toBeLessThan(textType.bbox(hi!).minY)
  })

  it('refuses a second endpoint on the first', () => {
    const t = commandBench()
    t.run('TEXT⏎J⏎A⏎0,0⏎0,0⏎')
    expect(t.interp.history.at(-1)).toBe('The endpoints must differ.')
    expect(t.interp.prompt).toBe('Specify second endpoint of text baseline:')
  })
})
