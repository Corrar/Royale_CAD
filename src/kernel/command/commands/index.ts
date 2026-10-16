import type { Command } from '../runtime'
import { arc } from './arc'
import { circle } from './circle'
import { erase } from './erase'
import { line } from './line'
import { pline } from './pline'
import { rectang } from './rectang'
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
  U: u,
  UNDO: undo,
  REDO: redo,
  ZOOM: zoom,
  PAN: pan,
}
