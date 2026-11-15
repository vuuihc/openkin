package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// SSEFrame is one dispatched Server-Sent Events frame. Comment and retry
// fields are kept because the contract mentions only `: ping` heartbeats while
// the daemon also sends a `retry:` directive.
type SSEFrame struct {
	Event   string
	Data    string
	Comment string
	Retry   string
	At      time.Time
}

// WSMessage is the discriminated union carried by both /api/ws and /api/events.
type WSMessage struct {
	Kind string          `json:"kind"`
	Data json.RawMessage `json:"data"`
}

// StreamEvents opens the SSE endpoint and calls onFrame for each dispatched
// frame. It returns when the stream ends, the context is cancelled, or
// onFrame fails.
func (c *Client) StreamEvents(ctx context.Context, onFrame func(SSEFrame) error) error {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = 15 * time.Second
	client := &http.Client{Transport: transport}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+"/api/events", nil)
	if err != nil {
		return err
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Cache-Control", "no-cache")

	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return &APIError{Status: resp.StatusCode, Body: truncate(strings.TrimSpace(string(data)), 400)}
	}
	return ParseSSE(resp.Body, onFrame)
}

// ParseSSE implements the event-stream framing the contract describes: fields
// up to a blank line, `:` comments, and one JSON WSMessage per data field.
func ParseSSE(r io.Reader, onFrame func(SSEFrame) error) error {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64*1024), 8<<20)

	var frame SSEFrame
	var dataLines []string
	var comment string
	flush := func() error {
		// A comment is not part of an event and must not suppress one: only a
		// frame with no event/data/retry fields is dispatched as a heartbeat.
		if frame.Event == "" && len(dataLines) == 0 && frame.Retry == "" {
			if comment == "" {
				return nil
			}
			out := SSEFrame{Comment: comment, At: time.Now()}
			comment = ""
			return onFrame(out)
		}
		comment = ""
		frame.Data = strings.Join(dataLines, "\n")
		frame.At = time.Now()
		err := onFrame(frame)
		frame = SSEFrame{}
		dataLines = nil
		return err
	}

	for scanner.Scan() {
		line := strings.TrimSuffix(scanner.Text(), "\r")
		if line == "" {
			if err := flush(); err != nil {
				return err
			}
			continue
		}
		if strings.HasPrefix(line, ":") {
			comment = strings.TrimSpace(line[1:])
			continue
		}
		field, value, found := strings.Cut(line, ":")
		if !found {
			field, value = line, ""
		}
		value = strings.TrimPrefix(value, " ")
		switch field {
		case "event":
			frame.Event = value
		case "data":
			dataLines = append(dataLines, value)
		case "retry":
			frame.Retry = value
		case "id":
			// Not used by this client; the cursor is an HTTP concept (ADR 0024).
		}
	}
	if err := scanner.Err(); err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return err
		}
		return fmt.Errorf("read event stream: %w", err)
	}
	return flush()
}

// DecodeWSMessage parses one SSE data field into the union envelope.
func DecodeWSMessage(data string) (*WSMessage, error) {
	var msg WSMessage
	if err := json.Unmarshal([]byte(data), &msg); err != nil {
		return nil, err
	}
	if msg.Kind == "" {
		return nil, errors.New("frame has no kind")
	}
	return &msg, nil
}
