package relay

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"nhooyr.io/websocket"
)

// TestNewBridge verifies basic construction.
func TestNewBridge(t *testing.T) {
	b := NewBridge("wss://relay.example.com", "my-mac", "http://127.0.0.1:7777")
	if b == nil {
		t.Fatal("NewBridge returned nil")
	}
	if b.relayURL != "wss://relay.example.com" {
		t.Errorf("relayURL = %q, want %q", b.relayURL, "wss://relay.example.com")
	}
	if b.room != "my-mac" {
		t.Errorf("room = %q, want %q", b.room, "my-mac")
	}
	if b.localBase != "http://127.0.0.1:7777" {
		t.Errorf("localBase = %q, want %q", b.localBase, "http://127.0.0.1:7777")
	}
	if b.httpClient == nil {
		t.Error("httpClient is nil")
	}
	if b.pending == nil {
		t.Error("pending map is nil")
	}
}

// TestConnectURL verifies ConnectURL() output.
func TestConnectURL(t *testing.T) {
	tests := []struct {
		relayURL string
		room     string
		want     string
	}{
		{"wss://relay.example.com", "my-mac", "wss://relay.example.com?room=my-mac"},
		{"wss://relay.example.com/path", "room-1", "wss://relay.example.com/path?room=room-1"},
		{"http://relay.example.com", "host", "https://relay.example.com?room=host"},
		{"wss://relay.example.com?token=abc", "my-mac", "wss://relay.example.com?token=abc&room=my-mac"},
	}

	for _, tt := range tests {
		b := NewBridge(tt.relayURL, tt.room, "http://127.0.0.1:7777")
		got := b.ConnectURL()
		if got != tt.want {
			t.Errorf("ConnectURL(%q, %q) = %q, want %q", tt.relayURL, tt.room, got, tt.want)
		}
	}
}

// TestStringToBody verifies the body helper.
func TestStringToBody(t *testing.T) {
	r := stringToBody("")
	if r != http.NoBody {
		t.Error("stringToBody('') should return http.NoBody")
	}

	r = stringToBody("hello")
	buf := make([]byte, 5)
	n, err := r.Read(buf)
	if err != nil {
		t.Fatalf("read error: %v", err)
	}
	if string(buf[:n]) != "hello" {
		t.Errorf("got %q, want %q", string(buf[:n]), "hello")
	}
}

// TestSendResponse verifies sendResponse writes the correct JSON over WebSocket.
func TestSendResponse(t *testing.T) {
	gotCh := make(chan relayMessage, 1)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close(websocket.StatusNormalClosure, "done") //nolint:errcheck

		_, msg, err := c.Read(context.Background())
		if err != nil {
			return
		}

		var m relayMessage
		if err := json.Unmarshal(msg, &m); err == nil {
			gotCh <- m
		}
	}))
	defer srv.Close()

	wsURL := "ws://" + strings.TrimPrefix(srv.URL, "http://")
	b := NewBridge(wsURL, "test", "http://127.0.0.1:7777")

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	dialURL := wsURL + "?room=test&role=daemon"
	c, _, err := websocket.Dial(ctx, dialURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	b.ws = c
	defer c.Close(websocket.StatusNormalClosure, "done") //nolint:errcheck

	b.sendResponse("req-1", 200, `{"ok":true}`)

	select {
	case m := <-gotCh:
		if m.Type != "response" {
			t.Errorf("type = %q, want %q", m.Type, "response")
		}
		if m.ReqID != "req-1" {
			t.Errorf("reqId = %q, want %q", m.ReqID, "req-1")
		}
		if m.Status != 200 {
			t.Errorf("status = %d, want 200", m.Status)
		}
		if m.Body != `{"ok":true}` {
			t.Errorf("body = %q, want %q", m.Body, `{"ok":true}`)
		}
	case <-ctx.Done():
		t.Fatal("timeout waiting for WebSocket message")
	}
}

// TestSendError verifies error messages are properly formatted over WebSocket.
func TestSendError(t *testing.T) {
	gotCh := make(chan relayMessage, 1)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close(websocket.StatusNormalClosure, "done") //nolint:errcheck

		_, msg, err := c.Read(context.Background())
		if err != nil {
			return
		}

		var m relayMessage
		if err := json.Unmarshal(msg, &m); err == nil {
			gotCh <- m
		}
	}))
	defer srv.Close()

	wsURL := "ws://" + strings.TrimPrefix(srv.URL, "http://")
	b := NewBridge(wsURL, "test", "http://127.0.0.1:7777")

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	dialURL := wsURL + "?room=test&role=daemon"
	c, _, err := websocket.Dial(ctx, dialURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	b.ws = c
	defer c.Close(websocket.StatusNormalClosure, "done") //nolint:errcheck

	b.sendError("req-err", "something broke")

	select {
	case m := <-gotCh:
		if m.Type != "response" {
			t.Errorf("type = %q, want %q", m.Type, "response")
		}
		if m.ReqID != "req-err" {
			t.Errorf("reqId = %q, want %q", m.ReqID, "req-err")
		}
		if m.Status != 502 {
			t.Errorf("status = %d, want 502", m.Status)
		}
		if !strings.Contains(m.Body, "something broke") {
			t.Errorf("body = %q, should contain error message", m.Body)
		}
	case <-ctx.Done():
		t.Fatal("timeout waiting for WebSocket message")
	}
}

// TestPendingMapOperations verifies pending map add/delete lifecycle.
func TestPendingMapOperations(t *testing.T) {
	b := NewBridge("wss://relay.example.com", "test", "http://127.0.0.1:7777")

	respCh := make(chan relayResponse, 1)
	b.mu.Lock()
	b.pending["test-id"] = respCh
	b.mu.Unlock()

	// Verify it's in the map.
	b.mu.Lock()
	_, ok := b.pending["test-id"]
	b.mu.Unlock()
	if !ok {
		t.Fatal("pending entry not found after insert")
	}

	// Verify delete.
	b.mu.Lock()
	delete(b.pending, "test-id")
	b.mu.Unlock()

	b.mu.Lock()
	_, ok = b.pending["test-id"]
	b.mu.Unlock()
	if ok {
		t.Fatal("pending entry still exists after delete")
	}
}

// TestDialError verifies a connection failure returns an error.
func TestDialError(t *testing.T) {
	b := NewBridge("wss://127.0.0.1:1", "test", "http://127.0.0.1:7777")

	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	err := b.Run(ctx)
	if err == nil {
		t.Fatal("expected dial error, got nil")
	}
}
