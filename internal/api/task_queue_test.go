package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
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

// A client renders "nothing is waiting" from this response, so an empty queue has
// to be an empty list rather than null: null is what a type-checking client reads
// as "the field is missing", and the waiting markers it would clear then stay up.
func TestQueuedPromptsAPIAnswersAnEmptyQueueWithAnEmptyList(t *testing.T) {
	s, token := newTestServer(t)
	h := s.Handler()
	task := insertRunningTask(t, s, "api-queued-empty")

	req := httptest.NewRequest(http.MethodGet, "/api/tasks/"+task.ID+"/prompts", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	if got := strings.TrimSpace(rr.Body.String()); got != "[]" {
		t.Fatalf("empty queue answered with %s, want []", got)
	}
}

// A message that has not started yet is still the sender's to withdraw. Deleting
// it takes exactly that row, answers 204, and leaves the rest of the queue in
// order; a second delete is an honest 404 because the row is gone.
func TestQueuedPromptCanBeWithdrawnBeforeItRuns(t *testing.T) {
	s, token := newTestServer(t)
	h := s.Handler()
	ctx := context.Background()
	task := insertRunningTask(t, s, "api-withdraw-1")
	other := insertRunningTask(t, s, "api-withdraw-2")

	first, err := s.Store.AppendPendingPrompt(ctx, store.PendingPrompt{
		TaskID: task.ID, Prompt: "keep me", QueuedAt: time.Now().UnixMilli(),
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.Store.AppendPendingPrompt(ctx, store.PendingPrompt{
		TaskID: task.ID, Prompt: "take me back", QueuedAt: time.Now().UnixMilli(),
	})
	if err != nil {
		t.Fatal(err)
	}

	del := func(taskID string, promptID int64) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodDelete,
			"/api/tasks/"+taskID+"/prompts/"+strconv.FormatInt(promptID, 10), nil)
		req.Header.Set("Authorization", "Bearer "+token)
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		return rr
	}

	// Another task's id does not reach this row, whatever the prompt id says.
	if rr := del(other.ID, second.ID); rr.Code != http.StatusNotFound {
		t.Fatalf("cross-task delete: status %d body %s, want 404", rr.Code, rr.Body.String())
	}

	if rr := del(task.ID, second.ID); rr.Code != http.StatusNoContent {
		t.Fatalf("delete: status %d body %s", rr.Code, rr.Body.String())
	}
	left, err := s.Store.ListPendingPrompts(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(left) != 1 || left[0].ID != first.ID {
		t.Fatalf("queue = %+v, want only the first message", left)
	}

	// The message stays in the transcript (events do not change once written), so
	// the withdrawal has to say so there. Without this note every other device
	// would read the bubble as delivered.
	events, err := s.Store.ListEvents(ctx, task.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Type != "notice" {
		t.Fatalf("events = %+v, want one notice about the withdrawal", events)
	}
	var note struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(events[0].Payload, &note); err != nil {
		t.Fatalf("note payload: %v body %s", err, events[0].Payload)
	}
	if note.Code != "prompt_withdrawn" || note.Message == "" {
		t.Fatalf("note = %+v, want the withdrawal code and a message", note)
	}
	// The text is the thing the sender took back; a second copy would defeat it.
	if strings.Contains(note.Message, "take me back") {
		t.Fatalf("withdrawal note repeats the message: %q", note.Message)
	}

	if rr := del(task.ID, second.ID); rr.Code != http.StatusNotFound {
		t.Fatalf("second delete: status %d, want 404", rr.Code)
	}
	// A failed withdrawal writes nothing: only the first delete leaves a note.
	after, err := s.Store.ListEvents(ctx, task.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != len(events) {
		t.Fatalf("a 404 wrote an event: %d notes, want %d", len(after), len(events))
	}
	// A prompt id that is not a number is a client bug, not a missing row.
	req := httptest.NewRequest(http.MethodDelete, "/api/tasks/"+task.ID+"/prompts/abc", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("bad id: status %d, want 400", rr.Code)
	}
}

// The zero anchor is part of the contract: a queued message whose user event failed
// to write reports 0 so the sender can still find the row, and a client that reads
// a missing key as "no anchor field" would drop it instead.
func TestQueuedPromptsAPIAlwaysCarriesTheAnchorField(t *testing.T) {
	s, token := newTestServer(t)
	h := s.Handler()
	ctx := context.Background()
	task := insertRunningTask(t, s, "api-queued-anchor")

	if _, err := s.Store.AppendPendingPrompt(ctx, store.PendingPrompt{
		TaskID: task.ID, Prompt: "no anchor", QueuedAt: time.Now().UnixMilli(),
	}); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/tasks/"+task.ID+"/prompts", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	var raw []map[string]json.RawMessage
	if err := json.Unmarshal(rr.Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	if len(raw) != 1 {
		t.Fatalf("entries = %+v, want the one queued message", raw)
	}
	if _, ok := raw[0]["user_seq"]; !ok {
		t.Fatalf("user_seq is absent from %s, want it present as 0", rr.Body.String())
	}
}

// The note has to reach the other devices live. A console that is not told about
// the event does not refetch the transcript for it, so a withdrawal that only
// wrote the row would look like nothing happened until the next reload — on the
// very devices whose reading of the bubble the note exists to correct.
func TestWithdrawingAQueuedPromptTellsOtherDevices(t *testing.T) {
	s, token := newTestServer(t)
	h := s.Handler()
	ctx := context.Background()
	task := insertRunningTask(t, s, "api-withdraw-live")
	queued, err := s.Store.AppendPendingPrompt(ctx, store.PendingPrompt{
		TaskID: task.ID, Prompt: "never mind", QueuedAt: time.Now().UnixMilli(),
	})
	if err != nil {
		t.Fatal(err)
	}

	ch := s.Engine.Bus().Subscribe()
	defer s.Engine.Bus().Unsubscribe(ch)

	req := httptest.NewRequest(http.MethodDelete,
		"/api/tasks/"+task.ID+"/prompts/"+strconv.FormatInt(queued.ID, 10), nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusNoContent {
		t.Fatalf("delete: status %d body %s", rr.Code, rr.Body.String())
	}

	select {
	case msg := <-ch:
		if msg.Kind != "event" {
			t.Fatalf("kind = %q, want an event", msg.Kind)
		}
		ev, ok := msg.Data.(store.Event)
		if !ok || ev.Type != "notice" {
			t.Fatalf("message = %+v, want the withdrawal notice", msg.Data)
		}
		if ev.TaskID != task.ID {
			t.Fatalf("notice is for %s, want %s", ev.TaskID, task.ID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the withdrawal was not published")
	}
}
