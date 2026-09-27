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

	// keepaliveInterval bounds how long the daemon leaves the relay socket
	// silent. Cloudflare closes an idle WebSocket after roughly half a minute;
	// every such close detaches all clients and takes the relay's HTTP proxy
	// offline until the daemon dials in again, which clients show as an endless
	// reconnect banner.
	keepaliveInterval = 20 * time.Second
	// healthyGeneration is how long a generation must stay up to count as
	// established rather than a failed dial.
	healthyGeneration = 30 * time.Second
	minReconnectDelay = 250 * time.Millisecond
	maxReconnectDelay = 15 * time.Second
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
	lastError                           string
	// keepaliveEvery and healthyAfter tune Run for tests; production uses the
	// package defaults set by newBridge.
	keepaliveEvery time.Duration
	healthyAfter   time.Duration
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
		streams:        make(map[string]*websocket.Conn),
		httpClient:     &http.Client{Timeout: 30 * time.Second},
		keepaliveEvery: keepaliveInterval,
		healthyAfter:   healthyGeneration,
	}
}

func newSecret() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("generate relay credential: %w", err)
	}
	return hex.EncodeToString(buf), nil
}

// ValidateURL verifies a user-provided Relay endpoint before it is persisted.
func ValidateURL(raw string) error {
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

func validateRelayURL(raw string) error {
	return ValidateURL(raw)
}

// Connected reports whether the daemon currently has an established Relay
// WebSocket generation.
func (b *Bridge) Connected() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.ws != nil
}

// LastError reports a sanitized reconnect error, if the most recent Relay
// generation failed. It never includes the URL or persistent Relay key.
func (b *Bridge) LastError() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.lastError
}

// Run maintains the daemon connection until ctx is cancelled.
func (b *Bridge) Run(ctx context.Context) error {
	if err := validateRelayURL(b.relayURL); err != nil {
		return err
	}
	delay := minReconnectDelay
	for {
		started := time.Now()
		err := b.runGeneration(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		b.closeStreams()
		// A generation that stayed up is not a failed dial: drop back to the base
		// delay instead of escalating toward the cap, so one relay-side close
		// (an idle timeout, a worker deploy) does not leave clients waiting
		// seconds for the daemon to come back.
		if time.Since(started) >= b.healthyAfter {
			delay = minReconnectDelay
		}
		wait := delay + time.Duration(time.Now().UnixNano()%int64(delay/2+1)) - delay/4
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait):
		}
		if delay < maxReconnectDelay {
			delay *= 2
			if delay > maxReconnectDelay {
				delay = maxReconnectDelay
			}
		}
		if err != nil {
			b.mu.Lock()
			b.lastError = "relay connection failed; retrying"
			b.mu.Unlock()
		}
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
	b.mu.Lock()
	b.lastError = ""
	b.mu.Unlock()
	// The keepalive gets its own context rather than the parent one: it has to
	// stop before this generation returns, or a tick already in flight would
	// write its ping onto the next generation's connection.
	keepaliveCtx, stopKeepalive := context.WithCancel(ctx)
	defer stopKeepalive()
	go b.keepalive(keepaliveCtx, c)
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

// keepalive keeps the daemon↔relay socket from going idle.
//
// Cloudflare closes an idle WebSocket after about half a minute. When that
// happens the relay detaches every client and answers proxied HTTP with 503
// "daemon offline" until the next generation, so an otherwise healthy daemon
// looks permanently offline to clients between reconnects. One frame per
// keepaliveInterval is enough to keep the socket alive; the relay ignores the
// kind, so it forwards nothing to the local daemon and expects no reply.
//
// A failed write means the relay is already gone: closing without a handshake
// unblocks the read loop in runGeneration so the generation ends now rather
// than after the read reports the same failure.
func (b *Bridge) keepalive(ctx context.Context, c *websocket.Conn) {
	ticker := time.NewTicker(b.keepaliveEvery)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := b.send(ctx, "ping", map[string]string{"room": b.room}); err != nil {
				_ = c.CloseNow()
				return
			}
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

// newLocalRequest mirrors a relayed client request onto the local daemon.
//
// The client's Accept-Encoding is deliberately not copied. The daemon gzips API
// responses, and a request that carries Accept-Encoding makes Go's transport
// skip the transparent decompression it would otherwise do, so resp.Body below
// would hold gzip bytes. Those are relayed onward while the response header
// allowlist drops Content-Encoding, leaving the client with gzip labelled as
// JSON. Letting the transport negotiate encoding keeps the relayed body plain.
func newLocalRequest(ctx context.Context, localBase string, d requestData, body []byte) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, d.Method, localBase+d.Path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	for k, v := range d.Headers {
		if isHopHeader(k) {
			continue
		}
		req.Header.Set(k, v)
	}
	return req, nil
}

// isHopHeader reports headers that describe the client/relay connection and
// must not be replayed onto the local daemon request. Accept-Encoding is on the
// list for the reason given on newLocalRequest.
func isHopHeader(name string) bool {
	switch strings.ToLower(name) {
	case "host", "connection", "upgrade", "content-length", "accept-encoding":
		return true
	default:
		return false
	}
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
	req, err := newLocalRequest(ctx, b.localBase, d, body)
	if err != nil {
		b.sendResponse(ctx, responseData{ID: d.ID, Status: 502, Error: "invalid local request"})
		return
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
	// This allowlist omits Content-Encoding, so whatever it forwards must be
	// identity-encoded. That holds because the transport decompresses whatever it
	// negotiated for the request built by newLocalRequest; a local handler that
	// set Content-Encoding itself would reach the client corrupted.
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
