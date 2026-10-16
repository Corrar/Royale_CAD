/**
 * A glyph atlas of signed distance fields, so text stays sharp at any size: each character is drawn once (by a
 * Raster the app gives, a canvas in the browser), turned into distances to its edge and packed into a texture.
 */

/** One character drawn in coverage (0–255) on a cell, its baseline-left at (left, baseline) px in the cell. */
export interface Raster { width: number; height: number; alpha: Uint8Array; left: number; baseline: number }

export interface GlyphAtlasOptions {
  /** Draws a character large: capPx is its capital height in px. */
  raster(cp: number): Raster
  capPx: number
  /** How far from the edge, in px, the distances reach before they saturate. */
  spread: number
  /** Atlas width in px; the height grows by doubling. */
  width?: number
}

/** What to upload: the atlas (one byte per px, 0.5·255 on the edges) and 8 floats per glyph (bounds, uv). */
export interface GlyphUpload { width: number; height: number; data: Uint8Array; table: Float32Array }

export interface GlyphAtlas {
  /** The glyph index of code point cp, drawn into the atlas the first time. */
  index(cp: number): number
  /** What changed since the last take, or null. */
  take(): GlyphUpload | null
}

/**
 * Squared distance transform (Felzenszwalb & Huttenlocher, 2012): each cell of g (0 where the feature is, a big
 * number elsewhere) becomes its squared distance to the nearest feature cell, by a 1D pass on rows then columns.
 */
export function distanceSquared(g: Float64Array, w: number, h: number): void {
  const n = Math.max(w, h)
  const f = new Float64Array(n)
  const d = new Float64Array(n)
  const v = new Int32Array(n)
  const z = new Float64Array(n + 1)
  const pass = (start: number, step: number, len: number): void => {
    for (let q = 0; q < len; q++) f[q] = g[start + q * step]!
    // The lower envelope of the parabolas rooted at each cell.
    let k = 0
    v[0] = 0
    z[0] = -Infinity
    z[1] = Infinity
    for (let q = 1; q < len; q++) {
      let s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!)
      while (s <= z[k]!) {
        k--
        s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!)
      }
      k++
      v[k] = q
      z[k] = s
      z[k + 1] = Infinity
    }
    k = 0
    for (let q = 0; q < len; q++) {
      while (z[k + 1]! < q) k++
      d[q] = (q - v[k]!) * (q - v[k]!) + f[v[k]!]!
    }
    for (let q = 0; q < len; q++) g[start + q * step] = d[q]!
  }
  for (let y = 0; y < h; y++) pass(y * w, 1, w)
  for (let x = 0; x < w; x++) pass(x, w, h)
}

const FAR = 1e20

/** A raster's signed distance field, the cell grown by spread on each side, as bytes: 128 on the edge. */
function sdf(r: Raster, spread: number): { width: number; height: number; data: Uint8Array } {
  const width = r.width + 2 * spread
  const height = r.height + 2 * spread
  const outside = new Float64Array(width * height).fill(FAR)
  const inside = new Float64Array(width * height).fill(0)
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      if (r.alpha[y * r.width + x]! >= 128) {
        const i = (y + spread) * width + x + spread
        outside[i] = 0
        inside[i] = FAR
      }
    }
  }
  distanceSquared(outside, width, height)
  distanceSquared(inside, width, height)
  const data = new Uint8Array(width * height)
  for (let i = 0; i < data.length; i++) {
    // Positive inside: half a cell either way puts the edge between the cells.
    const signed = Math.sqrt(inside[i]!) - Math.sqrt(outside[i]!)
    data[i] = Math.max(0, Math.min(255, Math.round(128 + (signed / spread) * 127)))
  }
  return { width, height, data }
}

export function createGlyphAtlas(o: GlyphAtlasOptions): GlyphAtlas {
  const width = o.width ?? 1024
  let height = 0
  let data = new Uint8Array(0)
  const indexOf = new Map<number, number>()
  // 8 numbers a glyph: bounds l b r t (capital heights), then its cell in px: left, bottom row, right, top row.
  const glyphs: number[] = []
  // Shelf packing: rows of glyph cells, left to right.
  let rowY = 0
  let rowH = 0
  let x = 0
  let changed = false

  function grow(atLeast: number): void {
    let h = Math.max(height, width)
    while (h < atLeast) h *= 2
    if (h === height) return
    const next = new Uint8Array(width * h)
    next.set(data)
    data = next
    height = h
  }

  return {
    index(cp) {
      const known = indexOf.get(cp)
      if (known !== undefined) return known
      const r = o.raster(cp)
      const cell = sdf(r, o.spread)
      if (x + cell.width > width) {
        rowY += rowH
        rowH = 0
        x = 0
      }
      grow(rowY + cell.height)
      for (let y = 0; y < cell.height; y++) data.set(cell.data.subarray(y * cell.width, (y + 1) * cell.width), (rowY + y) * width + x)
      const s = o.spread
      const k = 1 / o.capPx
      // The cell's edges from the baseline-left, in capital heights; up is up (rows grow downwards).
      glyphs.push(
        -(r.left + s) * k, -(r.height - r.baseline + s) * k, (cell.width - r.left - s) * k, (r.baseline + s) * k,
        x, rowY + cell.height, x + cell.width, rowY,
      )
      x += cell.width
      rowH = Math.max(rowH, cell.height)
      const index = indexOf.size
      indexOf.set(cp, index)
      changed = true
      return index
    },
    take() {
      if (!changed) return null
      changed = false
      // Cells to uv for the atlas as it is now: it may have grown since a glyph was placed.
      const table = Float32Array.from(glyphs, (v, i) => (i % 8 < 4 ? v : i % 2 === 0 ? v / width : v / height))
      return { width, height, data, table }
    },
  }
}
