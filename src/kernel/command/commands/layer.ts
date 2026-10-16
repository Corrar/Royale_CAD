import { TRUE_COLOR, trueColor, type Color } from '../../color'
import type { Layer } from '../../document'
import type { Command, CommandContext, CommandGen, Input, Request } from '../runtime'

/** AutoCAD's color names for ACI 1–7. */
const COLOR_NAMES: Readonly<Record<string, number>> = { RED: 1, YELLOW: 2, GREEN: 3, CYAN: 4, BLUE: 5, MAGENTA: 6, WHITE: 7 }

/** A color as typed: an ACI number 1–255, a color name, or "r,g,b" for a true color; null when it is neither. */
export function parseColor(text: string): Color | null {
  const t = text.trim().toUpperCase()
  if (COLOR_NAMES[t] !== undefined) return COLOR_NAMES[t]
  if (/^\d+$/.test(t)) {
    const n = Number(t)
    return n >= 1 && n <= 255 ? n : null
  }
  const rgb = /^(\d+)\s*,\s*(\d+)\s*,\s*(\d+)$/.exec(t)
  if (rgb && rgb.slice(1).every((v) => Number(v) <= 255)) return trueColor(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]))
  return null
}

/** How a color reads in a list: its ACI number, or r,g,b. */
export const colorText = (c: Color): string => (c >= TRUE_COLOR ? `${(c >> 16) & 255},${(c >> 8) & 255},${c & 255}` : String(c))

/** The layers a name list picks: comma-separated names, with AutoCAD's wildcards * and ?. */
function matching(ctx: CommandContext, list: string): number[] {
  const out = new Set<number>()
  for (const raw of list.split(',')) {
    const name = raw.trim()
    if (name === '') continue
    const re = new RegExp(`^${name.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i')
    for (let i = 0; i < ctx.doc.layers.size; i++) if (re.test(ctx.doc.layers.get(i)!.name)) out.add(i)
  }
  return [...out]
}

const nameOf = (ctx: CommandContext, i: number): string => ctx.doc.layers.get(i)!.name

function* text(prompt: string, def?: string): Generator<Request, string | null, Input> {
  const r = yield { kind: 'text', prompt, ...(def !== undefined && { default: def }) }
  return r.kind === 'text' ? r.text : null
}

/** A layer by that name, created when missing; null with a message when the name cannot be a layer name. */
function ensure(ctx: CommandContext, name: string): number | null {
  const at = ctx.doc.layers.indexOf(name)
  if (at !== -1) return at
  try {
    return ctx.doc.layers.add({ name, color: 7, visible: true, locked: false })
  } catch (error) {
    ctx.message(error instanceof Error ? `${error.message[0]!.toUpperCase()}${error.message.slice(1)}.` : String(error))
    return null
  }
}

/** Applies a change to the layers a name list picks; says so when it picks none. */
function* change(ctx: CommandContext, prompt: string, patch: Partial<Layer>, def?: string): Generator<Request, void, Input> {
  const list = yield* text(prompt, def)
  if (list === null || list === '') return
  const ids = matching(ctx, list)
  if (ids.length === 0) return ctx.message('No matching layer names found.')
  for (const i of ids) {
    if (patch.visible === false && i === ctx.layer) {
      const r = yield { kind: 'keyword', prompt: `Really want layer ${nameOf(ctx, i)} (the CURRENT layer) off?`, keywords: ['Yes', 'No'], default: 'No' }
      if (r.kind !== 'keyword' || r.word === 'No') continue
    }
    ctx.doc.layers.update(i, patch)
  }
}

/** -LAYER: the layers from the command line, AutoCAD's options; Enter ends. */
export const layerLine: Command = Object.assign(
  function* (ctx: CommandContext): CommandGen {
    ctx.message(`Current layer: "${nameOf(ctx, ctx.layer)}"`)
    for (;;) {
      const r = yield { kind: 'keyword', prompt: 'Enter an option', keywords: ['?', 'Make', 'Set', 'New', 'ON', 'OFF', 'Color', 'Freeze', 'Thaw', 'LOck', 'Unlock'], allowEmpty: true }
      if (r.kind !== 'keyword') return
      const current = nameOf(ctx, ctx.layer)
      switch (r.word) {
        case '?':
          for (let i = 0; i < ctx.doc.layers.size; i++) {
            const l = ctx.doc.layers.get(i)!
            ctx.message(`${l.name.padEnd(24)} ${l.visible ? 'On ' : 'Off'}  ${l.locked ? 'Locked  ' : 'Unlocked'}  ${colorText(l.color)}${i === ctx.layer ? '  (current)' : ''}`)
          }
          break
        case 'Make': {
          const name = yield* text('Enter name for new layer (becomes the current layer)', current)
          const i = name ? ensure(ctx, name) : null
          if (i !== null) ctx.setLayer(i)
          break
        }
        case 'Set': {
          const name = yield* text('Enter layer name to make current', current)
          if (!name) break
          const i = ctx.doc.layers.indexOf(name)
          if (i === -1) ctx.message(`Cannot find layer "${name}".`)
          else ctx.setLayer(i)
          break
        }
        case 'New': {
          const list = yield* text('Enter name list for new layer(s)')
          for (const name of (list ?? '').split(',').map((n) => n.trim()).filter(Boolean)) {
            if (ctx.doc.layers.indexOf(name) !== -1) ctx.message(`Layer "${name}" already exists.`)
            else ensure(ctx, name)
          }
          break
        }
        case 'ON':
        case 'Thaw':
          yield* change(ctx, `Enter name list of layer(s) to ${r.word === 'ON' ? 'turn on' : 'thaw'}`, { visible: true })
          break
        case 'OFF':
        case 'Freeze':
          yield* change(ctx, `Enter name list of layer(s) to ${r.word === 'OFF' ? 'turn off' : 'freeze'}`, { visible: false })
          break
        case 'LOck':
        case 'Unlock':
          yield* change(ctx, `Enter name list of layer(s) to ${r.word === 'LOck' ? 'lock' : 'unlock'}`, { locked: r.word === 'LOck' })
          break
        case 'Color': {
          let color: Color | null = null
          while (color === null) {
            const t = yield* text('New color (1-255, a name, or r,g,b)')
            if (t === null || t === '') break
            color = parseColor(t)
            if (color === null) ctx.message('Requires a color number 1-255, a color name or r,g,b.')
          }
          if (color === null) break
          yield* change(ctx, `Enter name list of layer(s) for color ${colorText(color)}`, { color }, current)
          break
        }
      }
    }
  },
  { noUndoGroup: true },
)

/** LAYER (LA): the layer panel, or -LAYER where the app has none. */
export const layer: Command = Object.assign(
  function* (ctx: CommandContext): CommandGen {
    if (ctx.host.showLayers) return ctx.host.showLayers()
    return yield* layerLine(ctx)
  },
  { noUndoGroup: true },
)
