import { TRUE_COLOR, type Color } from '../color'
import type { PairList } from './tokenizer'

/** A table of the TABLES section: its 0/TABLE pair, the 0 pair of each entry, and its 0/ENDTAB pair. */
export interface TableRange { table: number; entries: number[]; endtab: number }

/** The table `name` (LAYER, BLOCK_RECORD…) among the pairs [start, end); null when the file has none. */
export function findTable(pairs: PairList, start: number, end: number, name: string): TableRange | null {
  for (let i = start; i + 1 < end; i++) {
    if (!pairs.is(i, 0, 'TABLE') || !pairs.is(i + 1, 2, name)) continue
    const entries: number[] = []
    let j = i + 1
    for (; j < end && !pairs.is(j, 0, 'ENDTAB'); j++) if (pairs.code(j) === 0) entries.push(j)
    return { table: i, entries, endtab: j }
  }
  return null
}

/** Where entry k of a table ends: at the next entry, or at ENDTAB. */
export const entryEnd = (t: TableRange, k: number): number => t.entries[k + 1] ?? t.endtab

/** The first value of group `code` among the pairs [a, b), trimmed; null when absent. */
export function groupValue(pairs: PairList, a: number, b: number, code: number): string | null {
  for (let i = a + 1; i < b; i++) if (pairs.code(i) === code) return pairs.value(i).trim()
  return null
}

/** A LAYER entry as the document sees it, with the raw flags and color it was derived from. */
export interface LayerEntry {
  name: string
  color: Color
  visible: boolean
  locked: boolean
  /** Group 70: 1 frozen, 4 locked. */
  flags: number
  /** Group 62: negative when the layer is off. */
  aci: number
}

/** Reads the LAYER entry [a, b); unreadable numbers take their defaults. */
export function layerEntry(pairs: PairList, a: number, b: number): LayerEntry {
  let name = ''
  let aci = 7
  let trueColor: number | undefined
  let flags = 0
  for (let k = a + 1; k < b; k++) {
    const v = Number(pairs.value(k))
    switch (pairs.code(k)) {
      case 2:
        name = pairs.value(k).trim()
        break
      case 62:
        if (Number.isFinite(v)) aci = v
        break
      case 420:
        if (Number.isFinite(v)) trueColor = v
        break
      case 70:
        if (Number.isFinite(v)) flags = v
        break
    }
  }
  const a62 = Math.abs(aci)
  const color = trueColor !== undefined ? TRUE_COLOR | (trueColor & 0xffffff) : Number.isInteger(a62) && a62 >= 1 && a62 <= 255 ? a62 : 7
  // Off (negative color) and frozen (flag 1) both hide the layer.
  return { name, color, visible: aci >= 0 && !(flags & 1), locked: (flags & 4) !== 0, flags, aci }
}
