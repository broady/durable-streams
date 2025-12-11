/**
 * Run conformance tests against Caddy Durable Streams implementation
 */

import { describe, beforeAll, afterAll, afterEach, expect, test } from "vitest"
import { runConformanceTests } from "@durable-streams/conformance-tests"
import { spawn, ChildProcess } from "child_process"
import * as path from "path"

// ============================================================================
// Caddy Server Conformance Tests
// ============================================================================

describe(`Caddy Durable Streams Implementation`, () => {
  let caddy: ChildProcess | null = null
  const port = 8787

  // Use object with mutable property so conformance tests can access it
  const config = { baseUrl: `http://localhost:${port}` }

  beforeAll(async () => {
    const caddyBinary = path.join(__dirname, "..", "caddy")
    const caddyfile = path.join(__dirname, "..", "Caddyfile")

    // Start Caddy
    caddy = spawn(caddyBinary, ["run", "--config", caddyfile], {
      stdio: ["ignore", "pipe", "pipe"],
    })

    // Wait for Caddy to be ready
    await waitForServer(config.baseUrl, 10000)
  }, 15000)

  afterAll(async () => {
    if (caddy) {
      caddy.kill("SIGTERM")
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  })

  runConformanceTests(config)
})

async function waitForServer(baseUrl: string, timeoutMs: number): Promise<void> {
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/v1/stream/__health__`, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
      })

      if (response.ok || response.status === 201) {
        // Clean up health check stream
        await fetch(`${baseUrl}/v1/stream/__health__`, { method: "DELETE" })
        return
      }
    } catch {
      // Server not ready yet
    }

    await new Promise(resolve => setTimeout(resolve, 100))
  }

  throw new Error(`Server did not become ready within ${timeoutMs}ms`)
}
