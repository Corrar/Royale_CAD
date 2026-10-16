import type { ViewState } from '../kernel/view'
import { splitDouble } from './hilo'

export type BatchId = number
// subdiv applies to the arc of each instance, so arcSubdiv(largest radius in px) is a safe upper bound.
export interface Draw { batch: BatchId; first: number; count: number; subdiv?: number }
export interface RenderBackend {
  createBatch(kind: 'segment' | 'arc', capacity: number): BatchId
  writeBatch(id: BatchId, first: number, instances: ArrayBufferView): void
  destroyBatch(id: BatchId): void
  setStyleTable(table: Uint32Array): void
  // The draws array is kept for the replay after a context restore: do not mutate it after the call.
  frame(view: ViewState, draws: readonly Draw[]): void
  resize(width: number, height: number, dpr: number): void
}

/** Channels in 0..1. */
export type Rgba = readonly [number, number, number, number]
/** Colors the backend paints itself; the caller resolves them (e.g. from CSS tokens). */
export interface BackendTheme { bg: Rgba; gridMinor: Rgba; gridMajor: Rgba }

/**
 * frame() drops a segment longer than MAX_SEGMENT_PX and an arc with a radius above MAX_ARC_RADIUS_PX (device px):
 * past them the shader's f32 shifts and thickens the stroke. The caller re-emits such primitives clipped in f64.
 */
export const MAX_SEGMENT_PX = 4e6
export const MAX_ARC_RADIUS_PX = 1e6

export const SEGMENT_STRIDE = 36 // bytes per instance
export const ARC_STRIDE = 32
export const STYLE_WORDS = 2 // u32 words per style

const SEGMENT_WORDS = SEGMENT_STRIDE / 4

/** f32 and u32 are views over the same ArrayBuffer. */
export function writeSegment(
  f32: Float32Array, u32: Uint32Array, index: number,
  x0: number, y0: number, x1: number, y1: number, styleId: number,
): void {
  const w = index * SEGMENT_WORDS
  splitDouble(x0, f32, w)
  splitDouble(y0, f32, w + 2)
  splitDouble(x1, f32, w + 4)
  splitDouble(y1, f32, w + 6)
  u32[w + 8] = styleId
}

export const MAX_ARC_SUBDIV = 4096
const ARC_WORDS = ARC_STRIDE / 4

/** Angles in radians, counter-clockwise, world Y up. sweep is signed; a full circle is 2π. */
export function writeArc(
  f32: Float32Array, u32: Uint32Array, index: number,
  cx: number, cy: number, r: number, a0: number, sweep: number, styleId: number,
): void {
  const w = index * ARC_WORDS
  splitDouble(cx, f32, w)
  splitDouble(cy, f32, w + 2)
  f32[w + 4] = r
  f32[w + 5] = a0
  f32[w + 6] = sweep
  u32[w + 7] = styleId
}

/** Subdivisions of a full circle that keep the chord sagitta within 0.25 px. */
export function arcSubdiv(radiusPx: number): number {
  if (!(radiusPx > 0.25) || !Number.isFinite(radiusPx)) return 8
  const n = Math.ceil(Math.PI / Math.acos(1 - 0.25 / radiusPx))
  return Math.min(MAX_ARC_SUBDIV, Math.max(8, n))
}

/** Word 0: color 0xRRGGBBAA. Word 1: width in 1/64 px (bits 0-15), visible (bit 16). */
export function writeStyle(table: Uint32Array, styleId: number, rgba: number, widthPx: number, visible: boolean): void {
  const w = styleId * STYLE_WORDS
  table[w] = rgba
  // Negative (DXF lineweights -1..-3) or NaN would wrap into a 1023 px line, so they pack as 0.
  const width = widthPx > 0 ? Math.min(65535, Math.round(widthPx * 64)) : 0
  table[w + 1] = width | (visible ? 1 << 16 : 0)
}
