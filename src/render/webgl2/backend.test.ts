import { describe, expect, it } from 'vitest'
import type { ViewState } from '../../kernel/view'
import { ARC_STRIDE, MAX_ARC_SUBDIV, SEGMENT_STRIDE, STYLE_WORDS, type BackendTheme } from '../backend'
import { createWebGL2Backend } from './backend'

const THEME: BackendTheme = { bg: [0.1, 0.2, 0.3, 1], gridMinor: [0, 1, 1, 0.1], gridMajor: [0, 1, 1, 0.25] }
const VIEW: ViewState = { cx: 0, cy: 0, scale: 1, width: 100, height: 100, dpr: 1 }
const MAX_TEXTURE_SIZE = 64

type Call = { name: string; args: unknown[]; ret: unknown }

// A WebGL2 context made of a Proxy: enums are their own names, every method is recorded,
// create* and getUniformLocation return fresh handles.
function setup() {
  const calls: Call[] = []
  let lost = false
  let handle = 0
  const answers: Record<string, (...args: unknown[]) => unknown> = {
    getParameter: (p) => (p === 'MAX_TEXTURE_SIZE' ? MAX_TEXTURE_SIZE : 0),
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    isContextLost: () => lost,
  }
  const gl = new Proxy({}, {
    get(_, prop) {
      if (typeof prop !== 'string') return undefined
      if (/^[A-Z][A-Z0-9_]*$/.test(prop)) return prop
      return (...args: unknown[]) => {
        const answer = answers[prop]
        const ret = answer ? answer(...args) : prop.startsWith('create') || prop === 'getUniformLocation' ? { handle: ++handle } : undefined
        calls.push({ name: prop, args, ret })
        return ret
      }
    },
  })
  const canvas = Object.assign(new EventTarget(), { width: 300, height: 150, getContext: () => gl })
  const backend = createWebGL2Backend(canvas as never, THEME)
  const named = (name: string): Call[] => calls.filter((c) => c.name === name)
  const lose = (): Event => {
    const e = new Event('webglcontextlost', { cancelable: true })
    canvas.dispatchEvent(e)
    return e
  }
  const restore = (): void => {
    canvas.dispatchEvent(new Event('webglcontextrestored'))
  }
  const draws = (): Call[] => calls.filter((c) => c.name === 'drawArrays' || c.name === 'drawArraysInstanced')
  return {
    backend,
    named,
    draws,
    lose,
    restore,
    setLost: (v: boolean) => (lost = v),
    clear: () => (calls.length = 0),
  }
}

const bytes = (n: number, fill: number): Uint8Array => new Uint8Array(n).fill(fill)

describe('createWebGL2Backend', () => {
  it('writeBatch rejects a size that is not a whole number of instances', () => {
    const t = setup()
    const seg = t.backend.createBatch('segment', 2)
    const arc = t.backend.createBatch('arc', 2)
    expect(() => t.backend.writeBatch(seg, 0, bytes(SEGMENT_STRIDE - 1, 0))).toThrow(RangeError)
    expect(() => t.backend.writeBatch(arc, 0, bytes(SEGMENT_STRIDE, 0))).toThrow(RangeError)
    t.backend.writeBatch(arc, 0, bytes(ARC_STRIDE, 0))
  })

  it('writeBatch rejects writes outside the capacity', () => {
    const t = setup()
    const id = t.backend.createBatch('segment', 2)
    expect(() => t.backend.writeBatch(id, 2, bytes(SEGMENT_STRIDE, 0))).toThrow(RangeError)
    expect(() => t.backend.writeBatch(id, 1, bytes(2 * SEGMENT_STRIDE, 0))).toThrow(RangeError)
    expect(() => t.backend.writeBatch(id, -1, bytes(SEGMENT_STRIDE, 0))).toThrow(RangeError)
    expect(() => t.backend.writeBatch(id, 0.5, bytes(SEGMENT_STRIDE, 0))).toThrow(RangeError)
    t.backend.writeBatch(id, 1, bytes(SEGMENT_STRIDE, 0))
  })

  it('writeBatch uploads only the bytes of the view', () => {
    const t = setup()
    const id = t.backend.createBatch('segment', 2)
    const words = new Float32Array(3 * (SEGMENT_STRIDE / 4)).fill(1)
    words.fill(5, 9, 18)
    t.clear()
    t.backend.writeBatch(id, 1, words.subarray(9, 18))
    const [call] = t.named('bufferSubData')
    expect(call!.args[1]).toBe(SEGMENT_STRIDE)
    expect(call!.args[2]).toEqual(new Uint8Array(new Float32Array(9).fill(5).buffer))
  })

  it('unknown and destroyed batches are errors, not range errors', () => {
    const t = setup()
    const id = t.backend.createBatch('segment', 1)
    t.backend.destroyBatch(id)
    for (const f of [
      () => t.backend.writeBatch(id, 0, bytes(SEGMENT_STRIDE, 0)),
      () => t.backend.destroyBatch(id),
      () => t.backend.frame(VIEW, [{ batch: id, first: 0, count: 1 }]),
      () => t.backend.writeBatch(999, 0, bytes(SEGMENT_STRIDE, 0)),
    ]) {
      expect(f).toThrow(/unknown batch/)
      expect(f).not.toThrow(RangeError)
    }
  })

  it('setStyleTable rejects a partial row and more rows than MAX_TEXTURE_SIZE', () => {
    const t = setup()
    expect(() => t.backend.setStyleTable(new Uint32Array(STYLE_WORDS + 1))).toThrow(RangeError)
    expect(() => t.backend.setStyleTable(new Uint32Array((MAX_TEXTURE_SIZE + 1) * STYLE_WORDS))).toThrow(RangeError)
    t.backend.setStyleTable(new Uint32Array(MAX_TEXTURE_SIZE * STYLE_WORDS))
  })

  it('frame rejects draws outside the capacity', () => {
    const t = setup()
    const id = t.backend.createBatch('segment', 4)
    for (const d of [
      { first: 0, count: 5 },
      { first: 3, count: 2 },
      { first: -1, count: 1 },
      { first: 0, count: -1 },
      { first: 0.5, count: 1 },
      { first: 0, count: 1.5 },
    ]) {
      expect(() => t.backend.frame(VIEW, [{ batch: id, ...d }])).toThrow(RangeError)
    }
    t.backend.frame(VIEW, [{ batch: id, first: 1, count: 3 }])
  })

  it('frame rejects arc draws without an integer subdiv in range', () => {
    const t = setup()
    const id = t.backend.createBatch('arc', 1)
    for (const subdiv of [undefined, 0, 1.5, MAX_ARC_SUBDIV + 1, NaN]) {
      expect(() => t.backend.frame(VIEW, [{ batch: id, first: 0, count: 1, subdiv }])).toThrow(RangeError)
    }
    t.backend.frame(VIEW, [{ batch: id, first: 0, count: 1, subdiv: MAX_ARC_SUBDIV }])
  })

  it('a rejected frame draws nothing', () => {
    const t = setup()
    const id = t.backend.createBatch('segment', 1)
    t.clear()
    expect(() => t.backend.frame(VIEW, [{ batch: id, first: 0, count: 1 }, { batch: id, first: 0, count: 2 }])).toThrow(RangeError)
    expect(t.draws()).toEqual([])
  })

  it('paints the grid with the injected theme', () => {
    const t = setup()
    t.backend.frame(VIEW, [])
    const location = (name: string): unknown => t.named('getUniformLocation').find((c) => c.args[1] === name)!.ret
    const color = (name: string): number[] => {
      const call = t.named('uniform4fv').find((c) => c.args[0] === location(name))!
      return Array.from(call.args[1] as Float32Array)
    }
    const f32 = (xs: readonly number[]): number[] => xs.map(Math.fround)
    expect(color('bgColor')).toEqual(f32(THEME.bg))
    expect(color('minorColor')).toEqual(f32(THEME.gridMinor))
    expect(color('majorColor')).toEqual(f32(THEME.gridMajor))
  })

  it('the lost handler asks the browser to restore the context', () => {
    expect(setup().lose().defaultPrevented).toBe(true)
  })

  it('restore re-uploads every live batch with its latest data and skips destroyed ones', () => {
    const t = setup()
    const a = t.backend.createBatch('segment', 2)
    const b = t.backend.createBatch('arc', 1)
    const c = t.backend.createBatch('segment', 1)
    t.backend.writeBatch(a, 1, bytes(SEGMENT_STRIDE, 7))
    t.backend.writeBatch(b, 0, bytes(ARC_STRIDE, 8))
    t.backend.writeBatch(c, 0, bytes(SEGMENT_STRIDE, 9))
    t.backend.destroyBatch(b)
    const styles = new Uint32Array(2 * STYLE_WORDS).fill(3)
    t.backend.setStyleTable(styles)
    t.lose()
    t.clear()
    t.restore()
    const uploads = t.named('bufferData').map((call) => call.args[1])
    expect(uploads).toEqual([new Uint8Array([...bytes(SEGMENT_STRIDE, 0), ...bytes(SEGMENT_STRIDE, 7)]), bytes(SEGMENT_STRIDE, 9)])
    expect(t.named('createProgram')).toHaveLength(3) // grid, segment, arc
    expect(t.named('texImage2D').map((call) => call.args[8])).toEqual([styles])
  })

  it('restore replays the last frame without the batches destroyed since', () => {
    const t = setup()
    const a = t.backend.createBatch('segment', 2)
    const c = t.backend.createBatch('segment', 1)
    t.backend.frame(VIEW, [{ batch: a, first: 0, count: 2 }, { batch: c, first: 0, count: 1 }])
    t.backend.destroyBatch(c)
    t.lose()
    t.clear()
    t.restore()
    expect(t.named('drawArraysInstanced').map((call) => call.args[3])).toEqual([2])
  })

  it('frame with the context lost records the draws and does not draw', () => {
    const t = setup()
    const a = t.backend.createBatch('segment', 3)
    t.setLost(true)
    t.clear()
    t.backend.frame(VIEW, [{ batch: a, first: 0, count: 3 }])
    expect(t.draws()).toEqual([])
    t.setLost(false)
    t.restore()
    expect(t.named('drawArraysInstanced').map((call) => call.args[3])).toEqual([3])
  })
})
