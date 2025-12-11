import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { DurableStreamTestServer } from "@durable-streams/server"
import { DurableStream } from "@durable-streams/writer"
import { createStreamDB, defineStreamState } from "../src/index"
import type { StandardSchemaV1 } from "@standard-schema/spec"

// Simple Standard Schema implementations for testing
const userSchema: StandardSchemaV1<{ name: string; email: string }> = {
  "~standard": {
    version: 1,
    vendor: `test`,
    validate: (value) => {
      if (
        typeof value !== `object` ||
        value === null ||
        typeof (value as { name?: unknown }).name !== `string` ||
        typeof (value as { email?: unknown }).email !== `string`
      ) {
        return { issues: [{ message: `Invalid user` }] }
      }
      return { value: value as { name: string; email: string } }
    },
  },
}

const messageSchema: StandardSchemaV1<{ text: string; userId: string }> = {
  "~standard": {
    version: 1,
    vendor: `test`,
    validate: (value) => {
      if (
        typeof value !== `object` ||
        value === null ||
        typeof (value as { text?: unknown }).text !== `string` ||
        typeof (value as { userId?: unknown }).userId !== `string`
      ) {
        return { issues: [{ message: `Invalid message` }] }
      }
      return { value: value as { text: string; userId: string } }
    },
  },
}

describe(`Stream DB`, () => {
  let server: DurableStreamTestServer
  let baseUrl: string
  const dbs: Array<{ close: () => void }> = []

  beforeAll(async () => {
    server = new DurableStreamTestServer({ port: 0 })
    await server.start()
    baseUrl = server.url
  })

  afterAll(async () => {
    // Close all db instances to abort stream subscriptions
    for (const db of dbs) {
      db.close()
    }
    await server.stop()
  })

  it(`should define stream state and create db with collections`, async () => {
    // Define the stream state structure
    const streamState = defineStreamState({
      collections: {
        users: {
          schema: userSchema,
          type: `user`, // Maps to change event type field
        },
        messages: {
          schema: messageSchema,
          type: `message`,
        },
      },
    })

    // Create a durable stream
    const streamPath = `/db/chat-${Date.now()}`
    const stream = await DurableStream.create({
      url: `${baseUrl}${streamPath}`,
      contentType: `application/json`,
    })

    // Write change events BEFORE creating the DB so they're there when streaming starts
    await Promise.all([
      stream.append({
        type: `user`,
        key: `1`,
        value: { name: `Kyle`, email: `kyle@example.com` },
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

    // Create the stream DB - streaming starts automatically and catches up
    const db = await createStreamDB({
      stream,
      state: streamState,
    })
    dbs.push(db)

    // Verify collections are accessible
    expect(db.users).toBeDefined()
    expect(db.messages).toBeDefined()

    // Preload (waits for catch-up to complete)
    await db.preload()

    // Query using TanStack DB collection interface
    const kyle = db.users.state.get(`1`)
    const alice = db.users.state.get(`2`)
    const msg = db.messages.state.get(`msg1`)

    expect(kyle?.name).toBe(`Kyle`)
    expect(kyle?.email).toBe(`kyle@example.com`)
    expect(alice?.name).toBe(`Alice`)
    expect(msg?.text).toBe(`Hello!`)
    expect(msg?.userId).toBe(`1`)
  })

  it(`should receive live updates after preload`, async () => {
    const streamState = defineStreamState({
      collections: {
        users: {
          schema: userSchema,
          type: `user`,
        },
        messages: {
          schema: messageSchema,
          type: `message`,
        },
      },
    })

    const streamPath = `/db/chat-live-${Date.now()}`
    const stream = await DurableStream.create({
      url: `${baseUrl}${streamPath}`,
      contentType: `application/json`,
    })

    const db = await createStreamDB({
      stream,
      state: streamState,
    })
    dbs.push(db)

    // Add initial data
    await stream.append({
      type: `user`,
      key: `1`,
      value: { name: `Kyle`, email: `kyle@example.com` },
      headers: { operation: `insert` },
    })

    // Preload initial data
    await db.preload()

    // Verify initial data
    expect(db.users.state.get(`1`)?.name).toBe(`Kyle`)
    expect(db.users.state.get(`2`)).toBeUndefined()

    // Add new data after preload - should be received via live subscription
    await stream.append({
      type: `user`,
      key: `2`,
      value: { name: `Alice`, email: `alice@example.com` },
      headers: { operation: `insert` },
    })

    // Wait for live update to be processed
    await new Promise((resolve) => setTimeout(resolve, 100))

    // Verify live data was received
    const alice = db.users.state.get(`2`)
    expect(alice?.name).toBe(`Alice`)
    expect(alice?.email).toBe(`alice@example.com`)
  })

  it(`should handle live updates, modifications, and deletes`, async () => {
    const streamState = defineStreamState({
      collections: {
        messages: {
          schema: messageSchema,
          type: `message`,
        },
      },
    })

    const streamPath = `/db/messages-${Date.now()}`
    const stream = await DurableStream.create({
      url: `${baseUrl}${streamPath}`,
      contentType: `application/json`,
    })

    const db = await createStreamDB({
      stream,
      state: streamState,
    })
    dbs.push(db)

    // Start with empty stream
    await db.preload()
    expect(db.messages.state.size).toBe(0)

    // Insert a message
    await stream.append({
      type: `message`,
      key: `msg1`,
      value: { text: `Hello!`, userId: `user1` },
      headers: { operation: `insert` },
    })

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(db.messages.state.get(`msg1`)?.text).toBe(`Hello!`)
    expect(db.messages.state.size).toBe(1)

    // Update the message
    await stream.append({
      type: `message`,
      key: `msg1`,
      value: { text: `Hello, updated!`, userId: `user1` },
      headers: { operation: `update` },
    })

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(db.messages.state.get(`msg1`)?.text).toBe(`Hello, updated!`)
    expect(db.messages.state.size).toBe(1)

    // Delete the message
    await stream.append({
      type: `message`,
      key: `msg1`,
      headers: { operation: `delete` },
    })

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(db.messages.state.get(`msg1`)).toBeUndefined()
    expect(db.messages.state.size).toBe(0)
  })

  it(`should auto-start streaming when collection is subscribed to`, async () => {
    const streamState = defineStreamState({
      collections: {
        users: {
          schema: userSchema,
          type: `user`,
        },
      },
    })

    const streamPath = `/db/auto-start-${Date.now()}`
    const stream = await DurableStream.create({
      url: `${baseUrl}${streamPath}`,
      contentType: `application/json`,
    })

    // Add data before creating db
    await stream.append({
      type: `user`,
      key: `1`,
      value: { name: `Kyle`, email: `kyle@example.com` },
      headers: { operation: `insert` },
    })

    const db = await createStreamDB({
      stream,
      state: streamState,
    })
    dbs.push(db)

    // Simply waiting for the collection to be ready should trigger stream sync
    // WITHOUT calling preload() - the sync should start automatically
    await db.users.stateWhenReady()

    // Verify data was synced
    expect(db.users.state.get(`1`)?.name).toBe(`Kyle`)
  })
})
