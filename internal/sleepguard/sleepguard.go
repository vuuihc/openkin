// Package sleepguard keeps the host awake while Kin has active work.
package sleepguard

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"runtime"
	"sync"
)

type Process interface {
	Kill() error
}

type Starter func(context.Context) (Process, error)

type Guard struct {
	mu      sync.Mutex
	start   Starter
	process Process
	active  bool
}

func New() *Guard {
	return &Guard{start: defaultStarter}
}

// NewWithStarter is used by tests and embedders that provide an OS-specific
// sleep inhibitor.
func NewWithStarter(start Starter) *Guard {
	if start == nil {
		start = defaultStarter
	}
	return &Guard{start: start}
}

func (g *Guard) SetActive(ctx context.Context, active bool) error {
	if g == nil {
		return nil
	}
	g.mu.Lock()
	if g.active == active {
		g.mu.Unlock()
		return nil
	}
	if active {
		if g.process != nil {
			g.active = true
			g.mu.Unlock()
			return nil
		}
		process, err := g.start(ctx)
		if err == nil {
			g.process = process
			g.active = true
		}
		g.mu.Unlock()
		return err
	}
	g.active = false
	process := g.process
	g.process = nil
	g.mu.Unlock()
	if process != nil {
		return process.Kill()
	}
	return nil
}

func (g *Guard) Close() error {
	return g.SetActive(context.Background(), false)
}

func defaultStarter(ctx context.Context) (Process, error) {
	if runtime.GOOS != "darwin" {
		return noopProcess{}, nil
	}
	// caffeinate is part of macOS. Without -w, the inhibitor remains alive
	// until Kin explicitly releases it, including across task waits.
	cmd := exec.CommandContext(ctx, "caffeinate", "-dimsu")
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return commandProcess{cmd: cmd}, nil
}

type commandProcess struct{ cmd *exec.Cmd }

func (p commandProcess) Kill() error {
	if p.cmd == nil || p.cmd.Process == nil {
		return nil
	}
	err := p.cmd.Process.Kill()
	// Wait reaps the caffeinate child. The exit error is expected after Kill;
	// only return an actual failure to send the signal.
	_ = p.cmd.Wait()
	if err != nil && !errors.Is(err, os.ErrProcessDone) {
		return err
	}
	return nil
}

type noopProcess struct{}

func (noopProcess) Kill() error { return nil }
