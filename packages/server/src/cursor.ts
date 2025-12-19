/**
 * Stream cursor calculation for CDN cache collapsing.
 *
 * This module implements interval-based cursor generation to prevent
 * infinite CDN cache loops while enabling request collapsing.
 *
 * The mechanism works by:
 * 1. Dividing time into fixed intervals (default 20 seconds)
 * 2. Computing interval number from an epoch (December 19, 2025)
 * 3. Returning cursor values that change at interval boundaries
 * 4. Adding random jitter when cursor collisions occur
 */

/**
 * Default epoch for cursor calculation: December 19, 2025 00:00:00 UTC.
 * This is the reference point from which intervals are counted.
 */
export const DEFAULT_CURSOR_EPOCH: Date = new Date(`2025-12-19T00:00:00.000Z`)

/**
 * Default interval duration in seconds.
 */
export const DEFAULT_CURSOR_INTERVAL_SECONDS = 20

/**
 * Maximum jitter in seconds to add on collision.
 * Per protocol spec: random value between 1-3600 seconds.
 */
const MAX_JITTER_SECONDS = 3600

/**
 * Minimum jitter in seconds.
 */
const MIN_JITTER_SECONDS = 1

/**
 * Configuration options for cursor calculation.
 */
export interface CursorOptions {
  /**
   * Interval duration in seconds.
   * Default: 20 seconds.
   */
  intervalSeconds?: number

  /**
   * Epoch timestamp for interval calculation.
   * Default: December 19, 2025 00:00:00 UTC.
   */
  epoch?: Date
}

/**
 * Calculate the current cursor value based on time intervals.
 *
 * @param options - Configuration for cursor calculation
 * @returns The current cursor value as a string
 */
export function calculateCursor(options: CursorOptions = {}): string {
  const intervalSeconds =
    options.intervalSeconds ?? DEFAULT_CURSOR_INTERVAL_SECONDS
  const epoch = options.epoch ?? DEFAULT_CURSOR_EPOCH

  const now = Date.now()
  const epochMs = epoch.getTime()
  const intervalMs = intervalSeconds * 1000

  // Calculate interval number since epoch
  const intervalNumber = Math.floor((now - epochMs) / intervalMs)

  return String(intervalNumber)
}

/**
 * Handle cursor collision by adding random jitter.
 *
 * When the newly calculated cursor equals the previous cursor provided by the client,
 * we add random jitter (1-3600 seconds) to advance to a future interval.
 * This prevents clients from getting stuck in infinite loops when CDNs cache
 * responses with the same cursor.
 *
 * @param currentCursor - The newly calculated cursor value
 * @param previousCursor - The cursor provided by the client (if any)
 * @param options - Configuration for cursor calculation
 * @returns The cursor value to return, with jitter applied if there's a collision
 */
export function handleCursorCollision(
  currentCursor: string,
  previousCursor: string | undefined,
  options: CursorOptions = {}
): string {
  // No collision if no previous cursor or they differ
  if (!previousCursor || currentCursor !== previousCursor) {
    return currentCursor
  }

  const intervalSeconds =
    options.intervalSeconds ?? DEFAULT_CURSOR_INTERVAL_SECONDS

  // Add random jitter: 1-3600 seconds
  const jitterSeconds =
    MIN_JITTER_SECONDS +
    Math.floor(Math.random() * (MAX_JITTER_SECONDS - MIN_JITTER_SECONDS + 1))

  // Calculate how many intervals the jitter represents
  const jitterIntervals = Math.ceil(jitterSeconds / intervalSeconds)

  // Return the advanced cursor
  const currentInterval = parseInt(currentCursor, 10)
  return String(currentInterval + jitterIntervals)
}

/**
 * Generate a complete cursor for a response.
 *
 * This combines cursor calculation with collision handling.
 *
 * @param clientCursor - The cursor provided by the client (if any)
 * @param options - Configuration for cursor calculation
 * @returns The cursor value to include in the response
 */
export function generateResponseCursor(
  clientCursor: string | undefined,
  options: CursorOptions = {}
): string {
  const currentCursor = calculateCursor(options)
  return handleCursorCollision(currentCursor, clientCursor, options)
}
