import { CAP_PER_EM } from '../kernel/text/font'
import type { Raster } from '../render/glyphs'

/** The family text is drawn in: the bundled Inter (@fontsource-variable/inter), the font kernel/text measured. */
export const TEXT_FAMILY = "'Inter Variable'"

/** Capital height glyphs are drawn at in the atlas, px, and how far their distance fields reach. */
export const GLYPH_CAP_PX = 48
export const GLYPH_SPREAD_PX = 6
/** Raster px per atlas px: the distances come from a finer drawing, so curves stay smooth at any zoom. */
export const GLYPH_SUPERSAMPLE = 4

/** The CSS font for a capital height of capPx. */
export const textFont = (capPx: number): string => `${capPx / CAP_PER_EM}px ${TEXT_FAMILY}`

/**
 * Loads the font faces characters need before their glyphs are drawn: the bundled Inter comes in subsets by
 * unicode-range, and one drawn before its subset loaded is drawn in a fallback font, kept in the atlas for the
 * session. Gives null when every character asked has loaded (or failed to), else what settles once they have.
 */
export function fontLoader(load: (text: string) => Promise<unknown>): (cps: Iterable<number>) => Promise<void> | null {
  const loading = new Map<number, Promise<void>>()
  const done = new Set<number>()
  return (cps) => {
    let text = ''
    const wait = new Set<Promise<void>>()
    for (const cp of cps) {
      if (done.has(cp)) continue
      const p = loading.get(cp)
      if (p) wait.add(p)
      else if (!text.includes(String.fromCodePoint(cp))) text += String.fromCodePoint(cp)
    }
    if (text !== '') {
      const asked = [...text].map((c) => c.codePointAt(0)!)
      // A failed load settles too: the glyph is drawn in whatever font there is rather than never.
      const p = load(text).catch(() => undefined).then(() => {
        for (const cp of asked) {
          loading.delete(cp)
          done.add(cp)
        }
      })
      for (const cp of asked) loading.set(cp, p)
      wait.add(p)
    }
    return wait.size === 0 ? null : Promise.all(wait).then(() => undefined)
  }
}

/**
 * Draws one character at a time on a 2D canvas, cropped to its ink plus a pixel: what the glyph atlas turns into
 * distance fields. A character with no ink (a space) gives a 1×1 empty cell.
 */
export function canvasRaster(capPx: number, make: () => HTMLCanvasElement | OffscreenCanvas = () => document.createElement('canvas')): (cp: number) => Raster {
  const canvas = make()
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
  if (!ctx) throw new Error('the glyph canvas has no 2D context')
  const font = textFont(capPx)
  return (cp) => {
    const ch = String.fromCodePoint(cp)
    ctx.font = font
    const m = ctx.measureText(ch)
    const left = Math.ceil(m.actualBoundingBoxLeft) + 1
    const right = Math.ceil(m.actualBoundingBoxRight) + 1
    const ascent = Math.ceil(m.actualBoundingBoxAscent) + 1
    const descent = Math.ceil(m.actualBoundingBoxDescent) + 1
    const width = Math.max(1, left + right)
    const height = Math.max(1, ascent + descent)
    if (!(left + right > 2 && ascent + descent > 2)) return { width: 1, height: 1, alpha: new Uint8Array(1), left: 0, baseline: 0 }
    canvas.width = width
    canvas.height = height
    // Resizing resets the context's state.
    ctx.font = font
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = '#fff'
    ctx.clearRect(0, 0, width, height)
    ctx.fillText(ch, left, ascent)
    const rgba = ctx.getImageData(0, 0, width, height).data
    const alpha = new Uint8Array(width * height)
    for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3]!
    return { width, height, alpha, left, baseline: ascent }
  }
}
