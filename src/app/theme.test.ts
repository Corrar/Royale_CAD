import { describe, expect, it } from 'vitest'
import { packRgba, parseCssColor } from './theme'

describe('parseCssColor', () => {
  it('reads the two forms canvas 2D normalizes to', () => {
    expect(parseCssColor('#f2f4f5')).toEqual([0xf2 / 255, 0xf4 / 255, 0xf5 / 255, 1])
    expect(parseCssColor('rgba(103, 232, 249, 0.1)')).toEqual([103 / 255, 232 / 255, 249 / 255, 0.1])
    expect(parseCssColor('rgb(0, 0, 255)')).toEqual([0, 0, 1, 1])
  })

  it('rejects anything else', () => {
    for (const s of ['', '#fff', 'red', 'rgba(1, 2)', 'rgba(1, 2, x)', 'rgba(1, 2, 3, 4, 5)', 'hsl(0, 0%, 0%)']) {
      expect(parseCssColor(s)).toBeUndefined()
    }
  })
})

describe('packRgba', () => {
  it('packs 0..1 channels as 0xRRGGBBAA, clamped', () => {
    expect(packRgba([0xf2 / 255, 0xf4 / 255, 0xf5 / 255, 1])).toBe(0xf2f4f5ff)
    expect(packRgba([1, 0, 0, 0.5])).toBe(0xff000080)
    expect(packRgba([2, -1, 0, 1])).toBe(0xff0000ff)
  })
})
