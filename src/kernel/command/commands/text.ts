import type { PrimSink } from '../../entity/types'
import type { Vec2 } from '../../geom/vec'
import { decodeText } from '../../text/codes'
import { atFrame, layoutText, widthOf, type TextProps } from '../../text/layout'
import { formatNumber, getNumber, getPoint, type Command, type CommandContext, type CommandGen, type Request, type Input } from '../runtime'

/** Between baselines of the lines a TEXT types, in heights: MTEXT's spacing 1. */
const LINE_GAP = 5 / 3

/** DTEXT's cursor, where the next character goes: a box a capital high and this wide, in capital heights. */
const CURSOR = 0.6

/** The last line a TEXT wrote: Enter at the first prompt goes on below it, as in AutoCAD. */
const LAST_LINE = 'TEXT_LAST'

/** A line of TEXT as written: its points (Align's and Fit's second one too), height, rotation and justification. */
interface TextLine { a: Vec2; b: Vec2; height: number; rotation: number; halign: number; valign: number }

const JUSTIFY = ['Left', 'Center', 'Right', 'Align', 'Middle', 'Fit', 'TL', 'TC', 'TR', 'ML', 'MC', 'MR', 'BL', 'BC', 'BR']

/** Each option's DXF alignment (72, 73) and what its point is called. */
const PLACES: Readonly<Record<string, readonly [number, number, string]>> = {
  Left: [0, 0, 'start point'],
  Center: [1, 0, 'center point'],
  Right: [2, 0, 'right endpoint of text baseline'],
  Middle: [4, 0, 'middle point'],
  TL: [0, 3, 'top-left point'],
  TC: [1, 3, 'top-center point'],
  TR: [2, 3, 'top-right point'],
  ML: [0, 2, 'middle-left point'],
  MC: [1, 2, 'middle-center point'],
  MR: [2, 2, 'middle-right point'],
  BL: [0, 1, 'bottom-left point'],
  BC: [1, 1, 'bottom-center point'],
  BR: [2, 1, 'bottom-right point'],
}

const pointName = (name: string): string => (name.endsWith('baseline') ? name : `${name} of text`)

/**
 * TEXT (DTEXT): a line of single-line text per Enter, each below the last, until an empty line. The height
 * (TEXTSIZE) and the rotation asked last are the defaults. Justify places the text by another point of it; Align
 * and Fit run it between two, Align scaling its height to the width. Enter at the first prompt goes on below the
 * last line written.
 */
export const text: Command = function* (ctx) {
  const size = (ctx.vars.get('TEXTSIZE') as number | undefined) ?? 2.5
  ctx.message(`Current text style:  "Standard"  Text height:  ${formatNumber(size)}`)
  const last = ctx.vars.get(LAST_LINE) as TextLine | undefined
  let option = 'Left'
  let at = yield* getPoint('Specify start point of text', { keywords: ['Justify'], hidden: JUSTIFY, allowEmpty: last !== undefined })
  if (at === null) {
    // Enter: below the last line, set as it was; no height or rotation to ask.
    if (last) yield* lines(ctx, last, last.height)
    return
  }
  if (at === 'Justify') {
    const r = yield { kind: 'keyword', prompt: 'Enter an option', keywords: JUSTIFY }
    if (r.kind !== 'keyword') return
    at = r.word
  }
  if (typeof at === 'string') {
    // An option chosen after Justify, or typed at once: AutoCAD takes them at the first prompt unlisted.
    option = at
    if (option === 'Align' || option === 'Fit') at = yield* getPoint('Specify first endpoint of text baseline')
    else at = yield* getPoint(`Specify ${pointName(PLACES[option]![2])}`)
  }
  if (at === null || typeof at === 'string') return
  const p0 = at
  let p1: Vec2 = p0
  if (option === 'Align' || option === 'Fit') {
    for (;;) {
      const q = yield* getPoint('Specify second endpoint of text baseline', { base: p0 })
      if (q === null || typeof q === 'string') return
      if (q.x !== p0.x || q.y !== p0.y) {
        p1 = q
        break
      }
      ctx.message('The endpoints must differ.')
    }
  }
  let height = size
  if (option !== 'Align') {
    const h = yield* getNumber('Specify height', { base: p0, default: size, positive: true })
    if (typeof h !== 'number') return
    height = h
    ctx.vars.set('TEXTSIZE', height)
  }
  let rotation = Math.atan2(p1.y - p0.y, p1.x - p0.x)
  if (option !== 'Align' && option !== 'Fit') {
    const last = (ctx.vars.get('TEXTROTATION') as number | undefined) ?? 0
    const a = yield* getNumber('Specify rotation angle of text', { base: p0, angle: true, default: (last * 180) / Math.PI })
    if (typeof a !== 'number') return
    rotation = (a * Math.PI) / 180
    ctx.vars.set('TEXTROTATION', rotation)
  }
  const [halign, valign] = option === 'Align' ? [3, 0] : option === 'Fit' ? [5, 0] : PLACES[option]!
  yield* lines(ctx, { a: p0, b: p1, height, rotation, halign, valign }, null)
}

/**
 * The lines typed, one per Enter until an empty one, set as `at` is: the first at its points, or below them when
 * `above` is the height of a line there; each next one below the last.
 */
function* lines(ctx: CommandContext, at: TextLine, above: number | null): CommandGen {
  const { height, rotation, halign, valign } = at
  const span = Math.hypot(at.b.x - at.a.x, at.b.y - at.a.y)
  // Down the page: both points move together.
  const down = (p: Vec2, d: number): Vec2 => ({ x: p.x + Math.sin(rotation) * d, y: p.y - Math.cos(rotation) * d })
  // The points of the line above and its height; none above the first line, nor after a click.
  let { a, b } = at
  // Where a line of these words goes. Align scales each line's height to the span, as the layout does: that is the
  // height kept, and the one that spaces it from the line above, by the taller of the two.
  const place = (value: string): TextLine => {
    const w = widthOf(decodeText(value))
    const h = halign === 3 && w > 0 ? span / w : height
    const gap = above === null ? 0 : LINE_GAP * Math.max(above, h)
    return { a: down(a, gap), b: down(b, gap), height: h, rotation, halign, valign }
  }
  const textOf = (value: string, l: TextLine): TextProps => ({
    value, x: l.a.x, y: l.a.y, x2: l.b.x, y2: l.b.y, height: l.height, rotation, widthFactor: 1, oblique: 0,
    halign, valign, backward: false, upsideDown: false,
  })
  // The line as typed so far, where Enter will put it, and the cursor at its end: after an Enter, where the next goes.
  const preview = (typed: string, out: PrimSink): void => {
    const { frame: f, glyphs, box } = layoutText(textOf(typed, place(typed)))
    for (const g of glyphs) {
      const p = atFrame(f, g.x, g.y)
      out.glyph?.(g.cp, p.x, p.y, f.ux, f.uy, f.vx, f.vy)
    }
    const c = [atFrame(f, box.x1, 0), atFrame(f, box.x1 + CURSOR, 0), atFrame(f, box.x1 + CURSOR, 1), atFrame(f, box.x1, 1)]
    for (let i = 0; i < 4; i++) out.segment(c[i]!.x, c[i]!.y, c[(i + 1) % 4]!.x, c[(i + 1) % 4]!.y)
  }
  for (;;) {
    const r: Input = yield { kind: 'text', prompt: 'Enter text', spaces: true, acceptPoint: true, preview } satisfies Request
    if (r.kind === 'point') {
      // A click starts the next line there, as DTEXT does; Align's and Fit's second point keeps its place from the first.
      ;[a, b] = [r.p, { x: r.p.x + b.x - a.x, y: r.p.y + b.y - a.y }]
      above = null
      continue
    }
    if (r.kind !== 'text' || r.text === '') return
    const line = place(r.text)
    ctx.doc.transact('TEXT', (tx) => void tx.add({ type: 'text', layer: ctx.layer, ...textOf(r.text, line) }))
    ;({ a, b } = line)
    above = line.height
    ctx.vars.set(LAST_LINE, line)
  }
}
