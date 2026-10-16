import { describe, expect, it } from 'vitest'
import { TRUE_COLOR, aciRgb, colorRgb, isColor, trueColor } from './color'

describe('aciRgb', () => {
  it('has the fixed colors 1-9 and the grays 250-255', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map(aciRgb)).toEqual([
      0xff0000, 0xffff00, 0x00ff00, 0x00ffff, 0x0000ff, 0xff00ff, 0xffffff, 0x808080, 0xc0c0c0,
    ])
    expect([250, 251, 252, 253, 254, 255].map(aciRgb)).toEqual([0x333333, 0x5b5b5b, 0x848484, 0xadadad, 0xd6d6d6, 0xffffff])
  })

  it('walks the hue wheel in 15° steps from 10 to 249, with darker and paler variants', () => {
    expect(aciRgb(10)).toBe(0xff0000)
    expect(aciRgb(11)).toBe(0xff7f7f)
    expect(aciRgb(12)).toBe(0xcc0000)
    expect(aciRgb(19)).toBe(0x4c2626)
    expect(aciRgb(20)).toBe(0xff3f00)
    expect(aciRgb(21)).toBe(0xff9f7f)
    expect(aciRgb(50)).toBe(0xffff00)
    expect(aciRgb(90)).toBe(0x00ff00)
    expect(aciRgb(130)).toBe(0x00ffff)
    expect(aciRgb(170)).toBe(0x0000ff)
    expect(aciRgb(210)).toBe(0xff00ff)
    expect(aciRgb(240)).toBe(0xff003f)
  })

  it('rejects indices outside 1..255', () => {
    for (const i of [0, 256, -1, 1.5, NaN]) expect(() => aciRgb(i)).toThrow(RangeError)
  })
})

describe('colors', () => {
  it('true colors carry their RGB, ACI resolves through the table', () => {
    const c = trueColor(0x12, 0x34, 0x56)
    expect(c).toBe(TRUE_COLOR | 0x123456)
    expect(colorRgb(c)).toBe(0x123456)
    expect(colorRgb(1)).toBe(0xff0000)
  })

  it('isColor accepts ACI 1..255 and tagged true colors only', () => {
    for (const c of [1, 7, 255, TRUE_COLOR, TRUE_COLOR | 0xffffff]) expect(isColor(c)).toBe(true)
    for (const c of [0, 256, 0xffffff, TRUE_COLOR * 2, -1, 1.5]) expect(isColor(c)).toBe(false)
  })
})
