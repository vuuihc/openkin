package droid

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/approvalbridge"
)

const (
	defaultCancelGrace = 500 * time.Millisecond
	defaultKillGrace   = 5 * time.Second
)

// Adapter launches Droid CLI in its bidirectional stream-jsonrpc mode.
type Adapter struct {
	Binary      string
	LookPath    func(file string) (string, error)
	DaemonURL   string
	Token       string
	TokenFunc   func() string
	HTTPClient  *http.Client
	CancelGrace time.Duration
	KillGrace   time.Duration
}

// New returns a Droid adapter using the droid binary on PATH.
func New() *Adapter {
	return &Adapter{Binary: "droid"}
}

// Start implements adapter.Adapter.
func (a *Adapter) Start(ctx context.Context, spec adapter.TaskSpec) (adapter.RunHandle, error) {
	if spec.ProviderCfg != nil && strings.TrimSpace(spec.ProviderCfg.Kind) != "subscription" {
		return nil, fmt.Errorf("Droid only supports subscription providers; Factory CLI manages its own authentication")
	}
	// Subscription credentials are owned by Factory CLI. Kin intentionally
	// does not translate ProviderCfg endpoints or API keys into Droid's env.
	bin := strings.TrimSpace(a.Binary)
	if bin == "" {
		bin = "droid"
	}
	look := a.LookPath
	if look == nil {
		look = exec.LookPath
	}
	path, err := look(bin)
	if err != nil {
		return nil, fmt.Errorf("droid binary not found on PATH (%q): install Factory Droid CLI or set KIN_DROID_BIN", bin)
	}

	cmd := exec.CommandContext(ctx, path,
		"exec",
		"--input-format", "stream-jsonrpc",
		"--output-format", "stream-jsonrpc",
	)
	cmd.Dir = spec.Cwd
	cmd.Env = os.Environ()
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("droid stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("droid stdout pipe: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, fmt.Errorf("droid stderr pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start droid: %w", err)
	}

	runCtx, cancelRun := context.WithCancel(ctx)
	token := a.Token
	if a.TokenFunc != nil {
		if current := strings.TrimSpace(a.TokenFunc()); current != "" {
			token = current
		}
	}
	h := &handle{
		cmd:         cmd,
		stdin:       stdin,
		ch:          make(chan adapter.Event, 128),
		done:        make(chan struct{}),
		cancelRun:   cancelRun,
		cancelGrace: durationOr(a.CancelGrace, defaultCancelGrace),
		killGrace:   durationOr(a.KillGrace, defaultKillGrace),
		pending:     make(map[string]string),
	}
	h.bridge = newApprovalBridge(&approvalbridge.Client{
		DaemonURL:  strings.TrimRight(a.DaemonURL, "/"),
		Token:      token,
		HTTPClient: a.HTTPClient,
	}, spec)
	h.parser = NewParser(spec.SessionRef, spec.Model)

	initialMethod := methodInitializeSession
	var params map[string]any
	if spec.SessionRef == "" {
		params = map[string]any{
			"machineId":                    "local",
			"cwd":                          spec.Cwd,
			"mcpServers":                   []any{},
			"interactionMode":              "auto",
			"autonomyLevel":                autonomyLevel(spec.PermissionMode),
			"disableBuiltinSkills":         true,
			"autoRejectPermissionRequests": false,
		}
		if spec.Model != "" {
			params["modelId"] = spec.Model
		}
	} else {
		initialMethod = methodLoadSession
		params = map[string]any{
			"sessionId":                    spec.SessionRef,
			"mcpServers":                   []any{},
			"disableBuiltinSkills":         true,
			"autoRejectPermissionRequests": false,
		}
	}
	// Empty mcpServers and disabled builtin skills reduce per-session
	// integrations, but Droid still executes user ~/.factory hooks. The adapter
	// deliberately does not redirect HOME or claim full configuration isolation.
	if _, err := h.writeRequest(initialMethod, params); err != nil {
		cancelRun()
		_ = stdin.Close()
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		_ = cmd.Wait()
		return nil, fmt.Errorf("initialize droid protocol: %w", err)
	}

	var ioWG sync.WaitGroup
	ioWG.Add(2)
	go func() {
		defer ioWG.Done()
		h.scanStdout(runCtx, stdout, spec)
	}()
	go func() {
		defer ioWG.Done()
		h.scanStderr(stderr)
	}()
	go func() {
		ioWG.Wait()
		waitErr := cmd.Wait()
		cancelRun()
		h.requestWG.Wait()
		h.stateMu.Lock()
		if cmd.ProcessState != nil {
			code := cmd.ProcessState.ExitCode()
			h.exitCode = &code
		}
		h.stateMu.Unlock()
		h.finish(waitErr)
	}()

	return h, nil
}

func autonomyLevel(mode string) string {
	switch adapter.NormalizePermissionMode(mode) {
	case adapter.PermissionAcceptEdits:
		return "low"
	case adapter.PermissionYOLO:
		return "high"
	default:
		return "off"
	}
}

type handle struct {
	cmd         *exec.Cmd
	stdin       io.WriteCloser
	ch          chan adapter.Event
	done        chan struct{}
	cancelRun   context.CancelFunc
	cancelGrace time.Duration
	killGrace   time.Duration
	parser      *Parser
	bridge      *approvalBridge

	writeMu   sync.Mutex
	nextID    int
	pending   map[string]string
	requestWG sync.WaitGroup

	stateMu       sync.Mutex
	canceled      bool
	sawResult     bool
	reportedError bool
	exitCode      *int
	cancelOnce    sync.Once
	closeOnce     sync.Once
	terminateOnce sync.Once
}

func (h *handle) Events() <-chan adapter.Event {
	return h.ch
}

// ExitCode returns the Droid process exit code after Events is closed.
func (h *handle) ExitCode() *int {
	h.stateMu.Lock()
	defer h.stateMu.Unlock()
	return h.exitCode
}

// Cancel asks Droid to interrupt the active turn before terminating the
// process group if the protocol shutdown does not complete.
func (h *handle) Cancel() error {
	h.cancelOnce.Do(func() {
		h.stateMu.Lock()
		h.canceled = true
		h.stateMu.Unlock()
		h.cancelRun()
		_, _ = h.writeRequest(methodInterruptSession, map[string]any{})
		h.closeInput()
		h.scheduleTermination(h.cancelGrace)
	})
	return nil
}

func (h *handle) scanStdout(ctx context.Context, r io.Reader, spec adapter.TaskSpec) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.TrimSpace(line) == "" {
			continue
		}
		var env rpcEnvelope
		if err := json.Unmarshal([]byte(line), &env); err != nil {
			h.emit(rawOutput(line))
			continue
		}
		if err := validateIncomingEnvelope(env); err != nil {
			h.stopWithError("Droid protocol mismatch: "+err.Error(), h.cancelGrace)
			return
		}
		switch env.Type {
		case "response":
			h.handleResponse(env, spec)
		case "request":
			h.handleServerRequest(ctx, env)
		case "notification":
			for _, event := range h.parser.ParseLine(line) {
				h.noteEvent(event)
				h.emit(event)
				if event.Type == "result" {
					_, _ = h.writeRequest(methodCloseSession, map[string]any{"reason": "prompt_input_exit"})
					h.closeInput()
					h.scheduleTermination(h.killGrace)
				}
			}
		default:
			h.emit(rawOutput(line))
		}
	}
	if err := scanner.Err(); err != nil {
		h.stopWithError("read Droid stdout: "+err.Error(), h.cancelGrace)
	}
}

func (h *handle) handleResponse(env rpcEnvelope, spec adapter.TaskSpec) {
	method := h.takePending(env.ID)
	if method == "" {
		h.emit(rawOutput(string(mustMarshal(env))))
		return
	}
	if env.Error != nil {
		h.stopWithError(fmt.Sprintf("%s failed: %s", method, env.Error.Message), h.cancelGrace)
		return
	}

	switch method {
	case methodInitializeSession:
		var result struct {
			SessionID string `json:"sessionId"`
		}
		if err := json.Unmarshal(env.Result, &result); err != nil || strings.TrimSpace(result.SessionID) == "" {
			h.noteError()
			h.emit(errorEvent("droid.initialize_session returned no sessionId"))
			h.closeInput()
			h.scheduleTermination(h.cancelGrace)
			return
		}
		h.parser.SetSessionRef(result.SessionID)
		h.emit(startedEvent(result.SessionID, spec.Model))
		h.sendUserMessage(spec.Prompt)
	case methodLoadSession:
		var result struct {
			PendingPermissions     []json.RawMessage `json:"pendingPermissions"`
			PendingAskUserRequests []json.RawMessage `json:"pendingAskUserRequests"`
			IsAgentLoopInProgress  bool              `json:"isAgentLoopInProgress"`
			WorkingState           string            `json:"workingState"`
		}
		if err := json.Unmarshal(env.Result, &result); err != nil {
			h.stopWithError("decode droid.load_session result: "+err.Error(), h.cancelGrace)
			return
		}
		if reason := blockedResumeReason(
			len(result.PendingPermissions),
			len(result.PendingAskUserRequests),
			result.IsAgentLoopInProgress,
			result.WorkingState,
		); reason != "" {
			h.stopWithError("cannot resume Droid session: "+reason, h.cancelGrace)
			return
		}
		h.emit(startedEvent(spec.SessionRef, spec.Model))
		settings := map[string]any{
			"interactionMode": "auto",
			"autonomyLevel":   autonomyLevel(spec.PermissionMode),
		}
		if spec.Model != "" {
			settings["modelId"] = spec.Model
		}
		if _, err := h.writeRequest(methodUpdateSettings, settings); err != nil {
			h.failWrite(methodUpdateSettings, err)
		}
	case methodUpdateSettings:
		h.sendUserMessage(spec.Prompt)
	case methodAddUserMessage, methodCloseSession, methodInterruptSession:
		// Acknowledgements need no Kin event.
	}
}

func (h *handle) sendUserMessage(prompt string) {
	if _, err := h.writeRequest(methodAddUserMessage, map[string]any{"text": prompt}); err != nil {
		h.failWrite(methodAddUserMessage, err)
	}
}

func (h *handle) handleServerRequest(ctx context.Context, env rpcEnvelope) {
	if env.ID == "" {
		h.emit(rawOutput(string(mustMarshal(env))))
		return
	}
	h.requestWG.Add(1)
	go func() {
		defer h.requestWG.Done()
		var response rpcEnvelope
		switch env.Method {
		case methodRequestPermission:
			selected := h.bridge.requestPermission(ctx, env.Params)
			if selected == "proceed_once" && !permissionOptionOffered(env.Params, selected) {
				selected = "cancel"
			}
			response = responseEnvelope(env.ID, map[string]any{"selectedOption": selected})
		case methodAskUser:
			response = responseEnvelope(env.ID, h.bridge.askUser(ctx, env.Params))
		default:
			response = errorResponseEnvelope(env.ID, -32601, "method not found")
		}
		if ctx.Err() != nil || h.isCanceled() {
			return
		}
		if err := h.writeEnvelope(response); err != nil {
			if ctx.Err() != nil || h.isCanceled() {
				return
			}
			h.failWrite("server response "+env.Method, err)
		}
	}()
}

func permissionOptionOffered(params json.RawMessage, desired string) bool {
	var request struct {
		Options []struct {
			Value string `json:"value"`
		} `json:"options"`
	}
	if json.Unmarshal(params, &request) != nil {
		return false
	}
	for _, option := range request.Options {
		if option.Value == desired {
			return true
		}
	}
	return false
}

func (h *handle) scanStderr(r io.Reader) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	for scanner.Scan() {
		if line := scanner.Text(); line != "" {
			h.emit(adapter.Event{
				Type:    "raw_output",
				Payload: mustMarshal(map[string]string{"line": line, "stream": "stderr"}),
			})
		}
	}
	if err := scanner.Err(); err != nil {
		h.stopWithError("read Droid stderr: "+err.Error(), h.cancelGrace)
	}
}

func (h *handle) writeRequest(method string, params any) (string, error) {
	h.writeMu.Lock()
	defer h.writeMu.Unlock()
	h.nextID++
	id := fmt.Sprintf("kin-%d", h.nextID)
	h.pending[id] = method
	if err := h.writeEnvelopeLocked(requestEnvelope(id, method, params)); err != nil {
		delete(h.pending, id)
		return "", err
	}
	return id, nil
}

func (h *handle) writeEnvelope(env rpcEnvelope) error {
	h.writeMu.Lock()
	defer h.writeMu.Unlock()
	return h.writeEnvelopeLocked(env)
}

func (h *handle) writeEnvelopeLocked(env rpcEnvelope) error {
	data, err := json.Marshal(env)
	if err != nil {
		return err
	}
	_, err = h.stdin.Write(append(data, '\n'))
	return err
}

func (h *handle) takePending(id string) string {
	h.writeMu.Lock()
	defer h.writeMu.Unlock()
	method := h.pending[id]
	delete(h.pending, id)
	return method
}

func (h *handle) failWrite(method string, err error) {
	if h.isCanceled() {
		return
	}
	h.stopWithError(fmt.Sprintf("send %s: %v", method, err), h.cancelGrace)
}

func (h *handle) stopWithError(message string, grace time.Duration) {
	h.noteError()
	h.emit(errorEvent(message))
	if h.cancelRun != nil {
		h.cancelRun()
	}
	h.closeInput()
	h.scheduleTermination(grace)
}

func (h *handle) isCanceled() bool {
	h.stateMu.Lock()
	defer h.stateMu.Unlock()
	return h.canceled
}

func (h *handle) closeInput() {
	h.closeOnce.Do(func() {
		_ = h.stdin.Close()
	})
}

func (h *handle) scheduleTermination(grace time.Duration) {
	h.terminateOnce.Do(func() {
		go func() {
			timer := time.NewTimer(grace)
			defer timer.Stop()
			select {
			case <-h.done:
				return
			case <-timer.C:
			}
			if h.cmd != nil && h.cmd.Process != nil {
				_ = syscall.Kill(-h.cmd.Process.Pid, syscall.SIGTERM)
			}

			timer.Reset(h.killGrace)
			select {
			case <-h.done:
				return
			case <-timer.C:
			}
			if h.cmd != nil && h.cmd.Process != nil {
				_ = syscall.Kill(-h.cmd.Process.Pid, syscall.SIGKILL)
			}
		}()
	})
}

func (h *handle) noteEvent(event adapter.Event) {
	h.stateMu.Lock()
	defer h.stateMu.Unlock()
	if event.Type == "result" {
		h.sawResult = true
	}
	if event.Type == "error" {
		h.reportedError = true
	}
}

func (h *handle) noteError() {
	h.stateMu.Lock()
	h.reportedError = true
	h.stateMu.Unlock()
}

func (h *handle) emit(event adapter.Event) {
	h.ch <- event
}

func (h *handle) finish(waitErr error) {
	h.stateMu.Lock()
	canceled := h.canceled
	sawResult := h.sawResult
	reportedError := h.reportedError
	h.stateMu.Unlock()

	if !canceled && !sawResult && !reportedError {
		message := "Droid process exited without a result"
		if waitErr != nil {
			message = "Droid process exited: " + waitErr.Error()
		}
		h.emit(errorEvent(message))
	}
	close(h.done)
	close(h.ch)
}

func startedEvent(sessionRef, model string) adapter.Event {
	return adapter.Event{
		Type: "task_started",
		Payload: mustMarshal(map[string]any{
			"session_ref": sessionRef,
			"model":       model,
		}),
	}
}

func errorEvent(message string) adapter.Event {
	return adapter.Event{Type: "error", Payload: mustMarshal(map[string]string{"message": message})}
}

func durationOr(value, fallback time.Duration) time.Duration {
	if value > 0 {
		return value
	}
	return fallback
}

func blockedResumeReason(pendingPermissions, pendingAskUserRequests int, agentLoopInProgress bool, workingState string) string {
	switch {
	case pendingPermissions > 0:
		return fmt.Sprintf("loaded session has %d pending permission request(s)", pendingPermissions)
	case pendingAskUserRequests > 0:
		return fmt.Sprintf("loaded session has %d pending ask-user request(s)", pendingAskUserRequests)
	case agentLoopInProgress:
		return "loaded session agent loop is still in progress"
	case strings.TrimSpace(workingState) != "" && strings.TrimSpace(workingState) != "idle":
		return fmt.Sprintf("loaded session working state is %q", workingState)
	default:
		return ""
	}
}

var _ adapter.Adapter = (*Adapter)(nil)
