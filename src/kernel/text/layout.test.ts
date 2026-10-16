import { describe, expect, it } from 'vitest'
import { mirroring } from '../geom/vec'
import { advanceOf, DESCENT } from './font'
import { atFrame, layoutMText, layoutText, mirrorPlacement, widthOf, type TextProps } from './layout'

const H = advanceOf(72)
const text = (extra: Partial<TextProps> = {}): TextProps => ({
  value: 'HH', x: 10, y: 20, x2: 10, y2: 20, height: 2, rotation: 0, widthFactor: 1, oblique: 0, halign: 0, valign: 0, backward: false, upsideDown: false, ...extra,
})
const near = (a: number[], b: number[]): void => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 9))

describe('layoutText', () => {
  it('left on the baseline: the first letter starts at the point, one cap height is the height', () => {
    expect(widthOf('HH')).toBeCloseTo(2 * H, 12)
    const l = layoutText(text())
    near([l.frame.ox, l.frame.oy, l.frame.ux, l.frame.uy, l.frame.vx, l.frame.vy], [10, 20, 2, 0, 0, 2])
    expect(l.glyphs.map((g) => [g.cp, g.x, g.y])).toEqual([[72, 0, 0], [72, H, 0]])
    expect(l.box).toEqual({ x0: 0, y0: -DESCENT, x1: 2 * H, y1: 1 })
  })

  it('justified: the point is the middle of the text, its right end, its top', () => {
    const mc = layoutText(text({ halign: 1, valign: 2 }))
    // The box's centre (on the cap height) is at the point.
    near([atFrame(mc.frame, H, 0.5).x, atFrame(mc.frame, H, 0.5).y], [10, 20])
    const tr = layoutText(text({ halign: 2, valign: 3, rotation: Math.PI / 2 }))
    near([atFrame(tr.frame, 2 * H, 1).x, atFrame(tr.frame, 2 * H, 1).y], [10, 20])
    const middle = layoutText(text({ halign: 4 }))
    near([atFrame(middle.frame, H, 0.5).x, atFrame(middle.frame, H, 0.5).y], [10, 20])
  })

  it('aligned scales the height to fit between its points; fit stretches the width instead', () => {
    const w = 2 * H
    const aligned = layoutText(text({ halign: 3, x: 0, y: 0, x2: 0, y2: 10 }))
    near([aligned.frame.ox, aligned.frame.oy, aligned.frame.ux, aligned.frame.uy, aligned.frame.vx, aligned.frame.vy], [0, 0, 0, 10 / w, -10 / w, 0])
    const fit = layoutText(text({ halign: 5, x: 0, y: 0, x2: 10, y2: 0 }))
    near([fit.frame.ux, fit.frame.uy, fit.frame.vx, fit.frame.vy], [10 / w, 0, 0, 2])
  })

  it('slant leans the up vector; backward and upside down mirror the frame about the box', () => {
    const slanted = layoutText(text({ oblique: Math.PI / 4 }))
    near([slanted.frame.vx, slanted.frame.vy], [2, 2])
    const back = layoutText(text({ backward: true }))
    // The same box, read from the other end.
    near([back.frame.ux, back.frame.uy], [-2, 0])
    near([atFrame(back.frame, 2 * H, 0).x], [10])
    const down = layoutText(text({ upsideDown: true }))
    near([down.frame.vx, down.frame.vy], [0, -2])
  })
})

describe('layoutMText', () => {
  const mtext = (extra = {}) => ({ value: 'HH HH HH', x: 0, y: 0, height: 1, width: 0, attachment: 1, rotation: 0, spacing: 1, ...extra })
  it('top left: the first baseline one height below the point, lines 5/3 apart; wraps to the width', () => {
    const one = layoutMText(mtext())
    expect(one.glyphs.every((g) => g.y === -1)).toBe(true)
    expect(one.box.x1).toBeCloseTo(widthOf('HH HH HH'), 12)
    const wrapped = layoutMText(mtext({ width: widthOf('HH HH') + 0.01 }))
    const ys = [...new Set(wrapped.glyphs.map((g) => g.y))]
    expect(ys).toEqual([-1, -1 - 5 / 3])
    expect(wrapped.glyphs.filter((g) => g.y === -1).length).toBe(4) // a space has no glyph
    const two = layoutMText(mtext({ value: 'A\\PB', spacing: 2 }))
    expect([...new Set(two.glyphs.map((g) => g.y))]).toEqual([-1, -1 - 10 / 3])
  })

  it('middle center: the box is centred on the point; each line centred in the box', () => {
    const l = layoutMText(mtext({ value: 'HHHH\\PHH', attachment: 5, x: 50, y: 60 }))
    const c = atFrame(l.frame, (l.box.x0 + l.box.x1) / 2, (l.box.y1 + (-1 - 5 / 3)) / 2)
    near([c.x, c.y], [50, 60])
    const second = l.glyphs.filter((g) => g.y < -1)
    expect(second[0]!.x).toBeCloseTo(H, 12) // centred under four H: one H in
  })
})

describe('mirrorPlacement', () => {
  it('keeps text readable: the box goes where the mirror puts it, reading forward', () => {
    const t = text({ x: 0, y: 0 })
    const m = mirroring({ x: 10, y: 0 }, { x: 10, y: 1 })
    const p = mirrorPlacement(layoutText(t), { x: 0, y: 0 }, m, t.rotation)
    // The box [0, 2H] across x = 10 is [20 − 2H, 20]: a left-aligned text starts at its left.
    near([p.x, p.y, p.rotation], [20 - 2 * 2 * H, 0, 0])
    const flip = mirrorPlacement(layoutText(t), { x: 0, y: 0 }, mirroring({ x: 0, y: 5 }, { x: 1, y: 5 }), 0)
    // Across y = 5: upright still, its box from 10 − 1 cap down to 10 + descent… the baseline at 10 − 2·(1 − D)·…
    expect(flip.rotation).toBeCloseTo(0, 12)
    near([flip.x], [0])
    expect(flip.y).toBeCloseTo(10 - 2 * (1 - DESCENT), 9)
  })
})
