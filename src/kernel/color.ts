/**
 * ACI index 1..255, or TRUE_COLOR | 0xRRGGBB. ACI 7 is the one color that follows the background:
 * the renderer draws it with the theme's drawing color.
 */
export type Color = number

export const TRUE_COLOR = 0x1000000
export const ACI_DEFAULT = 7

export const trueColor = (r: number, g: number, b: number): Color => TRUE_COLOR | ((r & 255) << 16) | ((g & 255) << 8) | (b & 255)

export const isColor = (c: number): boolean =>
  Number.isInteger(c) && ((c >= 1 && c <= 255) || (c >= TRUE_COLOR && c <= (TRUE_COLOR | 0xffffff)))

const FIXED = [0, 0xff0000, 0xffff00, 0x00ff00, 0x00ffff, 0x0000ff, 0xff00ff, 0xffffff, 0x808080, 0xc0c0c0]
const GRAYS = [0x333333, 0x5b5b5b, 0x848484, 0xadadad, 0xd6d6d6, 0xffffff]
const LEVELS = [255, 204, 153, 127, 76]

/**
 * 0xRRGGBB of an ACI index. 10..249 walk the hue wheel in 15° steps; within each group of ten the value
 * steps down every two indices and the odd index is the half-saturated variant. T31 checks the table against the
 * LibreCAD and ODA oracles.
 */
export function aciRgb(index: number): number {
  if (!Number.isInteger(index) || index < 1 || index > 255) throw new RangeError(`ACI index ${index} is not in 1..255`)
  if (index < 10) return FIXED[index]!
  if (index >= 250) return GRAYS[index - 250]!
  const hue = Math.floor((index - 10) / 10) * 15
  const max = LEVELS[(index % 10) >> 1]!
  const min = index % 2 === 1 ? max / 2 : 0
  const sector = Math.floor(hue / 60)
  const f = hue / 60 - sector
  const rise = min + (max - min) * f
  const fall = min + (max - min) * (1 - f)
  const rgb = [
    [max, rise, min],
    [fall, max, min],
    [min, max, rise],
    [min, fall, max],
    [rise, min, max],
    [max, min, fall],
  ][sector]!
  return (Math.floor(rgb[0]!) << 16) | (Math.floor(rgb[1]!) << 8) | Math.floor(rgb[2]!)
}

/** 0xRRGGBB of any color; ACI 7 gives white, the renderer substitutes the theme's drawing color. */
export const colorRgb = (c: Color): number => (c >= TRUE_COLOR ? c & 0xffffff : aciRgb(c))
