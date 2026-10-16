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
  // As the controller does when a drawing is put in place.
  const replaced = (currentLayer: string | null): void => {
    t.selection.clear()
    t.interp.newDrawing()
    const i = currentLayer === null ? -1 : t.doc.layers.indexOf(currentLayer)
    t.interp.layer = i >= 0 ? i : 0
  }
  files = createFiles({
    api: fake.api, doc: t.doc, parse, print: (l) => t.interp.print(l), replaced,
    currentLayer: () => t.doc.layers.get(t.interp.layer)!.name,
    watch: (fn) => t.interp.onChange(fn),
  })
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

  it('a layer name with a character the code page lacks comes back from a save as it went in', async () => {
    const t = setup()
    t.fake.answers.opened = { token: 1, name: 'Plant.dxf', size: 0, bytes: latin1(PLANT.replace('Ação', '\\U+0394-COTA')) }
    t.files.open(false)
    await t.settle()
    t.doc.layers.add({ name: 'Ω', color: 1, visible: true, locked: false })
    t.files.save()
    await t.settle()
    expect(decodeDxf(t.fake.saved[0]!).text).toContain('\r\n\\U+03A9\r\n')
    t.fake.answers.opened = { token: 2, name: 'Plant.dxf', size: 0, bytes: t.fake.saved[0]! }
    t.files.open(false)
    await t.settle()
    expect([1, 2].map((i) => t.doc.layers.get(i)!.name)).toEqual(['Δ-COTA', 'Ω'])
    expect(t.lines).toEqual(['Opened Plant.dxf: 1 object.', 'Saved Plant.dxf.', 'Opened Plant.dxf: 1 object.'])
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

  it("TEXT's height is the drawing's: $TEXTSIZE when opened, 2.5 when new, kept in the file when saved", async () => {
    const fake = fakeApi()
    const doc = createDocument()
    const given: number[] = []
    let size = 0.2
    const files = createFiles({
      api: fake.api, doc, parse: parseHere, print: () => {}, replaced: (_layer, textSize) => given.push(textSize), currentLayer: () => '0', textSize: () => size,
    })
    const settle = () => new Promise((r) => setTimeout(r, 0))
    const imperial = PLANT.replace('ANSI_1252\r\n', 'ANSI_1252\r\n9\r\n$TEXTSIZE\r\n40\r\n0.2\r\n')
    fake.answers.opened = { token: 1, name: 'Imperial.dxf', size: 0, bytes: latin1(imperial) }
    files.open(false)
    await settle()
    expect(given).toEqual([0.2])
    // Unchanged, the header stays as read; changed, it says the new height.
    files.save()
    await settle()
    expect(decodeDxf(fake.saved[0]!).text).toContain('$TEXTSIZE\r\n40\r\n0.2\r\n')
    size = 5
    files.save()
    await settle()
    expect(decodeDxf(fake.saved[1]!).text).toContain('$TEXTSIZE\r\n40\r\n5.0\r\n')
    files.create(false)
    await settle()
    expect(given).toEqual([0.2, 2.5])
    size = 2.5
    files.save()
    await settle()
    expect(decodeDxf(fake.saved[2]!).text).toContain('$TEXTSIZE\r\n 40\r\n2.5\r\n')
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

describe('the current layer and the file', () => {
  it('making another layer current is a change, as AutoCAD counts CLAYER: closing asks, and a save keeps it', async () => {
    const t = benchSetup()
    // A file whose current layer is Ação: putting it in place sets that one, which is no change.
    t.fake.answers.opened = { token: 3, name: 'Plant.dxf', size: 0, bytes: latin1(PLANT.replace('$DWGCODEPAGE', '$CLAYER\r\n  8\r\nA\xe7\xe3o\r\n  9\r\n$DWGCODEPAGE')) }
    t.run('OPEN⏎')
    for (let k = 0; k < 10 && t.files.state.get().busy !== null; k++) await t.settle()
    expect(t.doc.layers.get(t.interp.layer)!.name).toBe('Ação')
    expect(t.files.dirty()).toBe(false)
    t.run('-LAYER⏎S⏎0⏎⏎')
    expect(t.files.dirty()).toBe(true)
    expect(t.fake.calls.at(-1)).toBe('dirty true')
    t.run('QSAVE⏎')
    await t.settle()
    expect(t.files.dirty()).toBe(false)
    expect(decodeDxf(t.fake.saved[0]!).text).toMatch(/\$CLAYER\r\n {2}8\r\n0\r\n/)
    // The same layer made current again changes nothing.
    t.interp.layer = 0
    expect(t.files.dirty()).toBe(false)
    t.run('NEW⏎')
    await t.settle()
    expect(t.files.dirty()).toBe(false)
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

  it("the current layer is one of the file's as soon as its layers are in, not an index into the table before", async () => {
    const t = benchSetup(async (bytes, progress) => {
      const r = await parseHere(bytes, progress)
      const lines = Array.from({ length: 2000 }, (_, k) => ({ type: 'line' as const, layer: 0, x0: k, y0: 0, x1: k, y1: 1 }))
      return { ...r, pack: packDrafts(lines) }
    })
    t.doc.layers.add({ name: 'X', color: 1, visible: true, locked: false })
    t.doc.layers.add({ name: 'Y', color: 1, visible: true, locked: false })
    t.interp.layer = 2
    // Plant.dxf has two layers, 0 and Ação: the layer panel, which shows the current one, renders while it comes in.
    t.fake.answers.opened = { token: 4, name: 'Plant.dxf', size: 0, bytes: latin1(PLANT) }
    const seen: (string | undefined)[] = []
    const offLayers = t.doc.layers.onChange(() => seen.push(t.doc.layers.get(t.interp.layer)?.name))
    let clock = 0
    const now = vi.spyOn(performance, 'now').mockImplementation(() => (clock += 10))
    try {
      const off = t.doc.onChange((c) => {
        if (!c.bulk) return
        off()
        seen.push(t.doc.layers.get(t.interp.layer)?.name)
        // A key pressed meanwhile (refused) is no change to the drawing coming in.
        t.run('L⏎')
      })
      t.run('OPEN⏎N⏎')
      for (let k = 0; k < 20 && t.files.state.get().busy !== null; k++) await t.settle()
    } finally {
      now.mockRestore()
      offLayers()
    }
    expect(t.interp.history.at(-1)).toBe('Opened Plant.dxf: 2000 objects.')
    expect(seen.length).toBeGreaterThan(1)
    expect(seen).not.toContain(undefined)
    expect(t.files.state.get()).toEqual({ name: 'Plant.dxf', dirty: false, busy: null })
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

  it('after NEW or OPEN, @ starts from 0,0 in the drawing put in place, not from a point of the one before', async () => {
    const held = heldParse()
    const t = benchSetup(held.parse)
    t.run('L⏎500,500⏎600,600⏎⏎')
    t.run('NEW⏎N⏎')
    await t.settle()
    t.run('L⏎@10,0⏎@0,10⏎⏎')
    expect(t.lines()).toEqual([[10, 0, 10, 10]])
    t.fake.answers.opened = { token: 9, name: 'Plant.dxf', size: 0, bytes: latin1(PLANT) }
    t.run('OPEN⏎N⏎')
    await t.settle()
    // A click on nothing while the file is read begins a window, in the drawing that goes.
    t.click(-50, -50)
    expect(t.interp.corner).toEqual({ x: -50, y: -50 })
    held.release()
    for (let k = 0; k < 10 && t.files.state.get().busy !== null; k++) await t.settle()
    expect(t.interp.corner).toBeNull()
    t.run('L⏎@3,4⏎@1,0⏎⏎')
    expect(t.lines()).toEqual([[0, 0, 10, 0], [3, 4, 4, 4]])
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
