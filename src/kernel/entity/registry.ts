import { arcType } from './arc'
import { circleType } from './circle'
import { lineType } from './line'
import { polylineType } from './polyline'
import type { Entity, EntityType } from './types'

const types = new Map<string, EntityType<Entity>>()

export function register<E extends Entity>(t: EntityType<E>): void {
  if (types.has(t.type)) throw new Error(`entity type ${t.type} is already registered`)
  types.set(t.type, t as unknown as EntityType<Entity>)
}

export function typeOf<E extends Entity>(e: E): EntityType<E> {
  const t = types.get(e.type)
  if (!t) throw new Error(`unregistered entity type ${String(e.type)}`)
  return t as unknown as EntityType<E>
}

register(lineType)
register(circleType)
register(arcType)
register(polylineType)
