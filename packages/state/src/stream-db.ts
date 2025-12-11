import { Collection } from "@tanstack/db"
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
 * Stream DB interface with dynamic collections and preload method
 */
type StreamDB<T extends Record<string, CollectionDefinition>> = {
  [K in keyof T]: Collection<
    T[K] extends CollectionDefinition<infer U>
      ? U extends object
        ? U
        : Record<string, unknown>
      : Record<string, unknown>
  >
} & {
  preload: () => Promise<void>
  close: () => void
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
 * Create a stream-backed database with TanStack DB collections
 */
export async function createStreamDB<
  T extends Record<string, CollectionDefinition>,
>(
  options: CreateStreamDBOptions & { state: { collections: T } }
): Promise<StreamDB<T>> {
  const { stream, state } = options

  // Map of type -> collection name for routing events
  const typeToCollectionName = new Map<string, string>()
  for (const [collectionName, definition] of Object.entries(
    state.collections
  )) {
    typeToCollectionName.set(definition.type, collectionName)
  }

  // Track preload promise
  let preloadPromise: Promise<void> | null = null

  // AbortController for the stream subscription
  const abortController = new AbortController()

  // Track whether streaming has started
  let hasStartedStreaming = false

  // Track when we've caught up with existing events
  let upToDateResolver: (() => void) | null = null
  const upToDatePromise = new Promise<void>((resolve) => {
    upToDateResolver = resolve
  })

  // Store sync callbacks for each collection
  const syncCallbacks: Map<
    string,
    {
      write: (msg: any) => void
      begin: () => void
      commit: () => void
    }
  > = new Map()

  // Function to start syncing from the stream (called automatically on first sync)
  const startStreamIfNeeded = () => {
    if (hasStartedStreaming) return
    hasStartedStreaming = true

    // Subscribe to stream and route events to appropriate collections
    // Note: begin() is called per-collection in their sync callback
    stream.subscribeJson<StateEvent>(
      (events, metadata) => {
        for (const event of events) {
          if (isChangeEvent(event)) {
            const targetCollectionName = typeToCollectionName.get(event.type)
            if (targetCollectionName) {
              const cb = syncCallbacks.get(targetCollectionName)
              if (cb) {
                cb.write({
                  key: event.key,
                  value: event.value as object,
                  previousValue: event.old_value as object | undefined,
                  type: event.headers.operation,
                  metadata: {
                    txid: event.headers.txid,
                    timestamp: event.headers.timestamp,
                  },
                })
              }
            }
          }
        }

        // Commit after each batch
        for (const cb of syncCallbacks.values()) {
          cb.commit()
        }

        // Check if we've caught up with existing events
        if (metadata.upToDate && upToDateResolver) {
          upToDateResolver()
          upToDateResolver = null
        }

        // Begin again for next batch
        for (const cb of syncCallbacks.values()) {
          cb.begin()
        }
      },
      {
        offset: `-1`,
        live: true,
        signal: abortController.signal,
      }
    )
  }

  // Create all collections, storing their sync callbacks
  const tanstackCollections: Record<string, Collection> = {}

  for (const [collectionName, definition] of Object.entries(
    state.collections
  )) {
    tanstackCollections[collectionName] = new Collection({
      id: collectionName,
      schema: definition.schema,
      sync: {
        sync: ({ write, begin, commit }) => {
          // Store the callbacks
          syncCallbacks.set(collectionName, { write, begin, commit })
          // Auto-start streaming when first collection requests sync
          startStreamIfNeeded()
          // Begin this collection's sync transaction
          begin()
        },
      },
    })
  }

  // Wrap TanStack DB collections to add convenience methods
  const collections: Record<string, any> = {}
  for (const [name, tanstackCollection] of Object.entries(
    tanstackCollections
  )) {
    // Return the TanStack collection directly - it already has the methods we need
    collections[name] = tanstackCollection
  }

  // Add preload method that ensures streaming starts and waits for catch-up
  const db = collections as StreamDB<T>
  db.preload = async () => {
    if (!preloadPromise) {
      // Ensure streaming has started (it may have already started automatically)
      startStreamIfNeeded()

      // Wait for all collections to be ready AND for the stream to catch up
      preloadPromise = Promise.all([
        ...Object.values(tanstackCollections).map((collection) =>
          collection.stateWhenReady()
        ),
        upToDatePromise,
      ]).then(() => undefined)
    }
    return preloadPromise
  }

  // Add close method to abort the stream subscription
  db.close = () => {
    abortController.abort()
  }

  return db
}
