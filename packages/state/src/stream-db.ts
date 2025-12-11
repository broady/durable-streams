import { MaterializedState } from "./materialized-state"
import { isChangeEvent } from "./types"
import type { StateEvent } from "./types"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { DurableStream } from "@durable-streams/writer"

/**
 * Definition for a single collection in the stream state
 */
export interface CollectionDefinition<T = unknown> {
  /** Standard Schema for validating values */
  schema: StandardSchemaV1<T>
  /** The type field value in change events that map to this collection */
  type: string
}

/**
 * Stream state definition containing all collections
 */
export interface StreamStateDefinition {
  collections: Record<string, CollectionDefinition>
}

/**
 * Options for creating a stream DB
 */
export interface CreateStreamDBOptions {
  /** The durable stream to subscribe to */
  stream: DurableStream
  /** The stream state definition */
  state: StreamStateDefinition
}

/**
 * Collection interface for querying a specific entity type
 */
interface Collection<T = unknown> {
  get: (key: string) => Promise<T | undefined>
  getType: (type: string) => Map<string, unknown>
}

/**
 * Stream DB interface with dynamic collections and preload method
 */
type StreamDB<T extends Record<string, CollectionDefinition>> = {
  [K in keyof T]: Collection<
    T[K] extends CollectionDefinition<infer U> ? U : unknown
  >
} & {
  preload: () => Promise<void>
}

/**
 * Define the structure of a stream state with typed collections
 */
export function defineStreamState<
  T extends Record<string, CollectionDefinition>,
>(definition: { collections: T }): { collections: T } {
  return definition
}

/**
 * Create a stream-backed database with materialized state collections
 */
export async function createStreamDB<
  T extends Record<string, CollectionDefinition>,
>(
  options: CreateStreamDBOptions & { state: { collections: T } }
): Promise<StreamDB<T>> {
  const { stream, state } = options
  const materializedState = new MaterializedState()

  // Build a map of collection name -> type for reverse lookup
  const typeToCollection = new Map<string, string>()
  for (const [collectionName, definition] of Object.entries(
    state.collections
  )) {
    typeToCollection.set(definition.type, collectionName)
  }

  // Track whether we've already consumed the stream
  let hasPreloaded = false
  let preloadPromise: Promise<void> | null = null

  // Consume the stream once
  const consumeStream = async () => {
    if (hasPreloaded) {
      return
    }
    hasPreloaded = true

    for await (const event of stream.jsonStream<StateEvent>({
      offset: `-1`,
      live: false,
    })) {
      if (isChangeEvent(event)) {
        materializedState.apply(event)
      }
      // Ignore control events for now
    }
  }

  // Create collection objects
  const db: Record<string, Collection> = {}

  for (const [collectionName, definition] of Object.entries(
    state.collections
  )) {
    db[collectionName] = {
      async get(key: string) {
        return materializedState.get(definition.type, key)
      },
      getType(type: string) {
        return materializedState.getType(type)
      },
    }
  }

  // Add preload method
  ;(db as StreamDB<T>).preload = async () => {
    if (!preloadPromise) {
      preloadPromise = consumeStream()
    }
    return preloadPromise
  }

  return db as StreamDB<T>
}
