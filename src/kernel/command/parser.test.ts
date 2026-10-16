import { describe, expect, it } from 'vitest'
import { parseInput, type Token } from './parser'

const S = Math.SQRT1_2 * 10

const cases: Array<[string, Token]> = [
  ['10,20', { kind: 'point', mode: 'abs', x: 10, y: 20 }],
  ['@5,0', { kind: 'point', mode: 'rel', x: 5, y: 0 }],
  ['@10<45', { kind: 'point', mode: 'rel', x: S, y: S }],
  ['10<90', { kind: 'point', mode: 'abs', x: 0, y: 10 }],
  ['@10<180', { kind: 'point', mode: 'rel', x: -10, y: 0 }],
  ['@10<-90', { kind: 'point', mode: 'rel', x: 0, y: -10 }],
  ['@3<450', { kind: 'point', mode: 'rel', x: 0, y: 3 }],
  ['@-5<0', { kind: 'point', mode: 'rel', x: -5, y: 0 }],
  ['5', { kind: 'number', value: 5 }],
  ['-2.5', { kind: 'number', value: -2.5 }],
  ['+3', { kind: 'number', value: 3 }],
  ['.5', { kind: 'number', value: 0.5 }],
  ['5.', { kind: 'number', value: 5 }],
  ['1e3', { kind: 'number', value: 1000 }],
  ['', { kind: 'empty' }],
  ['   ', { kind: 'empty' }],
  ['c', { kind: 'word', text: 'c' }],
  ['Close', { kind: 'word', text: 'Close' }],
  ['3P', { kind: 'word', text: '3P' }],
  ['-LAYER', { kind: 'word', text: '-LAYER' }],
  [' 1.5 , 2 ', { kind: 'point', mode: 'abs', x: 1.5, y: 2 }],
  ['@ 1 , -2', { kind: 'point', mode: 'rel', x: 1, y: -2 }],
  ['7400000.001,9100000.002', { kind: 'point', mode: 'abs', x: 7400000.001, y: 9100000.002 }],
  ['1,,2', { kind: 'invalid', text: '1,,2' }],
  ['@', { kind: 'invalid', text: '@' }],
  ['1,2,3', { kind: 'invalid', text: '1,2,3' }],
  ['10<', { kind: 'invalid', text: '10<' }],
  ['<45', { kind: 'invalid', text: '<45' }],
  ['@,', { kind: 'invalid', text: '@,' }],
  ['1 2', { kind: 'invalid', text: '1 2' }],
  ['1,2<3', { kind: 'invalid', text: '1,2<3' }],
  ['1.2.3', { kind: 'invalid', text: '1.2.3' }],
  ['1e999', { kind: 'invalid', text: '1e999' }],
  ['a.b', { kind: 'invalid', text: 'a.b' }],
  ['1,2a', { kind: 'invalid', text: '1,2a' }],
]

describe('parseInput', () => {
  it.each(cases)('%j', (text, token) => {
    const got = parseInput(text)
    if (got.kind === 'point' && token.kind === 'point') {
      expect(got.mode).toBe(token.mode)
      expect(got.x).toBeCloseTo(token.x, 12)
      expect(got.y).toBeCloseTo(token.y, 12)
    } else {
      expect(got).toEqual(token)
    }
  })

  it('angles on the axes give exact coordinates', () => {
    expect(parseInput('@10<90')).toEqual({ kind: 'point', mode: 'rel', x: 0, y: 10 })
    expect(parseInput('@10<270')).toEqual({ kind: 'point', mode: 'rel', x: 0, y: -10 })
  })
})
