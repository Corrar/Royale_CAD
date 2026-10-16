import { unitDeg } from '../geom/vec'

/** What one line typed at the command line means, before any prompt gives it context. */
export type Token =
  | { kind: 'point'; mode: 'abs' | 'rel'; x: number; y: number }
  | { kind: 'number'; value: number }
  | { kind: 'word'; text: string }
  | { kind: 'empty' }
  | { kind: 'invalid'; text: string }

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/
// At least one letter: "3P" is a keyword, "-LAYER" the command-line form of a command.
const WORD = /^-?[A-Za-z0-9_]*[A-Za-z][A-Za-z0-9_]*$/

function number(s: string): number | undefined {
  const t = s.trim()
  if (!NUMBER.test(t)) return undefined
  const v = Number(t)
  return Number.isFinite(v) ? v : undefined
}

/** "x,y" or "d<a" (degrees, counter-clockwise) as a vector. */
function vector(s: string): [number, number] | undefined {
  const comma = s.split(',')
  const polar = s.split('<')
  if (comma.length === 2 && polar.length === 1) {
    const x = number(comma[0]!)
    const y = number(comma[1]!)
    return x === undefined || y === undefined ? undefined : [x, y]
  }
  if (polar.length === 2 && comma.length === 1) {
    const d = number(polar[0]!)
    const a = number(polar[1]!)
    if (d === undefined || a === undefined) return undefined
    const [c, n] = unitDeg(a)
    return [d * c, d * n]
  }
  return undefined
}

/**
 * `x,y` absolute · `@dx,dy` relative to the last point · `d<a` / `@d<a` polar in degrees · a number (a distance,
 * a radius, …) · a word (command, alias or keyword) · empty (Enter). Decimal separator: '.'.
 */
export function parseInput(text: string): Token {
  const t = text.trim()
  if (t === '') return { kind: 'empty' }
  const rel = t.startsWith('@')
  const v = vector(rel ? t.slice(1) : t)
  if (v) return { kind: 'point', mode: rel ? 'rel' : 'abs', x: v[0], y: v[1] }
  if (!rel) {
    // Shaped like a number: a number, or invalid when it overflows; never a word.
    if (NUMBER.test(t)) {
      const n = number(t)
      if (n !== undefined) return { kind: 'number', value: n }
    } else if (WORD.test(t)) return { kind: 'word', text: t }
  }
  return { kind: 'invalid', text }
}
