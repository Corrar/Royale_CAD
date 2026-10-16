/** $DWGCODEPAGE values and the WHATWG encodings that decode them. */
const CODEPAGES: Readonly<Record<string, string>> = {
  ANSI_874: 'windows-874',
  ANSI_932: 'shift_jis',
  ANSI_936: 'gbk',
  ANSI_949: 'euc-kr',
  ANSI_950: 'big5',
  ANSI_1250: 'windows-1250',
  ANSI_1251: 'windows-1251',
  ANSI_1252: 'windows-1252',
  ANSI_1253: 'windows-1253',
  ANSI_1254: 'windows-1254',
  ANSI_1255: 'windows-1255',
  ANSI_1256: 'windows-1256',
  ANSI_1257: 'windows-1257',
  ANSI_1258: 'windows-1258',
  ISO8859_1: 'windows-1252',
}

/** What new files, and files that name no code page, are written in. */
export const DEFAULT_ENCODING = 'windows-1252'

/** The encoding a DXF is in: UTF-8 from AC1021 (2007) on; before that its code page. Null when unknown. */
export function encodingOf(version: string | null, codepage: string | null): string | null {
  if (version !== null && version >= 'AC1021') return 'utf-8'
  if (codepage === null) return DEFAULT_ENCODING
  return CODEPAGES[codepage.toUpperCase()] ?? null
}

/** The first value of a header variable, read from the start of the text. */
function headerValue(head: string, name: string): string | null {
  const m = new RegExp(`\\${name}\\s*\\r?\\n\\s*\\d+\\s*\\r?\\n([^\\r\\n]*)`).exec(head)
  return m ? m[1]!.trim() : null
}

export interface Decoded {
  text: string
  encoding: string
  /** Set when the code page is unknown and the text was read as windows-1252. */
  warning: string | null
}

/** The text of a DXF file. A UTF-8 byte order mark wins; otherwise the header decides. */
export function decodeDxf(bytes: Uint8Array): Decoded {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8', warning: null }
  // The header is ASCII: any single-byte reading of the start finds it.
  const head = new TextDecoder('windows-1252').decode(bytes.subarray(0, 1 << 16))
  const codepage = headerValue(head, '$DWGCODEPAGE')
  const known = encodingOf(headerValue(head, '$ACADVER'), codepage)
  const encoding = known ?? DEFAULT_ENCODING
  const warning = known ? null : `Code page ${codepage} is not supported: the text was read as ${DEFAULT_ENCODING}.`
  return { text: new TextDecoder(encoding).decode(bytes), encoding, warning }
}

/** Per encoding: each character it can write, and its bytes. Built once, by decoding every byte and byte pair. */
const tables = new Map<string, Map<string, number[]>>()

function tableOf(encoding: string): Map<string, number[]> {
  let t = tables.get(encoding)
  if (t) return t
  t = new Map()
  const dec = new TextDecoder(encoding)
  const take = (bytes: number[]): void => {
    const s = dec.decode(new Uint8Array(bytes))
    if (s.length === 1 && s !== '�' && !t!.has(s)) t!.set(s, bytes)
  }
  for (let b = 0; b < 256; b++) take([b])
  // Double-byte code pages: a lead byte from 0x81 on and a trail byte from 0x40 on.
  if (['shift_jis', 'gbk', 'euc-kr', 'big5'].includes(encoding)) {
    for (let lead = 0x81; lead <= 0xfe; lead++) for (let trail = 0x40; trail <= 0xfe; trail++) take([lead, trail])
  }
  tables.set(encoding, t)
  return t
}

/**
 * The bytes of a DXF text in an encoding. A character the code page lacks is written as AutoCAD writes it, \U+XXXX
 * (UTF-16 units, so one beyond the BMP takes two).
 */
export function encodeDxf(text: string, encoding: string): Uint8Array {
  if (encoding === 'utf-8') return new TextEncoder().encode(text)
  const table = tableOf(encoding)
  const out = new Uint8Array(text.length * 2 + 16)
  let n = 0
  let buf = out
  const push = (b: number): void => {
    if (n === buf.length) {
      const grown = new Uint8Array(buf.length * 2)
      grown.set(buf)
      buf = grown
    }
    buf[n++] = b
  }
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) {
      push(code)
      continue
    }
    const bytes = table.get(text[i]!)
    if (bytes) for (const b of bytes) push(b)
    else for (const ch of `\\U+${code.toString(16).toUpperCase().padStart(4, '0')}`) push(ch.charCodeAt(0))
  }
  return buf.slice(0, n)
}
