package claudecode

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
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
	// KinBinary is the absolute path to the kin binary for approve-mcp.
	// Empty → os.Executable().
	KinBinary string
	// DaemonURL is the base URL for the daemon (e.g. http://127.0.0.1:7777).
	// Required for the approval bridge; if empty, MCP config is omitted (tests).
	DaemonURL string
	// Token is the KIN auth token injected into the MCP server env.
	// Prefer TokenFunc when the daemon may rotate tokens while running.
	Token string
	// TokenFunc, if set, is called at Start to resolve the current token
	// (e.g. re-read ~/.kin/token after `kin token rotate`).
	TokenFunc func() string
}

// New returns a Claude Code adapter using the "claude" binary on PATH.
func New() *Adapter {
	return &Adapter{Binary: "claude"}
}

// Start implements adapter.Adapter.
// Launch (M2 — with approval bridge):
//
//	claude -p "<prompt>" --output-format stream-json --verbose --include-partial-messages
//	  --mcp-config <file> --permission-prompt-tool mcp__kin__approve
//	  [--permission-mode <mode>] [--resume <session_ref>] [--model <model>]
//
// PermissionMode mapping:
//   default       → MCP approve bridge (when DaemonURL/Token set)
//   accept_edits  → --permission-mode acceptEdits (+ MCP for other tools)
//   yolo          → --dangerously-skip-permissions (no MCP)
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
	perm := adapter.NormalizePermissionMode(spec.PermissionMode)

	token := a.Token
	if a.TokenFunc != nil {
		if t := a.TokenFunc(); t != "" {
			token = t
		}
	}

	var mcpPath string
	// YOLO: skip Kin MCP bridge and bypass Claude permission checks.
	// Operator opted in via session permission mode.
	if perm == adapter.PermissionYOLO {
		// --allow-… unlocks the flag on newer Claude Code builds; both are safe.
		args = append(args,
			"--allow-dangerously-skip-permissions",
			"--dangerously-skip-permissions",
			"--permission-mode", "bypassPermissions",
		)
	} else if a.DaemonURL != "" && token != "" {
		kinBin := a.KinBinary
		if kinBin == "" {
			kinBin, err = os.Executable()
			if err != nil {
				return nil, fmt.Errorf("resolve kin binary: %w", err)
			}
			kinBin, err = filepath.EvalSymlinks(kinBin)
			if err != nil {
				// Non-fatal: use unresolved path.
				kinBin, _ = os.Executable()
			}
		}
		mcpPath, err = writeMCPConfig(kinBin, spec.ID, a.DaemonURL, token)
		if err != nil {
			return nil, fmt.Errorf("mcp config: %w", err)
		}
		args = append(args,
			"--mcp-config", mcpPath,
			"--permission-prompt-tool", "mcp__kin__approve",
		)
		if perm == adapter.PermissionAcceptEdits {
			args = append(args, "--permission-mode", "acceptEdits")
		}
	} else if perm == adapter.PermissionAcceptEdits {
		// No MCP bridge (tests / misconfig): still pass Claude permission mode.
		args = append(args, "--permission-mode", "acceptEdits")
	}

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
		cleanupMCP(mcpPath)
		return nil, fmt.Errorf("stdout pipe: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		cleanupMCP(mcpPath)
		return nil, fmt.Errorf("stderr pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		cleanupMCP(mcpPath)
		return nil, fmt.Errorf("start claude: %w", err)
	}

	ch := make(chan adapter.Event, 64)
	h := &handle{
		cmd:     cmd,
		ch:      ch,
		done:    make(chan struct{}),
		mcpPath: mcpPath,
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
		cleanupMCP(mcpPath)
		close(ch)
		close(h.done)
	}()

	return h, nil
}

// writeMCPConfig writes a per-task MCP config JSON and returns its path.
func writeMCPConfig(kinBin, taskID, daemonURL, token string) (string, error) {
	cfg := map[string]any{
		"mcpServers": map[string]any{
			"kin": map[string]any{
				"command": kinBin,
				"args":    []string{"approve-mcp"},
				"env": map[string]string{
					"KIN_TASK_ID": taskID,
					"KIN_DAEMON":  daemonURL,
					"KIN_TOKEN":   token,
				},
			},
		},
	}
	data, err := json.Marshal(cfg)
	if err != nil {
		return "", err
	}
	f, err := os.CreateTemp("", "kin-mcp-*.json")
	if err != nil {
		return "", err
	}
	path := f.Name()
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		_ = os.Remove(path)
		return "", err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(path)
		return "", err
	}
	return path, nil
}

func cleanupMCP(path string) {
	if path != "" {
		_ = os.Remove(path)
	}
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
	mcpPath    string
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
