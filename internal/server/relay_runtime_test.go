package server

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/vuuihc/openkin/internal/store"
)

func TestRelayRuntimeConfigureAndRefreshPairing(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runtime := newRelayRuntime(ctx, t.TempDir(), "http://127.0.0.1:7777", st, func() string {
		return "master-token"
	}, desktopIdentity{ID: "desktop_1234abcd", Name: "Work Mac"})

	if _, err := runtime.Configure(context.Background(), "ftp://relay.example"); err == nil {
		t.Fatal("invalid relay URL was accepted")
	}

	status, err := runtime.Configure(context.Background(), "wss://relay.example")
	if err != nil {
		t.Fatal(err)
	}
	if status.State != "connecting" || status.URL != "wss://relay.example" {
		t.Fatalf("unexpected status: %+v", status)
	}
	if status.ConnectURL == "" || status.PairingURL == "" {
		t.Fatalf("pairing projection incomplete: %+v", status)
	}
	if !strings.Contains(status.PairingURL, "desktop_id=desktop_1234abcd") ||
		!strings.Contains(status.PairingURL, "desktop_name=Work+Mac") {
		t.Fatalf("pairing URL missing desktop identity: %s", status.PairingURL)
	}

	refreshed, err := runtime.RefreshPairing(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if refreshed.PairingURL == status.PairingURL {
		t.Fatal("refresh did not issue a new pairing URL")
	}

	runtime.Stop()
	if got := runtime.Snapshot(); got.State != "disabled" {
		t.Fatalf("state after stop = %+v", got)
	}
}
