// Package relay provides a WebSocket relay bridge that connects outbound to a
// Cloudflare Worker and proxies HTTP requests to a local Kin daemon (spec §7).
package relay

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"nhooyr.io/websocket"
)

// Bridge connects to a Cloudflare Worker relay and proxies HTTP requests
// to a local Kin daemon running on loopback.
type Bridge struct {
	relayURL  string
	room      string
	localBase string

	ws         *websocket.Conn
	mu         sync.Mutex
	pending    map[string]chan<- relayResponse
	httpClient *http.Client
}

type relayResponse struct {
	Status int
	Body   string
}

type relayMessage struct {
	Type    string            `json:"type"`
	ReqID   string            `json:"reqId,omitempty"`
	Method  string            `json:"method,omitempty"`
	Path    string            `json:"path,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    string            `json:"body,omitempty"`
	Status  int               `json:"status,omitempty"`
}

// NewBridge creates a relay bridge.
//   - relayURL: wss://relay.example.com
//   - room: room identifier for pairing (e.g. hostname)
//   - localBase: http://127.0.0.1:7777 (the local daemon)
func NewBridge(relayURL, room, localBase string) *Bridge {
	return &Bridge{
		relayURL:  relayURL,
		room:      room,
		localBase: localBase,
		pending:   make(map[string]chan<- relayResponse),
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// Run connects to the relay and starts proxying. Blocks until ctx is cancelled
// or the connection is permanently lost.
func (b *Bridge) Run(ctx context.Context) error {
	dialURL := b.relayURL
	if strings.Contains(dialURL, "?") {
		dialURL += "&"
	} else {
		dialURL += "?"
	}
	dialURL += "room=" + url.QueryEscape(b.room) + "&role=daemon"

	c, _, err := websocket.Dial(ctx, dialURL, nil)
	if err != nil {
		return fmt.Errorf("relay dial: %w", err)
	}
	b.ws = c
	defer c.Close(websocket.StatusNormalClosure, "done") //nolint:errcheck

	// Read loop — dispatches requests and responses.
	for {
		_, msg, err := c.Read(ctx)
		if err != nil {
			return fmt.Errorf("relay read: %w", err)
		}

		var m relayMessage
		if err := json.Unmarshal(msg, &m); err != nil {
			continue
		}

		switch m.Type {
		case "request":
			go b.handleRelayRequest(ctx, m)
		case "response":
			b.mu.Lock()
			ch, ok := b.pending[m.ReqID]
			delete(b.pending, m.ReqID)
			b.mu.Unlock()
			if ok {
				ch <- relayResponse{Status: m.Status, Body: m.Body}
			}
		}
	}
}

// ConnectURL returns the URL an iOS/remote client should use to reach the
// daemon through this relay.
func (b *Bridge) ConnectURL() string {
	base := b.relayURL
	// Normalise http→https for non-WSS relay URLs (user may have typed http).
	if strings.HasPrefix(base, "http://") {
		base = "https://" + base[len("http://"):]
	}
	if strings.Contains(base, "?") {
		return base + "&room=" + url.QueryEscape(b.room)
	}
	return base + "?room=" + url.QueryEscape(b.room)
}

func (b *Bridge) handleRelayRequest(ctx context.Context, m relayMessage) {
	targetURL := b.localBase + m.Path
	req, err := http.NewRequestWithContext(ctx, m.Method, targetURL, stringToBody(m.Body))
	if err != nil {
		return
	}
	for k, v := range m.Headers {
		// Skip hop-by-hop headers.
		if k == "Host" || k == "Content-Length" || k == "Connection" || k == "Upgrade" {
			continue
		}
		req.Header.Set(k, v)
	}

	resp, err := b.httpClient.Do(req)
	if err != nil {
		b.sendError(m.ReqID, "proxy error: "+err.Error())
		return
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	b.sendResponse(m.ReqID, resp.StatusCode, string(body))
}

func (b *Bridge) sendResponse(reqID string, status int, body string) {
	msg, _ := json.Marshal(relayMessage{
		Type:   "response",
		ReqID:  reqID,
		Status: status,
		Body:   body,
	})
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.ws != nil {
		// Use background context for write — we're already in a goroutine
		// handling a request and the read-loop context may have been cancelled.
		_ = b.ws.Write(context.Background(), websocket.MessageText, msg)
	}
}

func (b *Bridge) sendError(reqID, errMsg string) {
	body := `{"error":"` + errMsg + `"}`
	b.sendResponse(reqID, 502, body)
}

func stringToBody(s string) io.Reader {
	if s == "" {
		return http.NoBody
	}
	return strings.NewReader(s)
}