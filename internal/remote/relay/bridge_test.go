package relay

import (
	"compress/gzip"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestNewBridge(t *testing.T) {
	b := NewBridge("wss://relay.example.com", "room", "http://127.0.0.1:7777")
	if b.room != "room" || b.localBase != "http://127.0.0.1:7777" || b.relayKey == "" {
		t.Fatalf("unexpected bridge: %+v", b)
	}
}

func TestPersistentBridgeCredentials(t *testing.T) {
	dir := t.TempDir()
	first, err := NewPersistentBridge("wss://relay.example.com", dir, "http://127.0.0.1:7777")
	if err != nil {
		t.Fatal(err)
	}
	second, err := NewPersistentBridge("wss://relay.example.com", dir, "http://127.0.0.1:7777")
	if err != nil {
		t.Fatal(err)
	}
	if first.room != second.room || first.relayKey != second.relayKey {
		t.Fatal("relay credentials did not persist")
	}
	info, err := os.Stat(filepath.Join(dir, "relay", "credentials.json"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("credentials mode = %o, want 600", info.Mode().Perm())
	}
}

func TestConnectURLs(t *testing.T) {
	b := NewBridge("wss://relay.example.com/path", "room-1", "http://127.0.0.1:7777")
	if got := b.ConnectURL(); got != "https://relay.example.com/path?room=room-1" {
		t.Fatalf("ConnectURL = %q", got)
	}
	if !strings.Contains(b.ConnectURLWithKey(), "key=") {
		t.Fatal("ConnectURLWithKey omitted relay key")
	}
	ws, err := url.Parse(b.wsURL())
	if err != nil {
		t.Fatal(err)
	}
	if ws.Query().Get("key") != b.relayKey || ws.Query().Get("role") != "daemon" {
		t.Fatalf("daemon WebSocket URL omitted credentials: %s", ws)
	}
}

func TestMalformedRelayURLRejected(t *testing.T) {
	b := NewBridge("ftp://relay.example.com", "room", "http://127.0.0.1:7777")
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if err := b.Run(ctx); err == nil {
		t.Fatal("Run accepted malformed relay URL")
	}
}

// The relay hands response bodies to the client as-is, so a compressed body that
// is not labelled as compressed arrives as unparseable bytes. A real client
// (URLSession, browsers) sends Accept-Encoding, which is only safe if the local
// read is decompressed first.
func TestRelayedRequestReadsDecompressedBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			_, _ = w.Write([]byte(`{"ok":true}`))
			return
		}
		w.Header().Set("Content-Encoding", "gzip")
		gz := gzip.NewWriter(w)
		_, _ = gz.Write([]byte(`{"ok":true}`))
		if err := gz.Close(); err != nil {
			t.Errorf("gzip close: %v", err)
		}
	}))
	defer srv.Close()

	req, err := newLocalRequest(context.Background(), srv.URL, requestData{
		Method:  http.MethodGet,
		Path:    "/api/pairing/exchange",
		Headers: map[string]string{"Accept-Encoding": "gzip, deflate, br"},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != `{"ok":true}` {
		t.Fatalf("relayed body = %q, want plain JSON", body)
	}
	if got := resp.Header.Get("Content-Encoding"); got != "" {
		t.Fatalf("Content-Encoding = %q, want it consumed by the transport", got)
	}
}

func TestNewLocalRequestKeepsAuthAndDropsHopHeaders(t *testing.T) {
	// Header names arrive lowercased: the relay worker iterates Fetch Headers.
	req, err := newLocalRequest(context.Background(), "http://127.0.0.1:7777", requestData{
		Method: http.MethodPost,
		Path:   "/api/tasks",
		Headers: map[string]string{
			"authorization":   "Bearer device-token",
			"content-type":    "application/json",
			"accept-encoding": "gzip",
			"connection":      "keep-alive",
			"content-length":  "2",
		},
	}, []byte("{}"))
	if err != nil {
		t.Fatal(err)
	}
	if got := req.Header.Get("Authorization"); got != "Bearer device-token" {
		t.Fatalf("Authorization = %q", got)
	}
	if got := req.Header.Get("Content-Type"); got != "application/json" {
		t.Fatalf("Content-Type = %q", got)
	}
	for _, name := range []string{"Accept-Encoding", "Connection", "Content-Length"} {
		if got := req.Header.Get(name); got != "" {
			t.Fatalf("%s = %q, want it dropped", name, got)
		}
	}
}
