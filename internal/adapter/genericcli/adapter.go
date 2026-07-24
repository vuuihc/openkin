// Package genericcli implements a declarative Tier-2 CLI agent adapter.
// Launch parameters come from detect.Invocation; prompts are never shell-interpolated.
package genericcli

import (
	"bufio"
	"bytes"
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

	"github.com/creack/pty"

	"github.com/vuuihc/kin/internal/adapter"
	"github.com/vuuihc/kin/internal/adapter/detect"
)

// CoalesceInterval matches rawpty (100ms) for text-mode PTY flushes.
const CoalesceInterval = 100 * time.Millisecond

// Adapter launches a generic CLI agent from a declarative Invocation.
type Adapter struct {
	ID       string
	Name     string
	Inv      detect.Invocation
	Bins     []string // DiscoverySpec.Bins fallback
	EnvBin   string   // optional env override (DiscoverySpec.EnvBin)
	LookPath func(file string) (string, error)
	// Coalesce overrides CoalesceInterval for tests (text mode).
	Coalesce time.Duration
}

// Start implements adapter.Adapter.
func (a *Adapter) Start(ctx context.Context, spec adapter.TaskSpec) (adapter.RunHandle, error) {
	if a == nil {
		return nil, fmt.Errorf("genericcli: nil adapter")
	}
	perm := adapter.NormalizePermissionMode(spec.PermissionMode)
	if perm != adapter.PermissionAcceptEdits && perm != adapter.PermissionYOLO {
		return nil, fmt.Errorf(
			"agent %q has no Kin approval channel; use permission_mode accept_edits or yolo (got %q)",
			a.ID, perm,
		)
	}

	path, err := a.resolveBinary()
	if err != nil {
		return nil, err
	}

	args := buildArgs(a.Inv, spec, perm)
	mode := strings.ToLower(strings.TrimSpace(a.Inv.Mode))
	if mode == "" {
		mode = "json"
	}

	switch mode {
	case "json":
		return a.startJSON(ctx, path, args, perm, spec.Cwd)
	case "text":
		return a.startText(ctx, path, args, perm, spec.Cwd)
	default:
		return nil, fmt.Errorf("genericcli %q: unknown mode %q", a.ID, mode)
	}
}

func (a *Adapter) resolveBinary() (string, error) {
	look := a.LookPath
	if look == nil {
		look = exec.LookPath
	}
	if env := strings.TrimSpace(a.EnvBin); env != "" {
		if v := strings.TrimSpace(os.Getenv(env)); v != "" {
			if path, err := look(v); err == nil {
				return path, nil
			}
			if _, err := os.Stat(v); err == nil {
				return v, nil
			}
		}
	}
	candidates := a.Inv.BinCandidates
	if len(candidates) == 0 {
		candidates = a.Bins
	}
	var tried []string
	for _, c := range candidates {
		c = strings.TrimSpace(c)
		if c == "" {
			continue
		}
		tried = append(tried, c)
		if path, err := look(c); err == nil {
			return path, nil
		}
	}
	if len(tried) == 0 {
		return "", fmt.Errorf("genericcli %q: no binary candidates configured", a.ID)
	}
	return "", fmt.Errorf("genericcli %q: binary not found on PATH (tried %v)", a.ID, tried)
}

func buildArgs(inv detect.Invocation, spec adapter.TaskSpec, perm string) []string {
	model := strings.TrimSpace(spec.Model)
	out := make([]string, 0, len(inv.Args)+4)
	for _, tok := range inv.Args {
		switch tok {
		case "{{prompt}}":
			out = append(out, spec.Prompt)
		case "{{model}}":
			out = append(out, model)
		default:
			out = append(out, tok)
		}
	}
	if inv.ModelFlag != "" && model != "" {
		out = append(out, inv.ModelFlag, model)
	}
	if inv.CwdFlag != "" && strings.TrimSpace(spec.Cwd) != "" {
		out = append(out, inv.CwdFlag, spec.Cwd)
	}
	if perm == adapter.PermissionAcceptEdits || perm == adapter.PermissionYOLO {
		out = append(out, inv.AutoConfirmFlags...)
	}
	return out
}

func (a *Adapter) applyEnv(cmd *exec.Cmd, perm string) {
	cmd.Env = os.Environ()
	if perm != adapter.PermissionAcceptEdits && perm != adapter.PermissionYOLO {
		return
	}
	for k, v := range a.Inv.AutoConfirmEnv {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
}

func (a *Adapter) startJSON(ctx context.Context, path string, args []string, perm, cwd string) (adapter.RunHandle, error) {
	cmd := exec.CommandContext(ctx, path, args...)
	if cwd != "" {
		cmd.Dir = cwd
	}
	a.applyEnv(cmd, perm)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("genericcli stdout: %w", err)
	}
	var stderrBuf bytes.Buffer
	cmd.Stderr = &stderrBuf

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("genericcli start: %w", err)
	}

	ch := make(chan adapter.Event, 64)
	h := &handle{
		cmd:    cmd,
		ch:     ch,
		done:   make(chan struct{}),
		id:     a.ID,
		stderr: &stderrBuf,
	}
	go h.runJSON(stdout)
	return h, nil
}

func (a *Adapter) startText(ctx context.Context, path string, args []string, perm, cwd string) (adapter.RunHandle, error) {
	coalesce := a.Coalesce
	if coalesce <= 0 {
		coalesce = CoalesceInterval
	}
	cmd := exec.CommandContext(ctx, path, args...)
	if cwd != "" {
		cmd.Dir = cwd
	}
	a.applyEnv(cmd, perm)
	// creack/pty sets Setsid; do not also Setpgid.

	ptmx, err := pty.Start(cmd)
	if err != nil {
		return nil, fmt.Errorf("genericcli start pty: %w", err)
	}

	ch := make(chan adapter.Event, 64)
	h := &handle{
		cmd:      cmd,
		ch:       ch,
		done:     make(chan struct{}),
		id:       a.ID,
		ptmx:     ptmx,
		coalesce: coalesce,
		textMode: true,
	}
	go h.runText()
	return h, nil
}

type handle struct {
	cmd      *exec.Cmd
	ch       chan adapter.Event
	done     chan struct{}
	id       string
	stderr   *bytes.Buffer
	ptmx     *os.File
	coalesce time.Duration
	textMode bool

	mu         sync.Mutex
	canceled   bool
	exitCode   *int
	waitErr    error
	ptmxClosed bool
	cancelOnce sync.Once
}

func (h *handle) Events() <-chan adapter.Event { return h.ch }

func (h *handle) Cancel() error {
	h.cancelOnce.Do(func() {
		h.mu.Lock()
		h.canceled = true
		h.mu.Unlock()

		if h.cmd != nil && h.cmd.Process != nil {
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
		h.closePTY()
	})
	return nil
}

func (h *handle) closePTY() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.ptmx != nil && !h.ptmxClosed {
		_ = h.ptmx.Close()
		h.ptmxClosed = true
	}
}

func (h *handle) runJSON(stdout io.Reader) {
	defer close(h.done)
	defer close(h.ch)

	var rawBuf bytes.Buffer
	scanner := bufio.NewScanner(stdout)
	// Allow large JSON lines (default 64K is tight for some CLIs).
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)

	emittedMessage := false
	emittedResult := false

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		rawBuf.Write(line)
		rawBuf.WriteByte('\n')
		if emitJSONLine(h.ch, h.id, line, &emittedMessage, &emittedResult) {
			continue
		}
		// Non-JSON line: surface as raw_output so nothing is lost.
		h.ch <- adapter.Event{
			Type:    "raw_output",
			Payload: mustMarshal(map[string]string{"text": string(line), "source": h.id}),
		}
	}

	waitErr := h.cmd.Wait()
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

	// EOF fallback: whole stdout as one JSON object (gemini-cli style).
	if !emittedMessage && !emittedResult {
		all := bytes.TrimSpace(rawBuf.Bytes())
		if len(all) > 0 {
			emitJSONLine(h.ch, h.id, all, &emittedMessage, &emittedResult)
		}
	}

	if !emittedMessage && rawBuf.Len() > 0 {
		// Still no structured message — promote combined text.
		text := strings.TrimSpace(rawBuf.String())
		if text != "" {
			h.ch <- adapter.Event{
				Type: "message",
				Payload: mustMarshal(map[string]any{
					"role":    "assistant",
					"content": []map[string]string{{"type": "text", "text": text}},
					"source":  h.id,
				}),
			}
			emittedMessage = true
		}
	}

	if !emittedResult {
		isErr := code != 0
		payload := map[string]any{
			"exit_code": code,
			"is_error":  isErr,
			"source":    h.id,
			"subtype":   "genericcli",
		}
		if isErr && h.stderr != nil {
			if s := strings.TrimSpace(h.stderr.String()); s != "" {
				payload["stderr"] = s
			}
		}
		h.ch <- adapter.Event{Type: "result", Payload: mustMarshal(payload)}
	}
}

// emitJSONLine tries to map one JSON object into message/usage/result events.
// Returns true when the line was valid JSON (even if only raw fields).
func emitJSONLine(ch chan<- adapter.Event, id string, line []byte, emittedMessage, emittedResult *bool) bool {
	var m map[string]any
	if err := json.Unmarshal(line, &m); err != nil {
		return false
	}

	// Nested result objects (streaming wrappers).
	if r, ok := m["result"].(map[string]any); ok {
		for k, v := range r {
			if _, exists := m[k]; !exists {
				m[k] = v
			}
		}
	}

	if text := firstString(m, "text", "content", "message", "response", "output"); text != "" {
		// content may be array — firstString only gets strings; handle array below.
		ch <- adapter.Event{
			Type: "message",
			Payload: mustMarshal(map[string]any{
				"role":    "assistant",
				"content": []map[string]string{{"type": "text", "text": text}},
				"source":  id,
			}),
		}
		*emittedMessage = true
	} else if arr, ok := m["content"].([]any); ok {
		var b strings.Builder
		for _, item := range arr {
			switch v := item.(type) {
			case string:
				b.WriteString(v)
			case map[string]any:
				if t, _ := v["text"].(string); t != "" {
					b.WriteString(t)
				}
			}
		}
		if s := strings.TrimSpace(b.String()); s != "" {
			ch <- adapter.Event{
				Type: "message",
				Payload: mustMarshal(map[string]any{
					"role":    "assistant",
					"content": []map[string]string{{"type": "text", "text": s}},
					"source":  id,
				}),
			}
			*emittedMessage = true
		}
	}

	if sid := firstString(m, "session_id", "sessionId"); sid != "" {
		ch <- adapter.Event{
			Type: "task_started",
			Payload: mustMarshal(map[string]string{
				"session_id": sid,
				"source":     id,
			}),
		}
	}

	usage := extractUsageMap(m)
	if usage != nil {
		usage["source"] = id
		ch <- adapter.Event{Type: "usage", Payload: mustMarshal(usage)}
	}

	// Explicit result markers.
	if _, has := m["is_error"]; has || m["type"] == "result" || m["stop_reason"] != nil {
		result := map[string]any{"source": id, "subtype": "genericcli"}
		if v, ok := m["is_error"].(bool); ok {
			result["is_error"] = v
		} else {
			result["is_error"] = false
		}
		if v, ok := m["stop_reason"]; ok {
			result["stop_reason"] = v
		}
		if sid := firstString(m, "session_id", "sessionId"); sid != "" {
			result["session_id"] = sid
		}
		if usage != nil {
			result["usage"] = usage
			if tin, ok := usage["input_tokens"].(int); ok {
				result["tokens_in"] = tin
			}
			if tout, ok := usage["output_tokens"].(int); ok {
				result["tokens_out"] = tout
			}
		}
		ch <- adapter.Event{Type: "result", Payload: mustMarshal(result)}
		*emittedResult = true
	}

	// Unknown-but-JSON: keep transparency when we emitted nothing useful from this line.
	if !*emittedMessage && !*emittedResult {
		ch <- adapter.Event{
			Type:    "raw_output",
			Payload: mustMarshal(map[string]string{"text": string(line), "source": id}),
		}
	}
	return true
}

func extractUsageMap(m map[string]any) map[string]any {
	out := map[string]any{}
	ok := false
	if u, okm := m["usage"].(map[string]any); okm {
		if v, okn := asInt(u["input_tokens"]); okn {
			out["input_tokens"] = v
			ok = true
		}
		if v, okn := asInt(u["output_tokens"]); okn {
			out["output_tokens"] = v
			ok = true
		}
		if v, okn := asInt(u["total_tokens"]); okn {
			out["total_tokens"] = v
			ok = true
		}
		if v, okn := asInt(u["prompt_tokens"]); okn {
			out["input_tokens"] = v
			ok = true
		}
		if v, okn := asInt(u["completion_tokens"]); okn {
			out["output_tokens"] = v
			ok = true
		}
	}
	if v, okn := asInt(m["tokens_in"]); okn {
		out["input_tokens"] = v
		ok = true
	}
	if v, okn := asInt(m["tokens_out"]); okn {
		out["output_tokens"] = v
		ok = true
	}
	if v, okn := asInt(m["input_tokens"]); okn {
		out["input_tokens"] = v
		ok = true
	}
	if v, okn := asInt(m["output_tokens"]); okn {
		out["output_tokens"] = v
		ok = true
	}
	if !ok {
		return nil
	}
	out["cache_read_reported"] = false
	out["cache_status"] = "unsupported"
	out["input_semantics"] = "unknown"
	return out
}

func asInt(v any) (int, bool) {
	switch n := v.(type) {
	case float64:
		return int(n), true
	case int:
		return n, true
	case int64:
		return int(n), true
	case json.Number:
		i, err := n.Int64()
		return int(i), err == nil
	default:
		return 0, false
	}
}

func firstString(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k].(string); ok {
			if s := strings.TrimSpace(v); s != "" {
				return s
			}
		}
	}
	return ""
}

func (h *handle) runText() {
	defer close(h.done)
	defer close(h.ch)
	defer h.closePTY()

	var (
		mu     sync.Mutex
		buf    strings.Builder
		all    strings.Builder
		ticker = time.NewTicker(h.coalesce)
	)
	defer ticker.Stop()

	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		b := make([]byte, 4096)
		for {
			n, err := h.ptmx.Read(b)
			if n > 0 {
				chunk := string(b[:n])
				mu.Lock()
				buf.WriteString(chunk)
				all.WriteString(chunk)
				mu.Unlock()
			}
			if err != nil {
				return
			}
		}
	}()

	flushRaw := func() {
		mu.Lock()
		s := buf.String()
		buf.Reset()
		mu.Unlock()
		if s == "" {
			return
		}
		h.ch <- adapter.Event{
			Type:    "raw_output",
			Payload: mustMarshal(map[string]string{"text": s, "source": h.id}),
		}
	}

	// Wait loop: coalesce ticks until process exits.
	waitDone := make(chan error, 1)
	go func() { waitDone <- h.cmd.Wait() }()

	var waitErr error
loop:
	for {
		select {
		case <-ticker.C:
			flushRaw()
		case waitErr = <-waitDone:
			break loop
		}
	}
	// Drain remaining output briefly.
	select {
	case <-readDone:
	case <-time.After(200 * time.Millisecond):
	}
	flushRaw()

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

	mu.Lock()
	full := strings.TrimSpace(all.String())
	mu.Unlock()
	if full != "" {
		h.ch <- adapter.Event{
			Type: "message",
			Payload: mustMarshal(map[string]any{
				"role":    "assistant",
				"content": []map[string]string{{"type": "text", "text": full}},
				"source":  h.id,
			}),
		}
	}
	h.ch <- adapter.Event{
		Type: "result",
		Payload: mustMarshal(map[string]any{
			"exit_code": code,
			"is_error":  code != 0,
			"source":    h.id,
			"subtype":   "genericcli",
		}),
	}
}

func mustMarshal(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return b
}

var _ adapter.Adapter = (*Adapter)(nil)
