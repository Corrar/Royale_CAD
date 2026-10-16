import type { FileHost } from '../kernel/command/runtime'
import type { Document, Draft } from '../kernel/document'
import { packDrafts, unpackDrafts, type DraftPack } from '../kernel/dxf/pack'
import { typeOf } from '../kernel/entity/registry'
import type { Entity } from '../kernel/entity/types'
import { bboxEmpty, bboxUnion, type BBox } from '../kernel/geom/vec'
import { loader, parseDxf, type DxfSource, type ParsedMeta } from '../kernel/dxf/reader'
import { textSizeOf } from '../kernel/dxf/template'
import { writeDxf } from '../kernel/dxf/writer'
import { DEFAULT_ENCODING, decodeDxf, encodeDxf } from './codec'
import { createStore, type Store } from './stores'

/**
 * A file the main process read for us: its bytes come in chunks (chunk), and `token` makes it the drawing's file
 * once it has loaded (adopt).
 */
export interface Opened { token: number; name: string; size: number }

/** Where a save went, why it failed, or null when the user cancelled the dialog. */
export type Saved = { name: string } | { error: string } | null

/** What the preload exposes as window.royale. Paths stay in the main process: the renderer sees names. */
export interface FileApi {
  /** The file given on the command line (--open), once; null without one. */
  initial(): Promise<Opened | null>
  /** Asks for a DXF and reads it; null when cancelled. */
  open(): Promise<Opened | null>
  /** Bytes [offset, offset + length) of the file read last; after the last chunk the main process lets them go. */
  chunk(token: number, offset: number, length: number): Promise<Uint8Array>
  /** The opened file became the drawing: later saves go to it. */
  adopt(token: number): Promise<void>
  /** To the drawing's file, or to one asked for when it has none. */
  save(bytes: Uint8Array, suggested: string): Promise<Saved>
  /** To a file asked for, which then is the drawing's. */
  saveAs(bytes: Uint8Array, suggested: string): Promise<Saved>
  /** The drawing has no file any more (NEW). */
  forget(): Promise<void>
  /** Tells the main process, which asks before closing a window with unsaved changes. */
  setDirty(dirty: boolean): void
  /** The main process wants the drawing saved before it closes the window. */
  onSaveAndClose(fn: () => void): () => void
  /** Saved: the window may close. */
  closeNow(): void
}

/**
 * A parsed file as a worker hands it over: the drafts packed in typed arrays, the file's bytes back instead of
 * its text (a 100 MB string takes most of a second to copy across; the bytes move), the extents for the view.
 */
export interface ParseResult {
  meta: Omit<ParsedMeta, 'text'>
  pack: DraftPack
  bytes: Uint8Array
  encoding: string
  warning: string | null
  extents: BBox | null
}

function extentsOf(drafts: readonly Draft[]): BBox | null {
  let box: BBox | null = null
  for (const d of drafts) {
    const b = typeOf(d as Entity).bbox(d as Entity)
    if (!bboxEmpty(b)) box = box ? bboxUnion(box, b) : b
  }
  return box
}

/** Splits a parsed file for the hand-over. */
export function toResult(parsed: ReturnType<typeof parseDxf>, bytes: Uint8Array, encoding: string, warning: string | null): ParseResult {
  const { drafts, text: _text, ...meta } = parsed
  return { meta, pack: packDrafts(drafts), bytes, encoding, warning, extents: extentsOf(drafts) }
}

/** Bytes to a parsed drawing; the app runs it in a worker. */
export type Parse = (bytes: Uint8Array, progress: (done: number) => void) => Promise<ParseResult>

/** The same work on this thread: for tests, and where workers are missing. */
export const parseHere: Parse = async (bytes, progress) => {
  const { text, encoding, warning } = decodeDxf(bytes)
  return toResult(parseDxf(text, progress), bytes, encoding, warning)
}

/** Lets the thread draw a frame and take input between slices of work. */
const yieldToUI = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** The time one slice of loading may take, ms: frames keep coming at ~60 Hz even on a big file. */
const SLICE_MS = 12
/** Drafts between looks at the clock while loading. */
const SLICE_STEP = 512
/** Bytes per message from the main process: each one copies quickly. */
const CHUNK_BYTES = 8 << 20

export interface FileState {
  /** The drawing's file name, or DrawingN.dxf before its first save. */
  name: string
  dirty: boolean
  /** What a file operation under way is doing ("Reading Plant.dxf… 40%"); null when idle. */
  busy: string | null
}

export interface FilesOptions {
  api: FileApi
  doc: Document
  parse: Parse
  /** A line in the command history. */
  print(line: string): void
  /**
   * A drawing was put in place (opened or new): the view frames it (extents when known, else the app works them
   * out), the selection goes, its layer is current, its text height ($TEXTSIZE) is TEXT's default.
   */
  replaced(currentLayer: string | null, textSize: number, extents?: BBox | null): void
  /** The current layer's name, which the file keeps ($CLAYER). */
  currentLayer(): string
  /** TEXT's default height, which the file keeps ($TEXTSIZE); without it the file's stays as it was. */
  textSize?(): number | undefined
}

declare global {
  interface Window {
    /** Set by the preload in the app; absent in a plain browser (and in the bench). */
    royale?: FileApi
  }
}

/** Warnings shown after a load; the rest are counted. */
const WARNINGS_SHOWN = 5

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export type Files = FileHost & { readonly state: Store<FileState>; openInitial(): Promise<void>; dispose(): void }

/** The drawing's file: open, save, save as and new, with the dialogs and the reading done elsewhere. */
export function createFiles(o: FilesOptions): Files {
  const { api, doc } = o
  let untitled = 1
  const state = createStore<FileState>({ name: `Drawing${untitled}.dxf`, dirty: false, busy: null })
  const patch = (p: Partial<FileState>): void => state.set({ ...state.get(), ...p })
  let source: DxfSource | null = null
  let encoding = DEFAULT_ENCODING
  /** Changes made now put another drawing in place: they are not edits. */
  let quiet = false
  /** Edits so far: a save that took the drawing before the last one did not write it. */
  let edits = 0

  const setDirty = (dirty: boolean): void => {
    if (state.get().dirty === dirty) return
    patch({ dirty })
    api.setDirty(dirty)
  }
  const edited = (): void => {
    edits++
    setDirty(true)
  }
  // The slices of a file being read (bulk) are not edits either; what is drawn meanwhile is.
  const offDoc = doc.onChange((c) => {
    if (!quiet && !c.bulk) edited()
  })
  const offLayers = doc.layers.onChange(() => {
    if (!quiet) edited()
  })
  const quietly = <T>(fn: () => T): T => {
    quiet = true
    try {
      return fn()
    } finally {
      quiet = false
    }
  }

  /** Runs one file operation at a time. */
  const run = (task: () => Promise<void>): Promise<void> => {
    if (state.get().busy !== null) {
      o.print(`Wait: ${state.get().busy}`)
      return Promise.resolve()
    }
    patch({ busy: 'Working…' })
    return task()
      .catch((error: unknown) => o.print(`Error: ${messageOf(error)}`))
      .finally(() => patch({ busy: null }))
  }

  /** Puts another drawing in place at once. */
  const replace = (fn: () => void): void => {
    quietly(fn)
    setDirty(false)
    o.replaced(source?.header.get('$CLAYER') ?? null, textSizeOf(source?.header))
  }

  /** Whether the file now holds the drawing: false when not saved, or when it changed while being written. */
  async function save(asNew: boolean): Promise<boolean> {
    const name = state.get().name
    patch({ busy: `Saving ${name}…` })
    const kept = { currentLayer: o.currentLayer(), textSize: o.textSize?.() }
    const bytes = encodeDxf(writeDxf(doc, source ?? undefined, kept), encoding)
    const taken = edits
    const r = await (asNew ? api.saveAs(bytes, name) : api.save(bytes, name))
    if (r === null) {
      o.print('Save cancelled.')
      return false
    }
    if ('error' in r) {
      o.print(`Could not save ${name}: ${r.error}`)
      return false
    }
    patch({ name: r.name })
    // The UI stays live while the main process writes: what was drawn meanwhile is not in the file, and keeps the
    // drawing dirty (closing still asks; what was to follow the save does not go on).
    const whole = edits === taken
    setDirty(!whole)
    o.print(whole ? `Saved ${r.name}.` : `Saved ${r.name}, without the changes made while it was being written.`)
    return whole
  }

  /** Reads f in place of the drawing as it was at `asked` edits (when the user chose to leave it). */
  async function load(f: Opened, asked: number): Promise<void> {
    patch({ busy: `Reading ${f.name}…` })
    let result: ParseResult
    try {
      const bytes = new Uint8Array(f.size)
      for (let at = 0; at < f.size; ) {
        const chunk = await api.chunk(f.token, at, CHUNK_BYTES)
        if (chunk.length === 0) throw new Error('the file ended early')
        bytes.set(chunk, at)
        at += chunk.length
        patch({ busy: `Reading ${f.name}… ${Math.round((40 * at) / f.size)}%` })
      }
      performance.mark('royale:bytes')
      result = await o.parse(bytes, (done) => patch({ busy: `Reading ${f.name}… ${40 + Math.round(done * 50)}%` }))
    } catch (error) {
      o.print(`Could not open ${f.name}: ${messageOf(error)}`)
      return
    }
    // A change made during the read (the layer panel stays live) was not in what the user chose to leave.
    if (edits !== asked) {
      o.print(`${f.name} was not opened: the drawing changed while it was being read.`)
      return
    }
    let warnings: readonly string[] = []
    performance.mark('royale:parsed')
    // The text is decoded again here only when it is needed: the bytes came back, the text did not.
    let text: string | null = null
    const meta: ParsedMeta = {
      ...result.meta,
      get text() {
        return (text ??= decodeDxf(result.bytes).text)
      },
    }
    let gone = false
    try {
      const l = quietly(() => loader(doc, meta))
      // The drawing before is gone: what is drawn from here on belongs to this one.
      gone = true
      source = null
      setDirty(false)
      const { pack } = result
      // Slices of the drafts, each as long as fits in SLICE_MS: the UI keeps drawing while a big file comes in.
      for (let k = 0; k < pack.n; ) {
        const t = performance.now()
        while (k < pack.n && performance.now() - t < SLICE_MS) {
          const to = Math.min(pack.n, k + SLICE_STEP)
          l.add(unpackDrafts(pack, k, to))
          k = to
        }
        patch({ busy: `Reading ${f.name}… ${90 + Math.round((10 * k) / pack.n)}%` })
        if (k < pack.n) await yieldToUI()
      }
      const d = l.finish()
      source = d.source
      warnings = d.warnings
    } catch (error) {
      // Part of this one came in: neither half may be saved over a file.
      if (gone) await blank()
      o.print(`Could not open ${f.name}: ${messageOf(error)}`)
      return
    }
    o.replaced(source.header.get('$CLAYER') ?? null, textSizeOf(source.header), result.extents)
    performance.mark('royale:loaded', { detail: { objects: doc.size } })
    encoding = result.encoding
    patch({ name: f.name })
    await api.adopt(f.token)
    o.print(`Opened ${f.name}: ${doc.size} ${doc.size === 1 ? 'object' : 'objects'}.`)
    if (result.warning) o.print(result.warning)
    for (const w of warnings.slice(0, WARNINGS_SHOWN)) o.print(w)
    if (warnings.length > WARNINGS_SHOWN) o.print(`…and ${warnings.length - WARNINGS_SHOWN} more.`)
  }

  /** An empty drawing with the next name, tied to no file. */
  async function blank(): Promise<void> {
    source = null
    replace(() => void doc.replace([{ name: '0', color: 7, visible: true, locked: false }], []))
    encoding = DEFAULT_ENCODING
    patch({ name: `Drawing${++untitled}.dxf` })
    await api.forget()
  }

  const offClose = api.onSaveAndClose(() => {
    void run(async () => {
      if (await save(false)) api.closeNow()
    })
  })

  return {
    state,
    name: () => state.get().name,
    dirty: () => state.get().dirty,
    busy: () => state.get().busy,
    open(saveFirst) {
      void run(async () => {
        const asked = edits
        if (saveFirst && !(await save(false))) return
        performance.mark('royale:open')
        const f = await api.open()
        if (f) await load(f, asked)
      })
    },
    create(saveFirst) {
      void run(async () => {
        if (saveFirst && !(await save(false))) return
        await blank()
      })
    },
    save() {
      void run(async () => void (await save(false)))
    },
    saveAs() {
      void run(async () => void (await save(true)))
    },
    openInitial: () =>
      run(async () => {
        const asked = edits
        performance.mark('royale:open')
        const f = await api.initial()
        if (f) await load(f, asked)
      }),
    dispose() {
      offDoc()
      offLayers()
      offClose()
    },
  }
}
