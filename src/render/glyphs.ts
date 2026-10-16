/**
 * A glyph atlas of signed distance fields, so text stays sharp at any size: each character is drawn once (by a
 * Raster the app gives, a canvas in the browser), turned into distances to its edge and packed into a texture.
 */

/** One character drawn in coverage (0–255) on a cell, its baseline-left at (left, baseline) px in the cell. */
export interface Raster { width: number; height: number; alpha: Uint8Array; left: number; baseline: number }

export interface GlyphAtlasOptions {
  /** Draws a character large: its capital height in px is capPx·supersample. */
  raster(cp: number): Raster
  capPx: number
  /**
   * The raster's px per atlas px (1 by default): distances are worked out on the finer raster and averaged down,
   * so curved edges stay smooth when a glyph is drawn far larger than in the atlas.
   */
  supersample?: number
  /** How far from the edge, in px, the distances reach before they saturate. */
  spread: number
  /** Atlas width in px; the height grows by doubling. */
  width?: number
}

/** What to upload: the atlas (one byte per px, 0.5·255 on the edges) and 8 floats per glyph (bounds, uv). */
export interface GlyphUpload { width: number; height: number; data: Uint8Array; table: Float32Array }

export interface GlyphAtlas {
  /** The glyph index of code point cp. A new one is drawn by work(): till then it has no size and shows nothing. */
  index(cp: number): number
  /** What changed since the last take, or null. */
  take(): GlyphUpload | null
}

/** The atlas as its owner sees it: drawing a glyph takes milliseconds, so it happens between frames. */
export interface GlyphWorks extends GlyphAtlas {
  /** Glyphs wait to be drawn. */
  readonly pending: boolean
  /** Draws waiting glyphs, at least one, while more() says so. */
  work(more: () => boolean): void
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

/**
 * A raster's signed distance field, the cell grown by spread atlas px on each side, as bytes: 128 on the edge.
 * Worked out on the raster's px, ss of them to an atlas px, then averaged down; the raster is padded on the right and
 * at the bottom to whole atlas px. A partly covered pixel holds the edge at its coverage (half covered: on its
 * centre), so edges keep their antialiasing's sub-pixel place instead of stepping from pixel to pixel.
 */
export function sdf(r: Raster, spread: number, ss = 1): { width: number; height: number; data: Uint8Array } {
  const pad = spread * ss
  const W = Math.ceil((r.width + 2 * pad) / ss) * ss
  const H = Math.ceil((r.height + 2 * pad) / ss) * ss
  const outside = new Float64Array(W * H).fill(FAR)
  const inside = new Float64Array(W * H).fill(0)
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      const a = r.alpha[y * r.width + x]! / 255
      if (a === 0) continue
      const i = (y + pad) * W + x + pad
      if (a === 1) {
        outside[i] = 0
        inside[i] = FAR
      } else {
        // The edge lies 0.5 − a from the centre, outwards when positive.
        const d = 0.5 - a
        outside[i] = d > 0 ? d * d : 0
        inside[i] = d < 0 ? d * d : 0
      }
    }
  }
  distanceSquared(outside, W, H)
  distanceSquared(inside, W, H)
  const width = W / ss
  const height = H / ss
  const data = new Uint8Array(width * height)
  // Positive inside, in atlas px: the mean over the ss × ss raster px of each atlas px.
  const k = 1 / (ss * ss * ss * spread)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0
      for (let dy = 0; dy < ss; dy++) {
        for (let dx = 0; dx < ss; dx++) {
          const i = (y * ss + dy) * W + x * ss + dx
          sum += Math.sqrt(inside[i]!) - Math.sqrt(outside[i]!)
        }
      }
      data[y * width + x] = Math.max(0, Math.min(255, Math.round(128 + sum * k * 127)))
    }
  }
  return { width, height, data }
}

export function createGlyphAtlas(o: GlyphAtlasOptions): GlyphWorks {
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
  // Indexes given and not drawn yet, oldest first.
  const queue: number[] = []
  const cps: number[] = []

  function grow(atLeast: number): void {
    let h = Math.max(height, width)
    while (h < atLeast) h *= 2
    if (h === height) return
    const next = new Uint8Array(width * h)
    next.set(data)
    data = next
    height = h
  }

  function draw(index: number): void {
    const r = o.raster(cps[index]!)
    const ss = o.supersample ?? 1
    const cell = sdf(r, o.spread, ss)
    if (x + cell.width > width) {
      rowY += rowH
      rowH = 0
      x = 0
    }
    grow(rowY + cell.height)
    for (let y = 0; y < cell.height; y++) data.set(cell.data.subarray(y * cell.width, (y + 1) * cell.width), (rowY + y) * width + x)
    // The cell's edges from the baseline-left, in capital heights (raster px first); up is up (rows grow downwards).
    const s = o.spread * ss
    const k = 1 / (o.capPx * ss)
    glyphs.splice(
      8 * index, 8,
      -(r.left + s) * k, -(cell.height * ss - r.baseline - s) * k, (cell.width * ss - r.left - s) * k, (r.baseline + s) * k,
      x, rowY + cell.height, x + cell.width, rowY,
    )
    x += cell.width
    rowH = Math.max(rowH, cell.height)
    changed = true
  }

  return {
    index(cp) {
      const known = indexOf.get(cp)
      if (known !== undefined) return known
      const index = cps.length
      indexOf.set(cp, index)
      cps.push(cp)
      // No size till drawn: its quads collapse to a point.
      glyphs.push(0, 0, 0, 0, 0, 0, 0, 0)
      queue.push(index)
      // The table must reach every index instances may hold.
      changed = true
      return index
    },
    get pending() {
      return queue.length > 0
    },
    work(more) {
      do {
        const next = queue.shift()
        if (next === undefined) return
        draw(next)
      } while (more())
    },
    take() {
      if (!changed) return null
      changed = false
      // Glyphs given and none drawn yet: an empty atlas still has a size.
      grow(1)
      // Cells to uv for the atlas as it is now: it may have grown since a glyph was placed.
      const table = Float32Array.from(glyphs, (v, i) => (i % 8 < 4 ? v : i % 2 === 0 ? v / width : v / height))
      return { width, height, data, table }
    },
  }
}
