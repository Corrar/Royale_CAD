import { describe, expect, it } from 'vitest'
import { decodeDxf, encodeDxf, encodingOf } from './codec'

/** A small DXF whose layer name carries the text, in a version and code page. */
const dxf = (version: string, codepage: string | null, layer: string): string =>
  ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', version, ...(codepage ? ['9', '$DWGCODEPAGE', '3', codepage] : []), '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES', '0', 'LINE', '8', layer, '0', 'ENDSEC', '0', 'EOF', ''].join('\r\n')

/** Bytes of a string in windows-1252, as an old AutoCAD wrote them. */
const cp1252 = (s: string): Uint8Array => Uint8Array.from(s, (c) => ({ ç: 0xe7, ã: 0xe3, é: 0xe9, Ç: 0xc7 })[c] ?? c.charCodeAt(0))

describe('encodingOf', () => {
  it('UTF-8 from AC1021 on, the code page before, windows-1252 by default, null when unknown', () => {
    expect(encodingOf('AC1032', 'ANSI_1251')).toBe('utf-8')
    expect(encodingOf('AC1015', 'ANSI_1251')).toBe('windows-1251')
    expect(encodingOf('AC1015', 'ansi_932')).toBe('shift_jis')
    expect(encodingOf('AC1009', null)).toBe('windows-1252')
    expect(encodingOf('AC1015', 'DOS437')).toBeNull()
  })
})

describe('decodeDxf and encodeDxf', () => {
  it('ANSI_1252 with accents reads right and writes back the same bytes', () => {
    const bytes = cp1252(dxf('AC1015', 'ANSI_1252', 'Ação é Ç'))
    const d = decodeDxf(bytes)
    expect(d).toMatchObject({ encoding: 'windows-1252', warning: null })
    expect(d.text).toContain('\r\nAção é Ç\r\n')
    expect(encodeDxf(d.text, d.encoding)).toEqual(bytes)
  })

  it('AC1021 and later are UTF-8; a byte order mark wins', () => {
    const text = dxf('AC1032', 'ANSI_1252', 'Ação 日本')
    const bytes = new TextEncoder().encode(text)
    expect(decodeDxf(bytes)).toEqual({ text, encoding: 'utf-8', warning: null })
    expect(encodeDxf(text, 'utf-8')).toEqual(bytes)
    expect(decodeDxf(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(dxf('AC1015', 'ANSI_1252', 'ç'))])).text).toContain('\r\nç\r\n')
  })

  it('a byte order mark before AC1021 is read as UTF-8, and the file written back in the code page its header names', () => {
    const text = dxf('AC1015', 'ANSI_1252', 'Ação Δ')
    const d = decodeDxf(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)]))
    expect(d).toEqual({ text, encoding: 'windows-1252', warning: null })
    // Read again without the mark, as every reader does from the header: the same text, Δ escaped as AutoCAD does.
    const back = decodeDxf(encodeDxf(d.text, d.encoding))
    expect(back.encoding).toBe('windows-1252')
    expect(back.text).toBe(text.replace('Δ', '\\U+0394'))
  })

  it('a double-byte code page round-trips', () => {
    const text = dxf('AC1015', 'ANSI_932', '日本語ﾃｽﾄ')
    const bytes = encodeDxf(text, 'shift_jis')
    expect(bytes.length).toBeLessThan(new TextEncoder().encode(text).length) // two bytes a kanji, one a half-width kana
    expect(decodeDxf(bytes).text).toBe(text)
  })

  it('a character the code page lacks is written as \\U+XXXX', () => {
    expect(new TextDecoder().decode(encodeDxf('a日b', 'windows-1252'))).toBe('a\\U+65E5b')
  })

  it('a file from AC1021 on that is not UTF-8 (a writer that kept the code page) reads in its code page, and saves back the same', () => {
    const bytes = cp1252(dxf('AC1027', 'ANSI_1252', 'Ação'))
    const d = decodeDxf(bytes)
    expect(d.text).toContain('\r\nAção\r\n')
    expect(d.encoding).toBe('windows-1252')
    expect(d.warning).toBe('The file is not valid UTF-8, as files from AutoCAD 2007 on are: it was read, and is saved, as windows-1252.')
    expect(encodeDxf(d.text, d.encoding)).toEqual(bytes)
    // No code page named: windows-1252, which takes every byte.
    expect(decodeDxf(cp1252(dxf('AC1032', null, 'é')))).toMatchObject({ encoding: 'windows-1252' })
  })

  it('bytes that are not valid in a double-byte code page are said: a save cannot give them back', () => {
    const text = dxf('AC1015', 'ANSI_932', '日本')
    const ok = encodeDxf(text, 'shift_jis')
    const at = ok.indexOf(0x93) // the lead byte of 日, with a trail byte no lead byte takes
    const bytes = new Uint8Array(ok)
    bytes[at + 1] = 0x7f
    const d = decodeDxf(bytes)
    expect(d.encoding).toBe('shift_jis')
    expect(d.warning).toBe('Some bytes are not valid shift_jis: they were read as �, which a save writes in their place.')
    expect(decodeDxf(ok).warning).toBeNull()
  })

  it('an unknown code page reads as windows-1252, with a warning', () => {
    const d = decodeDxf(cp1252(dxf('AC1015', 'DOS437', 'é')))
    expect(d.encoding).toBe('windows-1252')
    expect(d.warning).toBe('Code page DOS437 is not supported: the text was read as windows-1252.')
  })
})
