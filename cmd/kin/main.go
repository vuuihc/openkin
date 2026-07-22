package main

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/vuuihc/kin/internal/approvemcp"
	"github.com/vuuihc/kin/internal/notify"
	"github.com/vuuihc/kin/internal/remote"
	"github.com/vuuihc/kin/internal/server"
	"github.com/vuuihc/kin/internal/store"
)

// version is reported by `kin version` and GET /api/version.
// Overridable at link time: -ldflags "-X main.version=…"
var version = "0.0.0-dev"

func main() {
	if err := loadDotEnv(".env"); err != nil && !os.IsNotExist(err) {
		fmt.Fprintf(os.Stderr, "kin: load .env: %v\n", err)
		os.Exit(1)
	}
	if len(os.Args) < 2 {
		usage(2)
	}
	switch os.Args[1] {
	case "serve":
		if err := server.Serve(version); err != nil {
			fmt.Fprintf(os.Stderr, "kin serve: %v\n", err)
			os.Exit(1)
		}
	case "token":
		if err := runToken(os.Args[2:]); err != nil {
			fmt.Fprintf(os.Stderr, "kin token: %v\n", err)
			os.Exit(1)
		}
	case "approve-mcp":
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		if err := approvemcp.Run(ctx); err != nil {
			fmt.Fprintf(os.Stderr, "kin approve-mcp: %v\n", err)
			os.Exit(1)
		}
	case "notify":
		if err := runNotify(os.Args[2:]); err != nil {
			fmt.Fprintf(os.Stderr, "kin notify: %v\n", err)
			os.Exit(1)
		}
	case "version":
		fmt.Println(version)
	case "help", "-h", "--help":
		usage(0)
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n", os.Args[1])
		usage(2)
	}
}

// loadDotEnv loads simple KEY=VALUE entries without overriding the process
// environment. This keeps deployment-provided secrets authoritative while
// supporting an ignored .env file for local development.
func loadDotEnv(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimSpace(strings.TrimPrefix(line, "export "))
		key, value, ok := strings.Cut(line, "=")
		key = strings.TrimSpace(key)
		if !ok || key == "" {
			return fmt.Errorf("invalid line %q", scanner.Text())
		}
		value = strings.TrimSpace(value)
		if len(value) >= 2 && ((value[0] == '\'' && value[len(value)-1] == '\'') ||
			(value[0] == '"' && value[len(value)-1] == '"')) {
			value = value[1 : len(value)-1]
		}
		if _, exists := os.LookupEnv(key); !exists {
			if err := os.Setenv(key, value); err != nil {
				return fmt.Errorf("set %s: %w", key, err)
			}
		}
	}
	return scanner.Err()
}

func runToken(args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: kin token rotate")
	}
	switch args[0] {
	case "rotate":
		home, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		stateDir := filepath.Join(home, ".kin")
		tok, err := remote.RotateToken(stateDir)
		if err != nil {
			return err
		}
		fmt.Printf("token rotated: %s\n", remote.TokenFile(stateDir))
		fmt.Printf("new token: %s\n", tok)
		fmt.Println("A running daemon re-reads the token file per request; old token is invalid immediately.")
		return nil
	default:
		return fmt.Errorf("unknown token subcommand %q (want: rotate)", args[0])
	}
}

// runNotify handles `kin notify test`: send a test push using settings in ~/.kin/kin.db
// without requiring the daemon.
func runNotify(args []string) error {
	if len(args) < 1 || args[0] != "test" {
		return fmt.Errorf("usage: kin notify test")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	dbPath := filepath.Join(home, ".kin", "kin.db")
	st, err := store.Open(dbPath)
	if err != nil {
		return fmt.Errorf("open %s: %w", dbPath, err)
	}
	defer st.Close()

	sender := &notify.Sender{Store: st}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	payload := notify.Payload{
		Title: "Kin test",
		Body:  "Notification test from kin",
		URL:   sender.DeepLink(ctx, "/settings"),
	}
	results := sender.Deliver(ctx, payload)
	if len(results) == 0 {
		fmt.Println("no notification channels configured (set notify.bark_url and/or notify.ntfy_topic)")
		return fmt.Errorf("no channels configured")
	}

	anyOK := false
	for _, r := range results {
		if r.OK {
			anyOK = true
			fmt.Printf("%s: ok\n", r.Channel)
			continue
		}
		fmt.Printf("%s: failed: %s\n", r.Channel, r.Error)
	}
	if !anyOK {
		return fmt.Errorf("all channels failed")
	}
	return nil
}

func usage(code int) {
	fmt.Fprintf(os.Stderr, `kin — self-hosted agent console

Usage:
  kin serve [flags]   start the daemon
  kin token rotate    regenerate ~/.kin/token
  kin notify test     send a test notification via configured Bark/ntfy
  kin approve-mcp     stdio MCP server for Claude Code permission prompts
  kin version         print version
  kin help            show this help

Serve flags:
  --port N              listen port (default 7777)
  --lan                 bind 0.0.0.0; print LAN QR
  --tailscale           serve via tsnet node "kin"
  --funnel              public HTTPS via Funnel (requires --tailscale)
  --ts-control-url URL  Headscale/custom control server for tsnet
`)
	os.Exit(code)
}
