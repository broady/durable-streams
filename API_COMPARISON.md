# API Comparison: Durable Streams vs Electric SQL vs fetch()

## Current State

### ✅ What We Have (Complete)

**From fetch() Response API:**
- `url` - Stream URL ✅
- `json()` - Parse as JSON ✅
- `text()` - Parse as text ✅
- `body` equivalent (`bodyStream()`) ✅
- `arrayBuffer()` equivalent (`body()` returns Uint8Array) ✅

**Beyond fetch() - Streaming Enhancements:**
- `jsonStream()` - ReadableStream of JSON items ✅
- `textStream()` - ReadableStream of text chunks ✅
- `subscribeJson/Bytes/Text()` - Push-based consumption ✅
- `cancel()` - Abort streaming ✅
- `closed` - Promise for lifecycle ✅
- `offset`, `cursor`, `upToDate` - Stream metadata ✅

**From Electric SQL Options:**
- `headers` with function support ✅
- `params` with function support ✅
- `backoffOptions` ✅
- `onError` handler ✅
- `signal` (AbortSignal) ✅
- `fetchClient` (custom fetch) ✅
- `live` modes (auto/long-poll/sse) ✅

---

## ⚠️ Potentially Missing (Should Consider)

### High Priority - From fetch() Response

**1. Response Headers Exposure**
```typescript
// fetch() has:
response.headers.get('etag')
response.headers.get('cache-control')

// We could add to StreamResponse:
readonly headers: Headers  // First response headers
```
**Use case**: ETag caching, custom headers from server, debugging

**2. HTTP Status/StatusText**
```typescript
// fetch() has:
response.status     // 200, 404, etc.
response.statusText // "OK", "Not Found"
response.ok         // true for 200-299

// We could add:
readonly status: number
readonly statusText: string
readonly ok: boolean  // Always true (we throw on !ok)
```
**Use case**: Debugging, logging, conditional logic

### High Priority - From Electric SQL

**3. Connection/Loading State**
```typescript
// Electric has:
isLoading(): boolean     // Initial fetch in progress
isConnected(): boolean   // Active connection
hasStarted(): boolean    // Stream initialized

// We could add to StreamResponse:
readonly isLoading: boolean
readonly isConnected: boolean
```
**Use case**: UI loading indicators, connection status badges

**4. Last Sync Timing**
```typescript
// Electric has:
lastSyncedAt(): number | undefined   // Unix timestamp
lastSynced(): number | undefined     // Milliseconds ago

// We could add:
readonly lastSyncedAt?: Date
readonly lastSyncMs?: number
```
**Use case**: "Last updated 5 seconds ago" UI, stale data detection

**5. Error Property**
```typescript
// Electric has:
error: ShapeStreamError | undefined

// We could add:
readonly error?: Error
```
**Use case**: Display last error to user without catching exceptions

---

### Medium Priority - Advanced Features

**6. Reconnection Control**
```typescript
// Electric has:
forceDisconnectAndRefresh(): void

// We could add:
reconnect(): Promise<void>
```
**Use case**: Force refresh after suspected stale data

**7. Pause/Resume**
```typescript
// Electric has (internal):
pause(): void
resume(): void

// We could add:
pause(): void
resume(): void
```
**Use case**: Visibility API integration, bandwidth conservation

**8. Unsubscribe All**
```typescript
// Electric has:
unsubscribeAll(): void

// We already have via cancel(), but could add explicit:
unsubscribeAll(): void  // Alias for cancel()
```

---

### Lower Priority - Specialized Features

**9. Snapshot/Query APIs**
```typescript
// Electric has:
requestSnapshot(params): Promise<...>
fetchSnapshot(opts): Promise<...>

// Not needed for durable streams (different use case)
```

**10. Shape Handle/Mode**
```typescript
// Electric has:
shapeHandle: string
mode: 'full' | 'changes_only'

// We have cursor/offset but don't expose handle concept
```

---

## Recommendations

### Should Add (High ROI):

1. **Response headers** - `readonly headers: Headers`
   - Simple to add, very useful for ETag/caching
   - Aligns with fetch() Response

2. **HTTP status** - `readonly status: number, statusText: string, ok: boolean`
   - Debugging value
   - ok is always true (we throw on errors), but consistency with fetch()

3. **Connection state** - `readonly isLoading: boolean`
   - Single most requested UI state
   - Simple to implement (track until first data arrives)

4. **Last sync timing** - `readonly lastSyncedAt?: Date`
   - Common UX requirement ("Updated 3s ago")
   - Electric proves this is valuable

### Maybe Add (Medium ROI):

5. **Error property** - `readonly error?: Error`
   - Nice to have but onError handler usually sufficient
   - Could expose last error for debugging

6. **Reconnect** - `reconnect(): Promise<void>`
   - Useful but can work around with cancel() + new stream()
   - Only if demand exists

### Skip (Low ROI or Different Use Case):

7. **Pause/Resume** - Complex lifecycle, unclear semantics with long-poll
8. **Snapshot APIs** - Different pattern, not core to durable streams
9. **Shape handle exposure** - Implementation detail

---

## Proposed Additions

### Minimal Addition (Align with fetch()):
```typescript
interface StreamResponse<TJson> {
  // Add these 3 from fetch() Response:
  readonly headers: Headers        // First response headers
  readonly status: number           // HTTP status (always 200-299)
  readonly ok: boolean              // Always true (throws on !ok)

  // ... existing properties
}
```

### Standard Addition (Align with Electric):
```typescript
interface StreamResponse<TJson> {
  // fetch() alignment:
  readonly headers: Headers
  readonly status: number
  readonly ok: boolean

  // Electric alignment:
  readonly isLoading: boolean       // True until first data
  readonly lastSyncedAt?: Date      // Last successful fetch
  readonly error?: Error            // Last error (if onError returned)

  // ... existing properties
}
```

### Full Addition (Best of Both):
```typescript
interface StreamResponse<TJson> {
  // fetch() alignment:
  readonly headers: Headers
  readonly status: number
  readonly statusText: string
  readonly ok: boolean

  // Electric alignment:
  readonly isLoading: boolean
  readonly lastSyncedAt?: Date
  readonly error?: Error

  // Lifecycle control:
  reconnect(): Promise<void>

  // ... existing properties
}
```

---

## Testing Gaps (From Electric)

### Already Covered ✅:
- onError retry behavior
- Function-based headers/params
- Backoff integration
- Merging handle-level and call-level options

### Not Yet Tested (Could Add):
1. **Abort/cancellation edge cases**
   - Cancel during initial request
   - Cancel during SSE stream
   - Cancel during long-poll wait

2. **SSE fallback scenarios** (if implementing)
   - Short connection detection
   - Auto-fallback to long-poll
   - Reset fallback state on shape rotation

3. **Header/Param resolution timing**
   - Function headers called on each request (not cached)
   - Async function resolution doesn't block unnecessarily

4. **Connection state transitions** (if adding isLoading)
   - isLoading true → false on first data
   - isLoading resets on reconnect

---

## Decision Framework

**Ask yourself:**
1. Would this make debugging easier? → Add `headers`, `status`
2. Would this enable common UI patterns? → Add `isLoading`, `lastSyncedAt`
3. Would users expect this from fetch()? → Add `ok`, `headers`
4. Does Electric prove this is valuable? → Add `isLoading`, `lastSyncedAt`, `error`
5. Is the complexity worth it? → Skip `pause/resume`, `snapshots`
