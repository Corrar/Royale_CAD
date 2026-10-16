/** A DXF group: a code that says what the value is, and the value as written (decoding is the reader's job). */
export interface Pair { code: number; value: string }

/** A malformed file; `line` is 1-based, in the decoded text. */
export class DxfError extends Error {
  readonly line: number
  constructor(line: number, message: string) {
    super(`line ${line}: ${message}`)
    this.name = 'DxfError'
    this.line = line
  }
}

/**
 * The pairs of a file without an object per pair: a 100 MB DXF has ~9M of them. Codes sit in a typed array and
 * values stay in the text, sliced only when asked for. Pair i starts on line 2i + 1.
 */
export interface PairList {
  readonly length: number
  /** The text the pairs index into. */
  readonly text: string
  /** Every group code, in order: for loops too hot for a call per pair. */
  readonly codes: Int16Array
  /** Where pair i begins in the text (its code line); offset(length) is past the last pair's line break. */
  offset(i: number): number
  code(i: number): number
  /** The value as written: text can begin or end with spaces. */
  value(i: number): string
  /** Whether pair i is `code/word`, ignoring padding around the value; allocates nothing. */
  is(i: number, code: number, word: string): boolean
  pair(i: number): Pair
}

const SPACE = (c: number): boolean => c === 32 || c === 9

/**
 * The pairs of an ASCII DXF, each a group-code line and a value line, up to and including 0/EOF (anything after
 * it is ignored). LF and CRLF both end lines; codes may be padded with spaces; values keep theirs.
 */
export function tokenize(text: string): PairList {
  const n = text.length
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0
  const first = pos
  if (text.startsWith('AutoCAD Binary DXF', pos)) throw new DxfError(1, 'binary DXF is not supported')
  // About 12 characters per pair in real files; grown by half when short.
  let cap = Math.max(16, Math.ceil(n / 12))
  let codes = new Int16Array(cap)
  let starts = new Uint32Array(cap)
  let ends = new Uint32Array(cap)
  let count = 0
  let line = 0
  /** End of the line that starts at pos, without its CR; -1 at the end of the text. Moves pos past it. */
  let lineStart = 0
  const nextLine = (): number => {
    if (pos >= n) return -1
    let end = text.indexOf('\n', pos)
    if (end < 0) end = n
    lineStart = pos
    pos = end + 1
    line++
    return end > lineStart && text.charCodeAt(end - 1) === 13 ? end - 1 : end
  }
  for (;;) {
    const ce = nextLine()
    if (ce < 0) break
    const code = parseCode(text, lineStart, ce)
    if (code === null) throw new DxfError(line, `invalid group code "${text.slice(lineStart, ce).trim()}"`)
    const ve = nextLine()
    if (ve < 0) throw new DxfError(line + 1, `group code ${code} has no value (file truncated?)`)
    if (count === cap) {
      cap = Math.ceil(cap * 1.5)
      codes = grow(codes, new Int16Array(cap))
      starts = grow(starts, new Uint32Array(cap))
      ends = grow(ends, new Uint32Array(cap))
    }
    codes[count] = code
    starts[count] = lineStart
    ends[count] = ve
    count++
    if (code === 0 && trimmedIs(text, lineStart, ve, 'EOF')) break
  }
  const list: PairList = {
    length: count,
    text,
    codes: codes.subarray(0, count),
    offset(i) {
      if (i >= count) {
        if (count === 0) return first
        let e = ends[count - 1]!
        if (text.charCodeAt(e) === 13) e++
        if (text.charCodeAt(e) === 10) e++
        return e
      }
      // The code line ends just before the value line; it starts after the line break before it.
      return Math.max(text.lastIndexOf('\n', starts[i]! - 2) + 1, first)
    },
    code: (i) => codes[i]!,
    value: (i) => text.slice(starts[i]!, ends[i]!),
    is: (i, code, word) => codes[i] === code && trimmedIs(text, starts[i]!, ends[i]!, word),
    pair: (i) => ({ code: codes[i]!, value: list.value(i) }),
  }
  return list
}

function grow<T extends Int16Array | Uint32Array>(from: T, to: T): T {
  to.set(from)
  return to
}

/** An integer of up to 4 digits, optionally signed and padded with spaces, in text[s, e); null otherwise. */
function parseCode(text: string, s: number, e: number): number | null {
  while (s < e && SPACE(text.charCodeAt(s))) s++
  while (e > s && SPACE(text.charCodeAt(e - 1))) e--
  const neg = s < e && text.charCodeAt(s) === 45
  if (neg) s++
  if (e - s < 1 || e - s > 4) return null
  let v = 0
  for (let k = s; k < e; k++) {
    const d = text.charCodeAt(k) - 48
    if (d < 0 || d > 9) return null
    v = v * 10 + d
  }
  return neg ? -v : v
}

/** Whether text[s, e), without the padding, is word. */
function trimmedIs(text: string, s: number, e: number, word: string): boolean {
  while (s < e && SPACE(text.charCodeAt(s))) s++
  while (e > s && SPACE(text.charCodeAt(e - 1))) e--
  return e - s === word.length && text.startsWith(word, s)
}

/** A section: its name, and the range [start, end) of its pairs, between the name pair and 0/ENDSEC. */
export interface SectionRange { name: string; start: number; end: number }

/** The sections of a tokenized file, in order. 999 comments between sections are skipped. */
export function sections(pairs: PairList): SectionRange[] {
  const lineOf = (i: number): number => 2 * i + 1
  const out: SectionRange[] = []
  let i = 0
  while (i < pairs.length) {
    if (pairs.code(i) === 999) {
      i++
      continue
    }
    if (pairs.is(i, 0, 'EOF')) break
    if (!pairs.is(i, 0, 'SECTION')) throw new DxfError(lineOf(i), `expected 0/SECTION, found ${pairs.code(i)}/${pairs.value(i).trim()}`)
    if (i + 1 >= pairs.length || pairs.code(i + 1) !== 2) throw new DxfError(lineOf(i + 1), 'a section starts with its name (code 2)')
    const name = pairs.value(i + 1).trim()
    let j = i + 2
    while (j < pairs.length && !pairs.is(j, 0, 'ENDSEC')) j++
    if (j >= pairs.length) throw new DxfError(lineOf(pairs.length), `section ${name} is not closed (file truncated?)`)
    out.push({ name, start: i + 2, end: j })
    i = j + 1
  }
  return out
}
