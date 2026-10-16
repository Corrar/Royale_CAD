import { describe, expect, it, vi } from 'vitest'
import type { FileHost } from '../kernel/command/runtime'
import { commandBench } from '../kernel/command/testing'
import { createDocument } from '../kernel/document'
import type { Line } from '../kernel/entity/types'
import { readDxf } from '../kernel/dxf/reader'
import { decodeDxf } from './codec'
import { packDrafts } from '../kernel/dxf/pack'
import { createFiles, parseHere, type FileApi, type Files, type Opened, type Parse, type Saved } from './files'

const PLANT = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1015', '9', '$DWGCODEPAGE', '3', 'ANSI_1252', '0', 'ENDSEC',
  '0', 'SECTION', '2', 'ENTITIES', '0', 'LINE', '5', '2A', '8', 'Ação', '10', '0', '20', '0', '11', '10', '21', '0', '0', 'ENDSEC', '0', 'EOF', ''].join('\r\n')
const latin1 = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0))

/** A main process in a test: records the calls, answers with what the test sets. */
function fakeApi() {
  const calls: string[] = []
  const saved: Uint8Array[] = []
  let closeHandler: (() => void) | null = null
  const answers = { opened: null as (Opened & { bytes: Uint8Array }) | null, saveAnswer: { name: 'Plant.dxf' } as Saved, holdSave: false }
  // With holdSave, a save answers only when the test lets it: the main process is still writing the file.
  let held: (() => void) | null = null
  const answer = (): Promise<Saved> =>
    answers.holdSave ? new Promise((r) => (held = () => r(answers.saveAnswer))) : Promise.resolve(answers.saveAnswer)
  const api: FileApi = {
    initial: async () => null,
    open: async () => {
      calls.push('open')
      return answers.opened && { token: answers.opened.token, name: answers.opened.name, size: answers.opened.bytes.length }
    },
    chunk: async (_token: number, offset: number, length: number) => answers.opened!.bytes.slice(offset, offset + length),
    adopt: async (token: number) => void calls.push(`adopt ${token}`),
    save: async (bytes: Uint8Array, suggested: string) => {
      calls.push(`save ${suggested}`)
      saved.push(bytes)
      return answer()
    },
    saveAs: async (bytes: Uint8Array, suggested: string) => {
      calls.push(`saveAs ${suggested}`)
      saved.push(bytes)
      return answer()
    },
    forget: async () => void calls.push('forget'),
    setDirty: (d: boolean) => void calls.push(`dirty ${d}`),
    onSaveAndClose: (fn: () => void) => {
      closeHandler = fn
      return () => (closeHandler = null)
    },
    closeNow: () => void calls.push('closeNow'),
  }
  return { api, answers, calls, saved, requestClose: () => closeHandler?.(), finishSave: () => held?.() }
}

function setup(parse: Parse = parseHere) {
  const doc = createDocument()
  const lines: string[] = []
  let replaced = 0
  const fake = fakeApi()
  const files = createFiles({ api: fake.api, doc, parse, print: (l) => lines.push(l), replaced: () => replaced++, currentLayer: () => '0' })
  /** Lets the async operation started by a call finish. */
  const settle = () => new Promise((r) => setTimeout(r, 0))
  return { doc, files, lines, fake, settle, replaced: () => replaced }
}

/** A parse that ends when the test lets it: a big file in the worker. */
function heldParse() {
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => (release = r))
  const parse: Parse = async (bytes, progress) => {
    await gate
    return parseHere(bytes, progress)
  }
  return { parse, release: () => release() }
}

/** The interpreter and the files on one document, as the app wires them: commands typed while files work. */
function benchSetup(parse: Parse = parseHere) {
  const fake = fakeApi()
  let files: Files | null = null
  const host: FileHost = {
    name: () => files!.name(),
    dirty: () => files!.dirty(),
    busy: () => files!.busy(),
    open: (saveFirst) => files!.open(saveFirst),
    create: (saveFirst) => files!.create(saveFirst),
    save: () => files!.save(),
    saveAs: () => files!.saveAs(),
  }
  const t = commandBench(undefined, { files: host })
  files = createFiles({ api: fake.api, doc: t.doc, parse, print: (l) => t.interp.print(l), replaced: () => t.selection.clear(), currentLayer: () => '0' })
  const settle = () => new Promise((r) => setTimeout(r, 0))
  /** The entities of the file saved k-th, read back. */
  const savedSize = (k: number): number => readDxf(decodeDxf(fake.saved[k]!).text).doc.size
  return { ...t, files, fake, settle, savedSize }
}

describe('createFiles', () => {
  it('OPEN reads the file, puts the drawing in place and adopts the file; nothing is dirty', async () => {
    const t = setup()
    t.fake.answers.opened = { token: 7, name: 'Plant.dxf', size: 0, bytes: latin1(PLANT.replace('Ação', 'A\xe7\xe3o')) }
    t.files.open(false)
    await t.settle()
    expect(t.doc.size).toBe(1)
    expect(t.doc.layers.get(1)!.name).toBe('Ação')
    expect(t.files.state.get()).toEqual({ name: 'Plant.dxf', dirty: false, busy: null })
    expect(t.fake.calls).toEqual(['open', 'adopt 7'])
    expect(t.lines).toEqual(['Opened Plant.dxf: 1 object.'])
    expect(t.replaced()).toBe(1)
  })

  it('an edit makes it dirty (told once); saving writes the file back in its code page and cleans it', async () => {
    const t = setup()
    t.fake.answers.opened = { token: 1, name: 'Plant.dxf', size: 0, bytes: latin1(PLANT.replace('Ação', 'A\xe7\xe3o')) }
    t.files.open(false)
    await t.settle()
    const line = [...t.doc.entities()][0] as Line
    t.doc.transact('edit', (tx) => tx.replace({ ...line, x1: 20 }))
    t.doc.transact('edit', (tx) => tx.replace({ ...line, x1: 30 }))
    expect(t.files.dirty()).toBe(true)
    t.files.save()
    await t.settle()
    expect(t.fake.calls).toEqual(['open', 'adopt 1', 'dirty true', 'save Plant.dxf', 'dirty false'])
    const written = decodeDxf(t.fake.saved[0]!)
    expect(written.encoding).toBe('windows-1252')
    expect(written.text).toContain('\r\nAção\r\n')
    expect(written.text).toContain(' 11\r\n30.0\r\n')
    expect(t.lines.at(-1)).toBe('Saved Plant.dxf.')
  })

  it('a file before AC1021 with a UTF-8 byte order mark is saved in its code page: it reads back the same', async () => {
    const t = setup()
    const utf8 = new TextEncoder().encode(PLANT)
    t.fake.answers.opened = { token: 1, name: 'Plant.dxf', size: 0, bytes: new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]) }
    t.files.open(false)
    await t.settle()
    expect(t.doc.layers.get(1)!.name).toBe('Ação')
    t.doc.layers.add({ name: 'Seção', color: 1, visible: true, locked: false })
    t.files.save()
    await t.settle()
    const written = decodeDxf(t.fake.saved[0]!)
    expect(written.encoding).toBe('windows-1252')
    expect(written.text).toContain('\r\nAção\r\n')
    expect(written.text).toContain('\r\nSeção\r\n')
    // Opened again: the same names.
    t.fake.answers.opened = { token: 2, name: 'Plant.dxf', size: 0, bytes: t.fake.saved[0]! }
    t.files.open(false)
    await t.settle()
    expect([1, 2].map((i) => t.doc.layers.get(i)!.name)).toEqual(['Ação', 'Seção'])
  })

  it('a failed or cancelled save keeps the changes and stops what was to follow', async () => {
    const t = setup()
    t.doc.transact('draw', (tx) => void tx.add({ type: 'line', layer: 0, x0: 0, y0: 0, x1: 1, y1: 1 }))
    t.fake.answers.saveAnswer = { error: 'disk full' }
    t.files.open(true)
    await t.settle()
    expect(t.fake.calls).toEqual(['dirty true', 'save Drawing1.dxf'])
    expect(t.lines).toEqual(['Could not save Drawing1.dxf: disk full'])
    t.fake.answers.saveAnswer = null
    t.files.saveAs()
    await t.settle()
    expect(t.lines.at(-1)).toBe('Save cancelled.')
    expect(t.files.dirty()).toBe(true)
  })

  it('a file that does not parse leaves the drawing alone and says why', async () => {
    const t = setup()
    t.doc.transact('draw', (tx) => void tx.add({ type: 'line', layer: 0, x0: 0, y0: 0, x1: 1, y1: 1 }))
    t.fake.answers.opened = { token: 2, name: 'Bad.dxf', size: 0, bytes: latin1('0\r\nSECTION\r\n2\r\nENTITIES\r\n10\r\n') }
    t.files.open(false)
    await t.settle()
    expect(t.doc.size).toBe(1)
    expect(t.lines).toEqual(['Could not open Bad.dxf: line 6: group code 10 has no value (file truncated?)'])
    expect(t.fake.calls).not.toContain('adopt 2')
  })

  it('a file that fails partway leaves an empty new drawing, not half of it under the old name', async () => {
    let broken = false
    // The second slice of a broken file holds a circle of radius 0: the document refuses it.
    const t = setup(async (bytes, progress) => {
      const r = await parseHere(bytes, progress)
      if (!broken) return r
      const lines = Array.from({ length: 2000 }, (_, k) => ({ type: 'line' as const, layer: 0, x0: k, y0: 0, x1: k, y1: 1 }))
      return { ...r, pack: packDrafts([...lines, { type: 'circle', layer: 0, cx: 0, cy: 0, r: 0 }]) }
    })
    t.fake.answers.opened = { token: 4, name: 'Plant.dxf', size: 0, bytes: latin1(PLANT) }
    t.files.open(false)
    await t.settle()
    broken = true
    t.fake.answers.opened = { token: 5, name: 'Broken.dxf', size: 0, bytes: latin1(PLANT) }
    t.files.open(false)
    for (let k = 0; k < 10 && t.files.state.get().busy !== null; k++) await t.settle()
    expect(t.lines.at(-1)).toMatch(/^Could not open Broken\.dxf: /)
    expect(t.doc.size).toBe(0)
    expect(t.files.state.get()).toEqual({ name: 'Drawing2.dxf', dirty: false, busy: null })
    expect(t.fake.calls).not.toContain('adopt 5')
    expect(t.fake.calls.at(-1)).toBe('forget')
  })

  it('an edit made while a file comes in counts: the drawing is dirty once it has loaded', async () => {
    const t = setup()
    t.fake.answers.opened = { token: 6, name: 'Plant.dxf', size: 0, bytes: latin1(PLANT) }
    // An edit between two slices of the file: here, in the middle of the first one.
    const off = t.doc.onChange((c) => {
      if (!c.bulk) return
      off()
      t.doc.transact('draw', (tx) => void tx.add({ type: 'line', layer: 0, x0: 5, y0: 5, x1: 6, y1: 6 }))
    })
    t.files.open(false)
    await t.settle()
    expect(t.doc.size).toBe(2)
    expect(t.files.state.get()).toEqual({ name: 'Plant.dxf', dirty: true, busy: null })
  })

  it('NEW begins an empty drawing with the next name; the file is forgotten', async () => {
    const t = setup()
    t.doc.layers.add({ name: 'A', color: 1, visible: true, locked: false })
    t.doc.transact('draw', (tx) => void tx.add({ type: 'line', layer: 1, x0: 0, y0: 0, x1: 1, y1: 1 }))
    t.files.create(false)
    await t.settle()
    expect(t.doc.size).toBe(0)
    expect(t.doc.layers.size).toBe(1)
    expect(t.files.state.get()).toEqual({ name: 'Drawing2.dxf', dirty: false, busy: null })
    expect(t.fake.calls).toEqual(['dirty true', 'dirty false', 'forget'])
  })

  it('one operation at a time; a close request saves, then lets the window close', async () => {
    const t = setup()
    t.fake.answers.opened = { token: 3, name: 'Plant.dxf', size: 0, bytes: latin1(PLANT) }
    t.files.open(false)
    t.files.save()
    expect(t.lines).toEqual(['Wait: Working…'])
    await t.settle()
    t.doc.transact('draw', (tx) => void tx.add({ type: 'line', layer: 0, x0: 0, y0: 0, x1: 1, y1: 1 }))
    t.fake.requestClose()
    await t.settle()
    expect(t.fake.calls.slice(-3)).toEqual(['save Plant.dxf', 'dirty false', 'closeNow'])
  })
})

describe('createFiles while the drawing changes', () => {
  const line = (x: number) => ({ type: 'line' as const, layer: 0, x0: x, y0: 0, x1: x + 1, y1: 1 })

  it('an edit made while the file is being written is not in it: the drawing stays dirty', async () => {
    const t = setup()
    t.doc.transact('draw', (tx) => void tx.add(line(0)))
    t.fake.answers.holdSave = true
    t.files.save()
    await t.settle()
    expect(t.files.state.get().busy).toBe('Saving Drawing1.dxf…')
    t.doc.transact('draw', (tx) => void tx.add(line(5)))
    t.fake.finishSave()
    await t.settle()
    expect(readDxf(decodeDxf(t.fake.saved[0]!).text).doc.size).toBe(1)
    expect(t.doc.size).toBe(2)
    expect(t.files.state.get()).toEqual({ name: 'Plant.dxf', dirty: true, busy: null })
    // The main process heard dirty once and never clean: closing the window still asks.
    expect(t.fake.calls).toEqual(['dirty true', 'save Drawing1.dxf'])
    expect(t.lines).toEqual(['Saved Plant.dxf, without the changes made while it was being written.'])
  })

  it('so does an undo, and an edit to a drawing that was clean when the save began', async () => {
    const t = setup()
    t.doc.transact('draw', (tx) => void tx.add(line(0)))
    t.files.save()
    await t.settle()
    expect(t.files.dirty()).toBe(false)
    t.fake.answers.holdSave = true
    t.files.save()
    await t.settle()
    t.doc.undo()
    t.fake.finishSave()
    await t.settle()
    expect(t.doc.size).toBe(0)
    expect(t.files.dirty()).toBe(true)
    expect(t.fake.calls.slice(-2)).toEqual(['save Plant.dxf', 'dirty true'])
    // Nothing changed during the next save: it cleans the drawing.
    t.fake.answers.holdSave = false
    t.files.save()
    await t.settle()
    expect(t.files.dirty()).toBe(false)
    expect(t.lines.at(-1)).toBe('Saved Plant.dxf.')
  })

  it('NEW after Save does not drop what changed while the save was being written', async () => {
    const t = setup()
    t.doc.transact('draw', (tx) => void tx.add(line(0)))
    t.fake.answers.holdSave = true
    t.files.create(true)
    await t.settle()
    t.doc.transact('draw', (tx) => void tx.add(line(5)))
    t.fake.finishSave()
    await t.settle()
    expect(t.doc.size).toBe(2)
    expect(t.files.state.get()).toEqual({ name: 'Plant.dxf', dirty: true, busy: null })
    expect(t.fake.calls).not.toContain('forget')
  })

  it('a change made while the file is read keeps the drawing: the file is not opened', async () => {
    const held = heldParse()
    const t = setup(held.parse)
    t.doc.transact('draw', (tx) => void tx.add(line(0)))
    t.fake.answers.opened = { token: 9, name: 'Plant.dxf', size: 0, bytes: latin1(PLANT) }
    // OPEN, and No to "Save changes?"; then, while the file is read, a layer from the layer panel.
    t.files.open(false)
    await t.settle()
    t.doc.layers.add({ name: 'Walls', color: 1, visible: true, locked: false })
    held.release()
    for (let k = 0; k < 10 && t.files.state.get().busy !== null; k++) await t.settle()
    expect(t.doc.size).toBe(1)
    expect(t.doc.layers.get(1)?.name).toBe('Walls')
    expect(t.files.state.get()).toEqual({ name: 'Drawing1.dxf', dirty: true, busy: null })
    expect(t.fake.calls).not.toContain('adopt 9')
    expect(t.lines).toEqual(['Plant.dxf was not opened: the drawing changed while it was being read.'])
    // OPEN again asks about the drawing as it is now; the file then comes in.
    held.release()
    t.files.open(false)
    for (let k = 0; k < 10 && t.files.state.get().busy !== null; k++) await t.settle()
    expect(t.lines.at(-1)).toBe('Opened Plant.dxf: 1 object.')
    expect(t.files.state.get()).toEqual({ name: 'Plant.dxf', dirty: false, busy: null })
  })

  it('a close request does not close a window whose drawing changed while it was saved', async () => {
    const t = benchSetup()
    t.run('L⏎0,0⏎5,5⏎')
    t.fake.answers.holdSave = true
    // Save, in the main process's close dialog, while LINE is still asking for points.
    t.fake.requestClose()
    await t.settle()
    t.run('10,0⏎⏎')
    t.fake.finishSave()
    await t.settle()
    expect(t.savedSize(0)).toBe(1)
    expect(t.doc.size).toBe(2)
    expect(t.fake.calls).not.toContain('closeNow')
    expect(t.files.dirty()).toBe(true)
    // Asked again, the save has everything: now the window closes.
    t.fake.answers.holdSave = false
    t.fake.requestClose()
    await t.settle()
    expect(t.savedSize(1)).toBe(2)
    expect(t.fake.calls.slice(-2)).toEqual(['dirty false', 'closeNow'])
  })
})

describe('commands while a file operation is under way', () => {
  it('none starts while a file is read, as AutoCAD holds the drawing while it opens one: the open completes', async () => {
    const held = heldParse()
    const t = benchSetup(held.parse)
    t.fake.answers.opened = { token: 9, name: 'Plant.dxf', size: 0, bytes: latin1(PLANT) }
    t.run('OPEN⏎')
    await t.settle()
    expect(t.files.state.get().busy).toBe('Reading Plant.dxf… 40%')
    // Enter repeats OPEN; L would begin a LINE, whose undo group the drawing read could not replace.
    t.run('⏎')
    t.run('L⏎')
    held.release()
    for (let k = 0; k < 10 && t.files.state.get().busy !== null; k++) await t.settle()
    expect(t.interp.history.slice(-5)).toEqual([
      'Command:', 'Wait: Reading Plant.dxf… 40%', 'Command: L', 'Wait: Reading Plant.dxf… 40%', 'Opened Plant.dxf: 1 object.',
    ])
    expect(t.fake.calls).toContain('adopt 9')
    expect(t.files.state.get()).toEqual({ name: 'Plant.dxf', dirty: false, busy: null })
    // Once it is in, commands start again.
    t.run('L⏎0,0⏎5,5⏎⏎')
    expect(t.doc.size).toBe(2)
  })

  it('nor while the slices of a file come in', async () => {
    const t = benchSetup(async (bytes, progress) => {
      const r = await parseHere(bytes, progress)
      const lines = Array.from({ length: 2000 }, (_, k) => ({ type: 'line' as const, layer: 0, x0: k, y0: 0, x1: k, y1: 1 }))
      return { ...r, pack: packDrafts(lines) }
    })
    t.fake.answers.opened = { token: 4, name: 'Big.dxf', size: 0, bytes: latin1(PLANT) }
    // The clock moves 10 ms at each look: one step of drafts per slice, then the UI's turn.
    let clock = 0
    const now = vi.spyOn(performance, 'now').mockImplementation(() => (clock += 10))
    try {
      const off = t.doc.onChange((c) => {
        if (!c.bulk) return
        off()
        t.run('L⏎')
      })
      t.run('OPEN⏎')
      for (let k = 0; k < 20 && t.files.state.get().busy !== null; k++) await t.settle()
    } finally {
      now.mockRestore()
    }
    expect(t.interp.history).toEqual(['Command: OPEN', 'Command: L', 'Wait: Reading Big.dxf… 90%', 'Opened Big.dxf: 2000 objects.'])
    expect(t.files.state.get()).toEqual({ name: 'Big.dxf', dirty: false, busy: null })
    expect(t.doc.size).toBe(2000)
  })

  it('nor while the drawing is saved before NEW: the new drawing begins', async () => {
    const t = benchSetup()
    t.run('L⏎0,0⏎5,5⏎⏎')
    t.fake.answers.holdSave = true
    t.run('NEW⏎Y⏎')
    await t.settle()
    t.run('C⏎')
    t.fake.finishSave()
    await t.settle()
    expect(t.interp.history.slice(-3)).toEqual(['Command: C', 'Wait: Saving Drawing1.dxf…', 'Saved Plant.dxf.'])
    expect(t.doc.size).toBe(0)
    expect(t.files.state.get()).toEqual({ name: 'Drawing2.dxf', dirty: false, busy: null })
    expect(t.fake.calls.at(-1)).toBe('forget')
  })

  it('a command already under way when a save begins goes on', async () => {
    const t = benchSetup()
    t.run('L⏎0,0⏎5,5⏎')
    t.fake.answers.holdSave = true
    t.files.save()
    await t.settle()
    t.run('10,0⏎⏎')
    t.fake.finishSave()
    await t.settle()
    expect(t.lines()).toEqual([[0, 0, 5, 5], [5, 5, 10, 0]])
  })
})
