package durablestreams

import (
	"net/http"
	"strings"
	"time"
)

// Client is a durable streams client.
// It is safe for concurrent use.
type Client struct {
	httpClient  *http.Client
	baseURL     string
	retryPolicy RetryPolicy
}

// NewClient creates a new durable streams client.
//
// Example:
//
//	client := durablestreams.NewClient()
//	stream := client.Stream("https://example.com/streams/my-stream")
func NewClient(opts ...ClientOption) *Client {
	cfg := &clientConfig{}
	for _, opt := range opts {
		opt(cfg)
	}

	// Default HTTP client with sensible timeouts
	httpClient := cfg.httpClient
	if httpClient == nil {
		httpClient = &http.Client{
			Timeout: 60 * time.Second,
			Transport: &http.Transport{
				MaxIdleConns:        100,
				MaxIdleConnsPerHost: 10,
				IdleConnTimeout:     90 * time.Second,
			},
		}
	}

	// Default retry policy
	retryPolicy := DefaultRetryPolicy()
	if cfg.retryPolicy != nil {
		retryPolicy = *cfg.retryPolicy
	}

	return &Client{
		httpClient:  httpClient,
		baseURL:     strings.TrimSuffix(cfg.baseURL, "/"),
		retryPolicy: retryPolicy,
	}
}

// Stream returns a handle to a stream at the given URL.
// No network request is made until an operation is called.
//
// The url can be:
//   - A full URL: "https://example.com/streams/my-stream"
//   - A path (if baseURL was set): "/streams/my-stream"
func (c *Client) Stream(url string) *Stream {
	// If url doesn't start with http and we have a baseURL, prepend it
	fullURL := url
	if !strings.HasPrefix(url, "http://") && !strings.HasPrefix(url, "https://") {
		if c.baseURL != "" {
			fullURL = c.baseURL + url
		}
	}

	return &Stream{
		url:    fullURL,
		client: c,
	}
}

// HTTPClient returns the underlying HTTP client.
// This can be useful for advanced configuration or testing.
func (c *Client) HTTPClient() *http.Client {
	return c.httpClient
}
