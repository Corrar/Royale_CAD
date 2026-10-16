/** The characters AutoCAD's %% codes stand for: diameter, degree, plus-minus. */
const PERCENT: Readonly<Record<string, string>> = { c: '⌀', d: '°', p: '±', '%': '%' }

/** At s[i], a %% code, a \U+XXXX escape or a caret code: what it stands for and its length; null when there is none. */
function special(s: string, i: number): [string, number] | null {
  // DXF writes a control character as ^ and the letter 64 above it (^I a tab, ^J a line feed), a caret as "^ ".
  if (s[i] === '^' && i + 1 < s.length) {
    const n = s.charCodeAt(i + 1)
    if (n === 32) return ['^', 2]
    if (n >= 64 && n <= 95) return [String.fromCharCode(n - 64), 2]
    return null
  }
  if (s[i] === '%' && s[i + 1] === '%') {
    const c = s[i + 2]?.toLowerCase() ?? ''
    if (c in PERCENT) return [PERCENT[c]!, 3]
    // Underline, overline and strike-through switch on and off: no character.
    if (c === 'u' || c === 'o' || c === 'k') return ['', 3]
    const digits = s.slice(i + 2, i + 5)
    if (/^\d{3}$/.test(digits)) return [String.fromCharCode(Number(digits)), 5]
    return null
  }
  if (s[i] === '\\' && (s[i + 1] === 'U' || s[i + 1] === 'u') && s[i + 2] === '+') {
    const hex = s.slice(i + 3, i + 7)
    if (/^[0-9A-Fa-f]{4}$/.test(hex)) return [String.fromCodePoint(parseInt(hex, 16)), 7]
  }
  return null
}

/** s as a DXF string holds it: control characters and carets in caret codes, so they read back as they were. */
export const caretCoded = (s: string): string =>
  s.replace(/[\x00-\x1f^]/g, (c) => (c === '^' ? '^ ' : `^${String.fromCharCode(c.charCodeAt(0) + 64)}`))

/** Underline, overline and strike-through, as bits: what %%u, %%o, %%k (TEXT) and \L, \O, \K (MTEXT) switch. */
export const MARK = { UNDER: 1, OVER: 2, STRIKE: 4 } as const

/** Text as it shows, and the marks on each of its UTF-16 units. */
export interface Marked { text: string; marks: number[] }

/** The mark each letter of %%u, %%o, %%k (TEXT) and of \L, \O, \K (MTEXT) switches. */
const PERCENT_MARK: Readonly<Record<string, number>> = { u: MARK.UNDER, o: MARK.OVER, k: MARK.STRIKE }
const MTEXT_MARK: Readonly<Record<string, number>> = { l: MARK.UNDER, o: MARK.OVER, k: MARK.STRIKE }

/** A TEXT string as it shows, with its marks: %%u, %%o and %%k switch a mark on and off, and have no character. */
export function decodeTextMarked(raw: string): Marked {
  const out: Marked = { text: '', marks: [] }
  let on = 0
  for (let i = 0; i < raw.length; ) {
    const mark = raw[i] === '%' && raw[i + 1] === '%' ? PERCENT_MARK[raw[i + 2]?.toLowerCase() ?? ''] : undefined
    if (mark) {
      on ^= mark
      i += 3
      continue
    }
    const sp = special(raw, i)
    const s = sp ? sp[0] : raw[i]!
    out.text += s
    for (let k = 0; k < s.length; k++) out.marks.push(on)
    i += sp ? sp[1] : 1
  }
  return out
}

/** A TEXT string as it shows: %%c, %%d, %%p, %%%, %%nnn, \U+XXXX and caret codes turned into their characters. */
export const decodeText = (raw: string): string => decodeTextMarked(raw).text

/** MTEXT codes that take an argument up to a semicolon: font, height, width, slant, tracking, alignment, colors… */
const WITH_ARGUMENT = new Set(['f', 'F', 'H', 'W', 'Q', 'T', 'A', 'C', 'c', 'p', 'a'])

/**
 * An MTEXT string as its paragraphs show, with their marks, the rest of the formatting left out: \P breaks
 * paragraphs, groups and codes go, escaped characters stay, stacked fractions read inline (\S1/2; is 1/2). A mark
 * holds until switched off or its group ends, past paragraphs. Wrapping to the box is the layout's.
 */
export function mtextParagraphsMarked(raw: string): Marked[] {
  const paragraphs: Marked[] = []
  let out: Marked = { text: '', marks: [] }
  let on = 0
  // The marks on where each open group began: its end puts them back.
  const groups: number[] = []
  const add = (s: string): void => {
    out.text += s
    for (let k = 0; k < s.length; k++) out.marks.push(on)
  }
  const breakParagraph = (): void => {
    paragraphs.push(out)
    out = { text: '', marks: [] }
  }
  for (let i = 0; i < raw.length; ) {
    const ch = raw[i]!
    const sp = special(raw, i)
    if (sp) {
      // A line feed (^J) breaks the paragraph, as \P does.
      if (sp[0] === '\n') breakParagraph()
      else add(sp[0])
      i += sp[1]
      continue
    }
    if (ch === '{' || ch === '}') {
      if (ch === '{') groups.push(on)
      else on = groups.pop() ?? on
      i++
      continue
    }
    if (ch !== '\\') {
      add(ch)
      i++
      continue
    }
    const c = raw[i + 1] ?? ''
    i += 2
    if (c === 'P' || c === 'X' || c === 'N') breakParagraph()
    else if (c === '~') add(' ')
    else if (c === '\\' || c === '{' || c === '}') add(c)
    else if (c === 'S') {
      // Stacked text, top and bottom: read as top/bottom (# and / are fractions, ^ a tolerance).
      const end = raw.indexOf(';', i)
      const body = raw.slice(i, end < 0 ? raw.length : end)
      add(body.replace(/#/g, '/').replace(/\^/g, ''))
      i = end < 0 ? raw.length : end + 1
    } else if (c === 'M' && raw[i] === '+') i += 6 // \M+nXXXX: a double-byte character of a code page
    else if (WITH_ARGUMENT.has(c)) {
      const end = raw.indexOf(';', i)
      i = end < 0 ? raw.length : end + 1
    } else if (c !== '' && 'LlOoKk'.includes(c)) {
      // Underline, overline, strike-through: on in capitals, off in lower case.
      const mark = MTEXT_MARK[c.toLowerCase()]!
      on = c === c.toUpperCase() ? on | mark : on & ~mark
    } else add(c)
  }
  paragraphs.push(out)
  return paragraphs
}

/** An MTEXT string as its paragraphs show, the formatting left out: see mtextParagraphsMarked. */
export const mtextParagraphs = (raw: string): string[] => mtextParagraphsMarked(raw).map((p) => p.text)
