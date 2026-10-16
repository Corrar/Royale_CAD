import { describe, expect, it } from 'vitest'
import { fontLoader } from './glyph-raster'

describe('fontLoader', () => {
  it('loads the faces of characters not asked before, once, and waits for those still loading', async () => {
    const asked: string[] = []
    const settle: Array<() => void> = []
    const ready = fontLoader((text) => (asked.push(text), new Promise<void>((r) => settle.push(r))))
    const first = ready([0x141, 0x416])
    expect(asked).toEqual(['ŁЖ'])
    expect(first).not.toBeNull()
    // Ж is still loading: drawing it now would draw a fallback font.
    const again = ready([0x416, 0x3a3])
    expect(asked).toEqual(['ŁЖ', 'Σ'])
    let done = false
    void again!.then(() => (done = true))
    settle[1]!()
    await Promise.resolve()
    await Promise.resolve()
    expect(done).toBe(false)
    settle[0]!()
    await again
    // All loaded: nothing to wait for.
    expect(ready([0x141, 0x416, 0x3a3])).toBeNull()
  })

  it('a failed load does not hold glyphs back for ever', async () => {
    const ready = fontLoader(() => Promise.reject(new Error('no font')))
    await expect(ready([0x41])).resolves.toBeUndefined()
    expect(ready([0x41])).toBeNull()
  })
})
