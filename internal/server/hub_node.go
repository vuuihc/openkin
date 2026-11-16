package server

import (
	"bufio"
	"context"
	"fmt"
	"io"
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
//
// Minting asks the operator to confirm on this machine, with the node's name
// and the token's fingerprint on screen (G7). A browser session cannot mint
// one at all — the endpoint does not exist — so nothing on the web can mint a
// credential and hope nobody reads the terminal it printed to.
func RunHubNodeToken(label, domain string) error {
	return runHubNodeToken(label, domain, os.Stdin)
}

func runHubNodeToken(label, domain string, in io.Reader) error {
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

	fmt.Println()
	fmt.Printf("  About to mint a node token.\n")
	fmt.Printf("    node:  %s (%s)\n", id, label)
	fmt.Printf("    hub:   %s\n", hubOrigin(domain))
	fmt.Printf("    fingerprint: %s\n", tokenFingerprint(token))
	fmt.Println()
	fmt.Printf("  Mint this token? [y/N] ")
	answer := readAnswer(in)
	switch strings.ToLower(strings.TrimSpace(answer)) {
	case "y", "yes":
	default:
		fmt.Println("  Cancelled; nothing was stored.")
		return nil
	}

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
	fmt.Printf("      kin serve --hub %s --token %s\n\n", hubOrigin(domain), token)
	fmt.Println("  The token is shown once and stored hashed. Revoke it from the")
	fmt.Println("  console's device list when that machine should stop working for this Hub.")
	fmt.Println("  The name above is a placeholder: the machine reports its own when it")
	fmt.Println("  first connects.")
	fmt.Println()
	return nil
}

// readAnswer reads one line of confirmation. A closed or empty input is a no:
// a piped or hung terminal must not mint by accident.
func readAnswer(in io.Reader) string {
	if in == nil {
		return ""
	}
	sc := bufio.NewScanner(in)
	if !sc.Scan() {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(sc.Text()))
}

// tokenFingerprint is the short, checkable summary of a token: the first bytes
// of its SHA-256, grouped for reading aloud. It is not the token and reveals
// nothing beyond what a guessed token would have to match, which is why it may
// sit on a screen the token itself should not.
func tokenFingerprint(token string) string {
	sum := remote.HashToken(token)
	groups := make([]string, 0, 4)
	for i := 0; i+4 <= len(sum); i += 4 {
		groups = append(groups, sum[i:i+4])
		if len(groups) == 4 {
			break
		}
	}
	return strings.Join(groups, "-")
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
