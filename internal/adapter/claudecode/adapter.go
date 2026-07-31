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
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/vuuihc/openkin/internal/adapter"
)

// Adapter launches Claude Code CLI processes.
type Adapter struct {
	Binary    string
	LookPath  func(file string) (string, error)
	KinBinary string
	DaemonURL string
	Token     string
	TokenFunc func() string
}

// New returns a Claude Code adapter using the "claude" binary on PATH.
func New() *Adapter {
	return &Adapter{Binary: "claude"}
}

// Start implements adapter.Adapter.
//
// Workspace access modes (ADR 0014):
//
//	source_read_only → --permission-mode plan, restricted tools, no hooks
//	writable         → existing permission-mode logic
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

	var mcpPath string

	// Resolve token for MCP config (used by both read-only and writable paths).
	token := a.Token
	if a.TokenFunc != nil {
		if t := a.TokenFunc(); t != "" {
			token = t
		}
	}

	// Read-only workspace access: plan mode with restricted tools.
	if spec.RunMeta.WorkspaceAccess == adapter.AccessSourceReadOnly {
		args = append(args,
			"--permission-mode", "plan",
			"--allowedTools", "Read,Glob,Grep,mcp__kin__request_workspace,mcp__kin__ask_user_question",
			"--disallowedTools", "Bash,Edit,Write,NotebookEdit,Agent",
		)
		// Mount MCP config so Claude can see Kin tools (request_workspace, ask_user_question).
		if a.DaemonURL != "" && token != "" {
			kinBin := a.KinBinary
			if kinBin == "" {
				kinBin, err = os.Executable()
				if err != nil {
					return nil, fmt.Errorf("resolve kin binary: %w", err)
				}
				kinBin, err = filepath.EvalSymlinks(kinBin)
				if err != nil {
					kinBin, _ = os.Executable()
				}
			}
			mcpPath, err = writeMCPConfig(kinBin, spec.ID, a.DaemonURL, token, spec.Execution)
			if err != nil {
				return nil, fmt.Errorf("mcp config: %w", err)
			}
			args = append(args,
				"--mcp-config", mcpPath,
				"--permission-prompt-tool", "mcp__kin__approve",
			)
		}
	} else {
		perm := adapter.NormalizePermissionMode(spec.PermissionMode)

		if perm == adapter.PermissionYOLO {
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
					kinBin, _ = os.Executable()
				}
			}
			mcpPath, err = writeMCPConfig(kinBin, spec.ID, a.DaemonURL, token, spec.Execution)
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
			args = append(args, "--permission-mode", "acceptEdits")
		}
	}

	if spec.SessionRef != "" {
		args = append(args, "--resume", spec.SessionRef)
	}
	if spec.Model != "" {
		args = append(args, "--model", spec.Model)
	}

	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Dir = spec.Cwd
	cmd.Env = os.Environ()
	// Inject provider-specific env vars when routing selected a specific provider.
	if spec.ProviderCfg != nil && spec.ProviderCfg.BaseURL != "" {
		switch spec.ProviderCfg.Kind {
		case "anthropic-compatible":
			cmd.Env = append(cmd.Env, "ANTHROPIC_BASE_URL="+spec.ProviderCfg.BaseURL)
			if spec.ProviderCfg.APIKey != "" {
				cmd.Env = append(cmd.Env, "ANTHROPIC_API_KEY="+spec.ProviderCfg.APIKey)
			}
		case "openai-compatible":
			cmd.Env = append(cmd.Env, "OPENAI_BASE_URL="+spec.ProviderCfg.BaseURL)
			if spec.ProviderCfg.APIKey != "" {
				cmd.Env = append(cmd.Env, "OPENAI_API_KEY="+spec.ProviderCfg.APIKey)
			}
		}
	}
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
		cleanupMCP(mcpPath)
		close(ch)
		close(h.done)
	}()

	return h, nil
}

func writeMCPConfig(kinBin, taskID, daemonURL, token string, exec adapter.ExecutionRef) (string, error) {
	env := map[string]string{
		"KIN_TASK_ID": taskID,
		"KIN_DAEMON":  daemonURL,
		"KIN_TOKEN":   token,
	}
	if id := strings.TrimSpace(exec.ID); id != "" {
		env["KIN_EXECUTION_ID"] = id
	}
	if agent := strings.TrimSpace(exec.Agent); agent != "" {
		env["KIN_EXECUTION_AGENT"] = agent
	}
	if exec.Step > 0 {
		env["KIN_EXECUTION_STEP"] = strconv.Itoa(exec.Step)
	}
	if model := strings.TrimSpace(exec.Model); model != "" {
		env["KIN_EXECUTION_MODEL"] = model
	}
	if provider := strings.TrimSpace(exec.ProviderID); provider != "" {
		env["KIN_PROVIDER_ID"] = provider
	}
	cfg := map[string]any{
		"mcpServers": map[string]any{
			"kin": map[string]any{
				"command": kinBin,
				"args":    []string{"approve-mcp"},
				"env":     env,
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

func (h *handle) Canceled() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.canceled
}

func (h *handle) ExitCode() *int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.exitCode
}

func ErrorEvent(msg string) adapter.Event {
	return adapter.Event{
		Type:    "error",
		Payload: json.RawMessage(fmt.Sprintf(`{"message":%q}`, msg)),
	}
}
