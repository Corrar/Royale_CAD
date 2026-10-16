import type { Vec2 } from '../../geom/vec'
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
  // Down the page, one line: both points move together.
  const down = { x: Math.sin(rotation) * height * LINE_GAP, y: -Math.cos(rotation) * height * LINE_GAP }
  for (let line = 0; ; line++) {
    const r: Input = yield { kind: 'text', prompt: 'Enter text', spaces: true } satisfies Request
    if (r.kind !== 'text' || r.text === '') return
    const value = r.text
    const [x, y, x2, y2] = [p0.x + line * down.x, p0.y + line * down.y, p1.x + line * down.x, p1.y + line * down.y]
    ctx.doc.transact('TEXT', (tx) => void tx.add({
      type: 'text', layer: ctx.layer, value, x, y, x2, y2, height, rotation, widthFactor: 1, oblique: 0,
      halign, valign, backward: false, upsideDown: false,
    }))
  }
}
