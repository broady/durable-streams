/**
 * StreamResponse - A streaming session for reading from a durable stream.
 *
 * Represents a live session with fixed `url`, `offset`, and `live` parameters.
 * Supports multiple consumption styles: Promise helpers, ReadableStreams, and Subscribers.
 */

import { DurableStreamError } from "./error"
import {
  STREAM_CURSOR_HEADER,
  STREAM_OFFSET_HEADER,
  STREAM_UP_TO_DATE_HEADER,
} from "./constants"
import type {
  ByteChunk,
  StreamResponse as IStreamResponse,
  JsonBatch,
  LiveMode,
  Offset,
  TextChunk,
} from "./types"

/**
 * Internal configuration for creating a StreamResponse.
 */
export interface StreamResponseConfig {
  /** The stream URL */
  url: string
  /** Content type from the first response */
  contentType?: string
  /** Live mode for this session */
  live: LiveMode
  /** Starting offset */
  startOffset: Offset
  /** Whether to treat as JSON (hint or content-type) */
  isJsonMode: boolean
  /** Initial offset from first response headers */
  initialOffset: Offset
  /** Initial cursor from first response headers */
  initialCursor?: string
  /** Initial upToDate from first response headers */
  initialUpToDate: boolean
  /** The held first Response object */
  firstResponse: Response
  /** Abort controller for the session */
  abortController: AbortController
  /** Function to fetch the next chunk (for long-poll) */
  fetchNext: (
    offset: Offset,
    cursor: string | undefined,
    signal: AbortSignal
  ) => Promise<Response>
  /** Function to start SSE and return an async iterator */
  startSSE?: (
    offset: Offset,
    cursor: string | undefined,
    signal: AbortSignal
  ) => AsyncIterator<ByteChunk>
}

/**
 * Implementation of the StreamResponse interface.
 */
export class StreamResponseImpl<
  TJson = unknown,
> implements IStreamResponse<TJson> {
  // --- Static session info ---
  readonly url: string
  readonly contentType?: string
  readonly live: LiveMode
  readonly startOffset: Offset

  // --- Evolving state ---
  offset: Offset
  cursor?: string
  upToDate: boolean

  // --- Internal state ---
  #isJsonMode: boolean
  #abortController: AbortController
  #fetchNext: StreamResponseConfig[`fetchNext`]
  #startSSE?: StreamResponseConfig[`startSSE`]
  #closedResolve!: () => void
  #closedReject!: (err: Error) => void
  #closed: Promise<void>
  #stopAfterUpToDate = false

  // Core primitive: a ReadableStream of Response objects
  #responseStream: ReadableStream<Response>

  constructor(config: StreamResponseConfig) {
    this.url = config.url
    this.contentType = config.contentType
    this.live = config.live
    this.startOffset = config.startOffset
    this.offset = config.initialOffset
    this.cursor = config.initialCursor
    this.upToDate = config.initialUpToDate

    this.#isJsonMode = config.isJsonMode
    this.#abortController = config.abortController
    this.#fetchNext = config.fetchNext
    this.#startSSE = config.startSSE

    this.#closed = new Promise((resolve, reject) => {
      this.#closedResolve = resolve
      this.#closedReject = reject
    })

    // Create the core response stream
    this.#responseStream = this.#createResponseStream(config.firstResponse)
  }

  // =================================
  // Internal helpers
  // =================================

  #ensureJsonMode(): void {
    if (!this.#isJsonMode) {
      throw new DurableStreamError(
        `JSON methods are only valid for JSON-mode streams. ` +
          `Content-Type is "${this.contentType}" and json hint was not set.`,
        `BAD_REQUEST`
      )
    }
  }

  #markClosed(): void {
    this.#closedResolve()
  }

  #markError(err: Error): void {
    this.#closedReject(err)
  }

  /**
   * Determine if we should continue with live updates based on live mode
   * and whether a promise helper signaled to stop.
   */
  #shouldContinueLive(): boolean {
    if (this.#stopAfterUpToDate) return false
    if (this.live === false) return false
    return true
  }

  /**
   * Update state from response headers.
   */
  #updateStateFromResponse(response: Response): void {
    const offset = response.headers.get(STREAM_OFFSET_HEADER)
    if (offset) this.offset = offset
    const cursor = response.headers.get(STREAM_CURSOR_HEADER)
    if (cursor) this.cursor = cursor
    this.upToDate = response.headers.has(STREAM_UP_TO_DATE_HEADER)
  }

  /**
   * Create the core ReadableStream<Response> that yields responses.
   * This is consumed once - all consumption methods use this same stream.
   */
  #createResponseStream(firstResponse: Response): ReadableStream<Response> {
    let firstResponseYielded = false

    return new ReadableStream<Response>({
      pull: async (controller) => {
        try {
          // First, yield the held first response
          if (!firstResponseYielded) {
            firstResponseYielded = true
            controller.enqueue(firstResponse)

            // If upToDate and not continuing live, we're done
            if (this.upToDate && !this.#shouldContinueLive()) {
              this.#markClosed()
              controller.close()
              return
            }
            return
          }

          // Continue with live updates if needed
          if (this.#shouldContinueLive()) {
            // Check if we should use SSE
            if (this.live === `sse` && this.#startSSE) {
              throw new DurableStreamError(
                `SSE mode is not yet implemented`,
                `SSE_NOT_SUPPORTED`
              )
            }

            // Use long-poll
            if (this.#abortController.signal.aborted) {
              this.#markClosed()
              controller.close()
              return
            }

            const response = await this.#fetchNext(
              this.offset,
              this.cursor,
              this.#abortController.signal
            )

            this.#updateStateFromResponse(response)
            controller.enqueue(response)

            if (this.upToDate && !this.#shouldContinueLive()) {
              this.#markClosed()
              controller.close()
            }
            return
          }

          // No more data
          this.#markClosed()
          controller.close()
        } catch (err) {
          if (this.#abortController.signal.aborted) {
            this.#markClosed()
            controller.close()
          } else {
            this.#markError(err instanceof Error ? err : new Error(String(err)))
            controller.error(err)
          }
        }
      },

      cancel: () => {
        this.#abortController.abort()
        this.#markClosed()
      },
    })
  }

  /**
   * Get the response stream reader. Can only be called once.
   */
  #getResponseReader(): ReadableStreamDefaultReader<Response> {
    return this.#responseStream.getReader()
  }

  // =================================
  // 1) Accumulating helpers (Promise)
  // =================================

  async body(): Promise<Uint8Array> {
    this.#stopAfterUpToDate = true
    const reader = this.#getResponseReader()
    const blobs: Array<Blob> = []

    try {
      let result = await reader.read()
      while (!result.done) {
        const blob = await result.value.blob()
        if (blob.size > 0) {
          blobs.push(blob)
        }
        if (this.upToDate) break
        result = await reader.read()
      }
    } finally {
      reader.releaseLock()
    }

    this.#markClosed()

    if (blobs.length === 0) {
      return new Uint8Array(0)
    }
    if (blobs.length === 1) {
      return new Uint8Array(await blobs[0]!.arrayBuffer())
    }

    const combined = new Blob(blobs)
    return new Uint8Array(await combined.arrayBuffer())
  }

  async json(): Promise<Array<TJson>> {
    this.#ensureJsonMode()
    this.#stopAfterUpToDate = true
    const reader = this.#getResponseReader()
    const items: Array<TJson> = []

    try {
      let result = await reader.read()
      while (!result.done) {
        const parsed = (await result.value.json()) as TJson | Array<TJson>
        if (Array.isArray(parsed)) {
          items.push(...parsed)
        } else {
          items.push(parsed)
        }
        if (this.upToDate) break
        result = await reader.read()
      }
    } finally {
      reader.releaseLock()
    }

    this.#markClosed()
    return items
  }

  async text(): Promise<string> {
    this.#stopAfterUpToDate = true
    const reader = this.#getResponseReader()
    const parts: Array<string> = []

    try {
      let result = await reader.read()
      while (!result.done) {
        const text = await result.value.text()
        if (text) {
          parts.push(text)
        }
        if (this.upToDate) break
        result = await reader.read()
      }
    } finally {
      reader.releaseLock()
    }

    this.#markClosed()
    return parts.join(``)
  }

  // =====================
  // 2) ReadableStreams
  // =====================

  bodyStream(): ReadableStream<Uint8Array> {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const reader = this.#getResponseReader()

    const pipeBodyStream = async (): Promise<void> => {
      try {
        let result = await reader.read()
        while (!result.done) {
          const body = result.value.body
          if (body) {
            await body.pipeTo(writable, {
              preventClose: true,
              preventAbort: true,
              preventCancel: true,
            })
          }

          if (this.upToDate && !this.#shouldContinueLive()) {
            break
          }
          result = await reader.read()
        }
        await writable.close()
        this.#markClosed()
      } catch (err) {
        if (this.#abortController.signal.aborted) {
          try {
            await writable.close()
          } catch {
            // Ignore close errors on abort
          }
          this.#markClosed()
        } else {
          try {
            await writable.abort(err)
          } catch {
            // Ignore abort errors
          }
          this.#markError(err instanceof Error ? err : new Error(String(err)))
        }
      } finally {
        reader.releaseLock()
      }
    }

    pipeBodyStream()

    return readable
  }

  jsonStream(): ReadableStream<TJson> {
    this.#ensureJsonMode()
    const reader = this.#getResponseReader()
    let pendingItems: Array<TJson> = []

    return new ReadableStream<TJson>({
      pull: async (controller) => {
        try {
          // If we have pending items, yield the next one
          const nextItem = pendingItems.shift()
          if (nextItem !== undefined) {
            controller.enqueue(nextItem)
            return
          }

          // Get next response and parse JSON
          const { done, value: response } = await reader.read()
          if (done) {
            this.#markClosed()
            controller.close()
            return
          }

          const parsed = (await response.json()) as TJson | Array<TJson>
          if (Array.isArray(parsed)) {
            pendingItems = parsed
          } else {
            pendingItems = [parsed]
          }

          // Yield first item
          const firstItem = pendingItems.shift()
          if (firstItem !== undefined) {
            controller.enqueue(firstItem)
          }

          // Check if we should stop
          if (this.upToDate && !this.#shouldContinueLive()) {
            if (pendingItems.length === 0) {
              this.#markClosed()
              controller.close()
            }
          }
        } catch (err) {
          if (this.#abortController.signal.aborted) {
            this.#markClosed()
            controller.close()
          } else {
            this.#markError(err instanceof Error ? err : new Error(String(err)))
            controller.error(err)
          }
        }
      },

      cancel: () => {
        reader.releaseLock()
        this.#abortController.abort()
        this.#markClosed()
      },
    })
  }

  textStream(): ReadableStream<string> {
    const decoder = new TextDecoder()

    return this.bodyStream().pipeThrough(
      new TransformStream<Uint8Array, string>({
        transform(chunk, controller) {
          controller.enqueue(decoder.decode(chunk, { stream: true }))
        },
        flush(controller) {
          const remaining = decoder.decode()
          if (remaining) {
            controller.enqueue(remaining)
          }
        },
      })
    )
  }

  // =====================
  // 3) Subscriber APIs
  // =====================

  subscribeJson(
    subscriber: (batch: JsonBatch<TJson>) => Promise<void>
  ): () => void {
    this.#ensureJsonMode()
    const abortController = new AbortController()
    const reader = this.#getResponseReader()

    const consumeJsonSubscription = async (): Promise<void> => {
      try {
        let result = await reader.read()
        while (!result.done) {
          if (abortController.signal.aborted) break

          const parsed = (await result.value.json()) as TJson | Array<TJson>
          const items = Array.isArray(parsed) ? parsed : [parsed]

          await subscriber({
            items,
            offset: this.offset,
            cursor: this.cursor,
            upToDate: this.upToDate,
          })

          result = await reader.read()
        }
      } catch (e) {
        if (!abortController.signal.aborted) throw e
      } finally {
        reader.releaseLock()
      }
    }

    consumeJsonSubscription()

    return () => {
      abortController.abort()
      this.cancel()
    }
  }

  subscribeBytes(subscriber: (chunk: ByteChunk) => Promise<void>): () => void {
    const abortController = new AbortController()
    const reader = this.#getResponseReader()

    const consumeBytesSubscription = async (): Promise<void> => {
      try {
        let result = await reader.read()
        while (!result.done) {
          if (abortController.signal.aborted) break

          const buffer = await result.value.arrayBuffer()

          await subscriber({
            data: new Uint8Array(buffer),
            offset: this.offset,
            cursor: this.cursor,
            upToDate: this.upToDate,
          })

          result = await reader.read()
        }
      } catch (e) {
        if (!abortController.signal.aborted) throw e
      } finally {
        reader.releaseLock()
      }
    }

    consumeBytesSubscription()

    return () => {
      abortController.abort()
      this.cancel()
    }
  }

  subscribeText(subscriber: (chunk: TextChunk) => Promise<void>): () => void {
    const abortController = new AbortController()
    const reader = this.#getResponseReader()

    const consumeTextSubscription = async (): Promise<void> => {
      try {
        let result = await reader.read()
        while (!result.done) {
          if (abortController.signal.aborted) break

          const text = await result.value.text()

          await subscriber({
            text,
            offset: this.offset,
            cursor: this.cursor,
            upToDate: this.upToDate,
          })

          result = await reader.read()
        }
      } catch (e) {
        if (!abortController.signal.aborted) throw e
      } finally {
        reader.releaseLock()
      }
    }

    consumeTextSubscription()

    return () => {
      abortController.abort()
      this.cancel()
    }
  }

  // =====================
  // 4) Lifecycle
  // =====================

  cancel(reason?: unknown): void {
    this.#abortController.abort(reason)
    this.#markClosed()
  }

  get closed(): Promise<void> {
    return this.#closed
  }
}
