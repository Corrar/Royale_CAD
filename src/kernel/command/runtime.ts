import type { Document } from '../document'
import type { PrimSink } from '../entity/types'
import type { BBox, Vec2 } from '../geom/vec'
import type { Selection } from '../selection'
import type { SnapHit } from '../snap'
import type { ViewState } from '../view'
import { DEFAULT_ALIASES, resolveCommand } from './aliases'
import { parseInput, type Token } from './parser'

interface Ask {
  /** Without the trailing colon; keywords and the default are appended by formatPrompt. */
  prompt: string
  /** Matched case-insensitively, by unique prefix. */
  keywords?: readonly string[]
}

export interface PointRequest extends Ask {
  kind: 'point'
  /** Anchor of the rubber band: a bare number is then a distance along the cursor's direction. */
  base?: Vec2
  /** Enter answers { kind: 'empty' } instead of being refused. */
  allowEmpty?: boolean
  /** A bare number (or "2x") answers { kind: 'number' } instead of a direct distance. */
  acceptNumber?: boolean
  /** Geometry drawn under the cursor while the request waits. */
  preview?: (cursor: Vec2, out: PrimSink) => void
  /** The point picks an object (TRIM, EXTEND): OSNAP and ORTHO leave it where it is, and the pick box shows. */
  pick?: boolean
  /** What Enter stands for, shown as <…>; Enter still answers { kind: 'empty' } (allowEmpty). */
  default?: string
}

export interface NumberRequest extends Ask {
  kind: 'number'
  /** A picked point answers its distance from base, or with `angle` the base-to-point direction in degrees. */
  base?: Vec2
  angle?: boolean
  /** What Enter answers; without it Enter is refused. */
  default?: number
  positive?: boolean
  preview?: (cursor: Vec2, out: PrimSink) => void
}

export interface KeywordRequest extends Ask {
  kind: 'keyword'
  keywords: readonly string[]
  default?: string
}

export interface SelectionRequest extends Ask {
  kind: 'selection'
}

export type Request = PointRequest | NumberRequest | KeywordRequest | SelectionRequest

export type Input =
  | { kind: 'point'; p: Vec2 }
  | { kind: 'number'; value: number }
  | { kind: 'keyword'; word: string }
  | { kind: 'empty' }
  | { kind: 'selection'; ids: number[] }

export type CommandGen = Generator<Request, void, Input>

/** A command is a linear script: it yields requests and receives the answers. */
export type Command = ((ctx: CommandContext) => CommandGen) & {
  /** Runs outside an undo group: commands that drive undo itself, or touch only the view. */
  noUndoGroup?: boolean
}

/** What the interpreter needs from the app; every member is optional so the kernel tests can leave it out. */
export interface InterpreterHost {
  getView?(): ViewState
  setView?(v: ViewState): void
  extents?(): BBox | null
  /** The entity under p, within the pick box. */
  pick?(p: Vec2): number | null
  pickBox?(b: BBox, crossing: boolean): number[]
  /** The object snap under p, with the app's modes and aperture; null when none. */
  snap?(p: Vec2): SnapHit | null
  /** The entities whose bbox meets b (the spatial index); a superset is fine. */
  query?(b: BBox): number[]
}

export interface CommandContext {
  readonly doc: Document
  readonly selection: Selection
  readonly host: InterpreterHost
  /** Layer that new entities go to. */
  readonly layer: number
  /** Values kept between commands, like AutoCAD system variables (CIRCLERAD, …). */
  readonly vars: Map<string, unknown>
  message(text: string): void
}

export interface Interpreter {
  /** What the active command waits for; null when idle. */
  readonly request: Request | null
  /** The active command's name; null when idle. */
  readonly command: string | null
  /** The prompt line: "Command" when idle. */
  readonly prompt: string
  readonly history: readonly string[]
  /** First corner of a window being dragged at a selection prompt (or idle); null otherwise. */
  readonly corner: Vec2 | null
  /** LASTPOINT: the origin of @ and the last point given. */
  readonly lastPoint: Vec2
  /** Cursor in world units, for direct distance and previews; set by the app on every move. */
  cursor: Vec2 | null
  /** Object snap on clicks while a point is asked for (F3). On by default, as in AutoCAD. */
  osnap: boolean
  /** Squares points to the base point's axes (F8). Typed coordinates are exempt; a snap wins over it. */
  ortho: boolean
  /** Where a click at the cursor would land now, and the snap that put it there; null without a cursor. */
  readonly tracked: { p: Vec2; snap: SnapHit | null } | null
  feedText(text: string): void
  /** A click. At a selection prompt or idle it picks, or opens and closes a window. */
  feedPoint(p: Vec2, shift?: boolean): void
  cancel(): void
  onChange(fn: () => void): () => void
}

export interface InterpreterOptions {
  commands: Readonly<Record<string, Command>>
  aliases?: Readonly<Record<string, string>>
  host?: InterpreterHost
}

const HISTORY_MAX = 500

/** "Specify next point or [Close/Undo] <5>:" */
export function formatPrompt(r: Request | null): string {
  if (!r) return 'Command:'
  // A question with only options reads "Erase source objects? [Yes/No] <No>:", without "or".
  const keywords = r.keywords && r.keywords.length > 0 ? `${r.kind === 'keyword' ? '' : ' or'} [${r.keywords.join('/')}]` : ''
  const def = r.kind !== 'selection' && r.default !== undefined ? ` <${r.default}>` : ''
  return `${r.prompt}${keywords}${def}:`
}

/** The keyword a typed word stands for: exact match first, then a unique prefix. */
export function matchKeyword(word: string, keywords: readonly string[] | undefined): string | undefined {
  if (!keywords) return undefined
  const w = word.toLowerCase()
  const exact = keywords.find((k) => k.toLowerCase() === w)
  if (exact) return exact
  const hits = keywords.filter((k) => k.toLowerCase().startsWith(w))
  return hits.length === 1 ? hits[0] : undefined
}

const SCALE_WORD = /^(\d+\.?\d*|\.\d+)x$/i

export function createInterpreter(doc: Document, selection: Selection, opts: InterpreterOptions): Interpreter {
  const commands = opts.commands
  const names = new Set(Object.keys(commands))
  const aliases = opts.aliases ?? DEFAULT_ALIASES
  const host = opts.host ?? {}
  const listeners = new Set<() => void>()
  const history: string[] = []
  const vars = new Map<string, unknown>()
  let gen: CommandGen | null = null
  let grouped = false
  let request: Request | null = null
  let active: string | null = null
  let last: string | null = null
  let lastPoint: Vec2 = { x: 0, y: 0 }
  let corner: Vec2 | null = null
  let cursor: Vec2 | null = null
  let osnap = true
  let ortho = false

  const emit = (): void => {
    for (const fn of [...listeners]) fn()
  }
  const say = (line: string): void => {
    history.push(line)
    if (history.length > HISTORY_MAX) history.splice(0, history.length - HISTORY_MAX)
  }

  const ctx: CommandContext = { doc, selection, host, layer: 0, vars, message: say }

  function finish(): void {
    gen = null
    request = null
    active = null
    if (grouped) doc.endGroup()
    grouped = false
  }

  /** Advances the command with an answer (none for the first step) and records the next request. */
  function step(input?: Input): void {
    try {
      const r = input === undefined ? gen!.next() : gen!.next(input)
      if (r.done) finish()
      else request = r.value
    } catch (error) {
      say(`Error: ${error instanceof Error ? error.message : String(error)}`)
      finish()
    }
  }

  function start(name: string): void {
    const cmd = commands[name]!
    corner = null
    active = name
    last = name
    say(`Command: ${name}`)
    grouped = !cmd.noUndoGroup
    if (grouped) doc.beginGroup(name)
    gen = cmd(ctx)
    step()
  }

  /** Echoes the answered prompt like AutoCAD's history, then hands the answer to the command. */
  function answer(input: Input, echo: string): void {
    say(`${formatPrompt(request)} ${echo}`.trimEnd())
    if (input.kind === 'point') lastPoint = input.p
    step(input)
  }

  function refuse(message: string): void {
    say(message)
  }

  /**
   * A pointed (not typed) location as the active request will take it: the snap point when OSNAP finds one, else
   * squared to the base when ORTHO is on. At the Command prompt, while selecting and for picks, the raw location.
   */
  function resolve(raw: Vec2): { p: Vec2; snap: SnapHit | null } {
    const r = request
    if (!r || (r.kind !== 'point' && r.kind !== 'number') || (r.kind === 'point' && r.pick)) return { p: raw, snap: null }
    const hit = osnap ? (host.snap?.(raw) ?? null) : null
    if (hit) return { p: hit.p, snap: hit }
    const base = r.base
    if (ortho && base) {
      return { p: Math.abs(raw.x - base.x) >= Math.abs(raw.y - base.y) ? { x: raw.x, y: base.y } : { x: base.x, y: raw.y }, snap: null }
    }
    return { p: raw, snap: null }
  }

  /** What a point answers to a number request with a base: a distance, or an angle in degrees. */
  const measure = (r: NumberRequest, p: Vec2): number =>
    r.angle ? (Math.atan2(p.y - r.base!.y, p.x - r.base!.x) * 180) / Math.PI : Math.hypot(p.x - r.base!.x, p.y - r.base!.y)

  const pointOf = (t: Extract<Token, { kind: 'point' }>): Vec2 =>
    t.mode === 'abs' ? { x: t.x, y: t.y } : { x: lastPoint.x + t.x, y: lastPoint.y + t.y }

  function keyword(word: string, text: string): boolean {
    const k = matchKeyword(word, request!.keywords)
    if (k === undefined) return false
    answer({ kind: 'keyword', word: k }, text)
    return true
  }

  function onText(text: string): void {
    const t = parseInput(text)
    if (!gen) {
      if (t.kind === 'empty') {
        if (last) start(last)
        return
      }
      const name = t.kind === 'word' ? resolveCommand(t.text, names, aliases) : undefined
      if (name) start(name)
      else refuse(`Unknown command "${text.trim().toUpperCase()}".`)
      return
    }
    const r = request!
    const echo = text.trim()
    switch (r.kind) {
      case 'point': {
        if (t.kind === 'point') return answer({ kind: 'point', p: pointOf(t) }, echo)
        if (r.acceptNumber && (t.kind === 'number' || (t.kind === 'word' && SCALE_WORD.test(t.text)))) {
          return answer({ kind: 'number', value: t.kind === 'number' ? t.value : parseFloat(t.text) }, echo)
        }
        if (t.kind === 'number' && r.base) {
          // Direct distance: along the rubber band, towards where the cursor would land (ORTHO squares it).
          const to = cursor ? resolve(cursor).p : r.base
          const d = Math.hypot(to.x - r.base.x, to.y - r.base.y)
          if (d === 0) return refuse('Move the cursor to give the direction.')
          const k = t.value / d
          return answer({ kind: 'point', p: { x: r.base.x + (to.x - r.base.x) * k, y: r.base.y + (to.y - r.base.y) * k } }, echo)
        }
        if (t.kind === 'word' && keyword(t.text, echo)) return
        if (t.kind === 'empty' && r.allowEmpty) return answer({ kind: 'empty' }, '')
        return refuse(r.keywords?.length ? 'Point or option keyword required.' : 'Invalid point.')
      }
      case 'number': {
        let value: number | undefined
        if (t.kind === 'number') value = t.value
        else if (t.kind === 'point' && r.base) value = measure(r, pointOf(t))
        else if (t.kind === 'word' && keyword(t.text, echo)) return
        else if (t.kind === 'empty' && r.default !== undefined) return answer({ kind: 'number', value: r.default }, '')
        if (value === undefined) return refuse(r.keywords?.length ? 'Requires a number or an option keyword.' : 'Requires a number.')
        if (r.positive && !(value > 0)) return refuse('Value must be positive and nonzero.')
        return answer({ kind: 'number', value }, echo)
      }
      case 'keyword': {
        if (t.kind === 'word' && keyword(t.text, echo)) return
        if (t.kind === 'empty' && r.default !== undefined) return answer({ kind: 'keyword', word: r.default }, '')
        return refuse('Invalid option keyword.')
      }
      case 'selection': {
        if (t.kind === 'empty') {
          corner = null
          return answer({ kind: 'selection', ids: [...selection.ids] }, '')
        }
        if (t.kind === 'word' && t.text.toUpperCase() === 'ALL') {
          const ids = host.pickBox?.({ minX: -Infinity, minY: -Infinity, maxX: Infinity, maxY: Infinity }, true) ?? []
          selection.add(ids)
          return say(`${ids.length} found`)
        }
        return refuse('Select objects, or press Enter to finish.')
      }
    }
  }

  /** Click selection, idle or at a selection prompt: an entity, or the corners of a window. */
  function selectAt(p: Vec2, shift: boolean): void {
    const prompting = request?.kind === 'selection'
    const apply = (ids: number[]): void => {
      if (shift) selection.remove(ids)
      else selection.add(ids)
      if (prompting) say(`${ids.length} found${shift ? ', removed' : ''}`)
    }
    if (corner) {
      // Left to right: window, only what lies inside. Right to left: crossing, also what touches.
      const b = { minX: Math.min(corner.x, p.x), minY: Math.min(corner.y, p.y), maxX: Math.max(corner.x, p.x), maxY: Math.max(corner.y, p.y) }
      const crossing = p.x < corner.x
      corner = null
      return apply(host.pickBox?.(b, crossing) ?? [])
    }
    const id = host.pick?.(p) ?? null
    if (id !== null) return apply([id])
    corner = p
  }

  function onPoint(raw: Vec2, shift: boolean): void {
    if (!gen || request?.kind === 'selection') return selectAt(raw, shift)
    const r = request!
    const p = resolve(raw).p
    if (r.kind === 'point') return answer({ kind: 'point', p }, '')
    if (r.kind === 'number' && r.base) return answer({ kind: 'number', value: measure(r, p) }, '')
    refuse(r.kind === 'number' ? 'Requires a number.' : 'Invalid option keyword.')
  }

  return {
    get request() {
      return request
    },
    get command() {
      return active
    },
    get prompt() {
      return formatPrompt(request)
    },
    history,
    get corner() {
      return corner
    },
    get lastPoint() {
      return lastPoint
    },
    get cursor() {
      return cursor
    },
    set cursor(p) {
      cursor = p
    },
    get osnap() {
      return osnap
    },
    set osnap(on) {
      if (on === osnap) return
      osnap = on
      emit()
    },
    get ortho() {
      return ortho
    },
    set ortho(on) {
      if (on === ortho) return
      ortho = on
      emit()
    },
    get tracked() {
      return cursor && resolve(cursor)
    },
    feedText(text) {
      onText(text)
      emit()
    },
    feedPoint(p, shift = false) {
      onPoint(p, shift)
      emit()
    },
    cancel() {
      // Esc: ends the command and drops the selection; idle, it first drops a window being dragged.
      if (gen) {
        try {
          gen.return()
        } catch {
          // A command that throws while unwinding is still cancelled.
        }
        say('*Cancel*')
        finish()
        selection.clear()
      } else if (!corner) selection.clear()
      corner = null
      emit()
    },
    onChange(fn) {
      const entry = (): void => fn()
      listeners.add(entry)
      return () => listeners.delete(entry)
    },
  }
}

/** Feeds a script for tests: each ⏎ (or newline) submits the text typed before it. */
export function runScript(interp: Interpreter, script: string): void {
  const parts = script.split(/⏎|\n/)
  for (let i = 0; i < parts.length - 1; i++) interp.feedText(parts[i]!)
}

// --- helpers for commands -------------------------------------------------------------------------------------

/** A point, a keyword, or null for Enter (only when allowEmpty). */
export function* getPoint(prompt: string, opts: Omit<PointRequest, 'kind' | 'prompt'> = {}): Generator<Request, Vec2 | string | null, Input> {
  const input = yield { kind: 'point', prompt, ...opts }
  return input.kind === 'point' ? input.p : input.kind === 'keyword' ? input.word : null
}

/** A number, a keyword, or null. */
export function* getNumber(prompt: string, opts: Omit<NumberRequest, 'kind' | 'prompt'> = {}): Generator<Request, number | string | null, Input> {
  const input = yield { kind: 'number', prompt, ...opts }
  return input.kind === 'number' ? input.value : input.kind === 'keyword' ? input.word : null
}

/** The pre-selection when there is one (noun-verb), otherwise what the user selects at the prompt. */
export function* getSelection(ctx: CommandContext, prompt = 'Select objects'): Generator<Request, number[], Input> {
  if (ctx.selection.ids.size > 0) return [...ctx.selection.ids]
  const input = yield { kind: 'selection', prompt }
  return input.kind === 'selection' ? input.ids : []
}
