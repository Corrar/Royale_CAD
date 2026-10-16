import type { Draft } from '../../document'
import { pathOf } from '../../entity/path'
import { typeOf } from '../../entity/registry'
import type { Entity } from '../../entity/types'
import { intersect } from '../../geom/intersect'
import type { BBox, Vec2 } from '../../geom/vec'
import { getPoint, getSelection, type Command, type CommandContext, type Input, type Request } from '../runtime'

/**
 * The cutting edges (TRIM) or boundaries (EXTEND): the pre-selection or what is selected at the prompt; Enter
 * with nothing selected means every object, null.
 */
export function* edgeSet(ctx: CommandContext, what: string): Generator<Request, Set<number> | null, Input> {
  ctx.message(`Select ${what} ...`)
  const ids = yield* getSelection(ctx, 'Select objects or <select all>')
  ctx.selection.clear()
  return ids.length > 0 ? new Set(ids) : null
}

/** The visible edges whose bbox meets b, other than `self`. */
export function edgesNear(ctx: CommandContext, b: BBox, edges: ReadonlySet<number> | null, self: number): Entity[] {
  const ids = ctx.host.query ? ctx.host.query(b) : Array.from(ctx.doc.entities(), (e) => e.id)
  const out: Entity[] = []
  for (const id of ids) {
    if (id === self || (edges && !edges.has(id))) continue
    const e = ctx.doc.get(id)
    if (e && ctx.doc.layers.get(e.layer)?.visible) out.push(e)
  }
  return out
}

/** The object under a pick, unless it sits on a locked layer (reported). */
export function picked(ctx: CommandContext, p: Vec2): Entity | null {
  const id = ctx.host.pick?.(p) ?? null
  const e = id === null ? undefined : ctx.doc.get(id)
  if (!e) return null
  if (ctx.doc.layers.get(e.layer)?.locked) {
    ctx.message('The object is on a locked layer.')
    return null
  }
  return e
}

/**
 * What is left of e once the piece around `at` between its neighbouring cuts is removed: the first entity keeps
 * e's id. Null when no edge cuts that piece off. A closed object needs two cuts and opens between them.
 */
function trimmed(e: Entity, at: Vec2, edges: Entity[]): Entity[] | null {
  const path = pathOf(e)
  const cuts: number[] = []
  for (const edge of edges) for (const p of intersect(e, edge)) cuts.push(path.param(p))
  const uc = path.param(at)
  if (path.closed) {
    // Distances forward from the click: the nearest cut ahead and the nearest behind bound the piece removed.
    const ahead = cuts.map((u) => (((u - uc) % path.end) + path.end) % path.end)
    const next = Math.min(...ahead)
    const prev = Math.max(...ahead)
    if (cuts.length === 0 || prev - next <= path.slack(uc + next)) return null
    const start = (uc + next) % path.end
    return [path.slice(start, start + (prev - next))]
  }
  let lo = 0
  let hi = path.end
  for (const u of cuts) {
    if (u < uc && u > lo) lo = u
    if (u > uc && u < hi) hi = u
  }
  const out: Entity[] = []
  if (lo > path.slack(lo)) out.push(path.slice(0, lo))
  if (path.end - hi > path.slack(hi)) out.push(path.slice(hi, path.end))
  return lo > path.slack(lo) || path.end - hi > path.slack(hi) ? out : null
}

/** TRIM: each pick removes the piece of an object between the cutting edges on either side, until Enter. */
export const trim: Command = function* (ctx) {
  const edges = yield* edgeSet(ctx, 'cutting edges')
  let trims = 0
  for (;;) {
    const r = yield* getPoint('Select object to trim', { pick: true, allowEmpty: true, keywords: ['Undo'] })
    if (r === null) return
    if (r === 'Undo') {
      if (trims > 0) {
        ctx.doc.undo()
        trims--
      } else ctx.message('Nothing to undo.')
      continue
    }
    if (typeof r === 'string') continue
    const e = picked(ctx, r)
    if (!e) continue
    const left = trimmed(e, r, edgesNear(ctx, typeOf(e).bbox(e), edges, e.id))
    if (!left) {
      ctx.message('Object does not intersect a cutting edge.')
      continue
    }
    ctx.doc.transact('TRIM', (tx) => {
      tx.replace(left[0]!)
      for (const piece of left.slice(1)) {
        const { id: _id, ...draft } = piece
        const added = tx.add(draft as Draft)
        // A cutting edge split in two still cuts with both parts.
        if (edges?.has(e.id)) edges.add(added.id)
      }
    })
    trims++
  }
}
