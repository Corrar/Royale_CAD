import { getSelection, type Command } from '../runtime'

/** ERASE: the pre-selection when there is one, otherwise what is selected at the prompt. Locked layers are kept. */
export const erase: Command = function* (ctx) {
  const ids = (yield* getSelection(ctx)).filter((id) => ctx.doc.get(id) !== undefined)
  ctx.selection.clear()
  const free = ids.filter((id) => !ctx.doc.layers.get(ctx.doc.get(id)!.layer)!.locked)
  const locked = ids.length - free.length
  if (locked > 0) ctx.message(locked === 1 ? '1 was on a locked layer.' : `${locked} were on a locked layer.`)
  if (free.length === 0) return
  ctx.doc.transact('ERASE', (tx) => {
    for (const id of free) tx.remove(id)
  })
}
