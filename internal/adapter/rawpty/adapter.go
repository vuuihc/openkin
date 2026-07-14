// Package rawpty implements the raw PTY adapter (spec §4.4).
// The task prompt is the shell command line, run via /bin/sh -c.
package rawpty

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"

	"github.com/vuuihc/kin/internal/adapter"
)

// CoalesceInterval is the minimum interval between raw_output flushes (spec §4.4).
const CoalesceInterval = 100 * time.Millisecond

// Adapter runs arbitrary shell commands under a PTY.
type Adapter struct {
	// Shell is the shell binary (default /bin/sh).
	Shell string
	// Coalesce overrides CoalesceInterval (tests).
	Coalesce time.Duration
}

// New returns a rawpty adapter.
func New() *Adapter {
	return &Adapter{Shell: "/bin/sh"}
}

// Start implements adapter.Adapter.
// Prompt is the command line; executed as: shell -c "<prompt>" in spec.Cwd.
func (a *Adapter) Start(ctx context.Context, spec adapter.TaskSpec) (adapter.RunHandle, error) {
	shell := a.Shell
	if shell == "" {
		shell = "/bin/sh"
	}
	coalesce := a.Coalesce
	if coalesce <= 0 {
		coalesce = CoalesceInterval
	}

	cmd := exec.CommandContext(ctx, shell, "-c", spec.Prompt)
	cmd.Dir = spec.Cwd
	cmd.Env = os.Environ()
	// Do NOT set Setpgid here: creack/pty sets Setsid (new session = new process
	// group with pgid == pid). Combining Setpgid+Setsid fails on macOS with
	// "operation not permitted". Cancel still signals -pid (session leader).

	ptmx, err := pty.Start(cmd)
	if err != nil {
		return nil, fmt.Errorf("start pty: %w", err)
	}

	ch := make(chan adapter.Event, 64)
	h := &handle{
		cmd:  cmd,
		ptmx: ptmx,
		ch:   ch,
		done: make(chan struct{}),
	}

	go h.run(coalesce)
	return h, nil
}

type handle struct {
	cmd        *exec.Cmd
	ptmx       *os.File
	ch         chan adapter.Event
	done       chan struct{}
	cancelOnce sync.Once
	mu         sync.Mutex
	waitErr    error
	exitCode   *int
	canceled   bool
	ptmxClosed bool
}

func (h *handle) Events() <-chan adapter.Event { return h.ch }

func (h *handle) run(coalesce time.Duration) {
	defer close(h.ch)
	defer close(h.done)
	defer h.closePTY()

	var bufMu sync.Mutex
	var buf []byte
	readDone := make(chan struct{})

	go func() {
		defer close(readDone)
		tmp := make([]byte, 4096)
		for {
			n, err := h.ptmx.Read(tmp)
			if n > 0 {
				bufMu.Lock()
				buf = append(buf, tmp[:n]...)
				bufMu.Unlock()
			}
			if err != nil {
				return
			}
		}
	}()

	ticker := time.NewTicker(coalesce)
	defer ticker.Stop()

	flush := func() {
		bufMu.Lock()
		if len(buf) == 0 {
			bufMu.Unlock()
			return
		}
		chunk := string(buf)
		buf = nil
		bufMu.Unlock()
		h.ch <- adapter.Event{
			Type:    "raw_output",
			Payload: mustMarshal(map[string]string{"chunk": chunk}),
		}
	}

	// Coalesce until the reader finishes (EOF or PTY closed).
	for {
		select {
		case <-readDone:
			flush()
			goto waited
		case <-ticker.C:
			flush()
		}
	}

waited:
	waitErr := h.cmd.Wait()
	// Reader may race slightly after Wait; ensure closed and final flush.
	select {
	case <-readDone:
	case <-time.After(200 * time.Millisecond):
	}
	flush()

	code := 0
	if h.cmd.ProcessState != nil {
		code = h.cmd.ProcessState.ExitCode()
	} else if waitErr != nil {
		code = 1
	}

	h.mu.Lock()
	h.waitErr = waitErr
	h.exitCode = &code
	canceled := h.canceled
	h.mu.Unlock()

	if canceled {
		return
	}
	h.ch <- adapter.Event{
		Type: "result",
		Payload: mustMarshal(map[string]any{
			"exit_code": code,
			"is_error":  code != 0,
			"subtype":   "rawpty",
		}),
	}
}

func (h *handle) closePTY() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.ptmx != nil && !h.ptmxClosed {
		_ = h.ptmx.Close()
		h.ptmxClosed = true
	}
}

// Cancel sends SIGTERM to the process group, then SIGKILL after 5s (spec §4.4).
func (h *handle) Cancel() error {
	h.cancelOnce.Do(func() {
		h.mu.Lock()
		h.canceled = true
		h.mu.Unlock()

		if h.cmd.Process != nil {
			pgid := h.cmd.Process.Pid
			_ = syscall.Kill(-pgid, syscall.SIGTERM)
			go func() {
				select {
				case <-time.After(5 * time.Second):
					_ = syscall.Kill(-pgid, syscall.SIGKILL)
				case <-h.done:
				}
			}()
		}
		// Unblock PTY reads.
		h.closePTY()
	})
	return nil
}

// ExitCode returns the process exit code after Events has closed.
func (h *handle) ExitCode() *int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.exitCode
}

func mustMarshal(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return b
}
