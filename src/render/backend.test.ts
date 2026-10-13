import { describe, expect, it } from 'vitest'
import { SEGMENT_STRIDE, writeSegment, writeStyle } from './backend'
import { splitDouble } from './hilo'

describe('writeSegment', () => {
  it('writes hi/lo pairs and styleId at instance 1, leaving instance 0 intact', () => {
    const buf = new ArrayBuffer(2 * SEGMENT_STRIDE)
    const f32 = new Float32Array(buf)
    const u32 = new Uint32Array(buf)
    u32.fill(0xdeadbeef, 0, 9)
    writeSegment(f32, u32, 1, 7_400_000.001, 9_100_000.001, 7_400_000.005, 9_100_000.004, 42)
    const expected = new Float32Array(8)
    ;[7_400_000.001, 9_100_000.001, 7_400_000.005, 9_100_000.004].forEach((v, k) => splitDouble(v, expected, k * 2))
    expect(Array.from(f32.subarray(9, 17))).toEqual(Array.from(expected))
    expect(u32[17]).toBe(42)
    expect(Array.from(u32.subarray(0, 9))).toEqual(new Array(9).fill(0xdeadbeef))
  })
})

describe('writeStyle', () => {
  it('packs color, width in 1/64 px and the visible bit', () => {
    const t = new Uint32Array(8)
    writeStyle(t, 3, 0xf2f4f5ff, 1.5, true)
    expect(t[6]).toBe(0xf2f4f5ff)
    expect(t[7]).toBe(96 | (1 << 16))
    writeStyle(t, 3, 0xf2f4f5ff, 1.5, false)
    expect(t[7]).toBe(96)
    writeStyle(t, 3, 0xf2f4f5ff, 5000, true)
    expect(t[7] & 0xffff).toBe(65535)
  })
})
