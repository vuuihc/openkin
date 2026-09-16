package relay

import (
	"context"
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
