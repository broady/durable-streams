package durablestreams

import (
	"context"
	"io"
	"net/http"
	"sync"
	"time"
)

// Chunk represents one HTTP response body from the stream.
type Chunk struct {
	// NextOffset is the position after this chunk.
	// Use this for resumption/checkpointing.
	NextOffset Offset

	// Data is the raw bytes from this response.
	Data []byte

	// UpToDate is true if this chunk ends at stream head.
	UpToDate bool

	// Cursor for CDN collapsing (automatically propagated by iterator).
	Cursor string

	// ETag for conditional requests.
	ETag string
}

// ChunkIterator iterates over raw byte chunks from the stream.
// Call Next() in a loop until it returns Done.
//
// The iterator automatically:
//   - Propagates cursor headers for CDN compatibility
//   - Handles 304 Not Modified responses (advances state, no error)
//   - Handles 204 No Content for long-poll timeouts
//
// Always call Close() when done to release resources.
type ChunkIterator struct {
	stream  *Stream
	ctx     context.Context
	cancel  context.CancelFunc
	offset  Offset
	live    LiveMode
	cursor  string
	headers map[string]string
	timeout time.Duration

	// Public state accessible during iteration
	// Offset is the current position in the stream.
	// Updated after each successful Next() call.
	Offset Offset

	// UpToDate is true when the iterator has caught up to stream head.
	UpToDate bool

	// Cursor is the current cursor value (for debugging/advanced use).
	// The iterator propagates this automatically; most users can ignore it.
	Cursor string

	// Internal state
	mu       sync.Mutex
	closed   bool
	doneOnce bool
}

// Next returns the next chunk of bytes from the stream.
// Returns Done when iteration is complete (live=false and caught up).
// In live mode, blocks waiting for new data.
//
// Example:
//
//	for {
//	    chunk, err := it.Next()
//	    if errors.Is(err, durablestreams.Done) {
//	        break
//	    }
//	    if err != nil {
//	        return err
//	    }
//	    fmt.Printf("Got %d bytes at offset %s\n", len(chunk.Data), chunk.NextOffset)
//	}
func (it *ChunkIterator) Next() (*Chunk, error) {
	it.mu.Lock()
	if it.closed {
		it.mu.Unlock()
		return nil, ErrAlreadyClosed
	}
	if it.doneOnce {
		it.mu.Unlock()
		return nil, Done
	}
	it.mu.Unlock()

	// Check context
	select {
	case <-it.ctx.Done():
		return nil, it.ctx.Err()
	default:
	}

	// Build the read URL
	readURL := it.stream.buildReadURL(it.offset, it.live, it.cursor)

	// Create request
	req, err := http.NewRequestWithContext(it.ctx, http.MethodGet, readURL, nil)
	if err != nil {
		return nil, newStreamError("read", it.stream.url, 0, err)
	}

	// Set custom headers
	for k, v := range it.headers {
		req.Header.Set(k, v)
	}

	// Execute request
	resp, err := it.stream.client.httpClient.Do(req)
	if err != nil {
		// Check if context was cancelled
		if it.ctx.Err() != nil {
			return nil, it.ctx.Err()
		}
		return nil, newStreamError("read", it.stream.url, 0, err)
	}
	defer resp.Body.Close()

	// Handle response status
	switch resp.StatusCode {
	case http.StatusOK:
		// Read body
		data, err := io.ReadAll(resp.Body)
		if err != nil {
			return nil, newStreamError("read", it.stream.url, resp.StatusCode, err)
		}

		// Extract headers
		nextOffset := Offset(resp.Header.Get(headerStreamOffset))
		cursor := resp.Header.Get(headerStreamCursor)
		upToDate := resp.Header.Get(headerStreamUpToDate) == "true"
		etag := resp.Header.Get(headerETag)

		// Update iterator state
		it.mu.Lock()
		it.offset = nextOffset
		it.cursor = cursor
		it.Offset = nextOffset
		it.Cursor = cursor
		it.UpToDate = upToDate

		// If up to date and not in live mode, mark as done for next call
		if upToDate && it.live == LiveModeNone {
			it.doneOnce = true
		}
		it.mu.Unlock()

		return &Chunk{
			NextOffset: nextOffset,
			Data:       data,
			UpToDate:   upToDate,
			Cursor:     cursor,
			ETag:       etag,
		}, nil

	case http.StatusNoContent:
		// 204 - Long-poll timeout or caught up with no new data
		nextOffset := Offset(resp.Header.Get(headerStreamOffset))
		cursor := resp.Header.Get(headerStreamCursor)
		upToDate := resp.Header.Get(headerStreamUpToDate) == "true"

		it.mu.Lock()
		if nextOffset != "" {
			it.offset = nextOffset
			it.Offset = nextOffset
		}
		if cursor != "" {
			it.cursor = cursor
			it.Cursor = cursor
		}
		it.UpToDate = upToDate

		// In non-live mode, 204 means we're done
		if it.live == LiveModeNone {
			it.doneOnce = true
			it.mu.Unlock()
			return nil, Done
		}
		it.mu.Unlock()

		// In live mode, return empty chunk and continue
		return &Chunk{
			NextOffset: nextOffset,
			Data:       nil,
			UpToDate:   upToDate,
			Cursor:     cursor,
		}, nil

	case http.StatusNotModified:
		// 304 - Not modified (cache hit)
		// Advance cursor if provided and try again
		if cursor := resp.Header.Get(headerStreamCursor); cursor != "" {
			it.mu.Lock()
			it.cursor = cursor
			it.Cursor = cursor
			it.mu.Unlock()
		}
		// Return empty chunk
		return &Chunk{
			NextOffset: it.offset,
			Data:       nil,
			UpToDate:   it.UpToDate,
			Cursor:     it.cursor,
		}, nil

	case http.StatusNotFound:
		io.Copy(io.Discard, resp.Body)
		return nil, newStreamError("read", it.stream.url, resp.StatusCode, ErrStreamNotFound)

	case http.StatusGone:
		io.Copy(io.Discard, resp.Body)
		return nil, newStreamError("read", it.stream.url, resp.StatusCode, ErrOffsetGone)

	default:
		io.Copy(io.Discard, resp.Body)
		return nil, newStreamError("read", it.stream.url, resp.StatusCode, errorFromStatus(resp.StatusCode))
	}
}

// Close cancels the iterator and releases resources.
// Always call Close when done, even if iteration completed.
// Implements io.Closer.
func (it *ChunkIterator) Close() error {
	it.mu.Lock()
	defer it.mu.Unlock()

	if it.closed {
		return nil
	}

	it.closed = true
	it.cancel()
	return nil
}

// Ensure ChunkIterator implements io.Closer
var _ io.Closer = (*ChunkIterator)(nil)
