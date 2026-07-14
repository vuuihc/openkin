package approvemcp_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/vuuihc/kin/internal/adapter"
	"github.com/vuuihc/kin/internal/api"
	"github.com/vuuihc/kin/internal/remote"
	"github.com/vuuihc/kin/internal/store"
	"github.com/vuuihc/kin/internal/task"
)

// Integration test: full bridge without real claude.
// Starts daemon HTTP, runs `kin approve-mcp` as subprocess, drives MCP JSON-RPC
// over stdin, decides via API, asserts allow/deny JSON on stdout.
func TestBridgeAllowDeny(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "kin")
	build := exec.Command("go", "build", "-o", bin, "./cmd/kin")
	build.Dir = repoRoot(t)
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build kin: %v\n%s", err, out)
	}

	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })

	const token = "aabbccdd00112233445566778899aabbccddeeff00112233445566778899aabb"
	ad := &holdAdapter{}
	eng := task.NewEngine(st, map[string]adapter.Adapter{"claude-code": ad}, task.NewBus(), 4)
	t.Cleanup(eng.Close)
	if err := eng.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}

	srv := &api.Server{
		Store:   st,
		Auth:    remote.NewAuth(token),
		Engine:  eng,
		Version: "test",
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	created, err := eng.Create(context.Background(), task.CreateRequest{
		Agent: "claude-code", Cwd: dir, Prompt: "hold",
	})
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		tt, _ := eng.Get(context.Background(), created.ID)
		if tt.Status == task.StatusRunning {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	// --- ALLOW path ---
	allowOut := runMCPCall(t, bin, ts.URL, token, created.ID, map[string]any{
		"tool_name": "Write",
		"input":     map[string]any{"file_path": "/tmp/x", "content": "hi"},
	}, func(approvalID string) {
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/approvals/"+approvalID+"/decision",
			strings.NewReader(`{"decision":"approved"}`))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Fatalf("decide status %d", resp.StatusCode)
		}
	})

	var allow map[string]any
	if err := json.Unmarshal([]byte(allowOut), &allow); err != nil {
		t.Fatalf("allow json: %v raw=%s", err, allowOut)
	}
	if allow["behavior"] != "allow" {
		t.Fatalf("want allow, got %v", allow)
	}
	upd, ok := allow["updatedInput"].(map[string]any)
	if !ok {
		t.Fatalf("updatedInput=%T %v", allow["updatedInput"], allow["updatedInput"])
	}
	if upd["content"] != "hi" {
		t.Fatalf("updatedInput=%v", upd)
	}

	// --- DENY path ---
	denyOut := runMCPCall(t, bin, ts.URL, token, created.ID, map[string]any{
		"tool_name": "Bash",
		"input":     map[string]any{"command": "echo no"},
	}, func(approvalID string) {
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/approvals/"+approvalID+"/decision",
			strings.NewReader(`{"decision":"denied"}`))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
	})

	var deny map[string]any
	if err := json.Unmarshal([]byte(denyOut), &deny); err != nil {
		t.Fatalf("deny json: %v raw=%s", err, denyOut)
	}
	if deny["behavior"] != "deny" {
		t.Fatalf("want deny, got %v", deny)
	}
	if deny["message"] != "denied via Kin console" {
		t.Fatalf("message=%v", deny["message"])
	}
}

func runMCPCall(t *testing.T, bin, daemonURL, token, taskID string, args map[string]any, onPending func(approvalID string)) string {
	t.Helper()
	cmd := exec.Command(bin, "approve-mcp")
	cmd.Env = append(os.Environ(),
		"KIN_TASK_ID="+taskID,
		"KIN_DAEMON="+daemonURL,
		"KIN_TOKEN="+token,
	)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = stdin.Close()
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}()

	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)

	writeLine := func(v any) {
		t.Helper()
		b, _ := json.Marshal(v)
		if _, err := stdin.Write(append(b, '\n')); err != nil {
			t.Fatal(err)
		}
	}
	readLine := func() map[string]any {
		t.Helper()
		type result struct {
			m   map[string]any
			err error
			ok  bool
		}
		ch := make(chan result, 1)
		go func() {
			if !sc.Scan() {
				ch <- result{err: sc.Err(), ok: false}
				return
			}
			var m map[string]any
			if err := json.Unmarshal(sc.Bytes(), &m); err != nil {
				ch <- result{err: err}
				return
			}
			ch <- result{m: m, ok: true}
		}()
		select {
		case r := <-ch:
			if !r.ok {
				t.Fatalf("read: %v stderr=%s", r.err, stderr.String())
			}
			return r.m
		case <-time.After(15 * time.Second):
			t.Fatalf("timeout reading mcp stdout; stderr=%s", stderr.String())
		}
		return nil
	}

	writeLine(map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "initialize",
		"params": map[string]any{
			"protocolVersion": "2024-11-05",
			"capabilities":    map[string]any{},
			"clientInfo":      map[string]any{"name": "test", "version": "0"},
		},
	})
	initResp := readLine()
	if initResp["result"] == nil {
		t.Fatalf("init: %v stderr=%s", initResp, stderr.String())
	}

	writeLine(map[string]any{
		"jsonrpc": "2.0",
		"method":  "notifications/initialized",
	})

	writeLine(map[string]any{
		"jsonrpc": "2.0",
		"id":      2,
		"method":  "tools/list",
		"params":  map[string]any{},
	})
	listResp := readLine()
	if listResp["result"] == nil {
		t.Fatalf("list: %v", listResp)
	}

	// Watch for approval creation then decide (before tools/call blocks).
	decided := make(chan struct{})
	go func() {
		defer close(decided)
		deadline := time.Now().Add(12 * time.Second)
		for time.Now().Before(deadline) {
			req, _ := http.NewRequest(http.MethodGet, daemonURL+"/api/approvals?status=pending", nil)
			req.Header.Set("Authorization", "Bearer "+token)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				time.Sleep(20 * time.Millisecond)
				continue
			}
			var list []store.Approval
			_ = json.NewDecoder(resp.Body).Decode(&list)
			resp.Body.Close()
			for _, a := range list {
				if a.TaskID == taskID && a.Decision == store.DecisionPending {
					onPending(a.ID)
					return
				}
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Error("no pending approval appeared")
	}()

	writeLine(map[string]any{
		"jsonrpc": "2.0",
		"id":      3,
		"method":  "tools/call",
		"params": map[string]any{
			"name":      "approve",
			"arguments": args,
		},
	})

	callResp := readLine()
	<-decided

	result, _ := callResp["result"].(map[string]any)
	if result == nil {
		t.Fatalf("call result nil: %v stderr=%s", callResp, stderr.String())
	}
	content, _ := result["content"].([]any)
	if len(content) == 0 {
		t.Fatalf("no content: %v", result)
	}
	block, _ := content[0].(map[string]any)
	text, _ := block["text"].(string)
	if text == "" {
		t.Fatalf("empty text: %v", block)
	}
	return text
}

type holdAdapter struct{}

type holdHandle struct {
	ch     chan adapter.Event
	cancel chan struct{}
}

func (h *holdHandle) Events() <-chan adapter.Event { return h.ch }
func (h *holdHandle) Cancel() error {
	select {
	case <-h.cancel:
	default:
		close(h.cancel)
	}
	return nil
}

func (a *holdAdapter) Start(ctx context.Context, spec adapter.TaskSpec) (adapter.RunHandle, error) {
	ch := make(chan adapter.Event, 4)
	cancel := make(chan struct{})
	go func() {
		defer close(ch)
		ch <- adapter.Event{Type: "task_started", Payload: json.RawMessage(`{"session_id":"bridge","subtype":"init"}`)}
		select {
		case <-cancel:
		case <-ctx.Done():
		case <-time.After(60 * time.Second):
		}
	}()
	return &holdHandle{ch: ch, cancel: cancel}, nil
}

func repoRoot(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	dir := wd
	for i := 0; i < 6; i++ {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		dir = filepath.Dir(dir)
	}
	t.Fatalf("go.mod not found from %s", wd)
	return ""
}
