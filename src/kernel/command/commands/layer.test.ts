import { describe, expect, it } from 'vitest'
import { TRUE_COLOR } from '../../color'
import { commandBench } from '../testing'
import { parseColor } from './layer'

const layerOf = (t: ReturnType<typeof commandBench>, name: string) => t.doc.layers.get(t.doc.layers.indexOf(name))

describe('-LAYER', () => {
  it('Make creates a layer and makes it current; new entities go there', () => {
    const t = commandBench()
    t.run('-LAYER⏎M⏎Walls⏎⏎')
    expect(t.interp.layer).toBe(t.doc.layers.indexOf('Walls'))
    t.run('L⏎0,0⏎1,1⏎⏎')
    expect([...t.doc.entities()][0]!.layer).toBe(t.interp.layer)
    expect(t.interp.history).toContain('Current layer: "0"')
  })

  it('New takes a list; Set makes one current, or says it does not exist', () => {
    const t = commandBench()
    t.run('-LA⏎N⏎A,B,C⏎S⏎B⏎S⏎Nope⏎⏎')
    expect(['A', 'B', 'C'].map((n) => t.doc.layers.indexOf(n))).toEqual([1, 2, 3])
    expect(t.interp.layer).toBe(2)
    expect(t.interp.history).toContain('Cannot find layer "Nope".')
  })

  it('OFF, ON, LOck, Unlock and Color act on name lists with wildcards', () => {
    const t = commandBench()
    t.run('-LAYER⏎N⏎Wall-A,Wall-B,Door⏎OFF⏎Wall*⏎LO⏎Door⏎C⏎red⏎Door⏎⏎')
    expect(layerOf(t, 'Wall-A')).toMatchObject({ visible: false })
    expect(layerOf(t, 'Wall-B')).toMatchObject({ visible: false })
    expect(layerOf(t, 'Door')).toMatchObject({ visible: true, locked: true, color: 1 })
    t.run('-LAYER⏎ON⏎wall-?⏎U⏎Door⏎C⏎10,20,30⏎Door⏎⏎')
    expect(layerOf(t, 'Wall-B')).toMatchObject({ visible: true })
    expect(layerOf(t, 'Door')).toMatchObject({ locked: false, color: TRUE_COLOR | 0x0a141e })
  })

  it('turning the current layer off asks first', () => {
    const t = commandBench()
    t.run('-LAYER⏎OFF⏎0⏎')
    expect(t.interp.prompt).toBe('Really want layer 0 (the CURRENT layer) off? [Yes/No] <No>:')
    t.run('⏎')
    expect(t.doc.layers.get(0)!.visible).toBe(true)
    t.run('OFF⏎0⏎Y⏎⏎')
    expect(t.doc.layers.get(0)!.visible).toBe(false)
  })

  it('? lists the layers; a bad name or color is refused', () => {
    const t = commandBench()
    t.run('-LAYER⏎M⏎a/b⏎C⏎purple⏎⏎?⏎⏎')
    expect(t.interp.history).toContain('Invalid layer name "a/b".')
    expect(t.interp.history).toContain('Requires a color number 1-255, a color name or r,g,b.')
    expect(t.interp.history.some((l) => l.startsWith('0 ') && l.includes('(current)'))).toBe(true)
  })

  it('LA without a layer panel falls back to the command line', () => {
    const t = commandBench()
    t.run('LA⏎')
    expect(t.interp.command).toBe('LAYER')
    expect(t.interp.prompt).toBe('Enter an option [?/Make/Set/New/ON/OFF/Color/Freeze/Thaw/LOck/Unlock]:')
  })
})

describe('parseColor', () => {
  it('ACI numbers, names and r,g,b', () => {
    expect(['1', '255', 'Blue', '0', '256', '10,20,30', '10,20,300', 'x'].map(parseColor)).toEqual([1, 255, 5, null, null, TRUE_COLOR | 0x0a141e, null, null])
  })
})
