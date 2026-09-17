package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"time"
)

const maxSuperviseRestarts = 3

// runSupervise keeps the daemon alive independently of Electron. The
// supervisor is intentionally a small process wrapper: task/workspace state
// remains durable in the daemon's store, while a crashed child gets a bounded
// restart opportunity without becoming an unbounded fork loop.
func runSupervise(ctx context.Context, serveArgs []string) error {
	for attempt := 0; attempt <= maxSuperviseRestarts; attempt++ {
		args := append([]string{"serve"}, serveArgs...)
		cmd := exec.Command(os.Args[0], args...)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		if err := cmd.Start(); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			if attempt == maxSuperviseRestarts {
				return fmt.Errorf("start daemon: %w", err)
			}
		} else {
			done := make(chan error, 1)
			go func() { done <- cmd.Wait() }()
			select {
			case <-ctx.Done():
				_ = cmd.Process.Signal(syscall.SIGTERM)
				<-done
				return nil
			case err := <-done:
				if ctx.Err() != nil {
					return nil
				}
				if attempt == maxSuperviseRestarts {
					return fmt.Errorf("daemon exited after %d restarts: %w", attempt, err)
				}
			}
		}
		if attempt < maxSuperviseRestarts {
			delay := time.Duration(1<<attempt) * time.Second
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(delay):
			}
		}
	}
	return nil
}
