import { describe, expect, it } from 'vitest'
import { ARC_STRIDE, MAX_ARC_SUBDIV, SEGMENT_STRIDE, arcSubdiv, writeArc, writeSegment, writeStyle } from './backend'
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
    writeStyle(t, 3, 0xf2f4f5ff, -1, true)
    expect(t[7]).toBe(1 << 16)
    writeStyle(t, 3, 0xf2f4f5ff, NaN, true)
    expect(t[7]).toBe(1 << 16)
  })
})

describe('writeArc', () => {
  it('writes hi/lo centre, r, a0, sweep and styleId at instance 1, leaving instance 0 intact', () => {
    const buf = new ArrayBuffer(2 * ARC_STRIDE)
    const f32 = new Float32Array(buf)
    const u32 = new Uint32Array(buf)
    writeArc(f32, u32, 1, 7_400_000.003, 9_100_000.0025, 0.0015, 0.5, -1.25, 9)
    const c = new Float32Array(4)
    splitDouble(7_400_000.003, c, 0)
    splitDouble(9_100_000.0025, c, 2)
    expect([...f32.subarray(8, 12)]).toEqual([...c])
    expect([...f32.subarray(12, 15)]).toEqual([Math.fround(0.0015), 0.5, -1.25])
    expect(u32[15]).toBe(9)
    expect([...u32.subarray(0, 8)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  })
})

describe('arcSubdiv', () => {
  it('keeps the chord sagitta within 0.25 px and never decreases with the radius', () => {
    let prev = 0
    for (const r of [1, 10, 100, 1000, 10000]) {
      const n = arcSubdiv(r)
      expect(r * (1 - Math.cos(Math.PI / n))).toBeLessThanOrEqual(0.25)
      expect(n).toBeGreaterThanOrEqual(prev)
      prev = n
    }
  })
  it('clamps to [8, MAX_ARC_SUBDIV]', () => {
    expect(arcSubdiv(0.1)).toBe(8)
    expect(arcSubdiv(NaN)).toBe(8)
    expect(arcSubdiv(1e9)).toBe(MAX_ARC_SUBDIV)
  })
})
