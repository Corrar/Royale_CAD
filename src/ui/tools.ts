import {
  ArrowRightToLine, Circle, Copy, Eraser, Fullscreen, Hand, Move, RectangleHorizontal, Redo2, RotateCw, Scaling,
  Scissors, Slash, SquareCenterlineDashedVertical, Type, Undo2, Waypoints, createLucideIcon, type LucideIcon,
} from 'lucide-react'
import { DEFAULT_ALIASES } from '../kernel/command/aliases'

/** An arc between its two ends, in Lucide's grid and stroke. */
const Arc = createLucideIcon('cad-arc', [
  ['path', { d: 'M5 19A14 14 0 0 1 19 5', key: 'arc' }],
  ['circle', { cx: '5', cy: '19', r: '2', key: 'start' }],
  ['circle', { cx: '19', cy: '5', r: '2', key: 'end' }],
])

/** A corner and its offset, parallel at a distance. */
const Offset = createLucideIcon('cad-offset', [
  ['path', { d: 'M3 13h6a4 4 0 0 0 4-4V3', key: 'inner' }],
  ['path', { d: 'M3 20h6a11 11 0 0 0 11-11V3', key: 'outer' }],
])

/** The shortest alias that types command (as AutoCAD's acad.pgp lists them); undefined when it has none. */
export function aliasOf(command: string): string | undefined {
  let best: string | undefined
  for (const [alias, target] of Object.entries(DEFAULT_ALIASES)) {
    if (target === command && (best === undefined || alias.length < best.length)) best = alias
  }
  return best
}

export interface Tool {
  label: string
  /** What the button types: the command, then its answers (ZOOM, E). */
  inputs: readonly string[]
  icon: LucideIcon
  /** What to type for it, as the tooltip shows it. */
  typed: string
  /** The tooltip in words: the label and what to type. */
  hint: string
}

function tool(label: string, inputs: readonly string[], icon: LucideIcon, shortcut?: string): Tool {
  const [command, ...rest] = inputs
  const typed = [aliasOf(command!) ?? command!, ...rest].join(' ') + (shortcut ? `, ${shortcut}` : '')
  return { label, inputs, icon, typed, hint: `${label} (${typed})` }
}

/** The floating toolbars, top left, as AutoCAD's Draw and Modify toolbars. */
export const TOOLBARS: readonly { name: string; tools: readonly Tool[] }[] = [
  {
    name: 'Draw',
    tools: [
      tool('Line', ['LINE'], Slash),
      tool('Polyline', ['PLINE'], Waypoints),
      tool('Circle', ['CIRCLE'], Circle),
      tool('Arc', ['ARC'], Arc),
      tool('Rectangle', ['RECTANG'], RectangleHorizontal),
      tool('Text', ['TEXT'], Type),
    ],
  },
  {
    name: 'Modify',
    tools: [
      tool('Move', ['MOVE'], Move),
      tool('Copy', ['COPY'], Copy),
      tool('Rotate', ['ROTATE'], RotateCw),
      tool('Mirror', ['MIRROR'], SquareCenterlineDashedVertical),
      tool('Scale', ['SCALE'], Scaling),
      tool('Offset', ['OFFSET'], Offset),
      tool('Trim', ['TRIM'], Scissors),
      tool('Extend', ['EXTEND'], ArrowRightToLine),
      tool('Erase', ['ERASE'], Eraser),
    ],
  },
  {
    name: 'View',
    tools: [
      tool('Undo', ['U'], Undo2, 'Ctrl+Z'),
      tool('Redo', ['REDO'], Redo2, 'Ctrl+Y'),
      tool('Zoom extents', ['ZOOM', 'E'], Fullscreen),
      tool('Pan', ['PAN'], Hand),
    ],
  },
]
