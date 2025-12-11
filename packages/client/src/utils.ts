/**
 * Shared utility functions for the Durable Streams client.
 */

import { DurableStreamError } from "./error"
import type { HeadersRecord, MaybePromise } from "./types"

/**
 * Resolve headers from HeadersRecord (supports async functions).
 * Unified implementation used by both stream() and DurableStream.
 */
export async function resolveHeaders(
  headers?: HeadersRecord
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {}

  if (!headers) {
    return resolved
  }

  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === `function`) {
      resolved[key] = await value()
    } else {
      resolved[key] = value
    }
  }

  return resolved
}

/**
 * Handle error responses from the server.
 * Throws appropriate DurableStreamError based on status code.
 */
export async function handleErrorResponse(
  response: Response,
  url: string,
  context?: { operation?: string }
): Promise<never> {
  const status = response.status

  if (status === 404) {
    throw new DurableStreamError(`Stream not found: ${url}`, `NOT_FOUND`, 404)
  }

  if (status === 409) {
    // Context-specific 409 messages
    const message =
      context?.operation === `create`
        ? `Stream already exists: ${url}`
        : `Sequence conflict: seq is lower than last appended`
    const code =
      context?.operation === `create` ? `CONFLICT_EXISTS` : `CONFLICT_SEQ`
    throw new DurableStreamError(message, code, 409)
  }

  if (status === 400) {
    throw new DurableStreamError(
      `Bad request (possibly content-type mismatch)`,
      `BAD_REQUEST`,
      400
    )
  }

  throw await DurableStreamError.fromResponse(response, url)
}

/**
 * Resolve params from ParamsRecord (supports async functions).
 */
export async function resolveParams(
  params?: Record<string, string | (() => MaybePromise<string>) | undefined>
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {}

  if (!params) {
    return resolved
  }

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      if (typeof value === `function`) {
        resolved[key] = await value()
      } else {
        resolved[key] = value
      }
    }
  }

  return resolved
}

/**
 * Resolve a value that may be a function returning a promise.
 */
export async function resolveValue<T>(
  value: T | (() => MaybePromise<T>)
): Promise<T> {
  if (typeof value === `function`) {
    return (value as () => MaybePromise<T>)()
  }
  return value
}
