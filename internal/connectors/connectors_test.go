package connectors

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

type auditRecorder struct {
	mu      sync.Mutex
	records []Audit
}

func (r *auditRecorder) RecordConnectorAudit(_ context.Context, audit Audit) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.records = append(r.records, audit)
	return nil
}

func (r *auditRecorder) last() Audit {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.records[len(r.records)-1]
}

func TestStdioToolsCallAndAudit(t *testing.T) {
	withConnectorHelper(t, "")
	recorder := &auditRecorder{}
	manager := NewManager(nil, recorder)
	cfg := Config{
		ID:         "fixture",
		Kind:       KindStdio,
		Command:    os.Args[0],
		Args:       []string{"-test.run=TestConnectorHelper"},
		AllowTools: []string{"echo"},
	}
	if err := manager.Register(cfg); err != nil {
		t.Fatal(err)
	}

	tools, err := manager.Tools(context.Background(), cfg.ID)
	if err != nil {
		t.Fatalf("Tools() error = %v", err)
	}
	if len(tools) != 1 || tools[0].Name != "echo" {
		t.Fatalf("Tools() = %+v, want only echo", tools)
	}

	result, err := manager.Call(context.Background(), Call{
		ConnectorID: cfg.ID,
		TaskID:      "task-1",
		Principal:   "test",
		Tool:        "echo",
		Arguments:   map[string]any{"value": "hello"},
	})
	if err != nil {
		t.Fatalf("Call() error = %v", err)
	}
	if result.IsError {
		t.Fatal("Call() returned an error result")
	}
	content, ok := result.Content.([]any)
	if !ok || len(content) != 1 {
		t.Fatalf("result content = %#v, want one content item", result.Content)
	}
	if got := recorder.last(); !got.Success || got.ApprovalDecision != "allowlist" ||
		got.ConnectorID != cfg.ID || got.Tool != "echo" || got.ArgumentsHash == "" {
		t.Fatalf("audit = %+v", got)
	}
}

func TestCallDeniedAndDisabledAreAudited(t *testing.T) {
	withConnectorHelper(t, "")
	recorder := &auditRecorder{}
	manager := NewManager(nil, recorder)
	cfg := Config{
		ID:         "fixture",
		Kind:       KindStdio,
		Command:    os.Args[0],
		Args:       []string{"-test.run=TestConnectorHelper"},
		AllowTools: []string{"echo"},
	}
	if err := manager.Register(cfg); err != nil {
		t.Fatal(err)
	}
	_, err := manager.Call(context.Background(), Call{ConnectorID: cfg.ID, Tool: "secret"})
	if !errors.Is(err, ErrToolDenied) {
		t.Fatalf("denied error = %v", err)
	}
	if got := recorder.last(); got.Success || got.ApprovalDecision != "denied" ||
		!strings.Contains(got.Error, "not allowlisted") {
		t.Fatalf("denied audit = %+v", got)
	}
	if err := manager.Disable(cfg.ID, true); err != nil {
		t.Fatal(err)
	}
	_, err = manager.Call(context.Background(), Call{ConnectorID: cfg.ID, Tool: "echo"})
	if !errors.Is(err, ErrDisabled) {
		t.Fatalf("disabled error = %v", err)
	}
}

func TestStdioOutputLimitAndCancellation(t *testing.T) {
	t.Run("output limit", func(t *testing.T) {
		withConnectorHelper(t, "large")
		manager := NewManager(nil, nil)
		cfg := Config{
			ID:         "fixture",
			Kind:       KindStdio,
			Command:    os.Args[0],
			Args:       []string{"-test.run=TestConnectorHelper"},
			AllowTools: []string{"echo"},
			MaxOutput:  128,
			TimeoutMS:  1000,
		}
		if err := manager.Register(cfg); err != nil {
			t.Fatal(err)
		}
		_, err := manager.Call(context.Background(), Call{ConnectorID: cfg.ID, Tool: "echo"})
		if !errors.Is(err, ErrOutputTooLarge) {
			t.Fatalf("error = %v, want ErrOutputTooLarge", err)
		}
	})

	t.Run("context cancellation", func(t *testing.T) {
		withConnectorHelper(t, "sleep")
		manager := NewManager(nil, nil)
		cfg := Config{
			ID:         "fixture",
			Kind:       KindStdio,
			Command:    os.Args[0],
			Args:       []string{"-test.run=TestConnectorHelper"},
			AllowTools: []string{"echo"},
			TimeoutMS:  30,
		}
		if err := manager.Register(cfg); err != nil {
			t.Fatal(err)
		}
		start := time.Now()
		_, err := manager.Call(context.Background(), Call{ConnectorID: cfg.ID, Tool: "echo"})
		if err == nil || time.Since(start) > time.Second {
			t.Fatalf("cancellation error = %v, elapsed = %s", err, time.Since(start))
		}
	})
}

func TestHTTPCallSSEAndCredential(t *testing.T) {
	withConnectorHelper(t, "")
	secrets := &mapSecretStore{values: map[string]string{"token": "secret-value"}}
	manager := NewManager(secrets, nil)
	manager.client = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if got := req.Header.Get("Authorization"); got != "Bearer secret-value" {
			return nil, fmt.Errorf("authorization = %q", got)
		}
		body, err := io.ReadAll(req.Body)
		if err != nil {
			return nil, err
		}
		var request struct {
			JSONRPC string `json:"jsonrpc"`
			ID      int64  `json:"id"`
			Method  string `json:"method"`
		}
		if err := json.Unmarshal(body, &request); err != nil {
			return nil, err
		}
		payload := fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"result":{"content":[{"type":"text","text":"ok"}]}}`, request.ID)
		return &http.Response{
			StatusCode: http.StatusOK,
			Status:     "200 OK",
			Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
			Body:       io.NopCloser(strings.NewReader("data: " + payload + "\n\n")),
		}, nil
	})}
	cfg := Config{
		ID:            "remote",
		Kind:          KindHTTP,
		URL:           "https://connector.example.test/mcp",
		AllowDomains:  []string{"example.test"},
		AllowTools:    []string{"echo"},
		CredentialRef: "token",
	}
	if err := manager.Register(cfg); err != nil {
		t.Fatal(err)
	}
	result, err := manager.Call(context.Background(), Call{ConnectorID: cfg.ID, Tool: "echo"})
	if err != nil {
		t.Fatalf("HTTP Call() error = %v", err)
	}
	if result.IsError {
		t.Fatal("HTTP Call() returned an error result")
	}
}

func TestHTTPCredentialErrorsAndUnsafeURL(t *testing.T) {
	manager := NewManager(nil, nil)
	cfg := Config{
		ID:            "remote",
		Kind:          KindHTTP,
		URL:           "https://connector.example.test/mcp",
		AllowDomains:  []string{"example.test"},
		AllowTools:    []string{"echo"},
		CredentialRef: "token",
	}
	if err := manager.Register(cfg); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Call(context.Background(), Call{ConnectorID: cfg.ID, Tool: "echo"}); err == nil || !strings.Contains(err.Error(), "secret store") {
		t.Fatalf("credential error = %v", err)
	}
	for _, raw := range []string{"http://example.test/mcp", "https://127.0.0.1/mcp", "https://example.test.evil/mcp"} {
		cfg.URL = raw
		if err := ValidateConfig(cfg); !errors.Is(err, ErrUnsafeURL) {
			t.Errorf("ValidateConfig(%q) error = %v, want ErrUnsafeURL", raw, err)
		}
	}
}

func withConnectorHelper(t *testing.T, mode string) {
	t.Helper()
	if mode == "" {
		mode = "normal"
	}
	old, had := os.LookupEnv("OPENKIN_CONNECTOR_HELPER")
	if err := os.Setenv("OPENKIN_CONNECTOR_HELPER", mode); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if had {
			_ = os.Setenv("OPENKIN_CONNECTOR_HELPER", old)
		} else {
			_ = os.Unsetenv("OPENKIN_CONNECTOR_HELPER")
		}
	})
}

func TestConnectorHelper(t *testing.T) {
	mode := os.Getenv("OPENKIN_CONNECTOR_HELPER")
	if mode == "" {
		return
	}
	if mode == "sleep" {
		time.Sleep(time.Second)
		return
	}
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var request struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &request); err != nil || request.Method == "notifications/initialized" {
			continue
		}
		var result any
		switch request.Method {
		case "initialize":
			result = map[string]any{"protocolVersion": mcpProtocolVersion}
		case "tools/list":
			result = map[string]any{"tools": []Tool{
				{Name: "echo", Description: "echo"},
				{Name: "secret", Description: "secret"},
			}}
		case "tools/call":
			if mode == "large" {
				result = map[string]any{"content": []map[string]string{{"type": "text", "text": strings.Repeat("x", 512)}}}
			} else {
				result = map[string]any{"content": []map[string]string{{"type": "text", "text": "ok"}}}
			}
		default:
			result = map[string]any{}
		}
		response := map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(request.ID), "result": result}
		data, _ := json.Marshal(response)
		_, _ = os.Stdout.Write(append(data, '\n'))
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

type mapSecretStore struct {
	values map[string]string
}

func (s *mapSecretStore) Get(ref string) (string, error) {
	value, ok := s.values[ref]
	if !ok {
		return "", os.ErrNotExist
	}
	return value, nil
}

func (s *mapSecretStore) Put(ref, value string) error {
	s.values[ref] = value
	return nil
}

func (s *mapSecretStore) Delete(ref string) error {
	delete(s.values, ref)
	return nil
}
