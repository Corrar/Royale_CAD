import { CAP_PER_EM } from '../kernel/text/font'
import type { Raster } from '../render/glyphs'

/** The family text is drawn in: the bundled Inter (@fontsource-variable/inter), the font kernel/text measured. */
export const TEXT_FAMILY = "'Inter Variable'"

/** Capital height glyphs are drawn at in the atlas, px, and how far their distance fields reach. */
export const GLYPH_CAP_PX = 48
export const GLYPH_SPREAD_PX = 6

/** The CSS font for a capital height of capPx. */
export const textFont = (capPx: number): string => `${capPx / CAP_PER_EM}px ${TEXT_FAMILY}`

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
