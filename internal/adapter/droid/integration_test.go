package droid

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/approvalbridge"
)

func TestAdapterSessionFlow(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fake binary")
	}
	tests := []struct {
		name        string
		sessionRef  string
		permission  string
		wantMethods []string
		wantLevel   string
	}{
		{
			name:        "new session",
			permission:  adapter.PermissionDefault,
			wantMethods: []string{methodInitializeSession, methodAddUserMessage, methodCloseSession},
			wantLevel:   "off",
		},
		{
			name:        "resume session",
			sessionRef:  "session-existing",
			permission:  adapter.PermissionAcceptEdits,
			wantMethods: []string{methodLoadSession, methodUpdateSettings, methodAddUserMessage, methodCloseSession},
			wantLevel:   "low",
		},
		{
			name:        "yolo uses high autonomy without unsafe bypass",
			permission:  adapter.PermissionYOLO,
			wantMethods: []string{methodInitializeSession, methodAddUserMessage, methodCloseSession},
			wantLevel:   "high",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			bin, logPath := writeFakeDroid(t)
			t.Setenv("DROID_FAKE_MODE", "success")
			t.Setenv("DROID_FAKE_LOG", logPath)
			ad := &Adapter{Binary: bin}
			h, err := ad.Start(context.Background(), adapter.TaskSpec{
				ID:             "task-1",
				Agent:          "droid",
				Cwd:            t.TempDir(),
				Prompt:         "do the work",
				Model:          "claude-opus-5",
				SessionRef:     test.sessionRef,
				PermissionMode: test.permission,
			})
			if err != nil {
				t.Fatal(err)
			}
			events := collectEvents(t, h, 10*time.Second)
			assertEventTypes(t, events, "task_started", "message", "tool_use", "tool_result", "usage", "result", "raw_output")
			started, ok := adapter.ParseStarted(findEvent(t, events, "task_started").Payload)
			if !ok {
				t.Fatal("task_started payload is not canonical")
			}
			wantSession := test.sessionRef
			if wantSession == "" {
				wantSession = "session-new"
			}
			if started.SessionRef != wantSession {
				t.Fatalf("session_ref=%q want=%q", started.SessionRef, wantSession)
			}

			requests := readLoggedRequests(t, logPath)
			if len(requests) != len(test.wantMethods) {
				t.Fatalf("methods=%v want=%v", requestMethods(requests), test.wantMethods)
			}
			for i, method := range test.wantMethods {
				if requests[i].Method != method {
					t.Fatalf("method[%d]=%s want=%s all=%v", i, requests[i].Method, method, requestMethods(requests))
				}
				assertRequestEnvelope(t, requests[i])
			}
			if test.sessionRef == "" {
				var params map[string]any
				if err := json.Unmarshal(requests[0].Params, &params); err != nil {
					t.Fatal(err)
				}
				if params["autonomyLevel"] != test.wantLevel {
					t.Fatalf("autonomyLevel=%v want=%s", params["autonomyLevel"], test.wantLevel)
				}
				if params["interactionMode"] != "auto" {
					t.Fatalf("interactionMode=%v want=auto", params["interactionMode"])
				}
				assertSafeSessionParams(t, params)
			} else {
				var params map[string]any
				if err := json.Unmarshal(requests[1].Params, &params); err != nil {
					t.Fatal(err)
				}
				if params["autonomyLevel"] != test.wantLevel {
					t.Fatalf("resume autonomyLevel=%v want=%s", params["autonomyLevel"], test.wantLevel)
				}
				if params["interactionMode"] != "auto" {
					t.Fatalf("resume interactionMode=%v want=auto", params["interactionMode"])
				}
			}
			if args := readLog(t, logPath); !strings.Contains(args, "ARGS:exec --input-format stream-jsonrpc --output-format stream-jsonrpc") {
				t.Fatalf("unexpected CLI args:\n%s", args)
			} else if strings.Contains(args, "--worktree") || strings.Contains(args, "--skip-permissions-unsafe") {
				t.Fatalf("unsafe/unowned CLI flag in args:\n%s", args)
			}
		})
	}
}

func TestAdapterPermissionBridge(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fake binary")
	}
	tests := []struct {
		name         string
		decision     string
		wantSelected string
		wantError    bool
	}{
		{name: "allow once", decision: "approved", wantSelected: "proceed_once"},
		{name: "deny", decision: "denied", wantSelected: "cancel", wantError: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var posted atomic.Bool
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer token-1" {
					t.Errorf("authorization=%q", r.Header.Get("Authorization"))
				}
				switch {
				case r.Method == http.MethodPost && r.URL.Path == "/internal/approvals":
					posted.Store(true)
					var body map[string]any
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error(err)
					}
					if body["task_id"] != "task-approval" || body["execution_agent"] != "droid" {
						t.Errorf("approval body=%v", body)
					}
					w.WriteHeader(http.StatusCreated)
					_ = json.NewEncoder(w).Encode(map[string]any{"id": "approval-1"})
				case r.Method == http.MethodGet && r.URL.Path == "/internal/approvals/approval-1/wait":
					_ = json.NewEncoder(w).Encode(map[string]any{"decision": test.decision})
				default:
					http.NotFound(w, r)
				}
			}))
			t.Cleanup(server.Close)

			bin, logPath := writeFakeDroid(t)
			t.Setenv("DROID_FAKE_MODE", "permission")
			t.Setenv("DROID_FAKE_LOG", logPath)
			ad := &Adapter{Binary: bin, DaemonURL: server.URL, TokenFunc: func() string { return "token-1" }, HTTPClient: server.Client()}
			h, err := ad.Start(context.Background(), adapter.TaskSpec{
				ID:             "task-approval",
				Agent:          "droid",
				Cwd:            t.TempDir(),
				Prompt:         "write a file",
				PermissionMode: adapter.PermissionDefault,
				Execution:      adapter.ExecutionRef{ID: "exec-1", Agent: "droid"},
			})
			if err != nil {
				t.Fatal(err)
			}
			events := collectEvents(t, h, 10*time.Second)
			if !posted.Load() {
				t.Fatal("approval was not posted to Kin")
			}
			response := findLoggedResponse(t, logPath, "permission-1")
			var result struct {
				SelectedOption string `json:"selectedOption"`
			}
			if err := json.Unmarshal(response.Result, &result); err != nil {
				t.Fatal(err)
			}
			if result.SelectedOption != test.wantSelected {
				t.Fatalf("selectedOption=%q want=%q", result.SelectedOption, test.wantSelected)
			}
			resultEvent := findEvent(t, events, "result")
			var resultPayload struct {
				IsError bool `json:"is_error"`
			}
			if err := json.Unmarshal(resultEvent.Payload, &resultPayload); err != nil {
				t.Fatal(err)
			}
			if resultPayload.IsError != test.wantError {
				t.Fatalf("is_error=%v want=%v", resultPayload.IsError, test.wantError)
			}
		})
	}
}

func TestAdapterPermissionFailsClosedWithoutBridge(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fake binary")
	}
	bin, logPath := writeFakeDroid(t)
	t.Setenv("DROID_FAKE_MODE", "permission")
	t.Setenv("DROID_FAKE_LOG", logPath)
	h, err := (&Adapter{Binary: bin}).Start(context.Background(), adapter.TaskSpec{
		ID: "task-1", Agent: "droid", Cwd: t.TempDir(), Prompt: "write",
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = collectEvents(t, h, 10*time.Second)
	response := findLoggedResponse(t, logPath, "permission-1")
	if !strings.Contains(string(response.Result), `"selectedOption":"cancel"`) {
		t.Fatalf("permission response=%s", response.Result)
	}
}

func TestAdapterAskUserBridge(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fake binary")
	}
	var created atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/internal/user-questions":
			id := created.Add(1)
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "question-" + string(rune('0'+id))})
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/internal/user-questions/question-"):
			answer := "blue"
			if strings.HasSuffix(r.URL.Path, "2/wait") {
				answer = "fast, careful"
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"status":   "answered",
				"response": map[string]any{"selected": strings.Split(answer, ", "), "other_text": ""},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	bin, logPath := writeFakeDroid(t)
	t.Setenv("DROID_FAKE_MODE", "ask")
	t.Setenv("DROID_FAKE_LOG", logPath)
	h, err := (&Adapter{
		Binary:     bin,
		DaemonURL:  server.URL,
		Token:      "token-1",
		HTTPClient: server.Client(),
	}).Start(context.Background(), adapter.TaskSpec{
		ID: "task-question", Agent: "droid", Cwd: t.TempDir(), Prompt: "ask",
	})
	if err != nil {
		t.Fatal(err)
	}
	events := collectEvents(t, h, 10*time.Second)
	assertEventTypes(t, events, "result")
	if created.Load() != 2 {
		t.Fatalf("created questions=%d want=2", created.Load())
	}
	response := findLoggedResponse(t, logPath, "ask-1")
	var result struct {
		Cancelled bool `json:"cancelled"`
		Answers   []struct {
			Index  int    `json:"index"`
			Answer string `json:"answer"`
		} `json:"answers"`
	}
	if err := json.Unmarshal(response.Result, &result); err != nil {
		t.Fatal(err)
	}
	if result.Cancelled || len(result.Answers) != 2 ||
		result.Answers[0].Index != 1 || result.Answers[0].Answer != "blue" ||
		result.Answers[1].Index != 2 || result.Answers[1].Answer != "fast, careful" {
		t.Fatalf("ask result=%+v", result)
	}
}

func TestAdapterCancelAndProcessExit(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fake binary")
	}
	t.Run("cancel sends interrupt before process termination", func(t *testing.T) {
		bin, logPath := writeFakeDroid(t)
		t.Setenv("DROID_FAKE_MODE", "cancel")
		t.Setenv("DROID_FAKE_LOG", logPath)
		h, err := (&Adapter{
			Binary:      bin,
			CancelGrace: 30 * time.Millisecond,
			KillGrace:   100 * time.Millisecond,
		}).Start(context.Background(), adapter.TaskSpec{
			ID: "task-cancel", Agent: "droid", Cwd: t.TempDir(), Prompt: "wait",
		})
		if err != nil {
			t.Fatal(err)
		}
		waitForLog(t, logPath, "READY", time.Second)
		if err := h.Cancel(); err != nil {
			t.Fatal(err)
		}
		started := time.Now()
		_ = collectEvents(t, h, 3*time.Second)
		logged := readLog(t, logPath)
		interrupt := strings.Index(logged, methodInterruptSession)
		if interrupt < 0 {
			t.Fatalf("cancel did not send interrupt before termination:\n%s", logged)
		}
		if time.Since(started) < 20*time.Millisecond {
			t.Fatalf("process exited before configured termination grace; protocol log:\n%s", logged)
		}
	})

	t.Run("unexpected process exit emits error", func(t *testing.T) {
		bin, logPath := writeFakeDroid(t)
		t.Setenv("DROID_FAKE_MODE", "exit")
		t.Setenv("DROID_FAKE_LOG", logPath)
		h, err := (&Adapter{Binary: bin}).Start(context.Background(), adapter.TaskSpec{
			ID: "task-exit", Agent: "droid", Cwd: t.TempDir(), Prompt: "exit",
		})
		if err != nil {
			t.Fatal(err)
		}
		events := collectEvents(t, h, 10*time.Second)
		assertEventTypes(t, events, "task_started", "error")
		exitCoder, ok := h.(interface{ ExitCode() *int })
		if !ok {
			t.Fatal("Droid handle does not expose ExitCode")
		}
		if code := exitCoder.ExitCode(); code == nil || *code != 7 {
			t.Fatalf("exit code=%v want=7", code)
		}
	})

	t.Run("drains tail output before reporting process exit", func(t *testing.T) {
		bin, logPath := writeFakeDroid(t)
		t.Setenv("DROID_FAKE_MODE", "tail")
		t.Setenv("DROID_FAKE_LOG", logPath)
		h, err := (&Adapter{Binary: bin}).Start(context.Background(), adapter.TaskSpec{
			ID: "task-tail", Agent: "droid", Cwd: t.TempDir(), Prompt: "tail",
		})
		if err != nil {
			t.Fatal(err)
		}
		events := collectEvents(t, h, 10*time.Second)
		result := findEvent(t, events, "result")
		var payload struct {
			Text string `json:"text"`
		}
		if err := json.Unmarshal(result.Payload, &payload); err != nil {
			t.Fatal(err)
		}
		if !strings.HasSuffix(payload.Text, "tail-final") {
			t.Fatalf("tail result was not drained: len=%d suffix=%q", len(payload.Text), payload.Text[max(0, len(payload.Text)-20):])
		}
	})
}

func TestAdapterResumeFailsClosedForNonIdleSession(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fake binary")
	}
	tests := []struct {
		name        string
		mode        string
		wantMessage string
	}{
		{name: "pending permission", mode: "resume_pending_permission", wantMessage: "pending permission"},
		{name: "pending ask user", mode: "resume_pending_ask_user", wantMessage: "pending ask-user request"},
		{name: "agent loop in progress", mode: "resume_agent_loop", wantMessage: "agent loop is still in progress"},
		{name: "non-idle working state", mode: "resume_working_state", wantMessage: `working state is "executing_tool"`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			bin, logPath := writeFakeDroid(t)
			t.Setenv("DROID_FAKE_MODE", test.mode)
			t.Setenv("DROID_FAKE_LOG", logPath)
			h, err := (&Adapter{
				Binary:      bin,
				CancelGrace: 20 * time.Millisecond,
				KillGrace:   50 * time.Millisecond,
			}).Start(context.Background(), adapter.TaskSpec{
				ID:         "task-resume",
				Agent:      "droid",
				Cwd:        t.TempDir(),
				Prompt:     "must not be sent",
				SessionRef: "session-existing",
			})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				_ = h.Cancel()
			})
			events := collectEvents(t, h, 3*time.Second)
			if len(events) == 0 || events[0].Type != "error" || !strings.Contains(eventErrorMessage(t, events[0]), test.wantMessage) {
				t.Fatalf("events=%v want error containing %q", events, test.wantMessage)
			}
			for _, event := range events {
				if event.Type == "task_started" {
					t.Fatalf("non-idle resume emitted task_started: %v", eventTypes(events))
				}
			}
			requests := readLoggedRequests(t, logPath)
			if got := requestMethods(requests); len(got) != 1 || got[0] != methodLoadSession {
				t.Fatalf("methods=%v want only %s", got, methodLoadSession)
			}
			if strings.Contains(readLog(t, logPath), "must not be sent") {
				t.Fatal("non-idle resume sent the new prompt")
			}
		})
	}
}

func TestAdapterRejectsNonSubscriptionProviderConfig(t *testing.T) {
	ad := &Adapter{
		Binary: "droid",
		LookPath: func(string) (string, error) {
			return "", errors.New("binary lookup should not run")
		},
	}
	_, err := ad.Start(context.Background(), adapter.TaskSpec{
		ProviderCfg: &adapter.ProviderConfig{
			Kind:    "openai-compatible",
			BaseURL: "https://provider.invalid",
			APIKey:  "secret",
		},
	})
	if err == nil || !strings.Contains(err.Error(), "subscription") {
		t.Fatalf("err=%v", err)
	}
}

func TestHandleServerRequestCancelSuppressesResponseWriteError(t *testing.T) {
	waitStarted := make(chan struct{})
	releaseWait := make(chan struct{})
	var waitOnce sync.Once
	client := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		switch req.Method {
		case http.MethodPost:
			return jsonHTTPResponse(http.StatusCreated, `{"id":"approval-1"}`), nil
		case http.MethodGet:
			waitOnce.Do(func() { close(waitStarted) })
			<-releaseWait
			return jsonHTTPResponse(http.StatusOK, `{"decision":"approved"}`), nil
		default:
			return jsonHTTPResponse(http.StatusNotFound, `{}`), nil
		}
	})}

	ctx, cancel := context.WithCancel(context.Background())
	writer := &recordingWriteCloser{}
	h := newServerRequestTestHandle(writer)
	h.cancelRun = cancel
	h.bridge = &approvalBridge{
		client: &approvalbridge.Client{
			DaemonURL:  "http://kin.invalid",
			Token:      "token-1",
			HTTPClient: client,
		},
		taskID: "task-1",
	}
	h.handleServerRequest(ctx, rpcEnvelope{
		ID:     "permission-1",
		Method: methodRequestPermission,
		Params: json.RawMessage(`{"options":[{"value":"proceed_once"},{"value":"cancel"}]}`),
	})
	select {
	case <-waitStarted:
	case <-time.After(time.Second):
		t.Fatal("permission bridge did not start waiting")
	}

	if err := h.Cancel(); err != nil {
		t.Fatal(err)
	}
	close(releaseWait)
	h.requestWG.Wait()

	select {
	case event := <-h.ch:
		t.Fatalf("cancel emitted a spurious event: %+v", event)
	default:
	}
	if !writer.isClosed() {
		t.Fatal("Cancel did not close input")
	}
	close(h.done)
}

func TestHandleServerRequest(t *testing.T) {
	t.Run("unknown method returns method not found", func(t *testing.T) {
		writer := &recordingWriteCloser{}
		h := newServerRequestTestHandle(writer)
		h.handleServerRequest(context.Background(), rpcEnvelope{
			ID:     "request-1",
			Method: "droid.future_method",
		})
		h.requestWG.Wait()

		var response rpcEnvelope
		if err := json.Unmarshal(bytes.TrimSpace(writer.bytes()), &response); err != nil {
			t.Fatal(err)
		}
		if response.Error == nil || response.Error.Code != -32601 || response.Result != nil {
			t.Fatalf("response=%+v", response)
		}
	})

	t.Run("response write failure emits error and terminates", func(t *testing.T) {
		writer := &recordingWriteCloser{writeErr: errors.New("broken pipe")}
		h := newServerRequestTestHandle(writer)
		h.handleServerRequest(context.Background(), rpcEnvelope{
			ID:     "request-1",
			Method: "droid.future_method",
		})
		h.requestWG.Wait()

		select {
		case event := <-h.ch:
			if event.Type != "error" || !strings.Contains(string(event.Payload), "broken pipe") {
				t.Fatalf("event=%+v", event)
			}
		default:
			t.Fatal("response write failure did not emit an error")
		}
		h.stateMu.Lock()
		reported := h.reportedError
		h.stateMu.Unlock()
		if !reported || !writer.isClosed() {
			t.Fatalf("reportedError=%v inputClosed=%v", reported, writer.isClosed())
		}
		close(h.done)
	})
}

func TestScanStdoutErrorClosesInputAndTerminates(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("process-group termination")
	}
	tests := []struct {
		name       string
		reader     io.Reader
		wantErrMsg string
	}{
		{
			name:       "token too long",
			reader:     strings.NewReader(strings.Repeat("x", 16*1024*1024+1)),
			wantErrMsg: "token too long",
		},
		{
			name:       "other scan error",
			reader:     errorReader{err: errors.New("forced read failure")},
			wantErrMsg: "forced read failure",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			h, writer, waitProcess := newTerminationTestHandle(t)
			h.scanStdout(context.Background(), test.reader, adapter.TaskSpec{})

			select {
			case event := <-h.ch:
				if event.Type != "error" || !strings.Contains(eventErrorMessage(t, event), test.wantErrMsg) {
					t.Fatalf("event=%+v want error containing %q", event, test.wantErrMsg)
				}
			default:
				t.Fatal("scan error did not emit an error event")
			}
			if !writer.isClosed() {
				terminateTestProcess(h, waitProcess)
				t.Fatal("scan error did not close input")
			}
			if !waitForProcessExit(waitProcess, time.Second) {
				terminateTestProcess(h, waitProcess)
				t.Fatal("scan error did not terminate the Droid process")
			}
			close(h.done)
		})
	}
}

func TestScanStderrErrorClosesInputAndTerminates(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("process-group termination")
	}
	tests := []struct {
		name       string
		reader     io.Reader
		wantErrMsg string
	}{
		{
			name:       "token too long",
			reader:     strings.NewReader(strings.Repeat("x", 16*1024*1024+1)),
			wantErrMsg: "token too long",
		},
		{
			name:       "other scan error",
			reader:     errorReader{err: errors.New("forced read failure")},
			wantErrMsg: "forced read failure",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			h, writer, waitProcess := newTerminationTestHandle(t)
			h.scanStderr(test.reader)

			select {
			case event := <-h.ch:
				if event.Type != "error" || !strings.Contains(eventErrorMessage(t, event), test.wantErrMsg) {
					t.Fatalf("event=%+v want error containing %q", event, test.wantErrMsg)
				}
			default:
				t.Fatal("scan error did not emit an error event")
			}
			if !writer.isClosed() {
				terminateTestProcess(h, waitProcess)
				t.Fatal("scan error did not close input")
			}
			if !waitForProcessExit(waitProcess, time.Second) {
				terminateTestProcess(h, waitProcess)
				t.Fatal("scan error did not terminate the Droid process")
			}
			close(h.done)
		})
	}
}

func TestScanStdoutRejectsProtocolMismatch(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("process-group termination")
	}
	tests := []struct {
		name       string
		mutate     func(*rpcEnvelope)
		wantErrMsg string
	}{
		{
			name: "jsonrpc",
			mutate: func(env *rpcEnvelope) {
				env.JSONRPC = "1.0"
			},
			wantErrMsg: `jsonrpc "1.0"`,
		},
		{
			name: "factory API version",
			mutate: func(env *rpcEnvelope) {
				env.FactoryAPIVersion = "2.0.0"
			},
			wantErrMsg: `factoryApiVersion "2.0.0"`,
		},
		{
			name: "factory protocol version",
			mutate: func(env *rpcEnvelope) {
				env.FactoryProtocolVersion = "9.9.9"
			},
			wantErrMsg: `factoryProtocolVersion "9.9.9"`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			h, writer, waitProcess := newTerminationTestHandle(t)
			h.pending["kin-1"] = methodInitializeSession
			mismatched := responseEnvelope("kin-1", map[string]any{"sessionId": "must-not-start"})
			test.mutate(&mismatched)
			valid := responseEnvelope("kin-1", map[string]any{"sessionId": "must-not-start"})
			input := string(mustMarshal(mismatched)) + "\n" + string(mustMarshal(valid)) + "\n"

			h.scanStdout(context.Background(), strings.NewReader(input), adapter.TaskSpec{Prompt: "must-not-send"})

			select {
			case event := <-h.ch:
				if event.Type != "error" || !strings.Contains(eventErrorMessage(t, event), test.wantErrMsg) {
					t.Fatalf("event=%+v want error containing %q", event, test.wantErrMsg)
				}
			default:
				t.Fatal("protocol mismatch did not emit an error event")
			}
			select {
			case event := <-h.ch:
				t.Fatalf("protocol mismatch continued processing: %+v", event)
			default:
			}
			if len(writer.bytes()) != 0 || !writer.isClosed() {
				terminateTestProcess(h, waitProcess)
				t.Fatalf("writer bytes=%q closed=%v", writer.bytes(), writer.isClosed())
			}
			if !waitForProcessExit(waitProcess, time.Second) {
				terminateTestProcess(h, waitProcess)
				t.Fatal("protocol mismatch did not terminate the Droid process")
			}
			close(h.done)
		})
	}
}

func TestScanStdoutAcceptsMissingFactoryProtocolVersion(t *testing.T) {
	writer := &recordingWriteCloser{}
	h := newServerRequestTestHandle(writer)
	h.parser = NewParser("", "")
	h.pending["kin-1"] = methodInitializeSession
	env := responseEnvelope("kin-1", map[string]any{"sessionId": "session-1"})
	env.FactoryProtocolVersion = ""

	h.scanStdout(context.Background(), strings.NewReader(string(mustMarshal(env))+"\n"), adapter.TaskSpec{Prompt: "continue"})

	select {
	case event := <-h.ch:
		if event.Type != "task_started" {
			t.Fatalf("event=%+v want task_started", event)
		}
	default:
		t.Fatal("missing optional factoryProtocolVersion was rejected")
	}
	var request rpcEnvelope
	if err := json.Unmarshal(bytes.TrimSpace(writer.bytes()), &request); err != nil {
		t.Fatal(err)
	}
	if request.Method != methodAddUserMessage {
		t.Fatalf("request method=%q want=%q", request.Method, methodAddUserMessage)
	}
	close(h.done)
}

func newServerRequestTestHandle(stdin *recordingWriteCloser) *handle {
	return &handle{
		cmd:         &exec.Cmd{},
		stdin:       stdin,
		ch:          make(chan adapter.Event, 1),
		done:        make(chan struct{}),
		cancelRun:   func() {},
		cancelGrace: time.Hour,
		killGrace:   time.Hour,
		pending:     make(map[string]string),
		bridge:      &approvalBridge{},
	}
}

func newTerminationTestHandle(t *testing.T) (*handle, *recordingWriteCloser, <-chan error) {
	t.Helper()
	cmd := exec.Command("sh", "-c", "trap 'exit 0' TERM; while :; do sleep 1; done")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	waitProcess := make(chan error, 1)
	go func() {
		defer close(waitProcess)
		waitProcess <- cmd.Wait()
	}()
	writer := &recordingWriteCloser{}
	h := &handle{
		cmd:         cmd,
		stdin:       writer,
		ch:          make(chan adapter.Event, 4),
		done:        make(chan struct{}),
		cancelRun:   func() {},
		cancelGrace: 10 * time.Millisecond,
		killGrace:   20 * time.Millisecond,
		pending:     make(map[string]string),
		parser:      NewParser("", ""),
		bridge:      &approvalBridge{},
	}
	t.Cleanup(func() {
		select {
		case <-waitProcess:
		default:
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
			<-waitProcess
		}
	})
	return h, writer, waitProcess
}

func waitForProcessExit(waitProcess <-chan error, timeout time.Duration) bool {
	select {
	case <-waitProcess:
		return true
	case <-time.After(timeout):
		return false
	}
}

func terminateTestProcess(h *handle, waitProcess <-chan error) {
	if h.cmd != nil && h.cmd.Process != nil {
		_ = syscall.Kill(-h.cmd.Process.Pid, syscall.SIGKILL)
	}
	<-waitProcess
}

type errorReader struct {
	err error
}

func (r errorReader) Read([]byte) (int, error) {
	return 0, r.err
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func jsonHTTPResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Status:     http.StatusText(status),
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}

type recordingWriteCloser struct {
	mu       sync.Mutex
	buf      bytes.Buffer
	writeErr error
	closed   bool
}

func (w *recordingWriteCloser) Write(data []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.writeErr != nil {
		return 0, w.writeErr
	}
	return w.buf.Write(data)
}

func (w *recordingWriteCloser) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.closed = true
	return nil
}

func (w *recordingWriteCloser) bytes() []byte {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]byte(nil), w.buf.Bytes()...)
}

func (w *recordingWriteCloser) isClosed() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.closed
}

func writeFakeDroid(t *testing.T) (string, string) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "fake-droid")
	logPath := filepath.Join(dir, "protocol.log")
	script := `#!/bin/sh
log="$DROID_FAKE_LOG"
printf 'ARGS:%s\n' "$*" >> "$log"
read_req() {
  IFS= read -r req || return 1
  printf '%s\n' "$req" >> "$log"
}
reply() {
  printf '{"type":"response","jsonrpc":"2.0","factoryApiVersion":"1.0.0","factoryProtocolVersion":"1.193.0","id":"%s","result":%s}\n' "$1" "$2"
}
notify() {
  printf '{"type":"notification","jsonrpc":"2.0","factoryApiVersion":"1.0.0","factoryProtocolVersion":"1.193.0","method":"droid.session_notification","params":{"sessionId":"session-new","notification":%s}}\n' "$1"
}

read_req || exit 2
case "$req" in
  *droid.load_session*)
    load_result='{"session":{"messages":[]},"settings":{"modelId":"old","reasoningEffort":"high"},"workingState":"idle"}'
    case "$DROID_FAKE_MODE" in
      resume_pending_permission)
        load_result='{"session":{"messages":[]},"settings":{"modelId":"old"},"pendingPermissions":[{"requestId":"permission-old"}],"workingState":"idle"}'
        ;;
      resume_pending_ask_user)
        load_result='{"session":{"messages":[]},"settings":{"modelId":"old"},"pendingAskUserRequests":[{"requestId":"ask-old"}],"workingState":"idle"}'
        ;;
      resume_agent_loop)
        load_result='{"session":{"messages":[]},"settings":{"modelId":"old"},"isAgentLoopInProgress":true,"workingState":"idle"}'
        ;;
      resume_working_state)
        load_result='{"session":{"messages":[]},"settings":{"modelId":"old"},"isAgentLoopInProgress":false,"workingState":"executing_tool"}'
        ;;
    esac
    reply kin-1 "$load_result"
    case "$DROID_FAKE_MODE" in
      resume_*)
        trap 'exit 0' TERM
        while read_req; do :; done
        while :; do sleep 1; done
        ;;
    esac
    read_req || exit 3
    reply kin-2 '{}'
    read_req || exit 4
    reply kin-3 '{}'
    ;;
  *)
    reply kin-1 '{"sessionId":"session-new","session":{"messages":[]},"settings":{"modelId":"claude-opus-5","reasoningEffort":"high"}}'
    read_req || exit 5
    reply kin-2 '{}'
    ;;
esac

case "$DROID_FAKE_MODE" in
  success)
    notify '{"type":"future_event","value":1}'
    notify '{"type":"assistant_text_delta","messageId":"m1","blockIndex":0,"textDelta":"done"}'
    notify '{"type":"create_message","message":{"id":"m1","role":"assistant","createdAt":1,"updatedAt":1,"content":[{"type":"text","text":"done"}]}}'
    notify '{"type":"tool_call","toolUse":{"type":"tool_use","id":"tool-1","name":"Execute","input":{"command":"pwd"}}}'
    notify '{"type":"tool_result","messageId":"m2","toolUseId":"tool-1","content":"ok","isError":false}'
    notify '{"type":"agent_turn_completed","reason":"completed","tokenUsage":{"inputTokens":10,"outputTokens":4,"cacheCreationTokens":3,"cacheReadTokens":2,"thinkingTokens":1,"factoryCredits":0.25}}'
    read_req || true
    reply kin-3 '{}'
    ;;
  permission)
    printf '%s\n' '{"type":"request","jsonrpc":"2.0","factoryApiVersion":"1.0.0","factoryProtocolVersion":"1.193.0","id":"permission-1","method":"droid.request_permission","params":{"toolUses":[{"toolUse":{"type":"tool_use","id":"tool-1","name":"Create","input":{"path":"x"}},"confirmationType":"create","details":{"type":"create","filePath":"x","fileName":"x","content":"x"}}],"options":[{"value":"proceed_once","label":"Proceed"},{"value":"cancel","label":"Cancel"}]}}'
    read_req || exit 6
    case "$req" in
      *proceed_once*) reason=completed ;;
      *) reason=permission_rejected ;;
    esac
    notify "{\"type\":\"agent_turn_completed\",\"reason\":\"$reason\",\"tokenUsage\":{\"inputTokens\":1,\"outputTokens\":1,\"cacheCreationTokens\":0,\"cacheReadTokens\":0,\"thinkingTokens\":0}}"
    read_req || true
    ;;
  ask)
    printf '%s\n' '{"type":"request","jsonrpc":"2.0","factoryApiVersion":"1.0.0","factoryProtocolVersion":"1.193.0","id":"ask-1","method":"droid.ask_user","params":{"toolCallId":"tool-ask","questions":[{"index":1,"topic":"Color","question":"Which color?","options":["blue","red"]},{"index":2,"topic":"Style","question":"Which styles?","options":["fast","careful"],"multiSelect":true}]}}'
    read_req || exit 7
    notify '{"type":"agent_turn_completed","reason":"completed","tokenUsage":{"inputTokens":1,"outputTokens":1,"cacheCreationTokens":0,"cacheReadTokens":0,"thinkingTokens":0}}'
    read_req || true
    ;;
  cancel)
    printf 'READY\n' >> "$log"
    trap 'printf "TERM\n" >> "$log"; exit 0' TERM
    while read_req; do
      case "$req" in
        *droid.interrupt_session*) printf 'INTERRUPT\n' >> "$log" ;;
      esac
    done
    while :; do sleep 1; done
    ;;
  exit)
    exit 7
    ;;
  tail)
    i=0
    while [ "$i" -lt 200 ]; do
      notify "{\"type\":\"assistant_text_delta\",\"messageId\":\"m1\",\"blockIndex\":0,\"textDelta\":\"tail-$i \"}"
      i=$((i + 1))
    done
    notify '{"type":"assistant_text_delta","messageId":"m1","blockIndex":0,"textDelta":"tail-final"}'
    notify '{"type":"agent_turn_completed","reason":"completed","tokenUsage":{"inputTokens":1,"outputTokens":1}}'
    ;;
esac
`
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return path, logPath
}

func collectEvents(t *testing.T, handle adapter.RunHandle, timeout time.Duration) []adapter.Event {
	t.Helper()
	var events []adapter.Event
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		select {
		case event, ok := <-handle.Events():
			if !ok {
				return events
			}
			events = append(events, event)
		case <-timer.C:
			t.Fatalf("timed out waiting for events: %v", eventTypes(events))
		}
	}
}

func assertEventTypes(t *testing.T, events []adapter.Event, want ...string) {
	t.Helper()
	got := eventTypes(events)
	for _, typ := range want {
		found := false
		for _, current := range got {
			if current == typ {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("missing event %q in %v", typ, got)
		}
	}
}

func eventTypes(events []adapter.Event) []string {
	types := make([]string, 0, len(events))
	for _, event := range events {
		types = append(types, event.Type)
	}
	return types
}

func eventErrorMessage(t *testing.T, event adapter.Event) string {
	t.Helper()
	var payload struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	return payload.Message
}

func findEvent(t *testing.T, events []adapter.Event, typ string) adapter.Event {
	t.Helper()
	for _, event := range events {
		if event.Type == typ {
			return event
		}
	}
	t.Fatalf("event %q missing in %v", typ, eventTypes(events))
	return adapter.Event{}
}

func readLoggedRequests(t *testing.T, logPath string) []rpcEnvelope {
	t.Helper()
	var requests []rpcEnvelope
	for _, line := range strings.Split(readLog(t, logPath), "\n") {
		if !strings.HasPrefix(line, "{") {
			continue
		}
		var env rpcEnvelope
		if json.Unmarshal([]byte(line), &env) == nil && env.Type == "request" && strings.HasPrefix(env.ID, "kin-") {
			requests = append(requests, env)
		}
	}
	return requests
}

func findLoggedResponse(t *testing.T, logPath, id string) rpcEnvelope {
	t.Helper()
	for _, line := range strings.Split(readLog(t, logPath), "\n") {
		var env rpcEnvelope
		if json.Unmarshal([]byte(line), &env) == nil && env.Type == "response" && env.ID == id {
			assertRequestEnvelope(t, env)
			return env
		}
	}
	t.Fatalf("response %q not found in:\n%s", id, readLog(t, logPath))
	return rpcEnvelope{}
}

func assertRequestEnvelope(t *testing.T, env rpcEnvelope) {
	t.Helper()
	if env.JSONRPC != jsonRPCVersion || env.FactoryAPIVersion != factoryAPIVersion || env.FactoryProtocolVersion != factoryProtocolVersion {
		t.Fatalf("invalid envelope versions: %+v", env)
	}
}

func assertSafeSessionParams(t *testing.T, params map[string]any) {
	t.Helper()
	if _, exists := params["skipPermissionsUnsafe"]; exists {
		t.Fatalf("skipPermissionsUnsafe must be absent: %v", params)
	}
	if _, exists := params["worktree"]; exists {
		t.Fatalf("Droid worktree must be absent: %v", params)
	}
	if disabled, _ := params["disableBuiltinSkills"].(bool); !disabled {
		t.Fatalf("disableBuiltinSkills=%v", params["disableBuiltinSkills"])
	}
	if servers, ok := params["mcpServers"].([]any); !ok || len(servers) != 0 {
		t.Fatalf("mcpServers=%v", params["mcpServers"])
	}
}

func requestMethods(requests []rpcEnvelope) []string {
	methods := make([]string, 0, len(requests))
	for _, request := range requests {
		methods = append(methods, request.Method)
	}
	return methods
}

func readLog(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func waitForLog(t *testing.T, path, marker string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		data, _ := os.ReadFile(path)
		if strings.Contains(string(data), marker) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("marker %q not found in %s", marker, path)
}
