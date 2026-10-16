import type { BackendTheme, Rgba } from '../render/backend'

/** Parses the two forms canvas 2D fillStyle reads back as: '#rrggbb' and 'rgb(a)(r, g, b[, a])'. */
export function parseCssColor(s: string): Rgba | undefined {
  if (/^#[0-9a-f]{6}$/i.test(s)) {
    const n = parseInt(s.slice(1), 16)
    return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1]
  }
  const parts = /^rgba?\(([^)]+)\)$/.exec(s)?.[1]?.split(',').map(Number)
  if (!parts || parts.length < 3 || parts.length > 4 || parts.some(Number.isNaN)) return undefined
  return [parts[0]! / 255, parts[1]! / 255, parts[2]! / 255, parts[3] ?? 1]
}

/** 0..1 channels to 0xRRGGBBAA, the color word of the style table. */
export function packRgba(c: Rgba): number {
  const byte = (x: number): number => Math.round(Math.min(1, Math.max(0, x)) * 255)
  return ((byte(c[0]) << 24) | (byte(c[1]) << 16) | (byte(c[2]) << 8) | byte(c[3])) >>> 0
}

/** Resolves any CSS color held by a custom property (alpha included) to 0..1 RGBA. */
export function readCssColor(el: Element, name: string): Rgba {
  const value = getComputedStyle(el).getPropertyValue(name).trim()
  const ctx = document.createElement('canvas').getContext('2d')
  if (!value || !ctx) throw new Error(`cannot resolve CSS color ${name}`)
  // An unparsable value leaves fillStyle untouched, so two different sentinels read back differently.
  ctx.fillStyle = '#010203'
  ctx.fillStyle = value
  const s = ctx.fillStyle
  ctx.fillStyle = '#040506'
  ctx.fillStyle = value
  const rgba = ctx.fillStyle === s ? parseCssColor(s) : undefined
  if (!rgba) throw new Error(`cannot resolve CSS color ${name}: ${value}`)
  return rgba
}

export function readBackendTheme(el: Element): BackendTheme {
  return { bg: readCssColor(el, '--bg'), gridMinor: readCssColor(el, '--grid-minor'), gridMajor: readCssColor(el, '--grid-major') }
}
