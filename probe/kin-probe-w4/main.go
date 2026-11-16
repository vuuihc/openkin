package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

func main() {
	base := flag.String("base", "http://127.0.0.1:7777", "daemon base URL")
	tokenFile := flag.String("token-file", "", "master token file (default ~/.kin/token)")
	label := flag.String("label", "probe-w4", "session and pairing label prefix")
	cwd := flag.String("cwd", "", "working directory for the probe session (default a temp dir)")
	agent := flag.String("agent", "", "agent id (default: the daemon's default installed agent)")
	keep := flag.Bool("keep", false, "keep the probe session and paired device")
	turnTimeout := flag.Duration("turn-timeout", 8*time.Minute, "how long to wait for one agent turn")
	timeout := flag.Duration("timeout", 20*time.Minute, "overall run budget")
	out := flag.String("out", "", "optional path for the JSON summary")
	flag.Parse()

	token, err := readToken(*tokenFile)
	if err != nil {
		fmt.Fprintln(os.Stderr, "token:", err)
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, *timeout)
	defer cancel()

	log := NewLogger(os.Stderr)
	summary := Run(ctx, Config{
		BaseURL:     *base,
		MasterToken: token,
		Label:       *label,
		Cwd:         *cwd,
		Agent:       *agent,
		Keep:        *keep,
		TurnTimeout: *turnTimeout,
	}, log)

	encoded, err := json.MarshalIndent(summary, "", "  ")
	if err != nil {
		fmt.Fprintln(os.Stderr, "encode summary:", err)
		os.Exit(2)
	}
	if *out != "" {
		if err := os.WriteFile(*out, append(encoded, '\n'), 0o600); err != nil {
			fmt.Fprintln(os.Stderr, "write summary:", err)
		}
	}
	fmt.Println(string(encoded))

	for _, step := range summary.Steps {
		if step.Status == "fail" {
			os.Exit(2)
		}
	}
}

func readToken(path string) (string, error) {
	if path == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		path = filepath.Join(home, ".kin", "token")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	token := strings.TrimSpace(string(raw))
	if token == "" {
		return "", fmt.Errorf("%s is empty", path)
	}
	return token, nil
}
