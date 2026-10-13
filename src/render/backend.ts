import type { ViewState } from '../kernel/view'
import { splitDouble } from './hilo'

export type BatchId = number
export interface Draw { batch: BatchId; first: number; count: number; subdiv?: number }
export interface RenderBackend {
  createBatch(kind: 'segment' | 'arc', capacity: number): BatchId
  writeBatch(id: BatchId, first: number, instances: ArrayBufferView): void
  destroyBatch(id: BatchId): void
  setStyleTable(table: Uint32Array): void
  frame(view: ViewState, draws: readonly Draw[]): void
  resize(width: number, height: number, dpr: number): void
}

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

/** Word 0: color 0xRRGGBBAA. Word 1: width in 1/64 px (bits 0-15), visible (bit 16). */
export function writeStyle(table: Uint32Array, styleId: number, rgba: number, widthPx: number, visible: boolean): void {
  const w = styleId * STYLE_WORDS
  table[w] = rgba
  table[w + 1] = Math.min(65535, Math.round(widthPx * 64)) | (visible ? 1 << 16 : 0)
}
