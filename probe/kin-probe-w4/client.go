package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// HTTPError is a non-2xx daemon answer, carrying enough of the body to explain
// a refusal without dumping an unbounded response into the log.
type HTTPError struct {
	Method string
	Path   string
	Status int
	Body   string
}

func (e *HTTPError) Error() string {
	return fmt.Sprintf("%s %s: HTTP %d: %s", e.Method, e.Path, e.Status, e.Body)
}

// Client is a minimal JSON-over-HTTP client for the documented API.
type Client struct {
	BaseURL string
	Token   string
	HTTP    *http.Client
	SSE     *http.Client
}

func NewClient(baseURL, token string) *Client {
	transport := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		MaxIdleConns:          32,
		IdleConnTimeout:       90 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
	}
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		Token:   token,
		HTTP:    &http.Client{Transport: transport, Timeout: 60 * time.Second},
		// A stream has no overall deadline; the caller's context ends it.
		SSE: &http.Client{Transport: transport},
	}
}

func (c *Client) url(path string) string {
	return c.BaseURL + path
}

func (c *Client) do(ctx context.Context, method, path string, body any, out any) error {
	var reader io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("encode %s %s: %w", method, path, err)
		}
		reader = bytes.NewReader(buf)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.url(path), reader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("%s %s: %w", method, path, err)
	}
	defer resp.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return fmt.Errorf("%s %s: read body: %w", method, path, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		snippet := strings.TrimSpace(string(payload))
		if len(snippet) > 400 {
			snippet = snippet[:400] + "…"
		}
		return &HTTPError{Method: method, Path: path, Status: resp.StatusCode, Body: snippet}
	}
	if out != nil && len(payload) > 0 {
		if err := json.Unmarshal(payload, out); err != nil {
			return fmt.Errorf("%s %s: decode: %w", method, path, err)
		}
	}
	return nil
}

func (c *Client) GetJSON(ctx context.Context, path string, out any) error {
	return c.do(ctx, http.MethodGet, path, nil, out)
}

func (c *Client) PostJSON(ctx context.Context, path string, body, out any) error {
	return c.do(ctx, http.MethodPost, path, body, out)
}

func (c *Client) Delete(ctx context.Context, path string) error {
	return c.do(ctx, http.MethodDelete, path, nil, nil)
}

// SSEEvent is one dispatched Server-Sent Event frame.
type SSEEvent struct {
	Event string
	Data  []byte
	At    time.Time
}

// SSEStream reads the documented `event: <kind>` / `data: <WSMessage>` format.
type SSEStream struct {
	body    io.ReadCloser
	cancel  context.CancelFunc
	scanner *bufio.Scanner
}

// OpenSSE subscribes to /api/events. The credential travels as the documented
// `?token=` query parameter because an EventSource cannot set a header.
func (c *Client) OpenSSE(ctx context.Context, path string) (*SSEStream, error) {
	ctx, cancel := context.WithCancel(ctx)
	sep := "?"
	if strings.Contains(path, "?") {
		sep = "&"
	}
	target := c.url(path + sep + "token=" + url.QueryEscape(c.Token))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		cancel()
		return nil, err
	}
	req.Header.Set("Accept", "text/event-stream")
	resp, err := c.SSE.Do(req)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("GET %s: %w", path, err)
	}
	if resp.StatusCode != http.StatusOK {
		defer resp.Body.Close()
		defer cancel()
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 400))
		return nil, &HTTPError{Method: http.MethodGet, Path: path, Status: resp.StatusCode, Body: strings.TrimSpace(string(snippet))}
	}
	contentType := resp.Header.Get("Content-Type")
	if !strings.HasPrefix(contentType, "text/event-stream") {
		defer resp.Body.Close()
		defer cancel()
		return nil, fmt.Errorf("GET %s: content-type %q, want text/event-stream", path, contentType)
	}
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 64<<10), 4<<20)
	return &SSEStream{body: resp.Body, cancel: cancel, scanner: scanner}, nil
}

func (s *SSEStream) Close() error {
	s.cancel()
	return s.body.Close()
}

// Next blocks until one event frame is dispatched. Comment lines (heartbeats)
// and fields other than event/data are skipped.
func (s *SSEStream) Next() (SSEEvent, error) {
	var event string
	var data []string
	for s.scanner.Scan() {
		line := s.scanner.Text()
		if line == "" {
			if len(data) == 0 {
				event = ""
				continue
			}
			if event == "" {
				event = "message"
			}
			return SSEEvent{Event: event, Data: []byte(strings.Join(data, "\n")), At: time.Now()}, nil
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		field, value, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		value = strings.TrimPrefix(value, " ")
		switch field {
		case "event":
			event = value
		case "data":
			data = append(data, value)
		}
	}
	if err := s.scanner.Err(); err != nil {
		return SSEEvent{}, err
	}
	return SSEEvent{}, io.EOF
}
