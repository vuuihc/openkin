package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/vuuihc/openkin/internal/node"
)

// apiTaskReader is one machine's own task store, answering the two questions a
// console asks when it opens a run from the relayed feed.
type apiTaskReader struct {
	task      node.RoutineAnswer
	events    node.RoutineAnswer
	eventsSeq int
	eventsID  string
}

func (r *apiTaskReader) Task(context.Context, string) (node.RoutineAnswer, error) {
	return r.task, nil
}

func (r *apiTaskReader) TaskEvents(_ context.Context, id string, sinceSeq int) (node.RoutineAnswer, error) {
	r.eventsID = id
	r.eventsSeq = sinceSeq
	return r.events, nil
}

// askMachineTask sends one task question to the Hub, naming a machine.
func askMachineTask(t *testing.T, s *Server, master, path string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("Authorization", "Bearer "+master)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	return rec
}

// A run listed by the Routines page lives in the store of the machine that ran
// it, so opening it asks that machine — not this Hub's task table, which has
// never seen the id. The machine's console answer is what the console reads:
// same status, same content type, same body.
func TestMachineTaskIsReadFromTheMachineThatOwnsIt(t *testing.T) {
	s, master, conns := machinesServer(t)
	reader := &apiTaskReader{
		task: node.RoutineAnswer{
			Status:      http.StatusOK,
			ContentType: "application/json",
			Body:        []byte(`{"id":"t-1","title":"Morning review","status":"succeeded"}`),
		},
	}
	deviceID := dialMachine(t, s, conns, master, &node.Responder{
		Roots: []string{t.TempDir()},
		Tasks: reader,
	})

	rec := askMachineTask(t, s, master, "/api/machines/"+deviceID+"/tasks/t-1")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want the machine's own 200: %s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("content type = %q", got)
	}
	if got := rec.Body.String(); got != `{"id":"t-1","title":"Morning review","status":"succeeded"}` {
		t.Fatalf("body = %q, want the machine's answer unchanged", got)
	}
}

// The transcript read carries the console's own since_seq to the machine, so a
// second read asks for what changed rather than for the whole transcript again.
func TestMachineTaskEventsCarrySinceSeqToTheMachine(t *testing.T) {
	s, master, conns := machinesServer(t)
	reader := &apiTaskReader{
		events: node.RoutineAnswer{
			Status:      http.StatusOK,
			ContentType: "application/json",
			Body:        []byte(`[{"seq":8,"type":"message"}]`),
		},
	}
	deviceID := dialMachine(t, s, conns, master, &node.Responder{
		Roots: []string{t.TempDir()},
		Tasks: reader,
	})

	rec := askMachineTask(t, s, master, "/api/machines/"+deviceID+"/tasks/t-1/events?since_seq=7")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if got := rec.Body.String(); got != `[{"seq":8,"type":"message"}]` {
		t.Fatalf("body = %q, want the machine's events", got)
	}
	if reader.eventsID != "t-1" || reader.eventsSeq != 7 {
		t.Fatalf("the machine was asked %q since %d, want t-1 since 7", reader.eventsID, reader.eventsSeq)
	}
}

// The machine's status is part of its answer: a run that is gone is a 404
// because the machine said so, not because this Hub decided what its words
// meant.
func TestMachineTaskPassesTheMachinesRefusalThrough(t *testing.T) {
	s, master, conns := machinesServer(t)
	reader := &apiTaskReader{
		task: node.RoutineAnswer{Status: http.StatusNotFound, Body: []byte(`{"error":"not found"}`)},
	}
	deviceID := dialMachine(t, s, conns, master, &node.Responder{
		Roots: []string{t.TempDir()},
		Tasks: reader,
	})

	rec := askMachineTask(t, s, master, "/api/machines/"+deviceID+"/tasks/gone")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want the machine's own 404: %s", rec.Code, rec.Body.String())
	}
}

// An id that is not one console path segment is refused at the Hub, before any
// machine is asked.
func TestMachineTaskRefusesAnIDThatCouldBeAnotherRoute(t *testing.T) {
	s, master, _ := machinesServer(t)
	rec := askMachineTask(t, s, master, "/api/machines/self/tasks/..%2Fevents")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for an id that leaves the route", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "path segment") {
		t.Fatalf("the refusal does not name the boundary: %s", rec.Body.String())
	}
}

// A transcript cursor is a non-negative integer, and a bad one is the caller's
// mistake rather than something to send to a machine.
func TestMachineTaskEventsRefuseABadSinceSeq(t *testing.T) {
	s, master, _ := machinesServer(t)
	rec := askMachineTask(t, s, master, "/api/machines/self/tasks/t-1/events?since_seq=-1")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for a negative since_seq", rec.Code)
	}
}
