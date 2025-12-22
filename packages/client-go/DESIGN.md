# Go Client Library Design for Durable Streams

## Overview

This document proposes a design for a Go client library implementing the Durable Streams Protocol. The design draws from:

- The existing TypeScript client in this repo
- The Python client PR (#83)
- The community Go implementation (ahimsalabs/durable-streams-go)
- Best practices from aws-sdk-go, google-cloud-go, and idiomatic Go patterns

## Design Goals

1. **Idiomatic Go** - Follow established Go conventions (context, errors, interfaces)
2. **Minimal dependencies** - Standard library where possible
3. **Type safety** - Leverage Go's type system effectively
4. **Performance** - Efficient streaming without buffering entire responses
5. **Testability** - Easy to mock and test
6. **Conformance** - Pass all protocol conformance tests

---

## Option A: Google Cloud Style (Recommended)

This approach follows patterns from google-cloud-go, the most widely adopted Go SDK style.

### Package Structure

```
packages/client-go/
├── go.mod                    # github.com/durable-streams/durable-streams/client-go
├── go.sum
├── client.go                 # Client type and constructor
├── stream.go                 # Stream handle
├── iterator.go               # Iterator types (MessageIterator, ByteIterator)
├── options.go                # Functional options
├── errors.go                 # Error types
├── doc.go                    # Package documentation
├── internal/
│   ├── sse/
│   │   └── parser.go         # SSE event parsing
│   └── backoff/
│       └── backoff.go        # Retry with exponential backoff
└── durablestreamstest/       # Testing utilities (mock client)
    └── mock.go
```

### Core Types

```go
package durablestreams

import (
    "context"
    "io"
    "net/http"
    "time"
)

// Offset is an opaque position token in a stream.
// Use StartOffset to read from the beginning.
type Offset string

const StartOffset Offset = "-1"

// Client is a durable streams client.
// It is safe for concurrent use.
type Client struct {
    httpClient *http.Client
    // ... internal fields
}

// NewClient creates a new durable streams client.
func NewClient(opts ...ClientOption) *Client

// Stream returns a handle to a stream at the given URL.
// No network request is made until an operation is called.
func (c *Client) Stream(url string) *Stream

// Stream represents a durable stream handle.
// It is a lightweight, reusable object - not a persistent connection.
type Stream struct {
    url    string
    client *Client
}
```

### Stream Operations

```go
// Create creates a new stream.
// Returns ErrStreamExists if the stream already exists with different config.
func (s *Stream) Create(ctx context.Context, opts ...CreateOption) error

// CreateOrEnsure creates a stream or ensures it exists with matching config.
// This is the idempotent create operation.
func (s *Stream) CreateOrEnsure(ctx context.Context, opts ...CreateOption) error

// Append writes data to the stream.
func (s *Stream) Append(ctx context.Context, data []byte, opts ...AppendOption) error

// AppendJSON writes JSON data to the stream.
// For JSON streams, arrays are flattened one level per protocol spec.
func (s *Stream) AppendJSON(ctx context.Context, v any, opts ...AppendOption) error

// Delete removes the stream.
func (s *Stream) Delete(ctx context.Context) error

// Head returns stream metadata without reading content.
func (s *Stream) Head(ctx context.Context) (*Metadata, error)

// Metadata contains stream information from HEAD request.
type Metadata struct {
    ContentType string
    NextOffset  Offset
    TTL         *time.Duration
    ExpiresAt   *time.Time
    ETag        string
}
```

### Reading - Iterator Pattern (Google Cloud Style)

Following [Google Cloud Iterator Guidelines](https://github.com/googleapis/google-cloud-go/wiki/Iterator-Guidelines):

```go
// Read returns an iterator for reading stream content.
// The iterator handles catch-up and optional live tailing.
func (s *Stream) Read(ctx context.Context, opts ...ReadOption) *MessageIterator

// MessageIterator iterates over stream messages.
// Call Next() in a loop until it returns iterator.Done.
type MessageIterator struct {
    // Offset is the current position in the stream.
    // Updated after each successful Next() call.
    Offset Offset

    // UpToDate is true when the iterator has caught up to stream head.
    UpToDate bool

    // ... internal fields
}

// Next returns the next message from the stream.
// Returns iterator.Done when iteration is complete.
// In live mode, blocks waiting for new data.
func (it *MessageIterator) Next() (*Message, error)

// Stop cancels the iterator and releases resources.
// Always call Stop when done, even if iteration completed.
func (it *MessageIterator) Stop()

// Message represents a single item from the stream.
type Message struct {
    // Offset is the position after this message.
    Offset Offset

    // Data is the raw message bytes.
    Data []byte
}

// Decode unmarshals the message into v using JSON.
func (m *Message) Decode(v any) error

// String returns the message data as a string.
func (m *Message) String() string
```

### Reading - Batch/Chunk Pattern

For performance-sensitive use cases, provide batch access:

```go
// ReadChunks returns an iterator for reading raw byte chunks.
// More efficient than message iteration for large streams.
func (s *Stream) ReadChunks(ctx context.Context, opts ...ReadOption) *ChunkIterator

// ChunkIterator iterates over raw byte chunks from the stream.
type ChunkIterator struct {
    Offset   Offset
    UpToDate bool
}

// Next returns the next chunk of bytes.
func (it *ChunkIterator) Next() (*Chunk, error)
func (it *ChunkIterator) Stop()

type Chunk struct {
    Offset   Offset
    Data     []byte
    UpToDate bool
}
```

### Live Modes

```go
type LiveMode string

const (
    // LiveModeNone stops after catching up (no live tailing).
    LiveModeNone LiveMode = ""

    // LiveModeLongPoll uses HTTP long-polling for live updates.
    LiveModeLongPoll LiveMode = "long-poll"

    // LiveModeSSE uses Server-Sent Events for live updates.
    LiveModeSSE LiveMode = "sse"

    // LiveModeAuto selects the best mode based on content type.
    LiveModeAuto LiveMode = "auto"
)
```

### Functional Options

```go
// Client options
type ClientOption func(*clientConfig)

func WithHTTPClient(c *http.Client) ClientOption
func WithBaseURL(url string) ClientOption
func WithRetryPolicy(p RetryPolicy) ClientOption

// Create options
type CreateOption func(*createConfig)

func WithContentType(ct string) CreateOption
func WithTTL(d time.Duration) CreateOption
func WithExpiresAt(t time.Time) CreateOption
func WithInitialData(data []byte) CreateOption

// Append options
type AppendOption func(*appendConfig)

func WithSeq(seq string) AppendOption

// Read options
type ReadOption func(*readConfig)

func WithOffset(o Offset) ReadOption
func WithLive(mode LiveMode) ReadOption
func WithCursor(cursor string) ReadOption
```

### Error Handling

```go
import "errors"

// Sentinel errors following Go conventions
var (
    // ErrStreamNotFound indicates the stream does not exist.
    ErrStreamNotFound = errors.New("durablestreams: stream not found")

    // ErrStreamExists indicates a create conflict.
    ErrStreamExists = errors.New("durablestreams: stream already exists")

    // ErrSeqConflict indicates a sequence ordering violation.
    ErrSeqConflict = errors.New("durablestreams: sequence conflict")

    // ErrOffsetGone indicates the offset is before retained data (410).
    ErrOffsetGone = errors.New("durablestreams: offset before retention window")

    // ErrRateLimited indicates rate limiting (429).
    ErrRateLimited = errors.New("durablestreams: rate limited")
)

// StreamError wraps errors with additional context.
type StreamError struct {
    Op         string // "create", "append", "read", "delete", "head"
    URL        string
    StatusCode int
    Err        error
}

func (e *StreamError) Error() string
func (e *StreamError) Unwrap() error

// Usage:
// if errors.Is(err, ErrStreamNotFound) { ... }
// var se *StreamError
// if errors.As(err, &se) { fmt.Println(se.StatusCode) }
```

### Example Usage

```go
package main

import (
    "context"
    "fmt"
    "log"

    ds "github.com/durable-streams/durable-streams/client-go"
    "google.golang.org/api/iterator"
)

func main() {
    ctx := context.Background()

    // Create client
    client := ds.NewClient()

    // Get stream handle
    stream := client.Stream("https://example.com/streams/my-stream")

    // Create the stream
    err := stream.Create(ctx,
        ds.WithContentType("application/json"),
        ds.WithTTL(24 * time.Hour),
    )
    if err != nil && !errors.Is(err, ds.ErrStreamExists) {
        log.Fatal(err)
    }

    // Append data
    err = stream.AppendJSON(ctx, map[string]any{
        "event": "user.created",
        "user":  "alice",
    })
    if err != nil {
        log.Fatal(err)
    }

    // Read all messages (catch-up only)
    it := stream.Read(ctx)
    defer it.Stop()

    for {
        msg, err := it.Next()
        if err == iterator.Done {
            break
        }
        if err != nil {
            log.Fatal(err)
        }
        fmt.Printf("Offset: %s, Data: %s\n", msg.Offset, msg.String())
    }

    // Live tailing with long-poll
    it = stream.Read(ctx, ds.WithLive(ds.LiveModeLongPoll))
    defer it.Stop()

    for {
        msg, err := it.Next()
        if err == iterator.Done {
            break
        }
        if err != nil {
            log.Fatal(err)
        }

        var event Event
        if err := msg.Decode(&event); err != nil {
            log.Printf("decode error: %v", err)
            continue
        }
        fmt.Printf("Event: %+v\n", event)
    }
}
```

---

## Option B: Simpler API (aws-sdk-go Style)

This approach is more direct with fewer abstractions.

### Core Types

```go
package durablestreams

// Client with direct methods
type Client struct {
    BaseURL    string
    HTTPClient *http.Client
}

// Direct operations without Stream handle
func (c *Client) CreateStream(ctx context.Context, url string, opts *CreateOptions) error
func (c *Client) Append(ctx context.Context, url string, data []byte, opts *AppendOptions) (*AppendResult, error)
func (c *Client) Read(ctx context.Context, url string, opts *ReadOptions) (*ReadResult, error)
func (c *Client) Delete(ctx context.Context, url string) error
func (c *Client) Head(ctx context.Context, url string) (*Metadata, error)

// Options as structs instead of functional options
type CreateOptions struct {
    ContentType string
    TTL         time.Duration
    ExpiresAt   time.Time
    InitialData []byte
}

type ReadOptions struct {
    Offset Offset
    Live   LiveMode
    Cursor string
}

// ReadResult with helper methods
type ReadResult struct {
    Body       io.ReadCloser
    Offset     Offset
    Cursor     string
    UpToDate   bool
    StatusCode int
    Headers    http.Header
}

// Messages returns an iterator over JSON messages
func (r *ReadResult) Messages() <-chan MessageOrError
```

### Example Usage

```go
client := &durablestreams.Client{
    HTTPClient: &http.Client{Timeout: 30 * time.Second},
}

err := client.CreateStream(ctx, "https://example.com/stream", &durablestreams.CreateOptions{
    ContentType: "application/json",
})

result, err := client.Read(ctx, "https://example.com/stream", &durablestreams.ReadOptions{
    Live: durablestreams.LiveModeLongPoll,
})
defer result.Body.Close()

for msg := range result.Messages() {
    if msg.Err != nil {
        log.Fatal(msg.Err)
    }
    fmt.Println(msg.Data)
}
```

---

## Option C: Go 1.23 Range-Over-Func (Modern Go)

Go 1.23 introduced range-over-func, allowing custom iterators with `for range`:

```go
package durablestreams

// Messages returns an iterator for use with range.
// Go 1.23+ range-over-func pattern.
func (s *Stream) Messages(ctx context.Context, opts ...ReadOption) iter.Seq2[*Message, error]

// Usage with Go 1.23+:
for msg, err := range stream.Messages(ctx, ds.WithLive(ds.LiveModeLongPoll)) {
    if err != nil {
        log.Fatal(err)
    }
    fmt.Println(msg.String())
}
```

### Tradeoff Analysis

| Feature | Go 1.23 iter.Seq2 | Classic Iterator |
|---------|-------------------|------------------|
| Syntax | Clean `for range` | `for { Next() }` |
| Cleanup | Automatic via break | Manual `Stop()` required |
| Go Version | 1.23+ only | Any version |
| Ecosystem | New pattern | Well-established |
| Cancel | Via context | Via context or Stop() |

---

## Recommendation

**Option A (Google Cloud Style)** is recommended because:

1. **Established pattern** - Widely used in google-cloud-go, battle-tested
2. **Explicit resource management** - `Stop()` makes cleanup clear
3. **Consistent with ecosystem** - Users familiar with GCP/AWS Go SDKs
4. **Metadata access** - Easy to check `it.UpToDate`, `it.Offset` during iteration
5. **Compatible** - Works with all Go versions (1.18+ for generics)

### Implementation Phases

**Phase 1: Core Operations**
- Client + Stream types
- Create, Append, Delete, Head
- Basic Read (catch-up only)
- Error types

**Phase 2: Live Streaming**
- Long-poll support
- SSE support with parser
- LiveModeAuto selection

**Phase 3: Advanced Features**
- Automatic batching for appends (like TS client)
- Retry with exponential backoff
- Dynamic headers/params callbacks
- Connection pooling optimization

**Phase 4: Testing & Conformance**
- Pass conformance test suite
- Testing utilities (mock client)
- Documentation

---

## Conformance Test Adapter

To pass the conformance tests, we need a stdin/stdout JSON adapter:

```go
// cmd/conformance-adapter/main.go
package main

// Implements the conformance test protocol:
// - Reads JSON operations from stdin
// - Executes against durable-streams client
// - Writes JSON results to stdout

type Operation struct {
    Type   string          `json:"type"`
    Create *CreateOp       `json:"create,omitempty"`
    Append *AppendOp       `json:"append,omitempty"`
    Read   *ReadOp         `json:"read,omitempty"`
    // ...
}

type CreateOp struct {
    URL         string `json:"url"`
    ContentType string `json:"contentType"`
    TTL         int    `json:"ttl,omitempty"`
}

// ... adapter implementation
```

---

## Dependencies

Minimal external dependencies:

```go
module github.com/durable-streams/durable-streams/client-go

go 1.21

require (
    google.golang.org/api v0.x.x // Only for iterator.Done sentinel
)
```

Alternative: Define our own `Done` sentinel to eliminate the dependency:

```go
package durablestreams

import "errors"

// Done is returned by iterators when iteration is complete.
var Done = errors.New("durablestreams: no more items in iterator")
```

---

## Open Questions

1. **Minimum Go version?**
   - 1.21 (current stable-1) or 1.18 (generics introduced)?

2. **Single package or split?**
   - Single `durablestreams` package (simpler)
   - Split into `durablestreams` + `durablestreamstest` (cleaner testing)

3. **Use google.golang.org/api/iterator.Done or define our own?**
   - Using theirs = consistent with GCP ecosystem
   - Own = zero external dependencies

4. **Automatic batching in Phase 1 or defer?**
   - TS client has it by default for performance
   - Could add in Phase 3 after basic functionality works

---

## References

- [Effective Go](https://go.dev/doc/effective_go)
- [Google Cloud Go Iterator Guidelines](https://github.com/googleapis/google-cloud-go/wiki/Iterator-Guidelines)
- [Functional Options Pattern](https://dev.to/kittipat1413/understanding-the-options-pattern-in-go-390c)
- [Go Context Best Practices](https://go.dev/blog/context)
- [Go HTTP Client Timeouts](https://blog.cloudflare.com/the-complete-guide-to-golang-net-http-timeouts/)
- [Designing Go Libraries](https://abhinavg.net/2022/12/06/designing-go-libraries/)
