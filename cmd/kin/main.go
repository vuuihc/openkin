package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/vuuihc/kin/internal/approvemcp"
	"github.com/vuuihc/kin/internal/remote"
	"github.com/vuuihc/kin/internal/server"
)

// version is reported by `kin version` and GET /api/version.
// Overridable at link time: -ldflags "-X main.version=…"
var version = "0.0.0-dev"

func main() {
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
	case "version":
		fmt.Println(version)
	case "help", "-h", "--help":
		usage(0)
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n", os.Args[1])
		usage(2)
	}
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

func usage(code int) {
	fmt.Fprintf(os.Stderr, `kin — self-hosted agent console

Usage:
  kin serve [flags]   start the daemon
  kin token rotate    regenerate ~/.kin/token
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
