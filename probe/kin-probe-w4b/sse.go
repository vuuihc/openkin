package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// SSEEvent is one dispatched server-sent event. Name defaults to "message"
// when the frame carried no event line, per the SSE format.
type SSEEvent struct {
	Name string
	Data string
}

// EventStream is an open text/event-stream response.
type EventStream struct {
	resp *http.Response
	// OnComment, when set before Read, is called for each comment line.
	OnComment func()
}

// OpenEventStream subscribes to GET /api/events with the bearer credential.
// The request inherits the caller's context, so cancelling it closes the
// stream. The client has no overall timeout: the stream is expected to stay
// open. A response-header timeout keeps a silent connect from hanging.
func OpenEventStream(ctx context.Context, baseURL, token string) (*EventStream, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(baseURL, "/")+"/api/events", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "text/event-stream")

	hc := &http.Client{Transport: &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		ResponseHeaderTimeout: 30 * time.Second,
	}}
	resp, err := hc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("open event stream: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		defer resp.Body.Close()
		body, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrorBody))
		return nil, &APIError{
			Method: http.MethodGet,
			Path:   "/api/events",
			Status: resp.StatusCode,
			Body:   strings.TrimSpace(string(body)),
		}
	}
	return &EventStream{resp: resp}, nil
}

func (s *EventStream) Close() error {
	if s == nil || s.resp == nil || s.resp.Body == nil {
		return nil
	}
	return s.resp.Body.Close()
}

// Read parses frames until the stream ends or emit returns an error. Comment
// lines (": ping") are keep-alives and are skipped. The retry field is parsed
// and ignored: reconnection is the client's own policy. Multi-line data is
// joined with newlines as the SSE format specifies.
func (s *EventStream) Read(emit func(SSEEvent) error) error {
	br := bufio.NewReaderSize(s.resp.Body, 64<<10)
	var name string
	var data []string

	dispatch := func() error {
		if len(data) == 0 {
			name = ""
			return nil
		}
		ev := SSEEvent{Name: name, Data: strings.Join(data, "\n")}
		if ev.Name == "" {
			ev.Name = "message"
		}
		name = ""
		data = nil
		return emit(ev)
	}

	for {
		line, err := br.ReadString('\n')
		if len(line) > 0 {
			line = strings.TrimSuffix(line, "\n")
			line = strings.TrimSuffix(line, "\r")
			switch {
			case line == "":
				if derr := dispatch(); derr != nil {
					return derr
				}
			case strings.HasPrefix(line, ":"):
				// Comment / keep-alive.
				if s.OnComment != nil {
					s.OnComment()
				}
			default:
				field, value, _ := strings.Cut(line, ":")
				value = strings.TrimPrefix(value, " ")
				switch field {
				case "event":
					name = value
				case "data":
					data = append(data, value)
				}
			}
		}
		if err != nil {
			if derr := dispatch(); derr != nil {
				return derr
			}
			if errors.Is(err, io.EOF) {
				return io.EOF
			}
			return err
		}
	}
}
