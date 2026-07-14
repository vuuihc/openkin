package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/vuuihc/kin/internal/approvemcp"
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

func usage(code int) {
	fmt.Fprintf(os.Stderr, `kin — self-hosted agent console

Usage:
  kin serve         start the daemon (127.0.0.1:7777)
  kin approve-mcp   stdio MCP server for Claude Code permission prompts
  kin version       print version
  kin help          show this help
`)
	os.Exit(code)
}
