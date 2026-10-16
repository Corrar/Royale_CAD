import type { Command } from '../runtime'
import { arc } from './arc'
import { circle } from './circle'
import { erase } from './erase'
import { extend } from './extend'
import { line } from './line'
import { pline } from './pline'
import { rectang } from './rectang'
import { copy, mirror, move, rotate, scale } from './transform'
import { trim } from './trim'
import { redo, u, undo } from './undo'
import { pan, zoom } from './view'

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
  TRIM: trim,
  EXTEND: extend,
  U: u,
  UNDO: undo,
  REDO: redo,
  ZOOM: zoom,
  PAN: pan,
}
