import { describe, expect, it } from 'vitest'
import { createFrameLoop } from './controller'

function setup() {
  const pending: Array<() => void> = []
  let draws = 0
  const loop = createFrameLoop((cb) => pending.push(cb), () => draws++)
  return { loop, pending, draws: () => draws }
}

describe('createFrameLoop', () => {
  it('coalesces invalidations into one frame', () => {
    const t = setup()
    t.loop.invalidate()
    t.loop.invalidate()
    t.loop.invalidate()
    expect(t.pending).toHaveLength(1)
    t.pending[0]()
    expect(t.draws()).toBe(1)
    expect(t.pending).toHaveLength(1)
  })

  it('schedules again after a frame ran', () => {
    const t = setup()
    t.loop.invalidate()
    t.pending[0]()
    t.loop.invalidate()
    expect(t.pending).toHaveLength(2)
    t.pending[1]()
    expect(t.draws()).toBe(2)
  })

  it('flush draws now and the pending callback does not draw again', () => {
    const t = setup()
    t.loop.invalidate()
    t.loop.flush()
    expect(t.draws()).toBe(1)
    t.pending[0]()
    expect(t.draws()).toBe(1)
    t.loop.flush()
    expect(t.draws()).toBe(1)
  })
})
