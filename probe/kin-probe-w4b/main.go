package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func main() {
	var (
		baseURL      = flag.String("base-url", "http://127.0.0.1:7777", "daemon base URL")
		agent        = flag.String("agent", "", "agent id for the probe session (empty: daemon default)")
		tokenFile    = flag.String("master-token-file", "", "file holding the master token (default ~/.kin/token)")
		approvalWait = flag.Duration("approval-wait", 90*time.Second, "how long to wait for a pending approval")
		timeout      = flag.Duration("timeout", 10*time.Minute, "overall run timeout")
		output       = flag.String("output", "", "write the JSON outcome here (never inside the repository by default)")
		keep         = flag.Bool("keep", false, "leave the probe session and device in place")
		verbose      = flag.Bool("verbose", false, "log progress to stderr")
	)
	flag.Parse()

	path := *tokenFile
	if path == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			fatalf("locate home directory: %v", err)
		}
		path = filepath.Join(home, ".kin", "token")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		fatalf("read master token file %s: %v", path, err)
	}
	token := strings.TrimSpace(string(raw))
	if token == "" {
		fatalf("master token file %s is empty", path)
	}

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()

	logf := func(string, ...any) {}
	if *verbose {
		logf = func(format string, args ...any) {
			fmt.Fprintf(os.Stderr, format+"\n", args...)
		}
	}
	outcome := RunAcceptance(ctx, Config{
		BaseURL:      *baseURL,
		MasterToken:  token,
		Agent:        *agent,
		ApprovalWait: *approvalWait,
		Keep:         *keep,
		Logf:         logf,
	})

	if *output != "" {
		data, err := json.MarshalIndent(outcome, "", "  ")
		if err != nil {
			fatalf("encode outcome: %v", err)
		}
		if err := os.WriteFile(*output, append(data, '\n'), 0o600); err != nil {
			fatalf("write outcome: %v", err)
		}
	}

	for _, step := range outcome.Steps {
		fmt.Printf("%-14s %-4s %s\n", step.Name, step.Status, step.Detail)
	}
	fmt.Printf("elapsed first-prompt→final: %d ms; total: %d ms; peak RSS: %d bytes\n",
		outcome.Metrics.FirstPromptToFinalMS, outcome.Metrics.TotalMS, outcome.Metrics.PeakRSSBytes)
	if outcome.Failed() {
		os.Exit(1)
	}
}

func fatalf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(2)
}
