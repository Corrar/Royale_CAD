import { describe, expect, it } from 'vitest'
import { findTable } from './tables'
import { tokenize } from './tokenizer'

const dxf = (...lines: string[]): string => lines.join('\n') + '\n'

describe('findTable', () => {
  it('finds a table whose name comes after 999 comments', () => {
    const pairs = tokenize(dxf('0', 'TABLE', '999', 'layer table', '2', 'LAYER', '70', '1', '0', 'LAYER', '2', 'Walls', '0', 'ENDTAB'))
    expect(findTable(pairs, 0, pairs.length, 'LAYER')).toEqual({ table: 0, entries: [4], endtab: 6 })
    expect(findTable(pairs, 0, pairs.length, 'LTYPE')).toBeNull()
  })
})
