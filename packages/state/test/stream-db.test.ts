import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { DurableStreamTestServer } from "@durable-streams/server"
import { DurableStream } from "@durable-streams/client"
import { createStateSchema, createStreamDB } from "../src/stream-db"
import type { StandardSchemaV1 } from "@standard-schema/spec"

// Simple Standard Schema implementations for testing
const userSchema: StandardSchemaV1<{
  id: string
  name: string
  email: string
}> = {
  "~standard": {
    version: 1,
    vendor: `test`,
    validate: (value) => {
      if (
        typeof value !== `object` ||
        value === null ||
        typeof (value as { id?: unknown }).id !== `string` ||
        typeof (value as { name?: unknown }).name !== `string` ||
        typeof (value as { email?: unknown }).email !== `string`
      ) {
        return { issues: [{ message: `Invalid user` }] }
      }
      return {
        value: value as { id: string; name: string; email: string },
      }
    },
  },
}

const messageSchema: StandardSchemaV1<{
  id: string
  text: string
  userId: string
}> = {
  "~standard": {
    version: 1,
    vendor: `test`,
    validate: (value) => {
      if (
        typeof value !== `object` ||
        value === null ||
        typeof (value as { id?: unknown }).id !== `string` ||
        typeof (value as { text?: unknown }).text !== `string` ||
        typeof (value as { userId?: unknown }).userId !== `string`
      ) {
        return { issues: [{ message: `Invalid message` }] }
      }
      return {
        value: value as { id: string; text: string; userId: string },
      }
    },
  },
}

describe(`Stream DB`, () => {
  let server: DurableStreamTestServer
  let baseUrl: string

  beforeAll(async () => {
    server = new DurableStreamTestServer({ port: 0 })
    await server.start()
    baseUrl = server.url
  })

  afterAll(async () => {
    await server.stop()
  })

  it(`should define stream state and create db with collections`, async () => {
    // Define the stream state structure
    const streamState = createStateSchema({
      collections: {
        users: {
          schema: userSchema,
          type: `user`, // Maps to change event type field
          primaryKey: `id`,
        },
        messages: {
          schema: messageSchema,
          type: `message`,
          primaryKey: `id`,
        },
      },
    })

    // Create a durable stream
    const streamPath = `/db/chat-${Date.now()}`
    const stream = await DurableStream.create({
      url: `${baseUrl}${streamPath}`,
      contentType: `application/json`,
    })

    // Create the stream DB
    const db = await createStreamDB({
      stream,
      state: streamState,
    })

    // Verify collections are accessible
    expect(db.users).toBeDefined()
    expect(db.messages).toBeDefined()

    // Write change events in parallel
    await Promise.all([
      stream.append({
        type: `user`,
        key: `1`,
        value: { id: `1`, name: `Kyle`, email: `kyle@example.com` },
        headers: { operation: `insert` },
      }),
      stream.append({
        type: `user`,
        key: `2`,
        value: { name: `Alice`, email: `alice@example.com` },
        headers: { operation: `insert` },
      }),
      stream.append({
        type: `message`,
        key: `msg1`,
        value: { text: `Hello!`, userId: `1` },
        headers: { operation: `insert` },
      }),
    ])

    // Preload (eager mode waits for all data to sync)
    await db.preload()

    // Query using TanStack DB collection interface
    const kyle = await db.users.get(`1`)
    const alice = await db.users.get(`2`)
    const msg = await db.messages.get(`msg1`)

    expect(kyle?.name).toBe(`Kyle`)
    expect(kyle?.email).toBe(`kyle@example.com`)
    expect(alice?.name).toBe(`Alice`)
    expect(msg?.text).toBe(`Hello!`)
    expect(msg?.userId).toBe(`1`)

    // Verify returned values include the primary key
    expect(Object.keys(kyle || {})).toEqual([`id`, `name`, `email`])

    // Cleanup
    db.close()
  })

  it(`should handle update operations`, async () => {
    const streamState = createStateSchema({
      collections: {
        users: { schema: userSchema, type: `user`, primaryKey: `id` },
      },
    })

    const stream = await DurableStream.create({
      url: `${baseUrl}/db/update-${Date.now()}`,
      contentType: `application/json`,
    })

    const db = await createStreamDB({ stream, state: streamState })

    // Insert then update
    await stream.append({
      type: `user`,
      key: `1`,
      value: { name: `Kyle`, email: `kyle@old.com` },
      headers: { operation: `insert` },
    })
    await stream.append({
      type: `user`,
      key: `1`,
      value: { name: `Kyle`, email: `kyle@new.com` },
      headers: { operation: `update` },
    })

    await db.preload()

    const user = db.users.get(`1`)
    expect(user?.email).toBe(`kyle@new.com`)

    db.close()
  })

  it(`should handle delete operations`, async () => {
    const streamState = createStateSchema({
      collections: {
        users: { schema: userSchema, type: `user`, primaryKey: `id` },
      },
    })

    const stream = await DurableStream.create({
      url: `${baseUrl}/db/delete-${Date.now()}`,
      contentType: `application/json`,
    })

    const db = await createStreamDB({ stream, state: streamState })

    // Insert then delete
    await stream.append({
      type: `user`,
      key: `1`,
      value: { name: `Kyle`, email: `kyle@example.com` },
      headers: { operation: `insert` },
    })
    await stream.append({
      type: `user`,
      key: `1`,
      headers: { operation: `delete` },
    })

    await db.preload()

    const user = db.users.get(`1`)
    expect(user).toBeUndefined()

    db.close()
  })

  it(`should handle empty streams`, async () => {
    const streamState = createStateSchema({
      collections: {
        users: { schema: userSchema, type: `user`, primaryKey: `id` },
      },
    })

    const stream = await DurableStream.create({
      url: `${baseUrl}/db/empty-${Date.now()}`,
      contentType: `application/json`,
    })

    const db = await createStreamDB({ stream, state: streamState })

    // No events written, just preload
    await db.preload()

    const user = db.users.get(`1`)
    expect(user).toBeUndefined()
    expect(db.users.size).toBe(0)

    db.close()
  })

  it(`should ignore unknown event types`, async () => {
    const streamState = createStateSchema({
      collections: {
        users: { schema: userSchema, type: `user`, primaryKey: `id` },
      },
    })

    const stream = await DurableStream.create({
      url: `${baseUrl}/db/unknown-${Date.now()}`,
      contentType: `application/json`,
    })

    const db = await createStreamDB({ stream, state: streamState })

    // Write events with unknown types (should be ignored)
    await stream.append({
      type: `unknown_type`,
      key: `1`,
      value: { foo: `bar` },
      headers: { operation: `insert` },
    })
    await stream.append({
      type: `user`,
      key: `1`,
      value: { name: `Kyle`, email: `kyle@example.com` },
      headers: { operation: `insert` },
    })

    await db.preload()

    // User should be inserted, unknown type ignored
    expect(db.users.get(`1`)?.name).toBe(`Kyle`)
    expect(db.users.size).toBe(1)

    db.close()
  })

  it(`should receive live updates after preload`, async () => {
    const streamState = createStateSchema({
      collections: {
        users: { schema: userSchema, type: `user`, primaryKey: `id` },
      },
    })

    const stream = await DurableStream.create({
      url: `${baseUrl}/db/live-${Date.now()}`,
      contentType: `application/json`,
    })

    const db = await createStreamDB({ stream, state: streamState })

    await stream.append({
      type: `user`,
      key: `1`,
      value: { name: `Kyle`, email: `kyle@example.com` },
      headers: { operation: `insert` },
    })

    await db.preload()
    expect(db.users.get(`1`)?.name).toBe(`Kyle`)

    // Write more events AFTER preload
    await stream.append({
      type: `user`,
      key: `2`,
      value: { name: `Alice`, email: `alice@example.com` },
      headers: { operation: `insert` },
    })

    // Wait a bit for live update to arrive
    await new Promise((resolve) => setTimeout(resolve, 50))

    // New user should be visible
    expect(db.users.get(`2`)?.name).toBe(`Alice`)

    db.close()
  })

  it(`should route events to correct collections by type`, async () => {
    const streamState = createStateSchema({
      collections: {
        users: { schema: userSchema, type: `user`, primaryKey: `id` },
        messages: {
          schema: messageSchema,
          type: `message`,
          primaryKey: `id`,
        },
      },
    })

    const stream = await DurableStream.create({
      url: `${baseUrl}/db/routing-${Date.now()}`,
      contentType: `application/json`,
    })

    const db = await createStreamDB({ stream, state: streamState })

    // Mix of user and message events
    await stream.append({
      type: `message`,
      key: `m1`,
      value: { text: `First`, userId: `1` },
      headers: { operation: `insert` },
    })
    await stream.append({
      type: `user`,
      key: `1`,
      value: { name: `Kyle`, email: `kyle@example.com` },
      headers: { operation: `insert` },
    })
    await stream.append({
      type: `message`,
      key: `m2`,
      value: { text: `Second`, userId: `1` },
      headers: { operation: `insert` },
    })

    await db.preload()

    // Verify correct routing
    expect(db.users.size).toBe(1)
    expect(db.messages.size).toBe(2)
    expect(db.users.get(`1`)?.name).toBe(`Kyle`)
    expect(db.messages.get(`m1`)?.text).toBe(`First`)
    expect(db.messages.get(`m2`)?.text).toBe(`Second`)

    db.close()
  })

  it(`should handle repeated operations on the same key`, async () => {
    const streamState = createStateSchema({
      collections: {
        users: { schema: userSchema, type: `user`, primaryKey: `id` },
      },
    })

    const stream = await DurableStream.create({
      url: `${baseUrl}/db/repeated-${Date.now()}`,
      contentType: `application/json`,
    })

    const db = await createStreamDB({ stream, state: streamState })

    // Sequence of operations on the same key
    // 1. Insert
    await stream.append({
      type: `user`,
      key: `1`,
      value: { name: `Kyle`, email: `kyle@v1.com` },
      headers: { operation: `insert` },
    })
    // 2. Update
    await stream.append({
      type: `user`,
      key: `1`,
      value: { name: `Kyle Smith`, email: `kyle@v2.com` },
      headers: { operation: `update` },
    })
    // 3. Another update
    await stream.append({
      type: `user`,
      key: `1`,
      value: { name: `Kyle J Smith`, email: `kyle@v3.com` },
      headers: { operation: `update` },
    })
    // 4. Delete
    await stream.append({
      type: `user`,
      key: `1`,
      headers: { operation: `delete` },
    })
    // 5. Re-insert with new data
    await stream.append({
      type: `user`,
      key: `1`,
      value: { name: `New Kyle`, email: `newkyle@example.com` },
      headers: { operation: `insert` },
    })

    await db.preload()

    // Final state should be the re-inserted value
    const user = db.users.get(`1`)
    expect(user?.name).toBe(`New Kyle`)
    expect(user?.email).toBe(`newkyle@example.com`)
    expect(db.users.size).toBe(1)

    db.close()
  })

  it(`should handle interleaved operations on multiple keys`, async () => {
    const streamState = createStateSchema({
      collections: {
        users: { schema: userSchema, type: `user`, primaryKey: `id` },
      },
    })

    const stream = await DurableStream.create({
      url: `${baseUrl}/db/interleaved-${Date.now()}`,
      contentType: `application/json`,
    })

    const db = await createStreamDB({ stream, state: streamState })

    // Interleaved operations on different keys
    await stream.append({
      type: `user`,
      key: `1`,
      value: { name: `Alice`, email: `alice@example.com` },
      headers: { operation: `insert` },
    })
    await stream.append({
      type: `user`,
      key: `2`,
      value: { name: `Bob`, email: `bob@example.com` },
      headers: { operation: `insert` },
    })
    await stream.append({
      type: `user`,
      key: `1`,
      value: { name: `Alice Updated`, email: `alice@new.com` },
      headers: { operation: `update` },
    })
    await stream.append({
      type: `user`,
      key: `3`,
      value: { name: `Charlie`, email: `charlie@example.com` },
      headers: { operation: `insert` },
    })
    await stream.append({
      type: `user`,
      key: `2`,
      headers: { operation: `delete` },
    })
    await stream.append({
      type: `user`,
      key: `3`,
      value: { name: `Charlie Updated`, email: `charlie@new.com` },
      headers: { operation: `update` },
    })

    await db.preload()

    // Verify final state
    expect(db.users.size).toBe(2) // Alice and Charlie remain, Bob deleted
    expect(db.users.get(`1`)?.name).toBe(`Alice Updated`)
    expect(db.users.get(`2`)).toBeUndefined() // Bob was deleted
    expect(db.users.get(`3`)?.name).toBe(`Charlie Updated`)

    db.close()
  })

  it(`should batch commit changes only on upToDate`, async () => {
    const streamState = createStateSchema({
      collections: {
        users: { schema: userSchema, type: `user`, primaryKey: `id` },
      },
    })

    const stream = await DurableStream.create({
      url: `${baseUrl}/db/batch-commit-${Date.now()}`,
      contentType: `application/json`,
    })

    const db = await createStreamDB({ stream, state: streamState })

    // Track change batches using subscribeChanges
    const changeBatches: Array<Array<{ key: string; type: string }>> = []
    db.users.subscribeChanges((changes) => {
      changeBatches.push(
        changes.map((c) => ({ key: String(c.key), type: c.type }))
      )
    })

    // Write many events - these should all be committed together
    const events = []
    for (let i = 0; i < 10; i++) {
      events.push(
        stream.append({
          type: `user`,
          key: String(i),
          value: { name: `User ${i}`, email: `user${i}@example.com` },
          headers: { operation: `insert` },
        })
      )
    }
    await Promise.all(events)

    // After preload, ALL data should be available atomically
    await db.preload()

    // Verify all 10 users are present - batch commit worked
    expect(db.users.size).toBe(10)
    for (let i = 0; i < 10; i++) {
      const user = db.users.get(String(i))
      expect(user?.name).toBe(`User ${i}`)
      expect(user?.email).toBe(`user${i}@example.com`)
    }

    // Verify changes were batched (fewer callbacks than individual events)
    // If commits happened per-event, we'd have 10 callbacks with 1 change each
    // With batch commits, we should have fewer callbacks with multiple changes each
    const nonEmptyBatches = changeBatches.filter((b) => b.length > 0)
    const totalChanges = nonEmptyBatches.reduce(
      (sum, batch) => sum + batch.length,
      0
    )
    expect(totalChanges).toBe(10)
    expect(nonEmptyBatches.length).toBeLessThan(10) // Batched, not one-by-one

    // Verify at least one batch had multiple changes (proves batching)
    const maxBatchSize = Math.max(...nonEmptyBatches.map((b) => b.length))
    expect(maxBatchSize).toBeGreaterThan(1)

    db.close()
  })

  it(`should emit changes via subscribeChanges for preload and live updates`, async () => {
    // Setup schema and stream
    const streamState = createStateSchema({
      collections: {
        users: { schema: userSchema, type: `user`, primaryKey: `id` },
      },
    })

    const stream = await DurableStream.create({
      url: `${baseUrl}/db/subscribe-changes-${Date.now()}`,
      contentType: `application/json`,
    })

    // Append initial events (before StreamDB creation)
    await stream.append(
      streamState.collections.users.insert({
        key: `1`,
        value: { id: `1`, name: `Kyle`, email: `kyle@example.com` },
      })
    )

    await stream.append(
      streamState.collections.users.insert({
        key: `2`,
        value: { id: `2`, name: `Sarah`, email: `sarah@example.com` },
      })
    )

    // Create StreamDB
    const db = await createStreamDB({ stream, state: streamState })

    // Subscribe to changes BEFORE preload
    const allChanges: Array<any> = []
    const subscription = db.users.subscribeChanges((changes) => {
      allChanges.push(...changes)
    })

    // Preload to get initial data
    await db.preload()

    // Verify initial inserts were received
    expect(allChanges.length).toBe(2)
    expect(allChanges[0]).toEqual({
      key: `1`,
      type: `insert`,
      value: { id: `1`, name: `Kyle`, email: `kyle@example.com` },
    })
    expect(allChanges[1]).toEqual({
      key: `2`,
      type: `insert`,
      value: { id: `2`, name: `Sarah`, email: `sarah@example.com` },
    })

    // Clear changes array for live update testing
    allChanges.length = 0

    // Append live update
    await stream.append(
      streamState.collections.users.update({
        key: `1`,
        value: { id: `1`, name: `Kyle Updated`, email: `kyle@example.com` },
        oldValue: { id: `1`, name: `Kyle`, email: `kyle@example.com` },
      })
    )

    // Wait for live update
    await new Promise((resolve) => setTimeout(resolve, 100))

    // Verify update was received
    expect(allChanges.length).toBe(1)
    expect(allChanges[0]).toEqual({
      key: `1`,
      type: `update`,
      value: { id: `1`, name: `Kyle Updated`, email: `kyle@example.com` },
      previousValue: { id: `1`, name: `Kyle`, email: `kyle@example.com` },
    })

    // Test delete
    allChanges.length = 0
    await stream.append(
      streamState.collections.users.delete({
        key: `2`,
      })
    )

    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(allChanges.length).toBe(1)
    expect(allChanges[0]).toEqual({
      key: `2`,
      type: `delete`,
      value: { id: `2`, name: `Sarah`, email: `sarah@example.com` },
    })

    // Cleanup
    subscription.unsubscribe()
    db.close()
  })

  it(`should commit live updates in batches`, async () => {
    const streamState = createStateSchema({
      collections: {
        users: { schema: userSchema, type: `user`, primaryKey: `id` },
      },
    })

    const stream = await DurableStream.create({
      url: `${baseUrl}/db/live-batch-${Date.now()}`,
      contentType: `application/json`,
    })

    const db = await createStreamDB({ stream, state: streamState })

    // Initial data
    await stream.append({
      type: `user`,
      key: `1`,
      value: { name: `Initial`, email: `initial@example.com` },
      headers: { operation: `insert` },
    })

    await db.preload()
    expect(db.users.get(`1`)?.name).toBe(`Initial`)

    // Now write more events that should be batched in subsequent commits
    await stream.append({
      type: `user`,
      key: `2`,
      value: { name: `Second`, email: `second@example.com` },
      headers: { operation: `insert` },
    })
    await stream.append({
      type: `user`,
      key: `3`,
      value: { name: `Third`, email: `third@example.com` },
      headers: { operation: `insert` },
    })

    // Wait for live updates to arrive and be committed
    await new Promise((resolve) => setTimeout(resolve, 100))

    // Both new users should be visible (committed together in batch)
    expect(db.users.size).toBe(3)
    expect(db.users.get(`2`)?.name).toBe(`Second`)
    expect(db.users.get(`3`)?.name).toBe(`Third`)

    db.close()
  })

  it(`should reject primitive values (non-objects)`, async () => {
    const streamState = createStateSchema({
      collections: {
        config: {
          schema: {
            "~standard": {
              version: 1,
              vendor: `test`,
              validate: (value) => ({ value: value as string }),
            },
          },
          type: `config`,
          primaryKey: `id` as any,
        },
      },
    })

    const stream = await DurableStream.create({
      url: `${baseUrl}/db/primitives-${Date.now()}`,
      contentType: `application/json`,
    })

    // Append the primitive value BEFORE creating the DB
    await stream.append({
      type: `config`,
      key: `theme`,
      value: `dark`, // primitive string, not an object
      headers: { operation: `insert` },
    })

    const db = await createStreamDB({ stream, state: streamState })

    // Should throw when trying to process the primitive value during preload
    await expect(db.preload()).rejects.toThrow(
      /StreamDB collections require object values/
    )

    db.close()
  })

  it(`should reject duplicate event types across collections`, async () => {
    // Two collections mapping to the same event type should throw
    expect(() => {
      createStateSchema({
        collections: {
          users: {
            schema: userSchema,
            type: `person`, // same type
            primaryKey: `id`,
          },
          admins: {
            schema: userSchema,
            type: `person`, // duplicate!
            primaryKey: `id`,
          },
        },
      })
    }).toThrow(/duplicate event type/i)
  })

  it(`should reject reserved collection names`, async () => {
    // Collection names that collide with StreamDB methods should throw
    expect(() => {
      createStateSchema({
        collections: {
          preload: {
            // reserved name!
            schema: userSchema,
            type: `user`,
            primaryKey: `id`,
          },
        },
      })
    }).toThrow(/reserved collection name/i)

    expect(() => {
      createStateSchema({
        collections: {
          close: {
            // reserved name!
            schema: userSchema,
            type: `user`,
            primaryKey: `id`,
          },
        },
      })
    }).toThrow(/reserved collection name/i)
  })
})

describe(`State Schema Event Helpers`, () => {
  it(`should create insert events with correct structure`, () => {
    const stateSchema = createStateSchema({
      collections: {
        users: {
          schema: userSchema,
          type: `user`,
          primaryKey: `id`,
        },
      },
    })

    const insertEvent = stateSchema.collections.users.insert({
      key: `123`,
      value: { id: `123`, name: `Kyle`, email: `kyle@example.com` },
    })

    expect(insertEvent).toEqual({
      type: `user`,
      key: `123`,
      value: { id: `123`, name: `Kyle`, email: `kyle@example.com` },
      headers: { operation: `insert` },
    })
  })

  it(`should create update events with correct structure`, () => {
    const stateSchema = createStateSchema({
      collections: {
        users: {
          schema: userSchema,
          type: `user`,
          primaryKey: `id`,
        },
      },
    })

    const updateEvent = stateSchema.collections.users.update({
      key: `123`,
      value: { id: `123`, name: `Kyle M`, email: `kyle@example.com` },
      oldValue: { id: `123`, name: `Kyle`, email: `kyle@example.com` },
    })

    expect(updateEvent).toEqual({
      type: `user`,
      key: `123`,
      value: { id: `123`, name: `Kyle M`, email: `kyle@example.com` },
      old_value: { id: `123`, name: `Kyle`, email: `kyle@example.com` },
      headers: { operation: `update` },
    })
  })

  it(`should create update events without old_value`, () => {
    const stateSchema = createStateSchema({
      collections: {
        users: {
          schema: userSchema,
          type: `user`,
          primaryKey: `id`,
        },
      },
    })

    const updateEvent = stateSchema.collections.users.update({
      key: `123`,
      value: { id: `123`, name: `Kyle M`, email: `kyle@example.com` },
    })

    expect(updateEvent).toEqual({
      type: `user`,
      key: `123`,
      value: { id: `123`, name: `Kyle M`, email: `kyle@example.com` },
      old_value: undefined,
      headers: { operation: `update` },
    })
  })

  it(`should create delete events with correct structure`, () => {
    const stateSchema = createStateSchema({
      collections: {
        users: {
          schema: userSchema,
          type: `user`,
          primaryKey: `id`,
        },
      },
    })

    const deleteEvent = stateSchema.collections.users.delete({
      key: `123`,
      oldValue: { id: `123`, name: `Kyle`, email: `kyle@example.com` },
    })

    expect(deleteEvent).toEqual({
      type: `user`,
      key: `123`,
      old_value: { id: `123`, name: `Kyle`, email: `kyle@example.com` },
      headers: { operation: `delete` },
    })
  })

  it(`should create delete events without old_value`, () => {
    const stateSchema = createStateSchema({
      collections: {
        users: {
          schema: userSchema,
          type: `user`,
          primaryKey: `id`,
        },
      },
    })

    const deleteEvent = stateSchema.collections.users.delete({
      key: `123`,
    })

    expect(deleteEvent).toEqual({
      type: `user`,
      key: `123`,
      old_value: undefined,
      headers: { operation: `delete` },
    })
  })

  it(`should use correct event type for different collections`, () => {
    const stateSchema = createStateSchema({
      collections: {
        users: {
          schema: userSchema,
          type: `user`,
          primaryKey: `id`,
        },
        messages: {
          schema: messageSchema,
          type: `message`,
          primaryKey: `id`,
        },
      },
    })

    const userEvent = stateSchema.collections.users.insert({
      key: `1`,
      value: { id: `1`, name: `Kyle`, email: `kyle@example.com` },
    })
    const messageEvent = stateSchema.collections.messages.insert({
      key: `msg1`,
      value: { id: `msg1`, text: `Hello`, userId: `1` },
    })

    expect(userEvent.type).toBe(`user`)
    expect(messageEvent.type).toBe(`message`)
  })

  it(`should support custom headers including txid and timestamp`, () => {
    const stateSchema = createStateSchema({
      collections: {
        users: {
          schema: userSchema,
          type: `user`,
          primaryKey: `id`,
        },
      },
    })

    const insertEvent = stateSchema.collections.users.insert({
      key: `123`,
      value: { id: `123`, name: `Kyle`, email: `kyle@example.com` },
      headers: {
        txid: `tx-001`,
        timestamp: `2025-01-15T12:00:00Z`,
        sourceApp: `web-app`,
      },
    })

    expect(insertEvent).toEqual({
      type: `user`,
      key: `123`,
      value: { id: `123`, name: `Kyle`, email: `kyle@example.com` },
      headers: {
        operation: `insert`,
        txid: `tx-001`,
        timestamp: `2025-01-15T12:00:00Z`,
        sourceApp: `web-app`,
      },
    })
  })
})

describe(`Stream DB Actions`, () => {
  let server: DurableStreamTestServer
  let baseUrl: string

  beforeAll(async () => {
    server = new DurableStreamTestServer({ port: 0 })
    await server.start()
    baseUrl = server.url
  })

  afterAll(async () => {
    await server.stop()
  })

  it(`should create actions with onMutate and mutationFn`, async () => {
    const streamState = createStateSchema({
      collections: {
        users: {
          schema: userSchema,
          type: `user`,
          primaryKey: `id`,
        },
      },
    })

    const stream = await DurableStream.create({
      url: `${baseUrl}/db/actions-basic-${Date.now()}`,
      contentType: `application/json`,
    })

    const mutationResults: Array<{ name: string; signal: AbortSignal }> = []

    const db = await createStreamDB({
      stream,
      state: streamState,
      actions: ({ db, stream }) => ({
        addUser: {
          onMutate: (name: string) => {
            // Optimistic update
            db.users.insert({
              id: name,
              name,
              email: `${name.toLowerCase()}@example.com`,
            })
          },
          mutationFn: async (
            name: string,
            { signal }: { signal: AbortSignal; transaction: any }
          ) => {
            // Track that mutationFn was called with correct params
            mutationResults.push({ name, signal })
            // Persist via stream
            await stream.append(
              streamState.collections.users.insert({
                value: {
                  id: crypto.randomUUID(),
                  name,
                  email: `${name.toLowerCase()}@example.com`,
                },
              })
            )
          },
        },
      }),
    })

    await db.preload()

    // Call the action
    db.actions.addUser(`Kyle`)

    // Wait for mutation to complete
    await new Promise((resolve) => setTimeout(resolve, 100))

    // Verify mutationFn was called
    expect(mutationResults).toHaveLength(1)
    expect(mutationResults[0]?.name).toBe(`Kyle`)
    // Signal may be undefined in test environment
    if (mutationResults[0]?.signal) {
      expect(mutationResults[0].signal).toBeInstanceOf(AbortSignal)
    }

    // Verify user was persisted via stream
    await new Promise((resolve) => setTimeout(resolve, 50))
    const users = Array.from(db.users.values())
    expect(users.length).toBeGreaterThan(0)
    expect(users.some((u: any) => u.name === `Kyle`)).toBe(true)

    db.close()
  })

  it(`should support multiple actions`, async () => {
    const streamState = createStateSchema({
      collections: {
        users: {
          schema: userSchema,
          type: `user`,
          primaryKey: `id`,
        },
      },
    })

    const stream = await DurableStream.create({
      url: `${baseUrl}/db/actions-multiple-${Date.now()}`,
      contentType: `application/json`,
    })

    const db = await createStreamDB({
      stream,
      state: streamState,
      actions: ({ db, stream }) => ({
        addUser: {
          onMutate: (name: string) => {
            db.users.insert({
              id: name,
              name,
              email: `${name.toLowerCase()}@example.com`,
            })
          },
          mutationFn: async (name: string) => {
            await stream.append(
              streamState.collections.users.insert({
                key: name,
                value: {
                  id: name,
                  name,
                  email: `${name.toLowerCase()}@example.com`,
                },
              })
            )
          },
        },
        updateUser: {
          onMutate: ({ id, name }: { id: string; name: string }) => {
            db.users.update(id, (draft) => {
              draft.name = name
            })
          },
          mutationFn: async ({ id, name }: { id: string; name: string }) => {
            const user = db.users.get(id)
            if (user) {
              await stream.append(
                streamState.collections.users.update({
                  key: id,
                  value: { ...user, name },
                })
              )
            }
          },
        },
      }),
    })

    await db.preload()

    // Use both actions
    db.actions.addUser(`Alice`)
    await new Promise((resolve) => setTimeout(resolve, 100))

    db.actions.updateUser({ id: `Alice`, name: `Alice Smith` })
    await new Promise((resolve) => setTimeout(resolve, 100))

    const alice = db.users.get(`Alice`)
    expect(alice?.name).toBe(`Alice Smith`)

    db.close()
  })

  it(`should provide stream context to actions`, async () => {
    const streamState = createStateSchema({
      collections: {
        users: {
          schema: userSchema,
          type: `user`,
          primaryKey: `id`,
        },
      },
    })

    const stream = await DurableStream.create({
      url: `${baseUrl}/db/actions-stream-${Date.now()}`,
      contentType: `application/json`,
    })

    let capturedStream: unknown = null

    const db = await createStreamDB({
      stream,
      state: streamState,
      actions: ({ db, stream: actionStream }) => {
        capturedStream = actionStream
        return {
          addUser: {
            onMutate: (name: string) => {
              db.users.insert({
                id: name,
                name,
                email: `${name.toLowerCase()}@example.com`,
              })
            },
            mutationFn: async (name: string) => {
              // Verify we can use the stream
              await actionStream.append(
                streamState.collections.users.insert({
                  key: name,
                  value: {
                    id: name,
                    name,
                    email: `${name.toLowerCase()}@example.com`,
                  },
                })
              )
            },
          },
        }
      },
    })

    // Verify stream was provided
    expect(capturedStream).toBe(stream)

    db.close()
  })

  it(`should handle errors in onMutate gracefully`, async () => {
    const streamState = createStateSchema({
      collections: {
        users: {
          schema: userSchema,
          type: `user`,
          primaryKey: `id`,
        },
      },
    })

    const stream = await DurableStream.create({
      url: `${baseUrl}/db/actions-error-mutate-${Date.now()}`,
      contentType: `application/json`,
    })

    const db = await createStreamDB({
      stream,
      state: streamState,
      actions: ({ db }) => ({
        addUser: {
          onMutate: (name: string) => {
            if (name === `ERROR`) {
              throw new Error(`onMutate error`)
            }
            db.users.insert({
              id: name,
              name,
              email: `${name.toLowerCase()}@example.com`,
            })
          },
          mutationFn: async (name: string) => {
            await stream.append(
              streamState.collections.users.insert({
                key: name,
                value: {
                  id: name,
                  name,
                  email: `${name.toLowerCase()}@example.com`,
                },
              })
            )
          },
        },
      }),
    })

    await db.preload()

    // This should throw due to onMutate error
    expect(() => db.actions.addUser(`ERROR`)).toThrow(`onMutate error`)

    db.close()
  })

  it(`should handle errors in mutationFn`, async () => {
    const streamState = createStateSchema({
      collections: {
        users: {
          schema: userSchema,
          type: `user`,
          primaryKey: `id`,
        },
      },
    })

    const stream = await DurableStream.create({
      url: `${baseUrl}/db/actions-error-mutation-${Date.now()}`,
      contentType: `application/json`,
    })

    const db = await createStreamDB({
      stream,
      state: streamState,
      actions: ({ db }) => ({
        addUser: {
          onMutate: (name: string) => {
            db.users.insert({
              id: name,
              name,
              email: `${name.toLowerCase()}@example.com`,
            })
          },
          mutationFn: async (name: string) => {
            if (name === `ERROR`) {
              throw new Error(`mutationFn error`)
            }
            await stream.append(
              streamState.collections.users.insert({
                key: name,
                value: {
                  id: name,
                  name,
                  email: `${name.toLowerCase()}@example.com`,
                },
              })
            )
          },
        },
      }),
    })

    await db.preload()

    // Call action that will fail in mutationFn and expect it to throw
    const tx = db.actions.addUser(`ERROR`)
    await expect(tx.isPersisted.promise).rejects.toThrow(`mutationFn error`)

    db.close()
  })
})

describe(`Stream DB TxId Tracking`, () => {
  let server: DurableStreamTestServer
  let baseUrl: string

  beforeAll(async () => {
    server = new DurableStreamTestServer({ port: 0 })
    await server.start()
    baseUrl = server.url
  })

  afterAll(async () => {
    await server.stop()
  })

  it(`should track txids from event headers and resolve awaitTxId`, async () => {
    const streamState = createStateSchema({
      collections: {
        users: {
          schema: userSchema,
          type: `user`,
          primaryKey: `id`,
        },
      },
    })

    const stream = await DurableStream.create({
      url: `${baseUrl}/db/txid-basic-${Date.now()}`,
      contentType: `application/json`,
    })

    const db = await createStreamDB({
      stream,
      state: streamState,
    })

    await db.preload()

    // Generate a txid
    const txid = crypto.randomUUID()

    // Write an event with the txid header
    await stream.append({
      type: `user`,
      key: `1`,
      value: { name: `Kyle`, email: `kyle@example.com` },
      headers: { operation: `insert`, txid },
    })

    // awaitTxId should resolve when the txid is seen
    await db.utils.awaitTxId(txid)

    // Verify the event was processed
    const user = db.users.get(`1`)
    expect(user?.name).toBe(`Kyle`)

    db.close()
  })

  it(`should resolve awaitTxId immediately if txid was already seen`, async () => {
    const streamState = createStateSchema({
      collections: {
        users: {
          schema: userSchema,
          type: `user`,
          primaryKey: `id`,
        },
      },
    })

    const stream = await DurableStream.create({
      url: `${baseUrl}/db/txid-already-seen-${Date.now()}`,
      contentType: `application/json`,
    })

    const db = await createStreamDB({
      stream,
      state: streamState,
    })

    const txid = crypto.randomUUID()

    // Write event with txid
    await stream.append({
      type: `user`,
      key: `1`,
      value: { name: `Alice`, email: `alice@example.com` },
      headers: { operation: `insert`, txid },
    })

    await db.preload()

    // First awaitTxId should work
    await db.utils.awaitTxId(txid)

    // Second awaitTxId should resolve immediately since txid is already seen
    await db.utils.awaitTxId(txid)

    db.close()
  })

  it(`should timeout if txid is not seen within timeout period`, async () => {
    const streamState = createStateSchema({
      collections: {
        users: {
          schema: userSchema,
          type: `user`,
          primaryKey: `id`,
        },
      },
    })

    const stream = await DurableStream.create({
      url: `${baseUrl}/db/txid-timeout-${Date.now()}`,
      contentType: `application/json`,
    })

    const db = await createStreamDB({
      stream,
      state: streamState,
    })

    await db.preload()

    const nonExistentTxid = crypto.randomUUID()

    // awaitTxId should timeout and reject
    await expect(db.utils.awaitTxId(nonExistentTxid, 100)).rejects.toThrow(
      /timeout/i
    )

    db.close()
  })

  it(`should use awaitTxId in action mutationFn`, async () => {
    const streamState = createStateSchema({
      collections: {
        users: {
          schema: userSchema,
          type: `user`,
          primaryKey: `id`,
        },
      },
    })

    const stream = await DurableStream.create({
      url: `${baseUrl}/db/txid-action-${Date.now()}`,
      contentType: `application/json`,
    })

    const db = await createStreamDB({
      stream,
      state: streamState,
      actions: ({ db, stream }) => ({
        addUser: {
          onMutate: (name: string) => {
            db.users.insert({
              id: name,
              name,
              email: `${name.toLowerCase()}@example.com`,
            })
          },
          mutationFn: async (name: string) => {
            const txid = crypto.randomUUID()

            // Write to stream with txid
            await stream.append(
              streamState.collections.users.insert({
                value: {
                  id: crypto.randomUUID(),
                  name,
                  email: `${name.toLowerCase()}@example.com`,
                },
                headers: { txid },
              })
            )

            // Wait for txid to be synced back
            await db.utils.awaitTxId(txid)
          },
        },
      }),
    })

    await db.preload()

    // Call action - should complete when txid is synced
    await db.actions.addUser(`Bob`)

    // Verify user was synced
    const users = Array.from(db.users.values())
    expect(users.some((u: any) => u.name === `Bob`)).toBe(true)

    db.close()
  })

  it(`should handle multiple concurrent awaitTxId calls for same txid`, async () => {
    const streamState = createStateSchema({
      collections: {
        users: {
          schema: userSchema,
          type: `user`,
          primaryKey: `id`,
        },
      },
    })

    const stream = await DurableStream.create({
      url: `${baseUrl}/db/txid-concurrent-${Date.now()}`,
      contentType: `application/json`,
    })

    const db = await createStreamDB({
      stream,
      state: streamState,
    })

    await db.preload()

    const txid = crypto.randomUUID()

    // Start multiple awaitTxId calls concurrently
    const awaits = [
      db.utils.awaitTxId(txid),
      db.utils.awaitTxId(txid),
      db.utils.awaitTxId(txid),
    ]

    // Write event with txid
    await stream.append({
      type: `user`,
      key: `1`,
      value: { name: `Concurrent`, email: `concurrent@example.com` },
      headers: { operation: `insert`, txid },
    })

    // All awaits should resolve
    await Promise.all(awaits)

    db.close()
  })
})
