package server

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/vuuihc/openkin/internal/remote"
	"github.com/vuuihc/openkin/internal/store"
)

// RunHubNodeToken implements `kin hub node-token`, which mints a device
// credential for another machine to run `kin node` with.
//
// It runs on the Hub, against the Hub's own database, for the same reason
// `kin hub claim-code` does: the operator already has a shell there, and the
// alternative — printing a token in a browser — would put a long-lived
// credential through a screen, a clipboard, and possibly a screenshot.
//
// domain, when given, is the Hub's public hostname (the same one `kin serve
// --domain` was started with). It only shapes the command printed at the end.
func RunHubNodeToken(label, domain string) error {
	stateDir, err := remote.StateDir()
	if err != nil {
		return err
	}
	st, err := store.Open(filepath.Join(stateDir, "kin.db"))
	if err != nil {
		return err
	}
	defer st.Close()

	label = strings.TrimSpace(label)
	if label == "" {
		label = "node"
	}

	secret, err := remote.NewSecret()
	if err != nil {
		return fmt.Errorf("generate device token: %w", err)
	}
	deviceID, err := remote.NewSecret()
	if err != nil {
		return fmt.Errorf("generate device id: %w", err)
	}
	// Minted the same way the pairing exchange mints one: a token derived from a
	// random secret, stored only as a hash, so nothing in the database can be
	// presented back as a credential.
	token := remote.HashToken(secret)
	id := "node-" + deviceID[:16]

	if err := st.InsertDeviceCredential(context.Background(), store.DeviceCredential{
		ID:        id,
		TokenHash: remote.HashToken(token),
		Label:     label,
		CreatedAt: time.Now().UnixMilli(),
	}); err != nil {
		return fmt.Errorf("store device credential: %w", err)
	}

	fmt.Println()
	fmt.Printf("  Device %s (%s) is ready to run a node.\n\n", id, label)
	fmt.Println("  On that machine, run:")
	fmt.Println()
	fmt.Printf("      kin node --hub %s --token %s\n\n", hubOrigin(domain), token)
	fmt.Println("  The token is shown once and stored hashed. Revoke it from the")
	fmt.Println("  console's device list, or with `kin devices revoke <id>`.")
	fmt.Println()
	return nil
}

// hubOrigin renders how another machine should reach this Hub.
//
// It is only a hint printed for the operator to copy: the Hub does not need to
// know its own public URL to accept a connection, and a wrong guess costs one
// edit to the command line.
func hubOrigin(domain string) string {
	if trimmed := strings.TrimSpace(domain); trimmed != "" {
		return "https://" + strings.TrimPrefix(strings.TrimPrefix(trimmed, "https://"), "http://")
	}
	host, err := os.Hostname()
	if err != nil || strings.TrimSpace(host) == "" {
		return "https://your-hub"
	}
	return fmt.Sprintf("https://%s (or http://%s:7777 on your LAN)", host, host)
}
