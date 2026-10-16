import { describe, expect, it } from 'vitest'
import { createDocument } from '../kernel/document'
import type { Line } from '../kernel/entity/types'
import { decodeDxf } from './codec'
import { createFiles, parseHere, type FileApi, type Opened, type Saved } from './files'

const PLANT = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1015', '9', '$DWGCODEPAGE', '3', 'ANSI_1252', '0', 'ENDSEC',
  '0', 'SECTION', '2', 'ENTITIES', '0', 'LINE', '5', '2A', '8', 'Ação', '10', '0', '20', '0', '11', '10', '21', '0', '0', 'ENDSEC', '0', 'EOF', ''].join('\r\n')
const latin1 = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0))

/** A main process in a test: records the calls, answers with what the test sets. */
function fakeApi() {
  const calls: string[] = []
  const saved: Uint8Array[] = []
  let closeHandler: (() => void) | null = null
  const answers = { opened: null as Opened | null, saveAnswer: { name: 'Plant.dxf' } as Saved }
  const api: FileApi = {
    initial: async () => null,
    open: async () => {
      calls.push('open')
      return answers.opened
    },
    adopt: async (token: number) => void calls.push(`adopt ${token}`),
    save: async (bytes: Uint8Array, suggested: string) => {
      calls.push(`save ${suggested}`)
      saved.push(bytes)
      return answers.saveAnswer
    },
    saveAs: async (bytes: Uint8Array, suggested: string) => {
      calls.push(`saveAs ${suggested}`)
      saved.push(bytes)
      return answers.saveAnswer
    },
    forget: async () => void calls.push('forget'),
    setDirty: (d: boolean) => void calls.push(`dirty ${d}`),
    onSaveAndClose: (fn: () => void) => {
      closeHandler = fn
      return () => (closeHandler = null)
    },
    closeNow: () => void calls.push('closeNow'),
  }
  return { api, answers, calls, saved, requestClose: () => closeHandler?.() }
}

function setup() {
  const doc = createDocument()
  const lines: string[] = []
  let replaced = 0
  const fake = fakeApi()
  const files = createFiles({ api: fake.api, doc, parse: parseHere, print: (l) => lines.push(l), replaced: () => replaced++ })
  /** Lets the async operation started by a call finish. */
  const settle = () => new Promise((r) => setTimeout(r, 0))
  return { doc, files, lines, fake, settle, replaced: () => replaced }
}

describe('createFiles', () => {
  it('OPEN reads the file, puts the drawing in place and adopts the file; nothing is dirty', async () => {
    const t = setup()
    t.fake.answers.opened = { token: 7, name: 'Plant.dxf', bytes: latin1(PLANT.replace('Ação', 'A\xe7\xe3o')) }
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
    t.fake.answers.opened = { token: 1, name: 'Plant.dxf', bytes: latin1(PLANT.replace('Ação', 'A\xe7\xe3o')) }
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
    t.fake.answers.opened = { token: 2, name: 'Bad.dxf', bytes: latin1('0\r\nSECTION\r\n2\r\nENTITIES\r\n10\r\n') }
    t.files.open(false)
    await t.settle()
    expect(t.doc.size).toBe(1)
    expect(t.lines).toEqual(['Could not open Bad.dxf: line 6: group code 10 has no value (file truncated?)'])
    expect(t.fake.calls).not.toContain('adopt 2')
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
    t.fake.answers.opened = { token: 3, name: 'Plant.dxf', bytes: latin1(PLANT) }
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
