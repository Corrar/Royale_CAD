import type { Command } from '../runtime'
import { arc } from './arc'
import { circle } from './circle'
import { erase } from './erase'
import { extend } from './extend'
import { create, open, qsave, saveas } from './file'
import { line } from './line'
import { offset } from './offset'
import { pline } from './pline'
import { rectang } from './rectang'
import { copy, mirror, move, rotate, scale } from './transform'
import { trim } from './trim'
import { redo, u, undo } from './undo'
import { pan, zoom } from './view'

// Commands that take the selection made before them (noun-verb).
for (const c of [move, copy, rotate, mirror, scale, trim, extend]) c.pickfirst = true

/** Every built-in command by its canonical name. */
export const BUILTIN_COMMANDS: Readonly<Record<string, Command>> = {
  LINE: line,
  CIRCLE: circle,
  ARC: arc,
  PLINE: pline,
  RECTANG: rectang,
  ERASE: erase,
  MOVE: move,
  COPY: copy,
  ROTATE: rotate,
  MIRROR: mirror,
  SCALE: scale,
  OFFSET: offset,
  TRIM: trim,
  EXTEND: extend,
  U: u,
  UNDO: undo,
  REDO: redo,
  ZOOM: zoom,
  PAN: pan,
  OPEN: open,
  NEW: create,
  QSAVE: qsave,
  SAVEAS: saveas,
}
