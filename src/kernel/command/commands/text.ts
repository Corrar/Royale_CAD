import type { Vec2 } from '../../geom/vec'
import { decodeText } from '../../text/codes'
import { widthOf } from '../../text/layout'
import { formatNumber, getNumber, getPoint, type Command, type Request, type Input } from '../runtime'

/** Between baselines of the lines a TEXT types, in heights: MTEXT's spacing 1. */
const LINE_GAP = 5 / 3

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
 * and Fit run it between two, Align scaling its height to the width.
 */
export const text: Command = function* (ctx) {
  const size = (ctx.vars.get('TEXTSIZE') as number | undefined) ?? 2.5
  ctx.message(`Current text style:  "Standard"  Text height:  ${formatNumber(size)}`)
  let option = 'Left'
  let at = yield* getPoint('Specify start point of text', { keywords: ['Justify'], hidden: JUSTIFY })
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
  const span = Math.hypot(p1.x - p0.x, p1.y - p0.y)
  // Down the page: both points move together.
  const down = (p: Vec2, d: number): Vec2 => ({ x: p.x + Math.sin(rotation) * d, y: p.y - Math.cos(rotation) * d })
  // The points of the line above and its height; none above the first line, nor after a click.
  let [a, b] = [p0, p1]
  let above: number | null = null
  for (;;) {
    const r: Input = yield { kind: 'text', prompt: 'Enter text', spaces: true, acceptPoint: true } satisfies Request
    if (r.kind === 'point') {
      // A click starts the next line there, as DTEXT does; Align's and Fit's second point keeps its place from the first.
      ;[a, b] = [r.p, { x: r.p.x + b.x - a.x, y: r.p.y + b.y - a.y }]
      above = null
      continue
    }
    if (r.kind !== 'text' || r.text === '') return
    const value = r.text
    // Align scales each line's height to the span, as the layout does: that is the height kept, and the one that
    // spaces it from the line above, by the taller of the two.
    const w = widthOf(decodeText(value))
    const h = halign === 3 && w > 0 ? span / w : height
    const gap = above === null ? 0 : LINE_GAP * Math.max(above, h)
    ;[a, b] = [down(a, gap), down(b, gap)]
    above = h
    const [x, y, x2, y2] = [a.x, a.y, b.x, b.y]
    ctx.doc.transact('TEXT', (tx) => void tx.add({
      type: 'text', layer: ctx.layer, value, x, y, x2, y2, height: h, rotation, widthFactor: 1, oblique: 0,
      halign, valign, backward: false, upsideDown: false,
    }))
  }
}
