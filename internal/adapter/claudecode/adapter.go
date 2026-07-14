package claudecode

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

// Adapter launches Claude Code CLI processes.
type Adapter struct {
	// Binary is the path or name of the claude executable. Defaults to "claude".
	// Tests inject a fake agent via this field.
	Binary string
	// LookPath, if set, is used instead of exec.LookPath (tests).
	LookPath func(file string) (string, error)
}

// New returns a Claude Code adapter using the "claude" binary on PATH.
func New() *Adapter {
	return &Adapter{Binary: "claude"}
}

// Start implements adapter.Adapter.
// Launch (M1 — no MCP / permission bridge):
//
//	claude -p "<prompt>" --output-format stream-json --verbose --include-partial-messages
func (a *Adapter) Start(ctx context.Context, spec adapter.TaskSpec) (adapter.RunHandle, error) {
	bin := a.Binary
	if bin == "" {
		bin = "claude"
	}
	look := a.LookPath
	if look == nil {
		look = exec.LookPath
	}
	path, err := look(bin)
	if err != nil {
		return nil, fmt.Errorf("claude binary not found on PATH (%q): install Claude Code CLI or fix PATH", bin)
	}

	args := []string{
		"-p", spec.Prompt,
		"--output-format", "stream-json",
		"--verbose",
		"--include-partial-messages",
	}
	// M2: --resume, --mcp-config, --permission-prompt-tool.
	if spec.SessionRef != "" {
		args = append(args, "--resume", spec.SessionRef)
	}
	if spec.Model != "" {
		args = append(args, "--model", spec.Model)
	}

	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Dir = spec.Cwd
	// Isolate from interactive TTY assumptions; inherit env for auth.
	cmd.Env = os.Environ()
	// Detach from process group so Cancel can signal just this process tree on Unix.
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
		return nil, fmt.Errorf("start claude: %w", err)
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
		// Surface stderr as raw_output so operators can diagnose failures.
		sc := bufio.NewScanner(stderr)
		// Claude can emit large JSON lines; raise the token limit.
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
	cmd      *exec.Cmd
	ch       chan adapter.Event
	done     chan struct{}
	cancelOnce sync.Once
	mu       sync.Mutex
	waitErr  error
	exitCode *int
	canceled bool
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
		// Signal the whole process group (negative pid).
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

// Ensure adapter.Event error payload helper is used when Start fails before process.
func ErrorEvent(msg string) adapter.Event {
	return adapter.Event{
		Type:    "error",
		Payload: json.RawMessage(fmt.Sprintf(`{"message":%q}`, msg)),
	}
}
