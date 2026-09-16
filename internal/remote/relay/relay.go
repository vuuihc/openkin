// Package relay provides the outbound bridge for a user-owned Kin Relay.
package relay

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"nhooyr.io/websocket"
)

const (
	protocolVersion = 2
	maxBodyBytes    = 20 << 20
	maxFrameBytes   = 32 << 20
)

type credentials struct {
	Room string `json:"room"`
	Key  string `json:"key"`
}

type Bridge struct {
	relayURL, room, relayKey, localBase string
	mu                                  sync.Mutex
	writeMu                             sync.Mutex
	ws                                  *websocket.Conn
	streams                             map[string]*websocket.Conn
	httpClient                          *http.Client
}

type envelope struct {
	Version int             `json:"v"`
	Kind    string          `json:"kind"`
	Data    json.RawMessage `json:"data,omitempty"`
}

type helloData struct {
	Role string `json:"role"`
	Room string `json:"room"`
	Key  string `json:"key"`
}

type requestData struct {
	ID      string            `json:"id"`
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers,omitempty"`
	BodyB64 string            `json:"body_b64,omitempty"`
}

type responseData struct {
	ID      string            `json:"id"`
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers,omitempty"`
	BodyB64 string            `json:"body_b64,omitempty"`
	Error   string            `json:"error,omitempty"`
}

type streamData struct {
	ID      string            `json:"id"`
	Headers map[string]string `json:"headers,omitempty"`
	Payload string            `json:"payload,omitempty"`
	Binary  bool              `json:"binary,omitempty"`
}

// NewBridge creates an ephemeral-credential bridge for tests and embedding.
// Production should use NewPersistentBridge.
func NewBridge(relayURL, room, localBase string) *Bridge {
	key, _ := newSecret()
	return newBridge(relayURL, room, key, localBase)
}

// NewPersistentBridge loads or creates stable room credentials below stateDir.
func NewPersistentBridge(relayURL, stateDir, localBase string) (*Bridge, error) {
	if err := validateRelayURL(relayURL); err != nil {
		return nil, err
	}
	dir := filepath.Join(stateDir, "relay")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create relay state: %w", err)
	}
	path := filepath.Join(dir, "credentials.json")
	var c credentials
	data, err := os.ReadFile(path)
	switch {
	case err == nil:
		if err := json.Unmarshal(data, &c); err != nil {
			return nil, fmt.Errorf("parse relay credentials: %w", err)
		}
	case errors.Is(err, os.ErrNotExist):
		c.Room, err = newSecret()
		if err != nil {
			return nil, err
		}
		c.Key, err = newSecret()
		if err != nil {
			return nil, err
		}
		data, _ := json.MarshalIndent(c, "", "  ")
		if err := os.WriteFile(path, append(data, '\n'), 0o600); err != nil {
			return nil, fmt.Errorf("write relay credentials: %w", err)
		}
	default:
		return nil, fmt.Errorf("read relay credentials: %w", err)
	}
	if c.Room == "" || c.Key == "" {
		return nil, errors.New("relay credentials are incomplete")
	}
	return newBridge(relayURL, c.Room, c.Key, localBase), nil
}

func newBridge(relayURL, room, key, localBase string) *Bridge {
	return &Bridge{
		relayURL: relayURL, room: room, relayKey: key, localBase: strings.TrimRight(localBase, "/"),
		streams:    make(map[string]*websocket.Conn),
		httpClient: &http.Client{Timeout: 30 * time.Second},
	}
}

func newSecret() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("generate relay credential: %w", err)
	}
	return hex.EncodeToString(buf), nil
}

func validateRelayURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return errors.New("relay URL must include a host")
	}
	switch u.Scheme {
	case "ws", "wss", "http", "https":
		return nil
	default:
		return errors.New("relay URL must use ws(s) or http(s)")
	}
}

// Run maintains the daemon connection until ctx is cancelled.
func (b *Bridge) Run(ctx context.Context) error {
	if err := validateRelayURL(b.relayURL); err != nil {
		return err
	}
	delay := 250 * time.Millisecond
	for {
		err := b.runGeneration(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		b.closeStreams()
		wait := delay + time.Duration(time.Now().UnixNano()%int64(delay/2+1)) - delay/4
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait):
		}
		if delay < 15*time.Second {
			delay *= 2
			if delay > 15*time.Second {
				delay = 15 * time.Second
			}
		}
		_ = err
	}
}

func (b *Bridge) runGeneration(ctx context.Context) error {
	c, _, err := websocket.Dial(ctx, b.wsURL(), nil)
	if err != nil {
		return fmt.Errorf("relay dial: %w", err)
	}
	b.mu.Lock()
	b.ws = c
	b.mu.Unlock()
	defer func() {
		_ = c.Close(websocket.StatusNormalClosure, "generation ended")
		b.mu.Lock()
		if b.ws == c {
			b.ws = nil
		}
		b.mu.Unlock()
	}()
	if err := b.send(ctx, "hello", helloData{Role: "daemon", Room: b.room, Key: b.relayKey}); err != nil {
		return err
	}
	for {
		typ, msg, err := c.Read(ctx)
		if err != nil {
			return fmt.Errorf("relay read: %w", err)
		}
		if typ != websocket.MessageText || len(msg) > maxFrameBytes {
			return errors.New("relay frame exceeds limit")
		}
		var frame envelope
		if json.Unmarshal(msg, &frame) != nil {
			continue
		}
		switch frame.Kind {
		case "request":
			var d requestData
			if json.Unmarshal(frame.Data, &d) == nil {
				go b.proxyHTTP(ctx, d)
			}
		case "open_stream":
			var d streamData
			if json.Unmarshal(frame.Data, &d) == nil {
				go b.openStream(ctx, d)
			}
		case "stream_data":
			var d streamData
			if json.Unmarshal(frame.Data, &d) == nil {
				b.writeStream(d)
			}
		case "close_stream":
			var d streamData
			if json.Unmarshal(frame.Data, &d) == nil {
				b.closeStream(d.ID)
			}
		case "ping":
			_ = b.send(ctx, "pong", map[string]string{"room": b.room})
		}
	}
}

func (b *Bridge) wsURL() string {
	base := b.relayURL
	if strings.HasPrefix(base, "http://") {
		base = "ws://" + strings.TrimPrefix(base, "http://")
	} else if strings.HasPrefix(base, "https://") {
		base = "wss://" + strings.TrimPrefix(base, "https://")
	}
	parsed, err := url.Parse(base)
	if err != nil {
		return base
	}
	query := parsed.Query()
	query.Set("room", b.room)
	query.Set("role", "daemon")
	query.Set("key", b.relayKey)
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

// ConnectURL returns the public client URL without credentials.
func (b *Bridge) ConnectURL() string {
	base := b.relayURL
	if strings.HasPrefix(base, "ws://") {
		base = "http://" + strings.TrimPrefix(base, "ws://")
	} else if strings.HasPrefix(base, "wss://") {
		base = "https://" + strings.TrimPrefix(base, "wss://")
	}
	sep := "?"
	if strings.Contains(base, "?") {
		sep = "&"
	}
	return base + sep + "room=" + url.QueryEscape(b.room)
}

// ConnectURLWithKey includes the room credential required by Relay v2 clients.
func (b *Bridge) ConnectURLWithKey() string {
	return b.ConnectURL() + "&key=" + url.QueryEscape(b.relayKey)
}

func (b *Bridge) proxyHTTP(ctx context.Context, d requestData) {
	if d.ID == "" || d.Method == "" || !strings.HasPrefix(d.Path, "/") || len(d.BodyB64) > maxBodyBytes*2 {
		b.sendResponse(ctx, responseData{ID: d.ID, Status: 413, Error: "invalid or oversized request"})
		return
	}
	body, err := base64.StdEncoding.DecodeString(d.BodyB64)
	if err != nil || len(body) > maxBodyBytes {
		b.sendResponse(ctx, responseData{ID: d.ID, Status: 413, Error: "invalid or oversized request"})
		return
	}
	req, err := http.NewRequestWithContext(ctx, d.Method, b.localBase+d.Path, bytes.NewReader(body))
	if err != nil {
		b.sendResponse(ctx, responseData{ID: d.ID, Status: 502, Error: "invalid local request"})
		return
	}
	for k, v := range d.Headers {
		if !strings.EqualFold(k, "host") && !strings.EqualFold(k, "connection") &&
			!strings.EqualFold(k, "upgrade") && !strings.EqualFold(k, "content-length") {
			req.Header.Set(k, v)
		}
	}
	resp, err := b.httpClient.Do(req)
	if err != nil {
		b.sendResponse(ctx, responseData{ID: d.ID, Status: 502, Error: "local daemon unavailable"})
		return
	}
	defer resp.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes+1))
	if err != nil || len(responseBody) > maxBodyBytes {
		b.sendResponse(ctx, responseData{ID: d.ID, Status: 502, Error: "local response exceeds limit"})
		return
	}
	headers := map[string]string{}
	for _, name := range []string{"Content-Type", "Cache-Control", "ETag", "Last-Modified"} {
		if value := resp.Header.Get(name); value != "" {
			headers[name] = value
		}
	}
	b.sendResponse(ctx, responseData{
		ID:      d.ID,
		Status:  resp.StatusCode,
		Headers: headers,
		BodyB64: base64.StdEncoding.EncodeToString(responseBody),
	})
}

func (b *Bridge) openStream(ctx context.Context, d streamData) {
	id := d.ID
	if id == "" {
		return
	}
	local := strings.Replace(strings.Replace(b.localBase, "http://", "ws://", 1), "https://", "wss://", 1) + "/api/ws"
	options := &websocket.DialOptions{HTTPHeader: make(http.Header)}
	for name, value := range d.Headers {
		options.HTTPHeader.Set(name, value)
	}
	c, _, err := websocket.Dial(ctx, local, options)
	if err != nil {
		b.sendResponse(ctx, responseData{ID: id, Status: 502, Error: "local websocket unavailable"})
		return
	}
	b.mu.Lock()
	b.streams[id] = c
	b.mu.Unlock()
	for {
		typ, payload, err := c.Read(ctx)
		if err != nil {
			b.closeStream(id)
			return
		}
		if len(payload) > maxFrameBytes {
			b.closeStream(id)
			return
		}
		_ = b.send(ctx, "stream_data", streamData{ID: id, Payload: base64.StdEncoding.EncodeToString(payload), Binary: typ == websocket.MessageBinary})
	}
}

func (b *Bridge) writeStream(d streamData) {
	b.mu.Lock()
	c := b.streams[d.ID]
	b.mu.Unlock()
	if c == nil {
		return
	}
	payload, err := base64.StdEncoding.DecodeString(d.Payload)
	if err != nil || len(payload) > maxFrameBytes {
		return
	}
	typ := websocket.MessageText
	if d.Binary {
		typ = websocket.MessageBinary
	}
	_ = c.Write(context.Background(), typ, payload)
}

func (b *Bridge) closeStream(id string) {
	b.mu.Lock()
	c := b.streams[id]
	delete(b.streams, id)
	b.mu.Unlock()
	if c != nil {
		_ = c.Close(websocket.StatusNormalClosure, "stream closed")
	}
}

func (b *Bridge) closeStreams() {
	b.mu.Lock()
	ids := make([]string, 0, len(b.streams))
	for id := range b.streams {
		ids = append(ids, id)
	}
	b.mu.Unlock()
	for _, id := range ids {
		b.closeStream(id)
	}
}

func (b *Bridge) send(ctx context.Context, kind string, data any) error {
	b.mu.Lock()
	c := b.ws
	b.mu.Unlock()
	if c == nil {
		return errors.New("relay is disconnected")
	}
	b.writeMu.Lock()
	defer b.writeMu.Unlock()
	msg, _ := json.Marshal(envelope{Version: protocolVersion, Kind: kind, Data: mustJSON(data)})
	return c.Write(ctx, websocket.MessageText, msg)
}

func (b *Bridge) sendResponse(ctx context.Context, d responseData) {
	_ = b.send(ctx, "response", d)
}

func mustJSON(v any) json.RawMessage {
	data, _ := json.Marshal(v)
	return data
}
