/** The characters AutoCAD's %% codes stand for: diameter, degree, plus-minus. */
const PERCENT: Readonly<Record<string, string>> = { c: '⌀', d: '°', p: '±', '%': '%' }

/** At s[i], a %% code or a \U+XXXX escape: what it stands for and its length; null when there is none. */
function special(s: string, i: number): [string, number] | null {
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

/** A TEXT string as it shows: %%c, %%d, %%p, %%%, %%nnn and \U+XXXX turned into their characters. */
export function decodeText(raw: string): string {
  let out = ''
  for (let i = 0; i < raw.length; ) {
    const sp = special(raw, i)
    if (sp) {
      out += sp[0]
      i += sp[1]
    } else out += raw[i++]
  }
  return out
}

/** MTEXT codes that take an argument up to a semicolon: font, height, width, slant, tracking, alignment, colors… */
const WITH_ARGUMENT = new Set(['f', 'F', 'H', 'W', 'Q', 'T', 'A', 'C', 'c', 'p', 'a'])

/**
 * An MTEXT string as its paragraphs show, the formatting left out: \P breaks paragraphs, groups and codes go,
 * escaped characters stay, stacked fractions read inline (\S1/2; is 1/2). Wrapping to the box is the layout's.
 */
export function mtextParagraphs(raw: string): string[] {
  const paragraphs: string[] = []
  let out = ''
  for (let i = 0; i < raw.length; ) {
    const ch = raw[i]!
    const sp = special(raw, i)
    if (sp) {
      out += sp[0]
      i += sp[1]
      continue
    }
    if (ch === '{' || ch === '}') {
      i++
      continue
    }
    if (ch !== '\\') {
      out += ch
      i++
      continue
    }
    const c = raw[i + 1] ?? ''
    i += 2
    if (c === 'P' || c === 'X' || c === 'N') {
      paragraphs.push(out)
      out = ''
    } else if (c === '~') out += ' '
    else if (c === '\\' || c === '{' || c === '}') out += c
    else if (c === 'S') {
      // Stacked text, top and bottom: read as top/bottom (# and / are fractions, ^ a tolerance).
      const end = raw.indexOf(';', i)
      const body = raw.slice(i, end < 0 ? raw.length : end)
      out += body.replace(/#/g, '/').replace(/\^/g, '')
      i = end < 0 ? raw.length : end + 1
    } else if (c === 'M' && raw[i] === '+') i += 6 // \M+nXXXX: a double-byte character of a code page
    else if (WITH_ARGUMENT.has(c)) {
      const end = raw.indexOf(';', i)
      i = end < 0 ? raw.length : end + 1
    } else if ('LlOoKk'.includes(c)) {
      // Underline, overline, strike-through on and off.
    } else out += c
  }
  paragraphs.push(out)
  return paragraphs
}
