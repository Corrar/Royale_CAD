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
  /** Taken like keywords but left out of the prompt: options AutoCAD takes there unlisted (TEXT's justifications). */
  hidden?: readonly string[]
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
  /** Whole numbers only (UNDO's count). */
  integer?: boolean
  preview?: (cursor: Vec2, out: PrimSink) => void
}

export interface KeywordRequest extends Ask {
  kind: 'keyword'
  keywords: readonly string[]
  default?: string
  /** Enter answers { kind: 'empty' } (ends a loop of options, as -LAYER's). */
  allowEmpty?: boolean
}

export interface SelectionRequest extends Ask {
  kind: 'selection'
}

/** A name or other free text, typed as is (Space ends it, as in AutoCAD). */
export interface TextRequest extends Ask {
  kind: 'text'
  /** What Enter answers, shown as <…>; without it Enter answers the empty text. */
  default?: string
  /** Space types a space and only Enter ends it (the words of a TEXT); the text is kept untrimmed. */
  spaces?: boolean
  /** A click answers { kind: 'point' } instead of being refused: DTEXT starts its next line there. */
  acceptPoint?: boolean
  /** Drawn while the words are typed, given those typed so far: TEXT shows its line in place. */
  preview?: (typed: string, out: PrimSink) => void
}

export type Request = PointRequest | NumberRequest | KeywordRequest | SelectionRequest | TextRequest

export type Input =
  /** shift: clicked with Shift held (TRIM's and EXTEND's shift-select). */
  | { kind: 'point'; p: Vec2; shift?: boolean }
  | { kind: 'number'; value: number }
  | { kind: 'keyword'; word: string }
  | { kind: 'empty' }
  | { kind: 'selection'; ids: number[] }
  | { kind: 'text'; text: string }

export type CommandGen = Generator<Request, void, Input>

/** A command is a linear script: it yields requests and receives the answers. */
export type Command = ((ctx: CommandContext) => CommandGen) & {
  /** Runs outside an undo group: commands that drive undo itself, or touch only the view. */
  noUndoGroup?: boolean
  /**
   * Takes the selection made before it (noun-verb, AutoCAD's PICKFIRST). Other commands that edit the drawing drop
   * it as they start, so a later ERASE cannot erase a selection forgotten on screen.
   */
  pickfirst?: boolean
}

/** What the interpreter needs from the app; every member is optional so the kernel tests can leave it out. */
export interface InterpreterHost {
  getView?(): ViewState
  setView?(v: ViewState): void
  extents?(): BBox | null
  /** The entity under p, within the pick box. */
  pick?(p: Vec2): number | null
  pickBox?(b: BBox, crossing: boolean): number[]
  /** The object snap under p, with the app's modes and aperture; null when none. PER starts from base. */
  snap?(p: Vec2, base?: Vec2): SnapHit | null
  /** The entities whose bbox meets b (the spatial index); a superset is fine. */
  query?(b: BBox): number[]
  /** Files: the app runs the dialogs and the reading and writing after the command has ended. */
  files?: FileHost
  /** Shows the layer panel (LAYER, LA). */
  showLayers?(): void
  /** Shows the settings at a tab: object snap (OSNAP, DSETTINGS) or aliases (ALIASEDIT). */
  showSettings?(tab: 'osnap' | 'aliases'): void
}

export interface FileHost {
  /** The drawing's file name, for prompts. */
  name(): string
  /** Whether the drawing changed since it was opened, saved or begun. */
  dirty(): boolean
  /** What a file operation under way is doing ("Reading Plant.dxf… 40%"); null when none. No command starts meanwhile. */
  busy(): string | null
  /** Asks for a file and opens it; saves the current drawing first when told to. */
  open(saveFirst: boolean): void
  /** Begins an empty drawing; saves the current one first when told to. */
  create(saveFirst: boolean): void
  /** Saves to the drawing's file, or asks for one when it has none. */
  save(): void
  /** Asks for a file and saves there; the drawing then goes by that name. */
  saveAs(): void
}

export interface CommandContext {
  readonly doc: Document
  readonly selection: Selection
  readonly host: InterpreterHost
  /** The current layer (CLAYER): new entities go to it. */
  readonly layer: number
  /** Makes another layer current. */
  setLayer(index: number): void
  /** Values kept between commands, like AutoCAD system variables (CIRCLERAD, …). */
  readonly vars: Map<string, unknown>
  message(text: string): void
  /** Moves LASTPOINT, the origin of @: LINE does when its Undo or Close changes where the next segment starts. */
  setLastPoint(p: Vec2): void
}

export interface Interpreter {
  /** What the active command waits for; null when idle. */
  readonly request: Request | null
  /** The active command's name; null when idle. */
  readonly command: string | null
  /** The prompt line: "Command" when idle. */
  readonly prompt: string
  readonly history: readonly string[]
  /** Lines said since the interpreter began, the dropped ones included: history[0] is line said − history.length. */
  readonly said: number
  /** First corner of a window being dragged at a selection prompt (or idle); null otherwise. */
  readonly corner: Vec2 | null
  /** LASTPOINT: the origin of @ and the last point given. */
  readonly lastPoint: Vec2
  /** Cursor in world units, for direct distance and previews; set by the app on every move. */
  cursor: Vec2 | null
  /** The current layer (CLAYER), where new entities go; listeners hear when it changes. */
  layer: number
  /** Values kept between commands (CIRCLERAD, TEXTSIZE…): those a drawing keeps, the app sets as it puts one in place. */
  readonly vars: Map<string, unknown>
  /** Object snap on clicks while a point is asked for (F3). On by default, as in AutoCAD. */
  osnap: boolean
  /** Squares points to the base point's axes (F8). Typed coordinates are exempt; a snap wins over it. */
  ortho: boolean
  /** The command aliases (acad.pgp): typed word to command name. Replaced whole, as the settings change. */
  aliases: Readonly<Record<string, string>>
  /** Where a click at the cursor would land now, and the snap that put it there; null without a cursor. */
  readonly tracked: { p: Vec2; snap: SnapHit | null } | null
  /** A line in the history from outside a command: what the app has to say (a file saved, a load failed). */
  print(line: string): void
  feedText(text: string): void
  /** A click. At a selection prompt or idle it picks, or opens and closes a window. */
  feedPoint(p: Vec2, shift?: boolean): void
  cancel(): void
  /**
   * Another drawing is in place (OPEN, NEW): LASTPOINT is 0,0 again and a window begun in the old one goes, as
   * every drawing starts in AutoCAD.
   */
  newDrawing(): void
  onChange(fn: () => void): () => void
}

export interface InterpreterOptions {
  commands: Readonly<Record<string, Command>>
  aliases?: Readonly<Record<string, string>>
  host?: InterpreterHost
}

const HISTORY_MAX = 500

/**
 * A number as AutoCAD shows it in prompts: lengths with 4 decimals (LUPREC), angles in whole degrees (AUPREC),
 * counts as they are.
 */
export function formatNumber(v: number, kind: 'length' | 'angle' | 'integer' = 'length'): string {
  const s = kind === 'integer' ? String(v) : v.toFixed(kind === 'angle' ? 0 : 4)
  return s === '-0' || /^-0\.0+$/.test(s) ? s.slice(1) : s
}

/** "Specify next point or [Close/Undo] <5.0000>:" */
export function formatPrompt(r: Request | null): string {
  if (!r) return 'Command:'
  // A question with only options reads "Erase source objects? [Yes/No] <No>:", without "or".
  const keywords = r.keywords && r.keywords.length > 0 ? `${r.kind === 'keyword' ? '' : ' or'} [${r.keywords.join('/')}]` : ''
  let def = ''
  if (r.kind === 'number' && r.default !== undefined) def = ` <${formatNumber(r.default, r.integer ? 'integer' : r.angle ? 'angle' : 'length')}>`
  else if ((r.kind === 'point' || r.kind === 'keyword' || r.kind === 'text') && r.default !== undefined) def = ` <${r.default}>`
  return `${r.prompt}${keywords}${def}:`
}

/** The keyword a typed word stands for: exact match first, then its capitals (AutoCAD's abbreviation), then a unique prefix. */
export function matchKeyword(word: string, keywords: readonly string[] | undefined): string | undefined {
  if (!keywords) return undefined
  const w = word.toLowerCase()
  const exact = keywords.find((k) => k.toLowerCase() === w)
  if (exact) return exact
  const short = keywords.filter((k) => /^[A-Z]+/.exec(k)?.[0].toLowerCase() === w)
  if (short.length === 1) return short[0]
  const hits = keywords.filter((k) => k.toLowerCase().startsWith(w))
  return hits.length === 1 ? hits[0] : undefined
}

const SCALE_WORD = /^(\d+\.?\d*|\.\d+)x$/i

export function createInterpreter(doc: Document, selection: Selection, opts: InterpreterOptions): Interpreter {
  const commands = opts.commands
  const names = new Set(Object.keys(commands))
  let aliases = opts.aliases ?? DEFAULT_ALIASES
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
  // Selecting: the window's first corner, a box forced to window or crossing (W, C), Remove mode, what each pick
  // did (for Undo), and the set the last command took (Previous).
  let boxMode: 'window' | 'crossing' | null = null
  let removing = false
  let picks: { added: number[]; removed: number[] }[] = []
  let previous: number[] = []

  const emit = (): void => {
    for (const fn of [...listeners]) fn()
  }
  let said = 0
  const say = (line: string): void => {
    said++
    history.push(line)
    if (history.length > HISTORY_MAX) history.splice(0, history.length - HISTORY_MAX)
  }

  let layer = 0
  const ctx: CommandContext = {
    doc,
    selection,
    host,
    get layer() {
      return layer
    },
    setLayer(index) {
      if (!doc.layers.get(index)) throw new Error(`no layer ${index}`)
      layer = index
    },
    vars,
    message: say,
    setLastPoint(p) {
      lastPoint = p
    },
  }

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
      else {
        if (r.value.kind === 'selection') {
          // Each selection prompt starts adding, with nothing to undo.
          boxMode = null
          removing = false
          picks = []
        }
        request = r.value
      }
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
    if (cmd.pickfirst && selection.ids.size > 0) {
      previous = [...selection.ids]
      say(`${previous.length} found`)
    } else if (!cmd.pickfirst && !cmd.noUndoGroup) selection.clear()
    grouped = !cmd.noUndoGroup
    if (grouped) doc.beginGroup(name)
    gen = cmd(ctx)
    step()
  }

  /** The prompt as shown now: a window waiting for its other corner, or Remove mode, change it. */
  function promptNow(): string {
    if (corner && (!gen || request?.kind === 'selection')) return 'Specify opposite corner:'
    if (request?.kind === 'selection') {
      if (boxMode) return 'Specify first corner:'
      if (removing) return 'Remove objects:'
    }
    return formatPrompt(request)
  }

  /** Echoes the answered prompt like AutoCAD's history, then hands the answer to the command. */
  function answer(input: Input, echo: string): void {
    say(`${promptNow()} ${echo}`.trimEnd())
    if (input.kind === 'point') lastPoint = input.p
    step(input)
  }

  /** Echoes what was typed, as AutoCAD keeps it in the history, then says why it was not taken. */
  function refuse(echo: string, message: string): void {
    say(`${promptNow()} ${echo}`.trimEnd())
    say(message)
  }

  /** A number for a number request, unless the request's limits refuse it. */
  function answerNumber(r: NumberRequest, value: number, echo: string): void {
    if (r.integer && !Number.isInteger(value)) return refuse(echo, 'Requires an integer value.')
    if (r.positive && !(value > 0)) return refuse(echo, 'Value must be positive and nonzero.')
    answer({ kind: 'number', value }, echo)
  }

  /**
   * A pointed (not typed) location as the active request will take it: the snap point when OSNAP finds one, else
   * squared to the base when ORTHO is on. At the Command prompt, while selecting and for picks, the raw location.
   */
  function resolve(raw: Vec2): { p: Vec2; snap: SnapHit | null } {
    const r = request
    // A number without a base takes no point (UNDO's count): nothing to snap.
    if (!r || (r.kind !== 'point' && r.kind !== 'number') || (r.kind === 'point' && r.pick) || (r.kind === 'number' && !r.base)) return { p: raw, snap: null }
    const hit = osnap ? (host.snap?.(raw, r.base) ?? null) : null
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
    const r = request!
    const k = matchKeyword(word, r.hidden ? [...(r.keywords ?? []), ...r.hidden] : r.keywords)
    if (k === undefined) return false
    answer({ kind: 'keyword', word: k }, text)
    return true
  }

  const EVERYTHING = { minX: -Infinity, minY: -Infinity, maxX: Infinity, maxY: Infinity }

  /** The selection options as AutoCAD spells them, each by its own abbreviation. */
  const SELECT_OPTIONS: Readonly<Record<string, string>> = {
    ALL: 'ALL', L: 'Last', LAST: 'Last', P: 'Previous', PREVIOUS: 'Previous', W: 'Window', WINDOW: 'Window',
    C: 'Crossing', CROSSING: 'Crossing', R: 'Remove', REMOVE: 'Remove', A: 'Add', ADD: 'Add', U: 'Undo', UNDO: 'Undo',
  }

  function selectOption(option: string, echo: string): void {
    const line = `${promptNow()} ${echo}`
    switch (option) {
      case 'ALL':
        return choose(host.pickBox?.(EVERYTHING, true) ?? [], removing, line)
      case 'Last': {
        // Ids grow with every new entity: the last one visible is the newest.
        const ids = host.pickBox?.(EVERYTHING, true) ?? []
        return choose(ids.length > 0 ? [ids[ids.length - 1]!] : [], removing, line)
      }
      case 'Previous':
        return choose(previous.filter((id) => doc.get(id) !== undefined), removing, line)
      case 'Window':
      case 'Crossing':
        say(line)
        boxMode = option === 'Window' ? 'window' : 'crossing'
        corner = null
        return
      case 'Remove':
      case 'Add':
        say(line)
        removing = option === 'Remove'
        return
      case 'Undo': {
        say(line)
        const op = picks.pop()
        if (!op) return say('All selection operations undone.')
        selection.remove(op.added)
        selection.add(op.removed)
        return
      }
    }
  }

  /**
   * Whether a command must wait for a file operation under way, as AutoCAD holds the drawing while it opens or
   * saves one: the drawing read would take the place of the command's (and cannot, inside its undo group).
   */
  function waits(echo: string): boolean {
    const busy = host.files?.busy() ?? null
    if (busy !== null) refuse(echo, `Wait: ${busy}`)
    return busy !== null
  }

  function onText(text: string): void {
    const t = parseInput(text)
    const echo = text.trim()
    if (!gen) {
      if (t.kind === 'empty') {
        if (last && !waits(echo)) start(last)
        return
      }
      const name = t.kind === 'word' ? resolveCommand(t.text, names, aliases) : undefined
      if (!name) refuse(echo, `Unknown command "${echo.toUpperCase()}".`)
      else if (!waits(echo)) start(name)
      return
    }
    const r = request!
    switch (r.kind) {
      case 'point': {
        if (t.kind === 'point') return answer({ kind: 'point', p: pointOf(t) }, echo)
        // "2x", ".5x": a scale factor, which the parser does not know as a word.
        if (r.acceptNumber && (t.kind === 'number' || SCALE_WORD.test(echo))) {
          return answer({ kind: 'number', value: t.kind === 'number' ? t.value : parseFloat(echo) }, echo)
        }
        if (t.kind === 'number' && r.base) {
          // Direct distance: along the rubber band, towards where the cursor would land (ORTHO squares it).
          const to = cursor ? resolve(cursor).p : r.base
          const d = Math.hypot(to.x - r.base.x, to.y - r.base.y)
          if (d === 0) return refuse(echo, 'Move the cursor to give the direction.')
          const k = t.value / d
          return answer({ kind: 'point', p: { x: r.base.x + (to.x - r.base.x) * k, y: r.base.y + (to.y - r.base.y) * k } }, echo)
        }
        if (t.kind === 'word' && keyword(t.text, echo)) return
        if (t.kind === 'empty' && r.allowEmpty) return answer({ kind: 'empty' }, '')
        return refuse(echo, r.keywords?.length ? 'Point or option keyword required.' : 'Invalid point.')
      }
      case 'number': {
        if (t.kind === 'word' && keyword(t.text, echo)) return
        if (t.kind === 'empty' && r.default !== undefined) return answerNumber(r, r.default, '')
        const value = t.kind === 'number' ? t.value : t.kind === 'point' && r.base ? measure(r, pointOf(t)) : undefined
        if (value === undefined) return refuse(echo, r.keywords?.length ? 'Requires a number or an option keyword.' : 'Requires a number.')
        return answerNumber(r, value, echo)
      }
      case 'keyword': {
        // A word, or a sign such as AutoCAD's "?" (list).
        if ((t.kind === 'word' || t.kind === 'invalid') && keyword(echo, echo)) return
        if (t.kind === 'empty' && r.default !== undefined) return answer({ kind: 'keyword', word: r.default }, '')
        if (t.kind === 'empty' && r.allowEmpty) return answer({ kind: 'empty' }, '')
        return refuse(echo, 'Invalid option keyword.')
      }
      case 'text': {
        if (r.spaces) return answer({ kind: 'text', text: text === '' ? (r.default ?? '') : text }, text)
        if (t.kind === 'empty') return answer({ kind: 'text', text: r.default ?? '' }, '')
        return answer({ kind: 'text', text: echo }, echo)
      }
      case 'selection': {
        if (t.kind === 'empty') {
          corner = null
          boxMode = null
          previous = [...selection.ids]
          return answer({ kind: 'selection', ids: previous }, '')
        }
        if (t.kind === 'point') return selectAt(pointOf(t), false, echo)
        const option = t.kind === 'word' ? SELECT_OPTIONS[t.text.toUpperCase()] : undefined
        if (option) return selectOption(option, echo)
        return refuse(echo, 'Expects a point or Window/Last/Crossing/ALL/Add/Remove/Previous/Undo.')
      }
    }
  }

  /**
   * Adds ids to the selection, or takes them out (Shift, Remove mode); at a selection prompt, says what happened
   * as AutoCAD does: "2 found (1 duplicate), 3 total", "1 found, 1 removed, 0 total".
   */
  function choose(ids: number[], remove: boolean, line: string | null): void {
    const before = selection.ids.size
    let message: string
    if (remove) {
      const hit = ids.filter((id) => selection.ids.has(id))
      selection.remove(hit)
      picks.push({ added: [], removed: hit })
      message = `${ids.length} found, ${hit.length} removed, ${selection.ids.size} total`
    } else {
      const fresh = ids.filter((id) => !selection.ids.has(id))
      selection.add(fresh)
      picks.push({ added: fresh, removed: [] })
      const dup = ids.length - fresh.length
      message = `${ids.length} found${dup > 0 ? ` (${dup} duplicate)` : ''}${before > 0 || dup > 0 ? `, ${selection.ids.size} total` : ''}`
    }
    if (line !== null) say(`${line} ${message}`)
  }

  /** A click (or typed point) when selecting, idle or at a selection prompt: an entity, or a window's corners. */
  function selectAt(p: Vec2, shift: boolean, echo = ''): void {
    const prompting = request?.kind === 'selection'
    const line = prompting ? `${promptNow()} ${echo}`.trimEnd() : null
    const remove = shift || (prompting && removing)
    if (corner) {
      // Left to right: window, only what lies inside. Right to left: crossing, also what touches. W and C force one.
      const b = { minX: Math.min(corner.x, p.x), minY: Math.min(corner.y, p.y), maxX: Math.max(corner.x, p.x), maxY: Math.max(corner.y, p.y) }
      const crossing = boxMode ? boxMode === 'crossing' : p.x < corner.x
      corner = null
      boxMode = null
      return choose(host.pickBox?.(b, crossing) ?? [], remove, line)
    }
    if (!boxMode) {
      const id = host.pick?.(p) ?? null
      if (id !== null) return choose([id], remove, line)
    }
    if (line !== null && echo !== '') say(line)
    corner = p
  }

  function onPoint(raw: Vec2, shift: boolean): void {
    if (!gen || request?.kind === 'selection') return selectAt(raw, shift)
    const r = request!
    const p = resolve(raw).p
    if (r.kind === 'point') return answer({ kind: 'point', p, shift }, '')
    if (r.kind === 'number' && r.base) return answerNumber(r, measure(r, p), '')
    if (r.kind === 'text' && r.acceptPoint) return answer({ kind: 'point', p }, '')
    refuse('', r.kind === 'number' ? 'Requires a number.' : r.kind === 'text' ? 'Requires a name.' : 'Invalid option keyword.')
  }

  return {
    get request() {
      return request
    },
    get command() {
      return active
    },
    get prompt() {
      return promptNow()
    },
    history,
    get said() {
      return said
    },
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
    get layer() {
      return layer
    },
    set layer(index) {
      if (index === layer) return
      ctx.setLayer(index)
      emit()
    },
    vars,
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
    get aliases() {
      return aliases
    },
    set aliases(next) {
      aliases = next
    },
    get tracked() {
      return cursor && resolve(cursor)
    },
    print(line) {
      say(line)
      emit()
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
    newDrawing() {
      lastPoint = { x: 0, y: 0 }
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
