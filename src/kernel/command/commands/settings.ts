import type { Command, CommandContext, CommandGen } from '../runtime'

/** A command that shows the settings at a tab; where the app has none, it says so. */
function opens(tab: 'osnap' | 'aliases'): Command {
  return Object.assign(
    function* (ctx: CommandContext): CommandGen {
      if (ctx.host.showSettings) return ctx.host.showSettings(tab)
      ctx.message('No settings to show here.')
    },
    { noUndoGroup: true },
  )
}

/** OSNAP (OS) and DSETTINGS (DS, SE): the object snap modes, as AutoCAD's Drafting Settings open on that tab. */
export const osnap = opens('osnap')
export const dsettings = opens('osnap')
/** ALIASEDIT: the command aliases. */
export const aliasedit = opens('aliases')
