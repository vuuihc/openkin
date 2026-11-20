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
// The order the console shows has to be the order the agent answers in, so the
// reorder route is a write to the delivery queue, not a display preference.
// These are its four answers: applied, stale (409), malformed (400), and the
// message already gone (404).

func appendQueuedPrompts(t *testing.T, s *Server, taskID string, texts ...string) []store.PendingPrompt {
	t.Helper()
	ctx := context.Background()
	out := make([]store.PendingPrompt, 0, len(texts))
	for _, text := range texts {
		p, err := s.Store.AppendPendingPrompt(ctx, store.PendingPrompt{
			TaskID: taskID, Prompt: text, QueuedAt: time.Now().UnixMilli(),
		})
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, p)
	}
	return out
}

func reorderQueuedPrompts(t *testing.T, s *Server, token, taskID, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPut,
		"/api/tasks/"+taskID+"/prompts/order", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	s.Handler().ServeHTTP(rr, req)
	return rr
}

func idsBody(ids ...int64) string {
	if ids == nil {
		ids = []int64{}
	}
	raw, _ := json.Marshal(map[string]any{"ids": ids})
	return string(raw)
}

func queuedOrder(t *testing.T, s *Server, taskID string) []string {
	t.Helper()
	rows, err := s.Store.ListPendingPrompts(context.Background(), taskID)
	if err != nil {
		t.Fatal(err)
	}
	out := make([]string, 0, len(rows))
	for _, row := range rows {
		out = append(out, row.Prompt)
	}
	return out
}

func assertOrder(t *testing.T, got []string, want ...string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("queue = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("queue = %v, want %v", got, want)
		}
	}
}

// A list that is not the current queue is refused whole. The daemon's queue is
// the truth: a partial list would either drop a message from the order or
// invent one, and neither is an order the sender asked for.
func TestReorderQueuedPromptsRejectsNonPermutation(t *testing.T) {
	s, token := newTestServer(t)
	task := insertRunningTask(t, s, "api-order-conflict")
	rows := appendQueuedPrompts(t, s, task.ID, "a", "b", "c")

	// One currently queued id is missing.
	if rr := reorderQueuedPrompts(t, s, token, task.ID,
		idsBody(rows[0].ID, rows[1].ID)); rr.Code != http.StatusConflict {
		t.Fatalf("missing id: status %d body %s, want 409", rr.Code, rr.Body.String())
	}

	// An id that is not queued cannot be ordered either; a stale or foreign
	// list gets the same answer as a missing one, whether it is longer than the
	// queue or replaces one of its ids.
	extra := idsBody(rows[0].ID, rows[1].ID, rows[2].ID, rows[2].ID+1000)
	if rr := reorderQueuedPrompts(t, s, token, task.ID, extra); rr.Code != http.StatusConflict {
		t.Fatalf("extra id: status %d body %s, want 409", rr.Code, rr.Body.String())
	}
	swapped := idsBody(rows[0].ID, rows[1].ID, rows[2].ID+1000)
	if rr := reorderQueuedPrompts(t, s, token, task.ID, swapped); rr.Code != http.StatusConflict {
		t.Fatalf("swapped id: status %d body %s, want 409", rr.Code, rr.Body.String())
	}

	// Neither refused list moved anything.
	assertOrder(t, queuedOrder(t, s, task.ID), "a", "b", "c")
	stored, err := s.Store.ListPendingPrompts(context.Background(), task.ID)
	if err != nil {
		t.Fatal(err)
	}
	for i, want := range []string{"a", "b", "c"} {
		if stored[i].ID != rows[i].ID || stored[i].Prompt != want || stored[i].Position != int64(i+1) {
			t.Fatalf("row %d = (%d, %q, position %d), want (%d, %q, %d)",
				i, stored[i].ID, stored[i].Prompt, stored[i].Position, rows[i].ID, want, i+1)
		}
	}
}

// Sending the order the queue already has is a no-op, not an error: a client
// that retries after a dropped response must not be told its order was wrong.
func TestReorderQueuedPromptsIdempotent(t *testing.T) {
	s, token := newTestServer(t)
	task := insertRunningTask(t, s, "api-order-idempotent")
	rows := appendQueuedPrompts(t, s, task.ID, "a", "b", "c")
	body := idsBody(rows[2].ID, rows[0].ID, rows[1].ID)

	first := reorderQueuedPrompts(t, s, token, task.ID, body)
	if first.Code != http.StatusOK {
		t.Fatalf("first reorder: status %d body %s", first.Code, first.Body.String())
	}
	var applied []struct {
		ID       int64  `json:"id"`
		Prompt   string `json:"prompt"`
		Position int64  `json:"position"`
		UserSeq  int    `json:"user_seq"`
	}
	if err := json.Unmarshal(first.Body.Bytes(), &applied); err != nil {
		t.Fatalf("reorder json: %v body %s", err, first.Body.String())
	}
	if len(applied) != 3 {
		t.Fatalf("reorder returned %+v, want the whole queue", applied)
	}
	for i, want := range []string{"c", "a", "b"} {
		if applied[i].Prompt != want || applied[i].Position != int64(i+1) {
			t.Fatalf("row %d = (%q, position %d), want (%q, %d)",
				i, applied[i].Prompt, applied[i].Position, want, i+1)
		}
	}

	second := reorderQueuedPrompts(t, s, token, task.ID, body)
	if second.Code != http.StatusOK {
		t.Fatalf("repeat reorder: status %d body %s", second.Code, second.Body.String())
	}
	// The answer is the whole queue in the GET shape, so the two must agree
	// byte for byte -- there is no separate reorder projection to drift.
	if second.Body.String() != first.Body.String() {
		t.Fatalf("repeat answer = %s, want %s", second.Body.String(), first.Body.String())
	}
	req := httptest.NewRequest(http.MethodGet, "/api/tasks/"+task.ID+"/prompts", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	s.Handler().ServeHTTP(rr, req)
	if rr.Code != http.StatusOK || rr.Body.String() != first.Body.String() {
		t.Fatalf("GET after reorder = %d %s, want the reorder answer %s",
			rr.Code, rr.Body.String(), first.Body.String())
	}
	assertOrder(t, queuedOrder(t, s, task.ID), "c", "a", "b")
}

// A list cannot express an order if an id appears twice or is not a row id at
// all; those are client bugs, and the queue is left alone.
func TestReorderQueuedPromptsRejectsDuplicateAndNonPositive(t *testing.T) {
	s, token := newTestServer(t)
	task := insertRunningTask(t, s, "api-order-bad")
	rows := appendQueuedPrompts(t, s, task.ID, "a", "b")

	cases := []struct {
		name string
		body string
	}{
		{"duplicate", idsBody(rows[0].ID, rows[0].ID, rows[1].ID)},
		{"zero", idsBody(rows[0].ID, 0, rows[1].ID)},
		{"negative", idsBody(rows[0].ID, -3, rows[1].ID)},
		{"not a number", `{"ids":["nope"]}`},
		{"missing field", `{}`},
		{"not json", `nonsense`},
	}
	for _, tc := range cases {
		if rr := reorderQueuedPrompts(t, s, token, task.ID, tc.body); rr.Code != http.StatusBadRequest {
			t.Fatalf("%s: status %d body %s, want 400", tc.name, rr.Code, rr.Body.String())
		}
	}
	assertOrder(t, queuedOrder(t, s, task.ID), "a", "b")
}

// 404 is only for a task that does not exist. A turn boundary can deliver the
// head between the caller's read and its write, and the resulting list is
// stale in the same way as one that omits a queued id: after the row is gone a
// delivered id and a never-queued id are the same observable state, so both
// answer 409 and the caller refetches the daemon's queue (ADR 0033).
func TestReorderQueuedPromptsUnknownTaskOrPoppedID(t *testing.T) {
	s, token := newTestServer(t)

	if rr := reorderQueuedPrompts(t, s, token, "nope", idsBody()); rr.Code != http.StatusNotFound {
		t.Fatalf("unknown task: status %d body %s, want 404", rr.Code, rr.Body.String())
	}

	task := insertRunningTask(t, s, "api-order-popped")
	rows := appendQueuedPrompts(t, s, task.ID, "a", "b", "c")
	if _, ok, err := s.Store.PopPendingPrompt(context.Background(), task.ID); err != nil || !ok {
		t.Fatalf("deliver the head = (ok=%v, err=%v)", ok, err)
	}

	if rr := reorderQueuedPrompts(t, s, token, task.ID,
		idsBody(rows[0].ID, rows[1].ID, rows[2].ID)); rr.Code != http.StatusConflict {
		t.Fatalf("popped id: status %d body %s, want 409", rr.Code, rr.Body.String())
	}
	// The refusal changed nothing: the surviving rows keep their order and
	// their positions, so a refetch renders exactly what the daemon holds.
	left, err := s.Store.ListPendingPrompts(context.Background(), task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(left) != 2 || left[0].ID != rows[1].ID || left[1].ID != rows[2].ID {
		t.Fatalf("queue after the refusal = %+v, want b then c", left)
	}
	if left[0].Position != 2 || left[1].Position != 3 {
		t.Fatalf("positions after the refusal = %d, %d; want them untouched",
			left[0].Position, left[1].Position)
	}
}

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
