import { describe, expect, it } from 'vitest'
import { createGlyphAtlas, distanceSquared, type Raster } from './glyphs'

describe('distanceSquared', () => {
  it('gives each cell its squared distance to the nearest zero cell', () => {
    // A 5×3 grid with one zero in the middle.
    const INF = 1e20
    const g = new Float64Array(15).fill(INF)
    g[7] = 0
    distanceSquared(g, 5, 3)
    expect([...g]).toEqual([5, 2, 1, 2, 5, 4, 1, 0, 1, 4, 5, 2, 1, 2, 5])
  })
})

/** A glyph drawn as a filled rectangle of w × h px, its baseline-left at (left, top) inside the cell. */
const box = (w: number, h: number): Raster => {
  const pad = 2
  const width = w + 2 * pad
  const height = h + 2 * pad
  const alpha = new Uint8Array(width * height)
  for (let y = pad; y < pad + h; y++) for (let x = pad; x < pad + w; x++) alpha[y * width + x] = 255
  return { width, height, alpha, left: pad, baseline: pad + h }
}

describe('createGlyphAtlas', () => {
  it('draws a glyph once, gives it an index, and reports its bounds and place in the atlas', () => {
    const drawn: number[] = []
    const atlas = createGlyphAtlas({ raster: (cp) => (drawn.push(cp), box(10, 20)), capPx: 20, spread: 4, width: 64 })
    const a = atlas.index(65)
    const b = atlas.index(66)
    expect([a, b, atlas.index(65)]).toEqual([0, 1, 0])
    expect(drawn).toEqual([65, 66])
    const up = atlas.take()!
    expect(atlas.take()).toBeNull()
    // Bounds in capital heights from the glyph's baseline-left, the spread included: (−0.3, −0.3)–(0.8, 1.3)…
    const [l, bottom, r, t] = up.table.subarray(0, 4)
    expect(l).toBeCloseTo(-(2 + 4) / 20, 6)
    expect(r).toBeCloseTo((10 + 2 + 4) / 20, 6)
    expect(t).toBeCloseTo((20 + 2 + 4) / 20, 6)
    expect(bottom).toBeCloseTo(-(2 + 4) / 20, 6)
    // The SDF: 0.5 on the edge, more inside, less outside.
    const [u0, v0, u1, v1] = up.table.subarray(4, 8)
    const px = (u: number, v: number): number => up.data[Math.floor(v * up.height) * up.width + Math.floor(u * up.width)]!
    expect(px((u0! + u1!) / 2, (v0! + v1!) / 2)).toBeGreaterThan(200)
    expect(px(u0! + 0.5 / up.width, v1! + 0.5 / up.height)).toBeLessThan(60)
  })

  it('grows the atlas when a row is full, keeping the glyphs it has', () => {
    const atlas = createGlyphAtlas({ raster: () => box(30, 30), capPx: 30, spread: 4, width: 64 })
    for (let cp = 0; cp < 12; cp++) atlas.index(cp)
    const up = atlas.take()!
    expect(up.height).toBeGreaterThanOrEqual(64 * 3)
    expect(up.table.length).toBe(12 * 8)
    // The first glyph, placed while the atlas was 64 px high, still points at its own cell.
    expect(up.table[7]).toBe(0)
    expect(up.table[5]).toBeCloseTo((30 + 4 + 8) / up.height, 9)
  })
})
