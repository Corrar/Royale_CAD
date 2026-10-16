import type { Draft } from '../../document'
import { pathOf } from '../../entity/path'
import { typeOf } from '../../entity/registry'
import type { Entity } from '../../entity/types'
import { intersect } from '../../geom/intersect'
import type { BBox, Vec2 } from '../../geom/vec'
import { getSelection, type Command, type CommandContext, type Input, type Request } from '../runtime'
// extend.ts imports this module back: safe, as only functions cross, called once both have loaded.
import { extendAt } from './extend'

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
  const path = pathOf(e)!
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
  // A cut at the click bounds the piece after it (before it, at the very end): one piece goes, not both.
  const s = path.slack(uc)
  const ahead = uc < path.end - s
  for (const u of cuts) {
    if (Math.abs(u - uc) <= s ? ahead : u < uc) lo = Math.max(lo, u)
    else hi = Math.min(hi, u)
  }
  // Each kept part is measured on its own piece: the one ending at lo, the one starting at hi.
  const head = lo > path.slack(lo, true)
  const tail = path.end - hi > path.slack(hi)
  const out: Entity[] = []
  if (head) out.push(path.slice(0, lo))
  if (tail) out.push(path.slice(hi, path.end))
  return head || tail ? out : null
}

/** What a pick at `at` does to e: the entities that take its place (the first keeps e's id), or why there are none. */
type EdgeEdit = (ctx: CommandContext, e: Entity, at: Vec2, edges: Set<number> | null) => Entity[] | string

/** TRIM's edit: e without the piece around `at` between the cutting edges on either side. */
export function trimAt(ctx: CommandContext, e: Entity, at: Vec2, edges: Set<number> | null): Entity[] | string {
  if (!pathOf(e)) return 'Cannot trim this object.'
  return trimmed(e, at, edgesNear(ctx, typeOf(e).bbox(e), edges, e.id)) ?? 'Object does not intersect a cutting edge.'
}

/**
 * The picks of TRIM and EXTEND, until Enter: each one edits the object under it, or with Shift does the other
 * command's edit against the same edges (AutoCAD's shift-select). Undo takes back the last one.
 */
export function* edgePicks(ctx: CommandContext, edges: Set<number> | null, label: string, prompt: string, edit: EdgeEdit, shifted: EdgeEdit): Generator<Request, void, Input> {
  let edits = 0
  for (;;) {
    const r = yield { kind: 'point', prompt, pick: true, allowEmpty: true, keywords: ['Undo'] }
    if (r.kind === 'empty') return
    if (r.kind === 'keyword') {
      if (edits > 0) {
        ctx.doc.undo()
        edits--
      } else ctx.message('Nothing to undo.')
      continue
    }
    if (r.kind !== 'point') continue
    const e = picked(ctx, r.p)
    if (!e) continue
    const left = (r.shift ? shifted : edit)(ctx, e, r.p, edges)
    if (typeof left === 'string') {
      ctx.message(left)
      continue
    }
    ctx.doc.transact(label, (tx) => {
      tx.replace(left[0]!)
      for (const piece of left.slice(1)) {
        const { id: _id, ...draft } = piece
        const added = tx.add(draft as Draft)
        // A cutting edge split in two still cuts with both parts.
        if (edges?.has(e.id)) edges.add(added.id)
      }
    })
    edits++
  }
}

/** TRIM: each pick removes the piece of an object between the cutting edges on either side, until Enter. */
export const trim: Command = function* (ctx) {
  const edges = yield* edgeSet(ctx, 'cutting edges')
  yield* edgePicks(ctx, edges, 'TRIM', 'Select object to trim or shift-select to extend', trimAt, extendAt)
}
