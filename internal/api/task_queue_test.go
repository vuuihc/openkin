package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/store"
)

// A prompt sent to a task that is still working is accepted, not applied, and the
// API is where a client finds out which of its messages are still waiting.

func insertRunningTask(t *testing.T, s *Server, id string) store.Task {
	t.Helper()
	task := store.Task{
		ID: id, Title: "busy", Agent: "claude-code", Cwd: "/tmp",
		Prompt: "start", Status: "running", CreatedAt: time.Now().UnixMilli(),
	}
	if err := s.Store.InsertTask(context.Background(), task); err != nil {
		t.Fatal(err)
	}
	return task
}

func TestQueuedPromptsAPIReportsWhatIsStillWaiting(t *testing.T) {
	s, token := newTestServer(t)
	h := s.Handler()
	ctx := context.Background()
	task := insertRunningTask(t, s, "api-queued-1")

	for _, text := range []string{"first waiting", "second waiting"} {
		body, _ := json.Marshal(map[string]any{"prompt": text})
		req := httptest.NewRequest(http.MethodPost, "/api/tasks/"+task.ID+"/prompt", strings.NewReader(string(body)))
		req.Header.Set("Authorization", "Bearer "+token)
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("prompt %q: status %d body %s", text, rr.Code, rr.Body.String())
		}
		// The task itself is left where it was: a queued prompt is not applied yet.
		var got store.Task
		if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		if got.Status != "running" {
			t.Fatalf("prompt %q moved the task to %s, want it left running", text, got.Status)
		}
	}

	req := httptest.NewRequest(http.MethodGet, "/api/tasks/"+task.ID+"/prompts", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("list queued: status %d body %s", rr.Code, rr.Body.String())
	}
	var queued []struct {
		Prompt  string `json:"prompt"`
		UserSeq int    `json:"user_seq"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &queued); err != nil {
		t.Fatalf("list queued json: %v body %s", err, rr.Body.String())
	}
	if len(queued) != 2 {
		t.Fatalf("queued = %+v, want the two prompts that were sent", queued)
	}
	if queued[0].Prompt != "first waiting" || queued[1].Prompt != "second waiting" {
		t.Fatalf("queued order = %q, %q; want send order", queued[0].Prompt, queued[1].Prompt)
	}
	// The seq is what a client uses to mark the message in the transcript as
	// waiting, so a zero here would leave it looking answered.
	if queued[0].UserSeq <= 0 {
		t.Fatalf("queued entry has no user_seq: %+v", queued[0])
	}
	stored, err := s.Store.ListPendingPrompts(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(stored) != 2 || stored[0].UserSeq != queued[0].UserSeq {
		t.Fatalf("api reported %+v, store holds %+v", queued, stored)
	}
}

func TestQueuedPromptsAPIRequiresTheTaskAndTheToken(t *testing.T) {
	s, token := newTestServer(t)
	h := s.Handler()

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/tasks/nope/prompts", nil))
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("no auth: status %d, want 401", rr.Code)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/tasks/nope/prompts", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusNotFound {
		t.Fatalf("unknown task: status %d body %s, want 404", rr.Code, rr.Body.String())
	}
}

// The interrupt flag has to survive the wire: it is the difference between a
// message that waits and a message that costs the work in flight.
func TestPromptInterruptFlagChangesWhatTheAPIDoes(t *testing.T) {
	s, token := newTestServer(t)
	h := s.Handler()

	post := func(id string, body map[string]any) store.Task {
		t.Helper()
		raw, _ := json.Marshal(body)
		req := httptest.NewRequest(http.MethodPost, "/api/tasks/"+id+"/prompt", strings.NewReader(string(raw)))
		req.Header.Set("Authorization", "Bearer "+token)
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("prompt %v: status %d body %s", body, rr.Code, rr.Body.String())
		}
		var got store.Task
		if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		return got
	}

	// No flag: waits.
	waiting := insertRunningTask(t, s, "api-interrupt-1")
	if got := post(waiting.ID, map[string]any{"prompt": "when you get a chance"}); got.Status != "running" {
		t.Fatalf("status = %s, want the task left running", got.Status)
	}

	// Explicit interrupt: the turn is cut short and the prompt takes its place.
	cutting := insertRunningTask(t, s, "api-interrupt-2")
	if got := post(cutting.ID, map[string]any{"prompt": "stop and do this", "interrupt": true}); got.Status != "queued" {
		t.Fatalf("status = %s, want the interrupted task re-queued with the new prompt", got.Status)
	}
}
