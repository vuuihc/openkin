package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/node"
	"github.com/vuuihc/openkin/internal/remote/worker"
)

// routineCall is one request as the machine received it.
type routineCall struct {
	method string
	path   string
	body   string
}

// routineMachine starts a paired machine whose routines are answered by answer,
// and returns its device id and the requests it was asked.
func routineMachine(t *testing.T, s *Server, conns *node.Connections, master string, answer node.RoutineCaller) (string, <-chan routineCall) {
	t.Helper()
	calls := make(chan routineCall, 8)
	responder := &node.Responder{Roots: []string{t.TempDir()}}
	if answer != nil {
		responder.Routines = func(ctx context.Context, asked worker.RoutinesParams) (node.RoutineAnswer, error) {
			calls <- routineCall{method: asked.Method, path: asked.Path, body: string(asked.Body)}
			return answer(ctx, asked)
		}
	}
	return dialMachine(t, s, conns, master, responder), calls
}

// dialMachine pairs a machine, starts its responder, and waits for the Hub to
// have a live channel to it.
func dialMachine(t *testing.T, s *Server, conns *node.Connections, master string, responder *node.Responder) string {
	t.Helper()
	hub := httptest.NewServer(s.Handler())
	t.Cleanup(hub.Close)
	deviceToken, deviceID := pairDevice(t, s.Handler(), master)
	runResponder(t, hub.URL, deviceToken, responder)
	awaitConnected(t, conns, deviceID)
	return deviceID
}

// askRoutine sends one routine request to the Hub, naming a machine.
func askRoutine(t *testing.T, s *Server, master, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	var reader *strings.Reader
	if body != "" {
		reader = strings.NewReader(body)
	} else {
		reader = strings.NewReader("")
	}
	req := httptest.NewRequest(method, path, reader)
	req.Header.Set("Authorization", "Bearer "+master)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	return rec
}

// A routine created from a phone is created on the machine the phone named: the
// Hub relays the request and passes the answer back as it stands, so the console
// reads the same status and the same body it would have read on that machine.
func TestRoutineRequestsAreRelayedToTheirMachine(t *testing.T) {
	s, master, conns := machinesServer(t)
	deviceID, calls := routineMachine(t, s, conns, master, func(context.Context, worker.RoutinesParams) (node.RoutineAnswer, error) {
		return node.RoutineAnswer{
			Status:      http.StatusCreated,
			ContentType: "application/json",
			Body:        []byte(`{"id":"r-9","title":"relayed"}`),
		}, nil
	})

	rec := askRoutine(t, s, master, http.MethodPost, "/api/routines?device="+deviceID,
		`{"title":"relayed"}`)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want the machine's own 201: %s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("content type = %q", got)
	}
	if got := rec.Body.String(); got != `{"id":"r-9","title":"relayed"}` {
		t.Fatalf("body = %q, want the machine's answer unchanged", got)
	}
	select {
	case call := <-calls:
		if call.method != http.MethodPost || call.path != "/api/routines" {
			t.Fatalf("the machine was asked %s %s", call.method, call.path)
		}
		if call.body != `{"title":"relayed"}` {
			t.Fatalf("the body reached the machine as %q", call.body)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the machine was never asked")
	}
}

// The parameter that named the machine is the Hub's word, not the machine's: it
// must not travel, while every other parameter — the page, the runs feed, the
// search — does, because they are the console's own request.
func TestRoutineRelayStripsOnlyTheDeviceParameter(t *testing.T) {
	s, master, conns := machinesServer(t)
	deviceID, calls := routineMachine(t, s, conns, master, func(context.Context, worker.RoutinesParams) (node.RoutineAnswer, error) {
		return node.RoutineAnswer{
			Status:      http.StatusOK,
			ContentType: "application/json",
			Body:        []byte(`{"routines":[],"runs":[]}`),
		}, nil
	})

	rec := askRoutine(t, s, master, http.MethodGet,
		"/api/routines?device="+deviceID+"&page=1&runs=1&runs_limit=7", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	select {
	case call := <-calls:
		if call.path != "/api/routines?page=1&runs=1&runs_limit=7" {
			t.Fatalf("the machine was asked %q, want the console's own query without device", call.path)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the machine was never asked")
	}
}

// A machine that has never heard of routine questions refuses, and that refusal
// is a version skew rather than the caller's mistake. It reaches the console as
// "not implemented" so an older machine reads as old rather than as broken.
func TestRoutineRelayReportsAMachineThatCannotAnswer(t *testing.T) {
	s, master, conns := machinesServer(t)
	// No Routines caller is what a build older than this Hub looks like.
	deviceID := dialMachine(t, s, conns, master, &node.Responder{Roots: []string{t.TempDir()}})

	rec := askRoutine(t, s, master, http.MethodGet, "/api/routines?device="+deviceID, "")
	if rec.Code != http.StatusNotImplemented {
		t.Fatalf("status = %d, want 501 for a machine that cannot answer: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "routine") {
		t.Fatalf("the refusal does not say what the machine cannot do: %s", rec.Body.String())
	}
}

// A machine that is not connected is reported as away, now, rather than after a
// timeout — the same answer every other question about a machine gives.
func TestRoutineRelayReportsAnOfflineMachine(t *testing.T) {
	s, master, _ := machinesServer(t)
	_, deviceID := pairDevice(t, s.Handler(), master)

	rec := askRoutine(t, s, master, http.MethodGet, "/api/routines?device="+deviceID, "")
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want a conflict: %s", rec.Code, rec.Body.String())
	}
}

// A body too large to relay is refused here, before a machine is made to read
// it, and the status says the request is too big rather than that it is wrong.
func TestRoutineRelayRefusesAnOversizedBody(t *testing.T) {
	s, master, conns := machinesServer(t)
	deviceID, calls := routineMachine(t, s, conns, master, func(context.Context, worker.RoutinesParams) (node.RoutineAnswer, error) {
		t.Error("an oversized body reached the machine")
		return node.RoutineAnswer{Status: http.StatusOK}, nil
	})

	body := `{"prompt":"` + strings.Repeat("x", worker.MaxRoutineBody) + `"}`
	rec := askRoutine(t, s, master, http.MethodPost, "/api/routines?device="+deviceID, body)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413: %s", rec.Code, rec.Body.String())
	}
	select {
	case <-calls:
		t.Fatal("an oversized body reached the machine")
	case <-time.After(100 * time.Millisecond):
	}
}

// A request that names this machine is answered here, in process, with no
// machine asked: the Hub is a machine too, and a console talking to a node
// directly must not take a different path than a phone.
func TestRoutineRequestsForThisMachineStayLocal(t *testing.T) {
	s, master, _ := machinesServer(t)
	s.DesktopID = "desktop-1"
	rec := askRoutine(t, s, master, http.MethodGet, "/api/routines?page=1&device=desktop-1", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"routines":[]`) {
		t.Fatalf("the local store did not answer: %s", rec.Body.String())
	}
}

// A 401 from the machine is that machine's own loopback auth failing, not the
// caller's session ending. Forwarding it would drop the person to the Hub's
// connect screen over a rotated token on a laptop.
func TestRoutineRelayDoesNotForwardTheMachinesOwnAuthFailure(t *testing.T) {
	s, master, conns := machinesServer(t)
	deviceID, _ := routineMachine(t, s, conns, master, func(context.Context, worker.RoutinesParams) (node.RoutineAnswer, error) {
		return node.RoutineAnswer{
			Status:      http.StatusUnauthorized,
			ContentType: "application/json",
			Body:        []byte(`{"error":"bad token"}`),
		}, nil
	})

	rec := askRoutine(t, s, master, http.MethodGet, "/api/routines?device="+deviceID, "")
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502 for a machine-side auth failure: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "bad token") {
		t.Fatalf("the machine's own reason was lost: %s", rec.Body.String())
	}
}
