package approvemcp

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestToolsListIncludesAskUserQuestion(t *testing.T) {
	s := &server{err: io.Discard}
	resp := s.handleToolsList(rpcRequest{ID: json.RawMessage(`1`)})
	raw, _ := json.Marshal(resp.Result)
	var result struct {
		Tools []struct {
			Name string `json:"name"`
		} `json:"tools"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, tool := range result.Tools {
		names[tool.Name] = true
	}
	if !names["approve"] || !names["ask_user_question"] {
		t.Fatalf("tools=%v", names)
	}
}

func TestToolsCallUnknownTool(t *testing.T) {
	s := &server{err: io.Discard}
	resp := s.handleToolsCall(context.Background(), rpcRequest{
		ID:     json.RawMessage(`2`),
		Params: json.RawMessage(`{"name":"nope","arguments":{}}`),
	})
	if resp.Error == nil || resp.Error.Code != -32602 {
		t.Fatalf("want -32602, got %+v", resp.Error)
	}
}

func TestAskUserQuestionToolResult(t *testing.T) {
	var mu sync.Mutex
	var createdID string
	answerOnce := make(chan struct{}, 1)
	answerOnce <- struct{}{}

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/internal/user-questions":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["task_id"] != "task-1" {
				t.Errorf("task_id=%v", body["task_id"])
			}
			opts, _ := body["options"].([]any)
			if len(opts) < 2 {
				http.Error(w, "bad options", 400)
				return
			}
			mu.Lock()
			createdID = "uq-1"
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "uq-1", "status": "pending"})
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/internal/user-questions/"):
			// First wait returns pending; after "answer" returns answered.
			select {
			case <-answerOnce:
				_ = json.NewEncoder(w).Encode(map[string]any{
					"id": "uq-1", "status": "pending",
				})
			default:
				_ = json.NewEncoder(w).Encode(map[string]any{
					"id":       "uq-1",
					"status":   "answered",
					"response": json.RawMessage(`{"selected":["JWT"],"other_text":""}`),
				})
			}
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(ts.Close)

	s := &server{
		taskID: "task-1",
		daemon: ts.URL,
		token:  "tok",
		client: ts.Client(),
		err:    io.Discard,
	}
	args := map[string]any{
		"question": "Which auth?",
		"header":   "Auth",
		"options": []map[string]any{
			{"label": "JWT"},
			{"label": "Session"},
		},
	}
	argRaw, _ := json.Marshal(args)
	params, _ := json.Marshal(map[string]any{"name": "ask_user_question", "arguments": json.RawMessage(argRaw)})
	resp := s.handleToolsCall(context.Background(), rpcRequest{
		ID:     json.RawMessage(`3`),
		Params: params,
	})
	if resp.Error != nil {
		t.Fatalf("error: %+v", resp.Error)
	}
	text := toolResultText(t, resp)
	var out map[string]any
	if err := json.Unmarshal([]byte(text), &out); err != nil {
		t.Fatalf("result text=%s err=%v", text, err)
	}
	// Must not be the allow/deny envelope.
	if _, ok := out["behavior"]; ok {
		t.Fatalf("must not use behavior envelope: %s", text)
	}
	sel, _ := out["selected"].([]any)
	if len(sel) != 1 || sel[0] != "JWT" {
		t.Fatalf("selected=%v text=%s", sel, text)
	}
	mu.Lock()
	if createdID != "uq-1" {
		t.Fatalf("createdID=%s", createdID)
	}
	mu.Unlock()
}

func TestAskUserQuestionFailOpen(t *testing.T) {
	// Daemon always errors → neutral fallback, not deny.
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "down", 500)
	}))
	t.Cleanup(ts.Close)
	s := &server{
		taskID: "task-1",
		daemon: ts.URL,
		token:  "tok",
		client: ts.Client(),
		err:    io.Discard,
	}
	params, _ := json.Marshal(map[string]any{
		"name": "ask_user_question",
		"arguments": map[string]any{
			"question": "Q?",
			"options":  []map[string]any{{"label": "A"}, {"label": "B"}},
		},
	})
	resp := s.handleToolsCall(context.Background(), rpcRequest{
		ID:     json.RawMessage(`4`),
		Params: params,
	})
	text := toolResultText(t, resp)
	if !strings.Contains(text, "no response") {
		t.Fatalf("want fail-open note, got %s", text)
	}
	if strings.Contains(text, `"behavior"`) {
		t.Fatalf("must not deny-envelope: %s", text)
	}
}

func toolResultText(t *testing.T, resp rpcResponse) string {
	t.Helper()
	raw, _ := json.Marshal(resp.Result)
	var result struct {
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Content) == 0 {
		t.Fatalf("no content: %s", raw)
	}
	return result.Content[0].Text
}

// silence unused import if any
var _ = time.Second
