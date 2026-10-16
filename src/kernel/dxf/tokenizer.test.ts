import { describe, expect, it } from 'vitest'
import { DxfError, sections, tokenize as tokenizeList, type Pair } from './tokenizer'

const dxf = (...lines: string[]): string => lines.join('\n') + '\n'
/** The pairs as objects, to compare. */
const tokenize = (text: string): Pair[] => {
  const list = tokenizeList(text)
  return Array.from({ length: list.length }, (_, i) => list.pair(i))
}

describe('tokenize', () => {
  it('reads code/value pairs; CRLF and LF give the same pairs', () => {
    const lf = dxf('0', 'SECTION', '2', 'ENTITIES', '0', 'ENDSEC', '0', 'EOF')
    const pairs = tokenize(lf)
    expect(pairs).toEqual([
      { code: 0, value: 'SECTION' },
      { code: 2, value: 'ENTITIES' },
      { code: 0, value: 'ENDSEC' },
      { code: 0, value: 'EOF' },
    ])
    expect(tokenize(lf.replace(/\n/g, '\r\n'))).toEqual(pairs)
  })

  it('takes codes padded with spaces, and keeps values as written', () => {
    expect(tokenize('  0\r\nLINE\r\n 10 \r\n  1.5\r\n  1\r\n two  words \r\n')).toEqual([
      { code: 0, value: 'LINE' },
      { code: 10, value: '  1.5' },
      { code: 1, value: ' two  words ' },
    ])
  })

  it('grows past its first guess of the number of pairs', () => {
    const lines: string[] = []
    for (let i = 0; i < 100; i++) lines.push('1', String(i))
    const pairs = tokenize(lines.join('\n'))
    expect(pairs).toHaveLength(100)
    expect(pairs[99]).toEqual({ code: 1, value: '99' })
  })

  it('gives where each pair starts in the text, CRLF and BOM included', () => {
    const list = tokenizeList('\uFEFF  0\r\nLINE\r\n  8\r\n0\r\n  0\r\nEOF')
    expect([0, 1, 2, 3].map((i) => list.offset(i))).toEqual([1, 12, 20, 28])
    expect(list.text.slice(list.offset(1), list.offset(2))).toBe('  8\r\n0\r\n')
    expect(tokenizeList('').offset(0)).toBe(0)
  })

  it('stops at EOF; a byte order mark and a final newline are not content', () => {
    expect(tokenize('﻿0\nEOF\ntrailing junk')).toEqual([{ code: 0, value: 'EOF' }])
    expect(tokenize('999\nmade by hand')).toEqual([{ code: 999, value: 'made by hand' }])
    expect(tokenize('')).toEqual([])
  })

  it('a file cut after a group code is an error that names the line', () => {
    const text = dxf('0', 'SECTION', '2', 'ENTITIES', '0', 'LINE', '10')
    expect(() => tokenize(text)).toThrow(DxfError)
    expect(() => tokenize(text)).toThrow('line 8: group code 10 has no value (file truncated?)')
    try {
      tokenize(text)
    } catch (error) {
      expect((error as DxfError).line).toBe(8)
    }
  })

  it('a group code that is not an integer is an error that names the line', () => {
    expect(() => tokenize(dxf('0', 'SECTION', 'abc', 'x'))).toThrow('line 3: invalid group code "abc"')
    expect(() => tokenize(dxf('0', 'SECTION', '12345', 'x'))).toThrow('line 3: invalid group code "12345"')
    expect(tokenize(dxf(' -5 ', 'x'))).toEqual([{ code: -5, value: 'x' }])
    expect(() => tokenize(dxf('0', 'SECTION', '', 'x'))).toThrow('line 3: invalid group code ""')
  })

  it('refuses binary DXF', () => {
    expect(() => tokenize('AutoCAD Binary DXF\r\n\u001a\u0000...')).toThrow('line 1: binary DXF is not supported')
  })

  it('quotes at most 40 characters of a line: a file without line breaks is one long line', () => {
    const long = ' 12345' + 'x'.repeat(100_000)
    expect(messageOf(() => tokenize(long))).toBe(`line 1: invalid group code "${long.trim().slice(0, 40)}…"`)
    expect(messageOf(() => sections(tokenizeList(dxf('0', 'y'.repeat(1000)))))).toBe(`line 1: expected 0/SECTION, found 0/${'y'.repeat(40)}…`)
  })

  it('refuses a file whose lines end in CR alone (classic Mac OS) in a short message', () => {
    const cr = ['0', 'SECTION', '2', 'ENTITIES', '0', 'ENDSEC', '0', 'EOF'].join('\r') + '\r'
    expect(messageOf(() => tokenize(cr))).toBe('line 1: lines end in CR alone (classic Mac OS), which is not supported')
  })
})

/** The message of what f throws; '' when it does not. */
function messageOf(f: () => unknown): string {
  try {
    f()
  } catch (error) {
    return (error as Error).message
  }
  return ''
}

describe('sections', () => {
  it('names each section and the range of its pairs, between the name and ENDSEC', () => {
    const pairs = tokenizeList(
      dxf('999', 'comment', '0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1015', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES', '0', 'ENDSEC', '0', 'EOF'),
    )
    expect(sections(pairs)).toEqual([
      { name: 'HEADER', section: 1, start: 3, end: 5 },
      { name: 'ENTITIES', section: 6, start: 8, end: 8 },
    ])
    expect(pairs.pair(3)).toEqual({ code: 9, value: '$ACADVER' })
    // Text spans: pair 1 starts on line 3; the end is past the last line break.
    const text = pairs.text
    expect(text.slice(pairs.offset(1), pairs.offset(3))).toBe('0\nSECTION\n2\nHEADER\n')
    expect(pairs.offset(pairs.length)).toBe(text.length)
    expect(pairs.is(2, 2, 'HEADER')).toBe(true)
    expect(pairs.is(2, 0, 'HEADER')).toBe(false)
  })

  it('steps over 999 comments between 0/SECTION and its name', () => {
    const pairs = tokenizeList(dxf('0', 'SECTION', '999', 'made by hand', '999', 'twice', '2', 'ENTITIES', '0', 'ENDSEC', '0', 'EOF'))
    expect(sections(pairs)).toEqual([{ name: 'ENTITIES', section: 0, start: 4, end: 4 }])
  })

  it('a section cut short is an error that names the line where the file ends', () => {
    const pairs = tokenizeList(dxf('0', 'SECTION', '2', 'ENTITIES', '0', 'LINE', '8', '0'))
    expect(() => sections(pairs)).toThrow('line 9: section ENTITIES is not closed (file truncated?)')
  })

  it('a section without its ENDSEC is an error at the 0/SECTION or 0/EOF that comes first, not a section swallowing the next', () => {
    const blocks = tokenizeList(dxf('0', 'SECTION', '2', 'BLOCKS', '0', 'BLOCK', '2', 'A', '0', 'ENDBLK', '0', 'SECTION', '2', 'ENTITIES', '0', 'ENDSEC', '0', 'EOF'))
    expect(() => sections(blocks)).toThrow('line 11: section BLOCKS is not closed (0/SECTION before 0/ENDSEC)')
    const header = tokenizeList(dxf('0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1015', '0', 'SECTION', '2', 'TABLES', '0', 'ENDSEC', '0', 'EOF'))
    expect(() => sections(header)).toThrow('line 9: section HEADER is not closed (0/SECTION before 0/ENDSEC)')
    const entities = tokenizeList(dxf('0', 'SECTION', '2', 'ENTITIES', '0', 'LINE', '8', '0', '0', 'EOF'))
    expect(() => sections(entities)).toThrow('line 9: section ENTITIES is not closed (0/EOF before 0/ENDSEC)')
  })

  it('a file without 0/EOF is an error at its end: cut after an ENDSEC, or empty', () => {
    expect(() => sections(tokenizeList(dxf('0', 'SECTION', '2', 'HEADER', '0', 'ENDSEC')))).toThrow('line 7: 0/EOF missing (file truncated?)')
    expect(() => sections(tokenizeList(dxf('999', 'comment')))).toThrow('line 3: 0/EOF missing (file truncated?)')
    expect(() => sections(tokenizeList(''))).toThrow('line 1: 0/EOF missing (file truncated?)')
    expect(sections(tokenizeList(dxf('0', 'EOF')))).toEqual([])
  })

  it('anything but a section at the top level is an error', () => {
    expect(() => sections(tokenizeList(dxf('0', 'LINE', '8', '0')))).toThrow('line 1: expected 0/SECTION, found 0/LINE')
    expect(() => sections(tokenizeList(dxf('0', 'SECTION', '8', '0')))).toThrow('line 3: a section starts with its name (code 2)')
  })
})
