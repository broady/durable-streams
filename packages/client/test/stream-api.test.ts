import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  FetchError,
  STREAM_OFFSET_HEADER,
  STREAM_UP_TO_DATE_HEADER,
  stream,
} from "../src/index"
import type { Mock } from "vitest"

describe(`stream() function`, () => {
  let mockFetch: Mock<typeof fetch>

  beforeEach(() => {
    mockFetch = vi.fn()
  })

  describe(`basic functionality`, () => {
    it(`should make the first request and return a StreamResponse`, async () => {
      const responseData = JSON.stringify([{ message: `hello` }])
      mockFetch.mockResolvedValue(
        new Response(responseData, {
          status: 200,
          headers: {
            "content-type": `application/json`,
            [STREAM_OFFSET_HEADER]: `1_20`,
            [STREAM_UP_TO_DATE_HEADER]: `true`,
          },
        })
      )

      const res = await stream({
        url: `https://example.com/stream`,
        fetchClient: mockFetch,
      })

      expect(mockFetch).toHaveBeenCalledTimes(1)
      expect(res.url).toBe(`https://example.com/stream`)
      expect(res.contentType).toBe(`application/json`)
      expect(res.live).toBe(`auto`)
      expect(res.startOffset).toBe(`-1`)
    })

    it(`should throw on 404`, async () => {
      mockFetch.mockResolvedValue(
        new Response(null, {
          status: 404,
          statusText: `Not Found`,
        })
      )

      // Note: The backoff wrapper throws FetchError for 4xx errors
      // before we can convert to DurableStreamError
      await expect(
        stream({
          url: `https://example.com/stream`,
          fetchClient: mockFetch,
        })
      ).rejects.toThrow(FetchError)
    })

    it(`should respect offset option`, async () => {
      mockFetch.mockResolvedValue(
        new Response(`data`, {
          status: 200,
          headers: {
            [STREAM_OFFSET_HEADER]: `2_10`,
            [STREAM_UP_TO_DATE_HEADER]: `true`,
          },
        })
      )

      await stream({
        url: `https://example.com/stream`,
        fetchClient: mockFetch,
        offset: `1_5`,
      })

      expect(mockFetch).toHaveBeenCalledWith(
        `https://example.com/stream?offset=1_5`,
        expect.anything()
      )
    })

    it(`should set live query param for explicit modes`, async () => {
      mockFetch.mockResolvedValue(
        new Response(`data`, {
          status: 200,
          headers: {
            [STREAM_OFFSET_HEADER]: `1_5`,
            [STREAM_UP_TO_DATE_HEADER]: `true`,
          },
        })
      )

      await stream({
        url: `https://example.com/stream`,
        fetchClient: mockFetch,
        live: `long-poll`,
      })

      expect(mockFetch).toHaveBeenCalledWith(
        `https://example.com/stream?offset=-1&live=long-poll`,
        expect.anything()
      )
    })
  })

  describe(`StreamResponse consumption`, () => {
    it(`should accumulate text with text()`, async () => {
      const responseData = `hello world`
      mockFetch.mockResolvedValue(
        new Response(responseData, {
          status: 200,
          headers: {
            "content-type": `text/plain`,
            [STREAM_OFFSET_HEADER]: `1_11`,
            [STREAM_UP_TO_DATE_HEADER]: `true`,
          },
        })
      )

      const res = await stream({
        url: `https://example.com/stream`,
        fetchClient: mockFetch,
      })

      const text = await res.text()
      expect(text).toBe(`hello world`)
    })

    it(`should accumulate JSON with json()`, async () => {
      const items = [{ id: 1 }, { id: 2 }]
      const responseData = JSON.stringify(items)
      mockFetch.mockResolvedValue(
        new Response(responseData, {
          status: 200,
          headers: {
            "content-type": `application/json`,
            [STREAM_OFFSET_HEADER]: `1_30`,
            [STREAM_UP_TO_DATE_HEADER]: `true`,
          },
        })
      )

      const res = await stream<{ id: number }>({
        url: `https://example.com/stream`,
        fetchClient: mockFetch,
      })

      const result = await res.json()
      expect(result).toEqual(items)
    })

    it(`should throw when json() is called on non-JSON content`, async () => {
      mockFetch.mockResolvedValue(
        new Response(`plain text`, {
          status: 200,
          headers: {
            "content-type": `text/plain`,
            [STREAM_OFFSET_HEADER]: `1_10`,
            [STREAM_UP_TO_DATE_HEADER]: `true`,
          },
        })
      )

      const res = await stream({
        url: `https://example.com/stream`,
        fetchClient: mockFetch,
      })

      await expect(res.json()).rejects.toThrow()
    })
  })

  describe(`body() method`, () => {
    it(`should accumulate bytes until upToDate`, async () => {
      const responseData = new Uint8Array([1, 2, 3, 4, 5])
      mockFetch.mockResolvedValue(
        new Response(responseData, {
          status: 200,
          headers: {
            [STREAM_OFFSET_HEADER]: `1_5`,
            [STREAM_UP_TO_DATE_HEADER]: `true`,
          },
        })
      )

      const res = await stream({
        url: `https://example.com/stream`,
        fetchClient: mockFetch,
        live: false,
      })

      const body = await res.body()
      expect(body).toBeInstanceOf(Uint8Array)
      expect(Array.from(body)).toEqual([1, 2, 3, 4, 5])
    })
  })

  describe(`bodyStream() method`, () => {
    it(`should return a ReadableStream of bytes`, async () => {
      const responseData = `stream data`
      mockFetch.mockResolvedValue(
        new Response(responseData, {
          status: 200,
          headers: {
            [STREAM_OFFSET_HEADER]: `1_11`,
            [STREAM_UP_TO_DATE_HEADER]: `true`,
          },
        })
      )

      const res = await stream({
        url: `https://example.com/stream`,
        fetchClient: mockFetch,
        live: false,
      })

      const readable = res.bodyStream()
      expect(readable).toBeInstanceOf(ReadableStream)

      const reader = readable.getReader()
      const { value, done } = await reader.read()

      expect(done).toBe(false)
      expect(value).toBeInstanceOf(Uint8Array)
      expect(new TextDecoder().decode(value)).toBe(`stream data`)
    })
  })

  describe(`jsonStream() method`, () => {
    it(`should return a ReadableStream of JSON items`, async () => {
      const items = [{ id: 1 }, { id: 2 }]
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(items), {
          status: 200,
          headers: {
            "content-type": `application/json`,
            [STREAM_OFFSET_HEADER]: `1_30`,
            [STREAM_UP_TO_DATE_HEADER]: `true`,
          },
        })
      )

      const res = await stream<{ id: number }>({
        url: `https://example.com/stream`,
        fetchClient: mockFetch,
        live: false,
      })

      const readable = res.jsonStream()
      expect(readable).toBeInstanceOf(ReadableStream)

      const reader = readable.getReader()
      const collected = []

      let result = await reader.read()
      while (!result.done) {
        collected.push(result.value)
        result = await reader.read()
      }

      expect(collected).toEqual(items)
    })

    it(`should throw on non-JSON content`, async () => {
      mockFetch.mockResolvedValue(
        new Response(`plain text`, {
          status: 200,
          headers: {
            "content-type": `text/plain`,
            [STREAM_OFFSET_HEADER]: `1_10`,
            [STREAM_UP_TO_DATE_HEADER]: `true`,
          },
        })
      )

      const res = await stream({
        url: `https://example.com/stream`,
        fetchClient: mockFetch,
      })

      expect(() => res.jsonStream()).toThrow()
    })
  })

  describe(`textStream() method`, () => {
    it(`should return a ReadableStream of text`, async () => {
      const responseData = `hello world`
      mockFetch.mockResolvedValue(
        new Response(responseData, {
          status: 200,
          headers: {
            "content-type": `text/plain`,
            [STREAM_OFFSET_HEADER]: `1_11`,
            [STREAM_UP_TO_DATE_HEADER]: `true`,
          },
        })
      )

      const res = await stream({
        url: `https://example.com/stream`,
        fetchClient: mockFetch,
        live: false,
      })

      const readable = res.textStream()
      expect(readable).toBeInstanceOf(ReadableStream)

      const reader = readable.getReader()
      const { value, done } = await reader.read()

      expect(done).toBe(false)
      expect(value).toBe(`hello world`)
    })
  })

  describe(`subscribeBytes() method`, () => {
    it(`should call subscriber for each byte chunk`, async () => {
      const responseData = `chunk data`
      mockFetch.mockResolvedValue(
        new Response(responseData, {
          status: 200,
          headers: {
            [STREAM_OFFSET_HEADER]: `1_10`,
            [STREAM_UP_TO_DATE_HEADER]: `true`,
          },
        })
      )

      const res = await stream({
        url: `https://example.com/stream`,
        fetchClient: mockFetch,
        live: false,
      })

      const received: Array<{ data: Uint8Array; offset: string }> = []
      const unsubscribe = res.subscribeBytes(async (chunk) => {
        received.push({ data: chunk.data, offset: chunk.offset })
      })

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 50))
      unsubscribe()

      expect(received.length).toBe(1)
      expect(received[0]!.offset).toBe(`1_10`)
    })

    it(`should return unsubscribe function that stops processing`, async () => {
      mockFetch.mockResolvedValue(
        new Response(`data`, {
          status: 200,
          headers: {
            [STREAM_OFFSET_HEADER]: `1_4`,
            [STREAM_UP_TO_DATE_HEADER]: `true`,
          },
        })
      )

      const res = await stream({
        url: `https://example.com/stream`,
        fetchClient: mockFetch,
        live: false,
      })

      const unsubscribe = res.subscribeBytes(async () => {
        // Immediately unsubscribe
        unsubscribe()
      })

      // Should not throw
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
  })

  describe(`subscribeJson() method`, () => {
    it(`should call subscriber for each JSON batch`, async () => {
      const items = [{ id: 1 }, { id: 2 }]
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(items), {
          status: 200,
          headers: {
            "content-type": `application/json`,
            [STREAM_OFFSET_HEADER]: `1_30`,
            [STREAM_UP_TO_DATE_HEADER]: `true`,
          },
        })
      )

      const res = await stream<{ id: number }>({
        url: `https://example.com/stream`,
        fetchClient: mockFetch,
        live: false,
      })

      const received: Array<Array<{ id: number }>> = []
      const unsubscribe = res.subscribeJson(async (batch) => {
        received.push([...batch.items])
      })

      await new Promise((resolve) => setTimeout(resolve, 50))
      unsubscribe()

      expect(received.length).toBe(1)
      expect(received[0]).toEqual(items)
    })

    it(`should throw on non-JSON content`, async () => {
      mockFetch.mockResolvedValue(
        new Response(`plain text`, {
          status: 200,
          headers: {
            "content-type": `text/plain`,
            [STREAM_OFFSET_HEADER]: `1_10`,
            [STREAM_UP_TO_DATE_HEADER]: `true`,
          },
        })
      )

      const res = await stream({
        url: `https://example.com/stream`,
        fetchClient: mockFetch,
      })

      expect(() => res.subscribeJson(async () => {})).toThrow()
    })
  })

  describe(`subscribeText() method`, () => {
    it(`should call subscriber for each text chunk`, async () => {
      const responseData = `hello world`
      mockFetch.mockResolvedValue(
        new Response(responseData, {
          status: 200,
          headers: {
            "content-type": `text/plain`,
            [STREAM_OFFSET_HEADER]: `1_11`,
            [STREAM_UP_TO_DATE_HEADER]: `true`,
          },
        })
      )

      const res = await stream({
        url: `https://example.com/stream`,
        fetchClient: mockFetch,
        live: false,
      })

      const received: Array<string> = []
      const unsubscribe = res.subscribeText(async (chunk) => {
        received.push(chunk.text)
      })

      await new Promise((resolve) => setTimeout(resolve, 50))
      unsubscribe()

      expect(received.length).toBe(1)
      expect(received[0]).toBe(`hello world`)
    })
  })

  describe(`cancel() method`, () => {
    it(`should abort the session`, async () => {
      mockFetch.mockResolvedValue(
        new Response(`data`, {
          status: 200,
          headers: {
            [STREAM_OFFSET_HEADER]: `1_4`,
            [STREAM_UP_TO_DATE_HEADER]: `true`,
          },
        })
      )

      const res = await stream({
        url: `https://example.com/stream`,
        fetchClient: mockFetch,
      })

      // Should not throw
      res.cancel()

      // Subsequent consumption should complete (cancelled)
      const reader = res.bodyStream().getReader()
      const chunks: Array<Uint8Array> = []
      let result = await reader.read()
      while (!result.done) {
        chunks.push(result.value)
        result = await reader.read()
      }
      // After cancel, reading should complete (possibly with existing data)
      expect(chunks.length).toBeLessThanOrEqual(1)
    })
  })

  describe(`closed property`, () => {
    it(`should resolve when session completes normally`, async () => {
      mockFetch.mockResolvedValue(
        new Response(`data`, {
          status: 200,
          headers: {
            [STREAM_OFFSET_HEADER]: `1_4`,
            [STREAM_UP_TO_DATE_HEADER]: `true`,
          },
        })
      )

      const res = await stream({
        url: `https://example.com/stream`,
        fetchClient: mockFetch,
        live: false,
      })

      // Consume the stream to completion
      await res.text()

      // closed should resolve
      await expect(res.closed).resolves.toBeUndefined()
    })

    it(`should resolve when cancelled`, async () => {
      mockFetch.mockResolvedValue(
        new Response(`data`, {
          status: 200,
          headers: {
            [STREAM_OFFSET_HEADER]: `1_4`,
            [STREAM_UP_TO_DATE_HEADER]: `true`,
          },
        })
      )

      const res = await stream({
        url: `https://example.com/stream`,
        fetchClient: mockFetch,
      })

      res.cancel()

      await expect(res.closed).resolves.toBeUndefined()
    })
  })

  describe(`json hint option`, () => {
    it(`should enable JSON mode even without application/json content-type`, async () => {
      const items = [{ id: 1 }]
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(items), {
          status: 200,
          headers: {
            "content-type": `text/plain`, // Not JSON content-type
            [STREAM_OFFSET_HEADER]: `1_10`,
            [STREAM_UP_TO_DATE_HEADER]: `true`,
          },
        })
      )

      const res = await stream<{ id: number }>({
        url: `https://example.com/stream`,
        fetchClient: mockFetch,
        json: true, // Force JSON mode
        live: false,
      })

      // json() should work despite text/plain content-type
      const result = await res.json()
      expect(result).toEqual(items)
    })
  })

  describe(`first request semantics`, () => {
    it(`should reject on 401 auth failure`, async () => {
      mockFetch.mockResolvedValue(
        new Response(null, {
          status: 401,
          statusText: `Unauthorized`,
        })
      )

      await expect(
        stream({
          url: `https://example.com/stream`,
          fetchClient: mockFetch,
        })
      ).rejects.toThrow(FetchError)
    })

    it(`should reject on 403 forbidden error`, async () => {
      mockFetch.mockResolvedValue(
        new Response(null, {
          status: 403,
          statusText: `Forbidden`,
        })
      )

      await expect(
        stream({
          url: `https://example.com/stream`,
          fetchClient: mockFetch,
        })
      ).rejects.toThrow(FetchError)
    })

    it(`should not consume body until consumption method is called`, async () => {
      const responseData = `hello world`
      mockFetch.mockResolvedValue(
        new Response(responseData, {
          status: 200,
          headers: {
            [STREAM_OFFSET_HEADER]: `1_11`,
            [STREAM_UP_TO_DATE_HEADER]: `true`,
          },
        })
      )

      // Call stream() - should resolve without consuming body
      const res = await stream({
        url: `https://example.com/stream`,
        fetchClient: mockFetch,
      })

      // At this point, only the fetch should have been called
      expect(mockFetch).toHaveBeenCalledTimes(1)
      expect(res.url).toBe(`https://example.com/stream`)

      // Now consume the body
      const text = await res.text()

      // Verify we got the data
      expect(text).toBe(`hello world`)
    })

    it(`should resolve with correct state from first response headers`, async () => {
      mockFetch.mockResolvedValue(
        new Response(`data`, {
          status: 200,
          headers: {
            "content-type": `text/plain`,
            [STREAM_OFFSET_HEADER]: `5_100`,
            [STREAM_UP_TO_DATE_HEADER]: `true`,
          },
        })
      )

      const res = await stream({
        url: `https://example.com/stream`,
        fetchClient: mockFetch,
        offset: `5_50`,
      })

      // Verify state is extracted from first response headers
      expect(res.offset).toBe(`5_100`)
      expect(res.upToDate).toBe(true)
      expect(res.startOffset).toBe(`5_50`)
      expect(res.contentType).toBe(`text/plain`)
    })

    it(`should only make one request when stream() resolves`, async () => {
      mockFetch.mockResolvedValue(
        new Response(`data`, {
          status: 200,
          headers: {
            [STREAM_OFFSET_HEADER]: `1_4`,
            [STREAM_UP_TO_DATE_HEADER]: `true`,
          },
        })
      )

      await stream({
        url: `https://example.com/stream`,
        fetchClient: mockFetch,
      })

      // Only one request should have been made
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })
  })

  describe(`auth`, () => {
    it(`should include token auth header`, async () => {
      mockFetch.mockResolvedValue(
        new Response(`ok`, {
          status: 200,
          headers: {
            [STREAM_OFFSET_HEADER]: `1_2`,
            [STREAM_UP_TO_DATE_HEADER]: `true`,
          },
        })
      )

      await stream({
        url: `https://example.com/stream`,
        fetchClient: mockFetch,
        headers: { Authorization: `Bearer my-token` },
      })

      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Bearer my-token`,
          }),
        })
      )
    })

    it(`should include custom headers`, async () => {
      mockFetch.mockResolvedValue(
        new Response(`ok`, {
          status: 200,
          headers: {
            [STREAM_OFFSET_HEADER]: `1_2`,
            [STREAM_UP_TO_DATE_HEADER]: `true`,
          },
        })
      )

      await stream({
        url: `https://example.com/stream`,
        fetchClient: mockFetch,
        headers: { "x-custom": `value` },
      })

      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          headers: expect.objectContaining({
            "x-custom": `value`,
          }),
        })
      )
    })
  })
})

describe(`DurableStream.stream() method`, () => {
  let mockFetch: Mock<typeof fetch>

  beforeEach(() => {
    mockFetch = vi.fn()
  })

  it(`should start a stream session using handle URL and auth`, async () => {
    // First call for connect HEAD
    mockFetch.mockResolvedValueOnce(
      new Response(null, {
        status: 200,
        headers: { "content-type": `application/json` },
      })
    )

    // Second call for stream GET
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify([{ id: 1 }]), {
        status: 200,
        headers: {
          "content-type": `application/json`,
          [STREAM_OFFSET_HEADER]: `1_10`,
          [STREAM_UP_TO_DATE_HEADER]: `true`,
        },
      })
    )

    const { DurableStream } = await import(`../src/index`)
    const handle = await DurableStream.connect({
      url: `https://example.com/stream`,
      fetch: mockFetch,
      headers: { Authorization: `Bearer handle-token` },
    })

    const res = await handle.stream<{ id: number }>()

    expect(res.url).toBe(`https://example.com/stream`)
    expect(res.contentType).toBe(`application/json`)
  })
})
