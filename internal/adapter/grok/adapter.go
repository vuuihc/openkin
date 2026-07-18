package grok

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/vuuihc/kin/internal/adapter"
)

// Adapter launches Grok CLI headless runs (`grok -p … --output-format streaming-json`).
type Adapter struct {
	Binary   string
	LookPath func(file string) (string, error)
}

// New returns a Grok adapter using the "grok" binary on PATH.
func New() *Adapter {
	return &Adapter{Binary: "grok"}
}

// Start implements adapter.Adapter.
//
// New task:
//
//	grok -p "<prompt>" --output-format streaming-json --cwd <cwd> [-m model]
//
// Follow-up (session_ref):
//
//	grok -r <session_ref> -p "<prompt>" --output-format streaming-json --cwd <cwd>
func (a *Adapter) Start(ctx context.Context, spec adapter.TaskSpec) (adapter.RunHandle, error) {
	bin := a.Binary
	if bin == "" {
		bin = "grok"
	}
	look := a.LookPath
	if look == nil {
		look = exec.LookPath
	}
	path, err := look(bin)
	if err != nil {
		return nil, fmt.Errorf("grok binary not found on PATH (%q): install Grok CLI or set KIN_GROK_BIN", bin)
	}

	args := []string{
		"-p", spec.Prompt,
		"--output-format", "streaming-json",
	}
	if spec.Cwd != "" {
		args = append(args, "--cwd", spec.Cwd)
	}
	if spec.Model != "" {
		args = append(args, "-m", spec.Model)
	}
	if spec.SessionRef != "" {
		args = append([]string{"-r", spec.SessionRef}, args...)
	}
	// Map Kin session permission mode onto Grok flags.
	switch adapter.NormalizePermissionMode(spec.PermissionMode) {
	case adapter.PermissionYOLO, adapter.PermissionAcceptEdits:
		// Grok has no graded edit mode; both auto-approve tool executions.
		args = append(args, "--always-approve")
	}

	cmd := exec.CommandContext(ctx, path, args...)
	if spec.Cwd != "" {
		cmd.Dir = spec.Cwd
	}
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
		return nil, fmt.Errorf("start grok: %w", err)
	}

	ch := make(chan adapter.Event, 64)
	h := &handle{cmd: cmd, ch: ch}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		scanStream(stdout, ch)
	}()
	go func() {
		defer wg.Done()
		scanStderr(stderr, ch)
	}()
	go func() {
		wg.Wait()
		err := cmd.Wait()
		exit := 0
		if err != nil {
			if ee, ok := err.(*exec.ExitError); ok {
				exit = ee.ExitCode()
			} else {
				exit = 1
			}
		}
		// If stream ended without `end` event, synthesize result.
		payload, _ := json.Marshal(map[string]any{
			"exit_code": exit,
			"source":    "grok",
		})
		// Prefer not double-emitting when scanStream already sent result.
		// Engine tolerates multiple results; only send if process failed hard.
		if exit != 0 {
			select {
			case ch <- adapter.Event{Type: "result", Payload: payload}:
			default:
			}
		}
		close(ch)
	}()
	return h, nil
}

type handle struct {
	cmd *exec.Cmd
	ch  chan adapter.Event
	mu  sync.Mutex
}

func (h *handle) Events() <-chan adapter.Event { return h.ch }

func (h *handle) Cancel() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.cmd.Process == nil {
		return nil
	}
	// SIGTERM process group, then SIGKILL after 5s.
	pgid := h.cmd.Process.Pid
	_ = syscall.Kill(-pgid, syscall.SIGTERM)
	done := make(chan struct{})
	go func() {
		_, _ = h.cmd.Process.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-time.After(5 * time.Second):
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
		return nil
	}
}

func scanStream(r io.Reader, ch chan<- adapter.Event) {
	sc := bufio.NewScanner(r)
	// Large lines for tool payloads.
	buf := make([]byte, 0, 64*1024)
	sc.Buffer(buf, 4*1024*1024)

	var textAcc strings.Builder
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var raw map[string]json.RawMessage
		if err := json.Unmarshal([]byte(line), &raw); err != nil {
			payload, _ := json.Marshal(map[string]string{"line": line})
			ch <- adapter.Event{Type: "raw_output", Payload: payload}
			continue
		}
		var typ string
		_ = json.Unmarshal(raw["type"], &typ)
		switch typ {
		case "thought":
			// Drop fine-grained thoughts from event log (noise); optional meta.
			continue
		case "text":
			var data string
			_ = json.Unmarshal(raw["data"], &data)
			if data == "" {
				continue
			}
			// Treat as full message snapshot if it replaces; accumulate if deltas.
			// Observed: single full text event. Emit assistant message.
			textAcc.Reset()
			textAcc.WriteString(data)
			payload, _ := json.Marshal(map[string]any{
				"role":    "assistant",
				"content": []map[string]string{{"type": "text", "text": data}},
				"partial": false,
				"source":  "grok",
			})
			ch <- adapter.Event{Type: "message", Payload: payload}
		case "end":
			var end endEvent
			if err := json.Unmarshal([]byte(line), &end); err != nil {
				payload, _ := json.Marshal(map[string]string{"line": line})
				ch <- adapter.Event{Type: "raw_output", Payload: payload}
				continue
			}
			// Session id for resume.
			if end.SessionID != "" {
				sidPayload, _ := json.Marshal(map[string]string{
					"session_id": end.SessionID,
					"source":     "grok",
				})
				// Reuse system/init-shaped payload so engine ExtractSessionID paths work.
				ch <- adapter.Event{Type: "task_started", Payload: sidPayload}
			}
			result := map[string]any{
				"stop_reason": end.StopReason,
				"session_id":  end.SessionID,
				"source":      "grok",
				"is_error":    false,
			}
			if end.Usage != nil {
				result["usage"] = end.Usage
				if end.Usage.InputTokens > 0 {
					result["tokens_in"] = end.Usage.InputTokens
				}
				if end.Usage.OutputTokens > 0 {
					result["tokens_out"] = end.Usage.OutputTokens
				}
				usagePayload, _ := json.Marshal(map[string]any{
					"source":              "grok",
					"input_tokens":        end.Usage.InputTokens,
					"output_tokens":       end.Usage.OutputTokens,
					"total_tokens":        end.Usage.TotalTokens,
					"cache_read_reported": false,
					"cache_status":        "unsupported",
					"input_semantics":     "unknown",
					"usage":               end.Usage,
				})
				ch <- adapter.Event{Type: "usage", Payload: usagePayload}
			}
			payload, _ := json.Marshal(result)
			ch <- adapter.Event{Type: "result", Payload: payload}
		default:
			// tool / unknown — keep as raw for transcript
			payload, _ := json.Marshal(map[string]any{"line": line, "type": typ})
			ch <- adapter.Event{Type: "raw_output", Payload: payload}
		}
	}
}

func scanStderr(r io.Reader, ch chan<- adapter.Event) {
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		payload, _ := json.Marshal(map[string]string{"line": line, "stream": "stderr"})
		ch <- adapter.Event{Type: "raw_output", Payload: payload}
	}
}

type endEvent struct {
	Type       string `json:"type"`
	StopReason string `json:"stopReason"`
	SessionID  string `json:"sessionId"`
	RequestID  string `json:"requestId"`
	Usage      *usage `json:"usage"`
}

type usage struct {
	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
	TotalTokens  int `json:"total_tokens"`
}

// ExtractSessionID pulls session id from grok task_started / result payloads.
func ExtractSessionID(payload json.RawMessage) string {
	var m map[string]any
	if err := json.Unmarshal(payload, &m); err != nil {
		return ""
	}
	for _, k := range []string{"session_id", "sessionId"} {
		if v, ok := m[k].(string); ok && v != "" {
			return v
		}
	}
	return ""
}

// ExtractUsage maps grok result usage into engine fields.
func ExtractUsage(payload json.RawMessage) (cost *float64, tin, tout int, isErr, ok bool) {
	var m map[string]any
	if err := json.Unmarshal(payload, &m); err != nil {
		return nil, 0, 0, false, false
	}
	if src, _ := m["source"].(string); src != "grok" {
		// Still accept if tokens present.
	}
	if v, okn := m["tokens_in"].(float64); okn {
		tin = int(v)
		ok = true
	}
	if v, okn := m["tokens_out"].(float64); okn {
		tout = int(v)
		ok = true
	}
	if u, okm := m["usage"].(map[string]any); okm {
		if v, okn := u["input_tokens"].(float64); okn {
			tin = int(v)
			ok = true
		}
		if v, okn := u["output_tokens"].(float64); okn {
			tout = int(v)
			ok = true
		}
	}
	if b, okb := m["is_error"].(bool); okb {
		isErr = b
		ok = true
	}
	return nil, tin, tout, isErr, ok
}
