import type { MText, Text } from '../entity/types'
import { normAngle } from '../geom/tol'
import { applyAffine, type Affine, type Vec2 } from '../geom/vec'
import { decodeText, mtextParagraphs } from './codes'
import { advanceOf, DESCENT } from './font'

/** Where text sits: world = origin + x·u + y·v for (x, y) in capital heights; u along the baseline, v up. */
export interface TextFrame { ox: number; oy: number; ux: number; uy: number; vx: number; vy: number }

/** Text laid out: its frame, its characters (baseline starts, in capital heights), and the box they fill. */
export interface Laid {
  frame: TextFrame
  glyphs: { cp: number; x: number; y: number }[]
  box: { x0: number; y0: number; x1: number; y1: number }
}

export type TextProps = Omit<Text, 'type' | 'id' | 'layer' | 'color'>
export type MTextProps = Omit<MText, 'type' | 'id' | 'layer' | 'color'>

export const atFrame = (f: TextFrame, x: number, y: number): Vec2 => ({ x: f.ox + x * f.ux + y * f.vx, y: f.oy + x * f.uy + y * f.vy })

/** Tab stops, in heights: MTEXT's default, every 4 from where the line starts (\p tab stops are not read). */
const TAB = 4

/** The advance of cp at x from where its line starts: a tab goes on to the next stop, other controls take none. */
const advanceAt = (cp: number, x: number): number => (cp === 9 ? (Math.floor(x / TAB) + 1) * TAB - x : cp < 32 ? 0 : advanceOf(cp))

/** The width of s in capital heights. */
export function widthOf(s: string): number {
  let w = 0
  for (const ch of s) w += advanceAt(ch.codePointAt(0)!, w)
  return w
}

/** The characters of s from (x, y) on: a space or a control character only advances. */
function place(s: string, x: number, y: number, out: Laid['glyphs']): void {
  let at = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0)!
    if (cp > 32 && cp !== 0xa0) out.push({ cp, x: x + at, y })
    at += advanceAt(cp, at)
  }
}

/** The frame that puts local point (ax, ay) at world (x, y), turned by rotation, one capital height being h. */
function frameAt(x: number, y: number, ax: number, ay: number, rotation: number, h: number, wf: number, slant: number): TextFrame {
  const c = Math.cos(rotation)
  const s = Math.sin(rotation)
  const t = Math.tan(slant)
  const ux = c * h * wf
  const uy = s * h * wf
  const vx = (-s + t * c) * h
  const vy = (c + t * s) * h
  return { ox: x - ax * ux - ay * vx, oy: y - ax * uy - ay * vy, ux, uy, vx, vy }
}

/** Horizontal place of the point along the text for halign 0–5, and vertical for valign 0–3, in its box. */
const H_AT = [0, 0.5, 1, 0, 0.5, 0]

/** A TEXT laid out: justified at its point, aligned or fit between its two, slanted, mirrored as flagged. */
export function layoutText(t: TextProps): Laid {
  const s = decodeText(t.value)
  const w = widthOf(s)
  const glyphs: Laid['glyphs'] = []
  place(s, 0, 0, glyphs)
  const box = { x0: 0, y0: -DESCENT, x1: w, y1: 1 }
  let frame: TextFrame
  // The local point mirroring pivots on.
  let ax: number
  let ay: number
  const span = Math.hypot(t.x2 - t.x, t.y2 - t.y)
  if ((t.halign === 3 || t.halign === 5) && w > 0 && span > 0) {
    // Aligned keeps the proportions and scales the height to the span; fit keeps the height and stretches.
    const rotation = Math.atan2(t.y2 - t.y, t.x2 - t.x)
    const h = t.halign === 3 ? span / (w * t.widthFactor) : t.height
    const wf = t.halign === 3 ? t.widthFactor : span / (w * t.height)
    frame = frameAt(t.x, t.y, 0, 0, rotation, h, wf, t.oblique)
    // Backward it stays between its points; upside down it hangs from its baseline.
    ax = w / 2
    ay = 0
  } else {
    ax = (H_AT[t.halign] ?? 0) * w
    ay = t.halign === 4 ? 0.5 : [0, -DESCENT, 0.5, 1][t.valign] ?? 0
    frame = frameAt(t.x, t.y, ax, ay, t.rotation, t.height, t.widthFactor, t.oblique)
  }
  // Mirrored about its justification point, which stays put: MIRROR with MIRRTEXT 1 writes these flags so.
  if (t.backward) frame = { ...frame, ox: frame.ox + 2 * ax * frame.ux, oy: frame.oy + 2 * ax * frame.uy, ux: -frame.ux, uy: -frame.uy }
  if (t.upsideDown) frame = { ...frame, ox: frame.ox + 2 * ay * frame.vx, oy: frame.oy + 2 * ay * frame.vy, vx: -frame.vx, vy: -frame.vy }
  return { frame, glyphs, box }
}

/** Paragraphs wrapped at maxWidth capital heights (Infinity: not at all), at spaces; a long word keeps its line. */
function wrap(paragraphs: readonly string[], maxWidth: number): string[] {
  if (maxWidth === Infinity) return [...paragraphs]
  const lines: string[] = []
  for (const p of paragraphs) {
    let line = ''
    for (const word of p.split(' ')) {
      const next = line === '' ? word : `${line} ${word}`
      if (line !== '' && widthOf(next) > maxWidth) {
        lines.push(line)
        line = word
      } else line = next
    }
    lines.push(line)
  }
  return lines
}

/** Between baselines, in heights, at spacing 1. */
const LINE_GAP = 5 / 3

/** An MTEXT's lines, each with its baseline start in its frame, and the box they fill. */
function mtextPlan(m: MTextProps): { frame: TextFrame; lines: { text: string; x: number; y: number }[]; box: Laid['box'] } {
  const texts = wrap(mtextParagraphs(m.value), m.width > 0 ? m.width / m.height : Infinity)
  const widths = texts.map(widthOf)
  const w = m.width > 0 ? m.width / m.height : Math.max(0, ...widths)
  const gap = LINE_GAP * m.spacing
  const toLast = 1 + (texts.length - 1) * gap
  const col = (m.attachment - 1) % 3
  const row = Math.floor((m.attachment - 1) / 3)
  const lines = texts.map((text, i) => ({ text, x: ((w - widths[i]!) * col) / 2, y: -1 - i * gap }))
  const frame = frameAt(m.x, m.y, (col * w) / 2, (-row * toLast) / 2, m.rotation, m.height, 1, 0)
  return { frame, lines, box: { x0: 0, y0: -toLast - DESCENT, x1: w, y1: 0 } }
}

/**
 * An MTEXT laid out: paragraphs wrapped to the width, the box put at its attachment point, each line aligned in
 * the box as the attachment's column says. The first baseline is one height below the top.
 */
export function layoutMText(m: MTextProps): Laid {
  const { frame, lines, box } = mtextPlan(m)
  const glyphs: Laid['glyphs'] = []
  for (const l of lines) place(l.text, l.x, l.y, glyphs)
  return { frame, glyphs, box }
}

/** An MTEXT's lines as shown, codes gone: each line's text and where its baseline starts, in the world. */
export function mtextLines(m: MTextProps): { text: string; x: number; y: number }[] {
  const { frame, lines } = mtextPlan(m)
  return lines.map((l) => ({ text: l.text, ...atFrame(frame, l.x, l.y) }))
}

/** Where the baseline of a TEXT starts, unmirrored: DXF's first alignment point, which its justification works out. */
export function baselineStart(t: TextProps): Vec2 {
  const f = layoutText({ ...t, backward: false, upsideDown: false }).frame
  return { x: f.ox, y: f.oy }
}

/** a − b turned into (−π, π]. */
const turn = (a: number, b: number): number => {
  const d = normAngle(a - b)
  return d > Math.PI ? d - 2 * Math.PI : d
}

/**
 * Where a mirror m puts text so that it still reads forward (AutoCAD's MIRRTEXT 0): its box goes where m puts the
 * box, read in whichever of the two right-handed directions is nearer its old rotation. anchor is the local point
 * the entity's (x, y) stands for. Returns the new (x, y) and rotation.
 */
export function mirrorPlacement(l: Laid, anchor: Vec2, m: Affine, rotation: number): { x: number; y: number; rotation: number } {
  const { frame: f, box: b } = l
  const qu = { x: m.a * f.ux + m.c * f.uy, y: m.b * f.ux + m.d * f.uy }
  const qv = { x: m.a * f.vx + m.c * f.vy, y: m.b * f.vx + m.d * f.vy }
  const qo = applyAffine(m, f.ox, f.oy)
  const back = Math.atan2(-qu.y, -qu.x)
  const ahead = Math.atan2(qu.y, qu.x)
  // Read from the other end (box mirrored along the baseline), or the same end upside up (mirrored across it).
  const [o, u, v, r] = Math.abs(turn(back, rotation)) <= Math.abs(turn(ahead, rotation))
    ? [{ x: qo.x + (b.x0 + b.x1) * qu.x, y: qo.y + (b.x0 + b.x1) * qu.y }, { x: -qu.x, y: -qu.y }, qv, back]
    : [{ x: qo.x + (b.y0 + b.y1) * qv.x, y: qo.y + (b.y0 + b.y1) * qv.y }, qu, { x: -qv.x, y: -qv.y }, ahead]
  return { x: o.x + anchor.x * u.x + anchor.y * v.x, y: o.y + anchor.x * u.y + anchor.y * v.y, rotation: normAngle(r) }
}
