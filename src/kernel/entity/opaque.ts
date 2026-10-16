import { emptyBBox } from '../geom/vec'
import type { EntityType, Opaque } from './types'

/** No geometry: an empty bbox keeps it out of the index, the extents and every pick. */
export const opaqueType: EntityType<Opaque> = {
  type: 'opaque',
  bbox: () => emptyBBox(),
  primitives() {},
  distance: () => Infinity,
}
