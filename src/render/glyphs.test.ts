import { describe, expect, it } from 'vitest'
import { createGlyphAtlas, distanceSquared, sdf, type Raster } from './glyphs'

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

describe('sdf', () => {
  it('puts the edge inside a partly covered pixel by its coverage, not on a pixel boundary', () => {
    // One row: empty, a quarter, half and three quarters covered, then ink.
    const r: Raster = { width: 5, height: 1, alpha: Uint8Array.from([0, 64, 128, 191, 255]), left: 0, baseline: 1 }
    const spread = 4
    const out = sdf(r, spread)
    const at = (x: number): number => out.data[spread * out.width + spread + x]!
    const expected = (inside: number): number => 128 + (inside / spread) * 127
    expect(at(2)).toBeCloseTo(expected(0.5 - 0.5), -0.5)
    expect(at(1)).toBeCloseTo(expected(0.25 - 0.5), -0.5)
    expect(at(3)).toBeCloseTo(expected(0.75 - 0.5), -0.5)
    expect(at(1)).toBeLessThan(at(2))
    expect(at(3)).toBeGreaterThan(at(2))
  })
})

describe('sdf supersampled', () => {
  it('averages the finer distances down, keeping the edge where it is', () => {
    // An ink block 4 raster px wide and 8 tall; two raster px to an atlas px, so its right edge falls between atlas
    // px 3 and 4 of the middle row.
    const alpha = new Uint8Array(64)
    for (let y = 0; y < 8; y++) for (let x = 0; x < 4; x++) alpha[y * 8 + x] = 255
    const out = sdf({ width: 8, height: 8, alpha, left: 0, baseline: 8 }, 2, 2)
    expect([out.width, out.height]).toEqual([(8 + 8) / 2, (8 + 8) / 2])
    const row = 4 * out.width
    expect(out.data[row + 3]! + out.data[row + 4]!).toBe(256)
    expect(out.data[row + 3]).toBeGreaterThan(160)
  })
})

describe('createGlyphAtlas', () => {
  it('draws a glyph once, gives it an index, and reports its bounds and place in the atlas', () => {
    const drawn: number[] = []
    const atlas = createGlyphAtlas({ raster: (cp) => (drawn.push(cp), box(10, 20)), capPx: 20, spread: 4, width: 64 })
    const a = atlas.index(65)
    const b = atlas.index(66)
    expect([a, b, atlas.index(65)]).toEqual([0, 1, 0])
    // Drawn later, by work: till then the table has the glyphs with no size.
    expect(drawn).toEqual([])
    expect(atlas.pending).toBe(true)
    expect(Array.from(atlas.take()!.table)).toEqual(new Array(16).fill(0))
    atlas.work(() => true)
    expect(drawn).toEqual([65, 66])
    expect(atlas.pending).toBe(false)
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

  it('with supersampling, takes raster px as finer and keeps the bounds in capital heights', () => {
    // box(20, 40) at 2 raster px to an atlas px is box(10, 20) at 1, its 2 px margin being 1.
    const atlas = createGlyphAtlas({ raster: () => box(20, 40), capPx: 20, spread: 4, supersample: 2, width: 64 })
    atlas.index(65)
    atlas.work(() => true)
    const up = atlas.take()!
    const [l, b, r, t, u0, v0, u1, v1] = up.table
    expect(l).toBeCloseTo(-(1 + 4) / 20, 6)
    expect(t).toBeCloseTo((20 + 1 + 4) / 20, 6)
    expect(b).toBeCloseTo(-(1 + 4) / 20, 6)
    expect(r).toBeCloseTo((10 + 1 + 4) / 20, 6)
    expect([(u1! - u0!) * up.width, (v0! - v1!) * up.height]).toEqual([10 + 2 + 8, 20 + 2 + 8])
  })

  it('work draws at least one glyph, then goes on while told to', () => {
    const atlas = createGlyphAtlas({ raster: () => box(4, 4), capPx: 4, spread: 2, width: 64 })
    for (let cp = 0; cp < 5; cp++) atlas.index(cp)
    atlas.work(() => false)
    let left = 2
    atlas.work(() => left-- > 0)
    // One, then three more (one, and two "more"s); one waits.
    expect(atlas.take()!.table.filter((v, i) => i % 8 === 2 && v > 0)).toHaveLength(4)
    expect(atlas.pending).toBe(true)
  })

  it('grows the atlas when a row is full, keeping the glyphs it has', () => {
    const atlas = createGlyphAtlas({ raster: () => box(30, 30), capPx: 30, spread: 4, width: 64 })
    for (let cp = 0; cp < 12; cp++) atlas.index(cp)
    atlas.work(() => true)
    const up = atlas.take()!
    expect(up.height).toBeGreaterThanOrEqual(64 * 3)
    expect(up.table.length).toBe(12 * 8)
    // The first glyph, placed while the atlas was 64 px high, still points at its own cell.
    expect(up.table[7]).toBe(0)
    expect(up.table[5]).toBeCloseTo((30 + 4 + 8) / up.height, 9)
  })
})
