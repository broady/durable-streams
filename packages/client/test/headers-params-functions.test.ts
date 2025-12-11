/**
 * Tests for function-based headers and params
 * Ported from Electric SQL client patterns
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { stream } from "../src/stream-api"
import { DurableStream } from "../src/stream"

describe("function-based headers and params", () => {
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "Stream-Next-Offset": "1",
        },
      })
    )
  })

  describe("headers", () => {
    it("should call sync function headers", async () => {
      const headerFn = vi.fn().mockReturnValue("Bearer token-123")

      await stream({
        url: "https://example.com/stream",
        fetchClient: mockFetch,
        headers: {
          Authorization: headerFn,
        },
      })

      expect(headerFn).toHaveBeenCalledOnce()
      expect(mockFetch.mock.calls[0][1].headers).toMatchObject({
        Authorization: "Bearer token-123",
      })
    })

    it("should call async function headers", async () => {
      const headerFn = vi.fn().mockResolvedValue("Bearer async-token")

      await stream({
        url: "https://example.com/stream",
        fetchClient: mockFetch,
        headers: {
          Authorization: headerFn,
        },
      })

      expect(headerFn).toHaveBeenCalledOnce()
      expect(mockFetch.mock.calls[0][1].headers).toMatchObject({
        Authorization: "Bearer async-token",
      })
    })

    it("should support multiple function headers", async () => {
      const authFn = vi.fn().mockReturnValue("Bearer token")
      const tenantFn = vi.fn().mockResolvedValue("tenant-123")

      await stream({
        url: "https://example.com/stream",
        fetchClient: mockFetch,
        headers: {
          Authorization: authFn,
          "X-Tenant-Id": tenantFn,
        },
      })

      expect(authFn).toHaveBeenCalledOnce()
      expect(tenantFn).toHaveBeenCalledOnce()
      expect(mockFetch.mock.calls[0][1].headers).toMatchObject({
        Authorization: "Bearer token",
        "X-Tenant-Id": "tenant-123",
      })
    })

    it("should mix static and function headers", async () => {
      const dynamicFn = vi.fn().mockReturnValue("dynamic-value")

      await stream({
        url: "https://example.com/stream",
        fetchClient: mockFetch,
        headers: {
          "X-Static": "static-value",
          "X-Dynamic": dynamicFn,
        },
      })

      expect(dynamicFn).toHaveBeenCalledOnce()
      expect(mockFetch.mock.calls[0][1].headers).toMatchObject({
        "X-Static": "static-value",
        "X-Dynamic": "dynamic-value",
      })
    })
  })

  describe("params", () => {
    it("should call sync function params", async () => {
      const paramFn = vi.fn().mockReturnValue("tenant-abc")

      await stream({
        url: "https://example.com/stream",
        fetchClient: mockFetch,
        params: {
          tenant: paramFn,
        },
      })

      expect(paramFn).toHaveBeenCalledOnce()
      const url = new URL(mockFetch.mock.calls[0][0])
      expect(url.searchParams.get("tenant")).toBe("tenant-abc")
    })

    it("should call async function params", async () => {
      const paramFn = vi.fn().mockResolvedValue("async-tenant")

      await stream({
        url: "https://example.com/stream",
        fetchClient: mockFetch,
        params: {
          tenant: paramFn,
        },
      })

      expect(paramFn).toHaveBeenCalledOnce()
      const url = new URL(mockFetch.mock.calls[0][0])
      expect(url.searchParams.get("tenant")).toBe("async-tenant")
    })

    it("should support multiple function params", async () => {
      const tenantFn = vi.fn().mockReturnValue("tenant-123")
      const regionFn = vi.fn().mockResolvedValue("us-west")

      await stream({
        url: "https://example.com/stream",
        fetchClient: mockFetch,
        params: {
          tenant: tenantFn,
          region: regionFn,
        },
      })

      expect(tenantFn).toHaveBeenCalledOnce()
      expect(regionFn).toHaveBeenCalledOnce()
      const url = new URL(mockFetch.mock.calls[0][0])
      expect(url.searchParams.get("tenant")).toBe("tenant-123")
      expect(url.searchParams.get("region")).toBe("us-west")
    })

    it("should mix static and function params", async () => {
      const dynamicFn = vi.fn().mockReturnValue("dynamic")

      await stream({
        url: "https://example.com/stream",
        fetchClient: mockFetch,
        params: {
          static: "value",
          dynamic: dynamicFn,
        },
      })

      expect(dynamicFn).toHaveBeenCalledOnce()
      const url = new URL(mockFetch.mock.calls[0][0])
      expect(url.searchParams.get("static")).toBe("value")
      expect(url.searchParams.get("dynamic")).toBe("dynamic")
    })
  })

  describe("DurableStream handle merging", () => {
    it("should merge handle-level and call-level headers", async () => {
      const handle = new DurableStream({
        url: "https://example.com/stream",
        fetch: mockFetch,
        headers: {
          "X-Handle-Header": "from-handle",
        },
      })

      await handle.stream({
        headers: {
          "X-Call-Header": "from-call",
        },
      })

      expect(mockFetch).toHaveBeenCalled()
      const headers = mockFetch.mock.calls[0][1].headers
      expect(headers).toMatchObject({
        "X-Handle-Header": "from-handle",
        "X-Call-Header": "from-call",
      })
    })

    it("should override handle headers with call headers", async () => {
      const handle = new DurableStream({
        url: "https://example.com/stream",
        fetch: mockFetch,
        headers: {
          Authorization: "Bearer handle-token",
        },
      })

      await handle.stream({
        headers: {
          Authorization: "Bearer call-token",
        },
      })

      expect(mockFetch).toHaveBeenCalled()
      const headers = mockFetch.mock.calls[0][1].headers
      expect(headers.Authorization).toBe("Bearer call-token")
    })

    it("should merge handle-level and call-level params", async () => {
      const handle = new DurableStream({
        url: "https://example.com/stream",
        fetch: mockFetch,
        params: {
          tenant: "handle-tenant",
        },
      })

      await handle.stream({
        params: {
          region: "call-region",
        },
      })

      expect(mockFetch).toHaveBeenCalled()
      const url = new URL(mockFetch.mock.calls[0][0])
      expect(url.searchParams.get("tenant")).toBe("handle-tenant")
      expect(url.searchParams.get("region")).toBe("call-region")
    })

    it("should override handle params with call params", async () => {
      const handle = new DurableStream({
        url: "https://example.com/stream",
        fetch: mockFetch,
        params: {
          tenant: "handle-tenant",
        },
      })

      await handle.stream({
        params: {
          tenant: "call-tenant",
        },
      })

      expect(mockFetch).toHaveBeenCalled()
      const url = new URL(mockFetch.mock.calls[0][0])
      expect(url.searchParams.get("tenant")).toBe("call-tenant")
    })

    it("should resolve handle-level function headers", async () => {
      const headerFn = vi.fn().mockReturnValue("Bearer dynamic-token")

      const handle = new DurableStream({
        url: "https://example.com/stream",
        fetch: mockFetch,
        headers: {
          Authorization: headerFn,
        },
      })

      await handle.stream()

      expect(headerFn).toHaveBeenCalled()
      expect(mockFetch.mock.calls[0][1].headers).toMatchObject({
        Authorization: "Bearer dynamic-token",
      })
    })

    it("should resolve handle-level function params", async () => {
      const paramFn = vi.fn().mockReturnValue("dynamic-tenant")

      const handle = new DurableStream({
        url: "https://example.com/stream",
        fetch: mockFetch,
        params: {
          tenant: paramFn,
        },
      })

      await handle.stream()

      expect(paramFn).toHaveBeenCalled()
      const url = new URL(mockFetch.mock.calls[0][0])
      expect(url.searchParams.get("tenant")).toBe("dynamic-tenant")
    })
  })

  describe("combined headers and params", () => {
    it("should support both function headers and params", async () => {
      const headerFn = vi.fn().mockReturnValue("Bearer token")
      const paramFn = vi.fn().mockReturnValue("tenant-123")

      await stream({
        url: "https://example.com/stream",
        fetchClient: mockFetch,
        headers: {
          Authorization: headerFn,
        },
        params: {
          tenant: paramFn,
        },
      })

      expect(headerFn).toHaveBeenCalledOnce()
      expect(paramFn).toHaveBeenCalledOnce()

      expect(mockFetch.mock.calls[0][1].headers).toMatchObject({
        Authorization: "Bearer token",
      })

      const url = new URL(mockFetch.mock.calls[0][0])
      expect(url.searchParams.get("tenant")).toBe("tenant-123")
    })
  })
})
