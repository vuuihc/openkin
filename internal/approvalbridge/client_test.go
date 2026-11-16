package approvalbridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestClientCreateRequests(t *testing.T) {
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer token-1" {
			t.Errorf("authorization=%q", r.Header.Get("Authorization"))
		}
		if r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("content-type=%q", r.Header.Get("Content-Type"))
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		paths = append(paths, r.URL.Path)
		switch r.URL.Path {
		case "/internal/approvals":
			if body["task_id"] != "task-1" || body["kind"] != "tool_use" ||
				body["execution_id"] != "exec-1" || body["execution_agent"] != "droid" ||
				body["execution_step"] != float64(2) || body["execution_model"] != "model-1" {
				t.Errorf("approval body=%v", body)
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"id": "approval-1"})
		case "/internal/user-questions":
			if body["question"] != "Choose" || body["header"] != "Mode" ||
				body["multi_select"] != true {
				t.Errorf("question body=%v", body)
			}
			options, _ := body["options"].([]any)
			if len(options) != 2 {
				t.Errorf("question options=%v", body["options"])
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"id": "question-1"})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	client := &Client{DaemonURL: server.URL, Token: "token-1", HTTPClient: server.Client()}
	exec := Execution{ID: "exec-1", Agent: "droid", Step: 2, Model: "model-1"}
	approvalID, err := client.CreateApproval(context.Background(), "task-1", "tool_use", json.RawMessage(`{"name":"Write"}`), exec)
	if err != nil {
		t.Fatal(err)
	}
	questionID, err := client.CreateUserQuestion(context.Background(), "task-1", Question{
		Text:        "Choose",
		Header:      "Mode",
		Options:     []QuestionOption{{Label: "safe"}, {Label: "fast", Description: "skip checks"}},
		MultiSelect: true,
	}, exec)
	if err != nil {
		t.Fatal(err)
	}
	if approvalID != "approval-1" || questionID != "question-1" {
		t.Fatalf("approval=%q question=%q", approvalID, questionID)
	}
	if strings.Join(paths, ",") != "/internal/approvals,/internal/user-questions" {
		t.Fatalf("paths=%v", paths)
	}
}

func TestClientWaitApproval(t *testing.T) {
	t.Run("polls pending and retries transient network errors", func(t *testing.T) {
		var calls atomic.Int32
		client := &Client{
			DaemonURL: "http://kin.invalid",
			HTTPClient: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
				switch calls.Add(1) {
				case 1:
					return nil, errors.New("temporary connection reset")
				case 2:
					return jsonResponse(http.StatusOK, `{"decision":"pending"}`), nil
				default:
					return jsonResponse(http.StatusOK, `{"decision":"approved"}`), nil
				}
			})},
			RetryDelay: time.Millisecond,
		}
		decision, err := client.WaitApproval(context.Background(), "approval-1")
		if err != nil {
			t.Fatal(err)
		}
		if decision != "approved" || calls.Load() != 3 {
			t.Fatalf("decision=%q calls=%d", decision, calls.Load())
		}
	})

	t.Run("does not retry non-2xx responses", func(t *testing.T) {
		var calls atomic.Int32
		client := &Client{
			DaemonURL: "http://kin.invalid",
			HTTPClient: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
				calls.Add(1)
				return jsonResponse(http.StatusUnauthorized, `denied`), nil
			})},
			RetryDelay: time.Millisecond,
		}
		_, err := client.WaitApproval(context.Background(), "approval-1")
		if err == nil || !strings.Contains(err.Error(), "401") {
			t.Fatalf("err=%v", err)
		}
		if calls.Load() != 1 {
			t.Fatalf("non-2xx requests=%d want=1", calls.Load())
		}
	})
}

func TestClientWaitUserQuestion(t *testing.T) {
	var calls atomic.Int32
	client := &Client{
		DaemonURL: "http://kin.invalid",
		HTTPClient: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			if calls.Add(1) == 1 {
				return jsonResponse(http.StatusOK, `{"status":"pending"}`), nil
			}
			return jsonResponse(http.StatusOK, `{"status":"answered","response":{"selected":["blue"],"other_text":"navy"}}`), nil
		})},
	}
	answer, err := client.WaitUserQuestion(context.Background(), "question-1")
	if err != nil {
		t.Fatal(err)
	}
	if answer.Status != "answered" || strings.Join(answer.Selected, ",") != "blue" ||
		answer.OtherText != "navy" || !json.Valid(answer.Raw) {
		t.Fatalf("answer=%+v raw=%s", answer, answer.Raw)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func jsonResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Status:     fmt.Sprintf("%d %s", status, http.StatusText(status)),
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}
