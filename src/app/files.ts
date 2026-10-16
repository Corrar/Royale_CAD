import type { FileHost } from '../kernel/command/runtime'
import type { Document } from '../kernel/document'
import { drawingFrom, parseDxf, type DxfSource, type ParsedDxf } from '../kernel/dxf/reader'
import { writeDxf } from '../kernel/dxf/writer'
import { DEFAULT_ENCODING, decodeDxf, encodeDxf } from './codec'
import { createStore, type Store } from './stores'

/** A file the main process read for us; `token` makes it the drawing's file once it has loaded (adopt). */
export interface Opened { token: number; name: string; bytes: Uint8Array }

/** Where a save went, why it failed, or null when the user cancelled the dialog. */
export type Saved = { name: string } | { error: string } | null

/** What the preload exposes as window.royale. Paths stay in the main process: the renderer sees names. */
export interface FileApi {
  /** The file given on the command line (--open), once; null without one. */
  initial(): Promise<Opened | null>
  /** Asks for a DXF and reads it; null when cancelled. */
  open(): Promise<Opened | null>
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

export interface ParseResult { parsed: ParsedDxf; encoding: string; warning: string | null }

/** Bytes to a parsed drawing; the app runs it in a worker. */
export type Parse = (bytes: Uint8Array, progress: (done: number) => void) => Promise<ParseResult>

/** The same work on this thread: for tests, and where workers are missing. */
export const parseHere: Parse = async (bytes, progress) => {
  const { text, encoding, warning } = decodeDxf(bytes)
  return { parsed: parseDxf(text, progress), encoding, warning }
}

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
  /** A drawing was put in place (opened or new): the view frames it, the selection goes, its layer is current. */
  replaced(currentLayer: string | null): void
  /** The current layer's name, which the file keeps ($CLAYER). */
  currentLayer(): string
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
  let replacing = false

  const setDirty = (dirty: boolean): void => {
    if (state.get().dirty === dirty) return
    patch({ dirty })
    api.setDirty(dirty)
  }
  const offDoc = doc.onChange(() => {
    if (!replacing) setDirty(true)
  })
  const offLayers = doc.layers.onChange(() => {
    if (!replacing) setDirty(true)
  })

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

  const replace = (fn: () => void): void => {
    replacing = true
    try {
      fn()
    } finally {
      replacing = false
    }
    setDirty(false)
    o.replaced(source?.header.get('$CLAYER') ?? null)
  }

  async function save(asNew: boolean): Promise<boolean> {
    const name = state.get().name
    patch({ busy: `Saving ${name}…` })
    const bytes = encodeDxf(writeDxf(doc, source ?? undefined, { currentLayer: o.currentLayer() }), encoding)
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
    setDirty(false)
    o.print(`Saved ${r.name}.`)
    return true
  }

  async function load(f: Opened): Promise<void> {
    patch({ busy: `Reading ${f.name}…` })
    let result: ParseResult
    try {
      result = await o.parse(f.bytes, (done) => patch({ busy: `Reading ${f.name}… ${Math.round(done * 100)}%` }))
    } catch (error) {
      o.print(`Could not open ${f.name}: ${messageOf(error)}`)
      return
    }
    let warnings: readonly string[] = []
    replace(() => {
      const d = drawingFrom(doc, result.parsed)
      source = d.source
      warnings = d.warnings
    })
    encoding = result.encoding
    patch({ name: f.name })
    await api.adopt(f.token)
    o.print(`Opened ${f.name}: ${doc.size} ${doc.size === 1 ? 'object' : 'objects'}.`)
    if (result.warning) o.print(result.warning)
    for (const w of warnings.slice(0, WARNINGS_SHOWN)) o.print(w)
    if (warnings.length > WARNINGS_SHOWN) o.print(`…and ${warnings.length - WARNINGS_SHOWN} more.`)
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
    open(saveFirst) {
      void run(async () => {
        if (saveFirst && !(await save(false))) return
        const f = await api.open()
        if (f) await load(f)
      })
    },
    create(saveFirst) {
      void run(async () => {
        if (saveFirst && !(await save(false))) return
        source = null
        replace(() => doc.replace([{ name: '0', color: 7, visible: true, locked: false }], []))
        encoding = DEFAULT_ENCODING
        patch({ name: `Drawing${++untitled}.dxf` })
        await api.forget()
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
        const f = await api.initial()
        if (f) await load(f)
      }),
    dispose() {
      offDoc()
      offLayers()
      offClose()
    },
  }
}
