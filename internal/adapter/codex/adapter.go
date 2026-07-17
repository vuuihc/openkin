package codex

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"github.com/vuuihc/kin/internal/adapter"
)

// Adapter launches Codex CLI processes (`codex exec --json`).
type Adapter struct {
	// Binary is the path or name of the codex executable. Defaults to "codex".
	// Override via KIN_CODEX_BIN at serve time, or inject in tests.
	Binary string
	// LookPath, if set, is used instead of exec.LookPath (tests).
	LookPath func(file string) (string, error)
}

// New returns a Codex adapter using the "codex" binary on PATH.
func New() *Adapter {
	return &Adapter{Binary: "codex"}
}

// Start implements adapter.Adapter.
//
// New task:
//
//	codex exec --json "<prompt>" [--model <model>]
//
// Follow-up (session_ref required):
//
//	codex exec resume <session_ref> --json "<prompt>"
func (a *Adapter) Start(ctx context.Context, spec adapter.TaskSpec) (adapter.RunHandle, error) {
	bin := a.Binary
	if bin == "" {
		bin = "codex"
	}
	look := a.LookPath
	if look == nil {
		look = exec.LookPath
	}
	path, err := look(bin)
	if err != nil {
		return nil, fmt.Errorf("codex binary not found on PATH (%q): install Codex CLI or set KIN_CODEX_BIN", bin)
	}

	var args []string
	if spec.SessionRef != "" {
		// Resume an existing thread/session.
		args = []string{"exec", "resume", spec.SessionRef, "--json", spec.Prompt}
	} else {
		args = []string{"exec", "--json", spec.Prompt}
		if spec.Model != "" {
			args = append(args, "--model", spec.Model)
		}
	}
	// Session permission mode (applies to new + resume).
	switch adapter.NormalizePermissionMode(spec.PermissionMode) {
	case adapter.PermissionYOLO:
		args = append(args, "--dangerously-bypass-approvals-and-sandbox")
	case adapter.PermissionAcceptEdits:
		// Auto-write inside workspace; still sandboxed.
		args = append(args, "--sandbox", "workspace-write")
	}

	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Dir = spec.Cwd
	cmd.Env = os.Environ()
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("stdout pipe: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, fmt.Errorf("stderr pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start codex: %w", err)
	}

	ch := make(chan adapter.Event, 64)
	h := &handle{
		cmd:  cmd,
		ch:   ch,
		done: make(chan struct{}),
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		scanLines(stdout, ch)
	}()
	go func() {
		defer wg.Done()
		sc := bufio.NewScanner(stderr)
		sc.Buffer(make([]byte, 0, 64*1024), 10*1024*1024)
		for sc.Scan() {
			line := sc.Text()
			if line == "" {
				continue
			}
			select {
			case ch <- adapter.Event{
				Type:    "raw_output",
				Payload: mustMarshal(map[string]string{"line": line, "stream": "stderr"}),
			}:
			case <-h.done:
				return
			}
		}
	}()

	go func() {
		wg.Wait()
		waitErr := cmd.Wait()
		h.mu.Lock()
		h.waitErr = waitErr
		if cmd.ProcessState != nil {
			code := cmd.ProcessState.ExitCode()
			h.exitCode = &code
		}
		h.mu.Unlock()
		close(ch)
		close(h.done)
	}()

	return h, nil
}

func scanLines(r io.Reader, ch chan<- adapter.Event) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 10*1024*1024)
	for sc.Scan() {
		line := sc.Text()
		for _, ev := range ParseLine(line) {
			ch <- ev
		}
	}
	if err := sc.Err(); err != nil {
		ch <- adapter.Event{
			Type:    "error",
			Payload: mustMarshal(map[string]string{"message": "read stdout: " + err.Error()}),
		}
	}
}

type handle struct {
	cmd        *exec.Cmd
	ch         chan adapter.Event
	done       chan struct{}
	cancelOnce sync.Once
	mu         sync.Mutex
	waitErr    error
	exitCode   *int
	canceled   bool
}

func (h *handle) Events() <-chan adapter.Event { return h.ch }

// Cancel sends SIGTERM to the process group, then SIGKILL after 5s (spec §4).
func (h *handle) Cancel() error {
	h.cancelOnce.Do(func() {
		h.mu.Lock()
		h.canceled = true
		h.mu.Unlock()

		if h.cmd.Process == nil {
			return
		}
		pgid := h.cmd.Process.Pid
		_ = syscall.Kill(-pgid, syscall.SIGTERM)

		go func() {
			select {
			case <-time.After(5 * time.Second):
				_ = syscall.Kill(-pgid, syscall.SIGKILL)
			case <-h.done:
			}
		}()
	})
	return nil
}

// Canceled reports whether Cancel was called.
func (h *handle) Canceled() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.canceled
}

// ExitCode returns the process exit code after the Events channel has closed.
func (h *handle) ExitCode() *int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.exitCode
}

// ErrorEvent builds an error event (for Start failures before process).
func ErrorEvent(msg string) adapter.Event {
	return adapter.Event{
		Type:    "error",
		Payload: json.RawMessage(fmt.Sprintf(`{"message":%q}`, msg)),
	}
}
