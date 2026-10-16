import { describe, expect, it } from 'vitest'
import { advanceOf, CAP_PER_EM } from './font'

const of = (ch: string): number => advanceOf(ch.codePointAt(0)!)

describe('advanceOf', () => {
  it('Greek, Cyrillic and punctuation advance as the bundled Inter draws them (measured on a canvas)', () => {
    // Ж is far wider than an average letter: laid out narrower, it ran into the next one.
    expect([of('Ж'), of('И'), of('ж'), of('Њ')]).toEqual([1.3072, 1.0259, 1.1031, 1.5319])
    expect([of('Δ'), of('Μ'), of('Ω'), of('π')]).toEqual([0.9275, 1.2301, 1.0485, 0.8238])
    expect([of('–'), of('—'), of('“'), of('•'), of('…'), of('€'), of('№')]).toEqual([0.6809, 1.3617, 0.5997, 0.766, 1.1769, 0.9076, 1.4874])
    expect(of('ệ')).toBe(of('e')) // Vietnamese
    expect([of('H'), of('Œ')]).toEqual([1.012, 1.3684])
  })

  it('what Inter lacks: East Asian wide characters one em, as the system font draws them; combining marks none', () => {
    for (const ch of ['中', '文', 'あ', 'カ', '한', 'Ａ', '　']) expect(of(ch)).toBe(1 / CAP_PER_EM)
    expect(of('̂')).toBe(0)
    expect(of('ﾊ')).toBeLessThan(1) // half-width katakana is not wide
  })
})
