import { createDocument, docExtents } from '../document'
import type { Entity } from '../entity/types'
import { pick, pickBox } from '../pick'
import { SNAP, snap } from '../snap'
import { createSelection } from '../selection'
import { createSpatialIndex } from '../spatial'
import type { ViewState } from '../view'
import { BUILTIN_COMMANDS } from './commands'
import { createInterpreter, runScript, type Command, type FileHost, type InterpreterHost } from './runtime'

/** A document, a selection and an interpreter wired like the app, with a fake view; for tests. */
export function commandBench(commands: Readonly<Record<string, Command>> = BUILTIN_COMMANDS, opts: { snapModes?: number; files?: FileHost } = {}) {
  const snapModes = opts.snapModes ?? (SNAP.END | SNAP.MID | SNAP.CEN)
  const doc = createDocument()
  const selection = createSelection()
  const index = createSpatialIndex(doc)
  let view: ViewState = { cx: 0, cy: 0, scale: 10, width: 800, height: 600, dpr: 1 }
  const host: InterpreterHost = {
    getView: () => view,
    setView: (v) => {
      view = v
    },
    extents: () => docExtents(doc),
    pick: (p) => pick(doc, index, p, 0.25),
    pickBox: (b, crossing) => pickBox(doc, index, b, crossing),
    snap: (p, base) => snap(doc, index, p, view, snapModes, 10, base),
    query: (b) => index.query(b),
    ...(opts.files && { files: opts.files }),
  }
  const interp = createInterpreter(doc, selection, { commands, host })
  const round = (v: number): number => Math.round(v * 1e9) / 1e9 + 0
  return {
    doc,
    selection,
    interp,
    run: (script: string) => runScript(interp, script),
    click: (x: number, y: number, shift = false) => interp.feedPoint({ x, y }, shift),
    view: () => view,
    /** Lines as [x0, y0, x1, y1], rounded, in creation order. */
    lines: () =>
      [...doc.entities()]
        .filter((e): e is Extract<Entity, { type: 'line' }> => e.type === 'line')
        .map((e) => [e.x0, e.y0, e.x1, e.y1].map(round)),
    circles: () =>
      [...doc.entities()].filter((e): e is Extract<Entity, { type: 'circle' }> => e.type === 'circle').map((e) => [e.cx, e.cy, e.r].map(round)),
  }
}
