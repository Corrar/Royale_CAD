import { describe, expect, it } from 'vitest'
import { decodeText, mtextParagraphs } from './codes'

describe('decodeText', () => {
  it('turns the %% codes and \\U+ escapes into the characters they stand for', () => {
    expect(decodeText('%%c50 %%d %%p0.1 100%%%')).toBe('⌀50 ° ±0.1 100%')
    expect(decodeText('%%C50 %%D')).toBe('⌀50 °')
    expect(decodeText('%%065%%066')).toBe('AB')
    expect(decodeText('caf\\U+00E9 \\U+2205')).toBe('café ∅')
    // Underline and overline toggles have no character.
    expect(decodeText('%%uTitle%%u and %%oover%%o')).toBe('Title and over')
    expect(decodeText('50%')).toBe('50%')
  })

  it('turns DXF caret codes into the control characters they stand for: ^I a tab, "^ " a caret', () => {
    expect(decodeText('A^IB')).toBe('A\tB')
    expect(decodeText('A^JB^M')).toBe('A\nB\r')
    expect(decodeText('x^ y')).toBe('x^y')
    // Not a caret code: as typed.
    expect(decodeText('m^2 x^')).toBe('m^2 x^')
  })
})

describe('mtextParagraphs', () => {
  it('splits paragraphs at \\P and keeps escaped characters', () => {
    expect(mtextParagraphs('One\\PTwo\\P\\PFour')).toEqual(['One', 'Two', '', 'Four'])
    expect(mtextParagraphs('a\\\\b \\{c\\} d\\~e')).toEqual(['a\\b {c} d\u00a0e'])
  })

  it('drops formatting: groups, codes with an argument up to ;, switches; stacked fractions read inline', () => {
    expect(mtextParagraphs('{\\fArial|b1|i0|c0|p34;Bold} plain')).toEqual(['Bold plain'])
    expect(mtextParagraphs('\\H2.5x;\\C1;Red \\c255;\\W0.8;\\Q15;\\T1.1;\\A1;mid')).toEqual(['Red mid'])
    expect(mtextParagraphs('\\LUnder\\l and \\OOver\\o \\KStrike\\k')).toEqual(['Under and Over Strike'])
    expect(mtextParagraphs('1\\S1/2; and \\S3#4; and \\Sx^2;')).toEqual(['11/2 and 3/4 and x2'])
    expect(mtextParagraphs('%%c25 \\U+00B0')).toEqual(['⌀25 °'])
    expect(mtextParagraphs('\\pxi-3,l3,t4;Indented')).toEqual(['Indented'])
  })

  it('caret codes: ^I is a tab (AutoCAD writes one after each number of a list), ^J breaks the paragraph', () => {
    expect(mtextParagraphs('\\pxi-3,l3,t3;1.^IALL DIMENSIONS IN MM\\P2.^IDO NOT SCALE')).toEqual(['1.\tALL DIMENSIONS IN MM', '2.\tDO NOT SCALE'])
    expect(mtextParagraphs('A^JB')).toEqual(['A', 'B'])
    expect(mtextParagraphs('x^ y')).toEqual(['x^y'])
    // A tolerance stack keeps its caret: it splits the stack, it is no code.
    expect(mtextParagraphs('\\S+0.1^ -0.2;')).toEqual(['+0.1 -0.2'])
  })
})
