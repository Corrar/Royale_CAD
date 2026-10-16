import { Check, ChevronDown, Eye, EyeOff, Layers, Lock, LockOpen, Plus } from 'lucide-react'
import { useState, useSyncExternalStore } from 'react'
import type { LayerActions, LayersState } from '../app/controller'
import type { Store } from '../app/stores'
import { ACI_DEFAULT, colorRgb, type Color } from '../kernel/color'

/** The colors offered at a click on a swatch: AutoCAD's nine standard colors and its six grays. */
const PALETTE: Color[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 250, 251, 252, 253, 254, 255]

/** A swatch's CSS color; ACI 7 is the drawing color, which follows the theme. */
const cssColor = (c: Color): string => (c === ACI_DEFAULT ? 'var(--draw)' : `#${colorRgb(c).toString(16).padStart(6, '0')}`)

const colorName = (c: Color): string => (c >= 1 << 24 ? `RGB ${(c >> 16) & 255},${(c >> 8) & 255},${c & 255}` : `color ${c}`)

/** Top right: the current layer; open, every layer with its visibility, lock and color, and a new layer. */
export function LayerPanel({ store, actions }: { store: Store<LayersState>; actions: LayerActions }) {
  const s = useSyncExternalStore(store.subscribe, store.get)
  const [picking, setPicking] = useState<number | null>(null)
  const current = s.layers[s.current]!
  return (
    <section className="layerpanel" aria-label="Layers">
      <button type="button" className="layerpanel-current" aria-expanded={s.open} title="Layers (LA)" onClick={actions.toggle}>
        <Layers size={14} aria-hidden="true" />
        <span className="layerpanel-swatch" style={{ background: cssColor(current.color) }} aria-hidden="true" />
        <span className="layerpanel-name">{current.name}</span>
        <ChevronDown size={14} aria-hidden="true" className="layerpanel-chevron" />
      </button>
      {s.open && (
        <div className="layerpanel-list">
          <ul aria-label="Layer list">
            {s.layers.map((l, i) => (
              <li key={i} className={i === s.current ? 'layerpanel-row current' : 'layerpanel-row'}>
                <button
                  type="button"
                  className="layerpanel-icon"
                  aria-label={i === s.current ? `${l.name} is the current layer` : `Make ${l.name} current`}
                  title={i === s.current ? 'Current layer' : 'Make current (-LAYER Set)'}
                  aria-pressed={i === s.current}
                  onClick={() => actions.setCurrent(i)}
                >
                  {i === s.current ? <Check size={14} aria-hidden="true" /> : null}
                </button>
                <button
                  type="button"
                  className="layerpanel-icon"
                  aria-label={l.visible ? `Turn ${l.name} off` : `Turn ${l.name} on`}
                  title={l.visible ? 'On (-LAYER OFF to hide)' : 'Off (-LAYER ON to show)'}
                  aria-pressed={l.visible}
                  onClick={() => actions.update(i, { visible: !l.visible })}
                >
                  {l.visible ? <Eye size={14} aria-hidden="true" /> : <EyeOff size={14} aria-hidden="true" />}
                </button>
                <button
                  type="button"
                  className="layerpanel-icon"
                  aria-label={l.locked ? `Unlock ${l.name}` : `Lock ${l.name}`}
                  title={l.locked ? 'Locked (-LAYER Unlock)' : 'Unlocked (-LAYER LOck)'}
                  aria-pressed={l.locked}
                  onClick={() => actions.update(i, { locked: !l.locked })}
                >
                  {l.locked ? <Lock size={14} aria-hidden="true" /> : <LockOpen size={14} aria-hidden="true" />}
                </button>
                <button
                  type="button"
                  className="layerpanel-icon"
                  aria-label={`${l.name}: ${colorName(l.color)}, change`}
                  title="Color (-LAYER Color)"
                  aria-expanded={picking === i}
                  onClick={() => setPicking(picking === i ? null : i)}
                >
                  <span className="layerpanel-swatch" style={{ background: cssColor(l.color) }} />
                </button>
                <span className="layerpanel-name" title={l.name}>
                  {l.name}
                </span>
                {picking === i && (
                  <div className="layerpanel-palette" role="group" aria-label={`Colors for ${l.name}`}>
                    {PALETTE.map((c) => (
                      <button
                        key={c}
                        type="button"
                        className="layerpanel-swatch big"
                        style={{ background: cssColor(c) }}
                        aria-label={`Color ${c}`}
                        aria-pressed={l.color === c}
                        title={`Color ${c}`}
                        onClick={() => {
                          actions.update(i, { color: c })
                          setPicking(null)
                        }}
                      />
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
          <button type="button" className="layerpanel-add" onClick={actions.add} title="New layer (-LAYER Make)">
            <Plus size={14} aria-hidden="true" /> New layer
          </button>
        </div>
      )}
    </section>
  )
}
