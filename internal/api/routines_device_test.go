package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/node"
	"github.com/vuuihc/openkin/internal/remote/worker"
	"github.com/vuuihc/openkin/internal/store"
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

// KIN-ROUTINE-001 J4: the phone's first screen is a bounded list read, not an
// export of 80 full prompts and every routine definition. A stored prompt is
// never cut down: its own GET remains the complete edit read.
func TestRoutinePhoneReadSurvivesRunsAndDefinitionsOverTheFrame(t *testing.T) {
	machine, machineStore := newRoutinesTestServer(t)
	machine.DesktopID = "desktop-<desktop-id>"
	machineHTTP := httptest.NewServer(machine.Handler())
	t.Cleanup(machineHTTP.Close)

	const promptBytes = 12000
	longPrompt := strings.Repeat("stored prompt ", promptBytes/14)
	if err := machineStore.InsertRoutine(t.Context(), store.Routine{
		ID: "r-large", Title: "Large but readable", Cwd: t.TempDir(), Agent: "kin",
		Prompt: longPrompt, IntervalSecs: 3600, Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}
	// Enough stored history to fail the original query at 80 runs. These IDs are
	// monotonic, so the second cursor page must include the oldest row just once.
	for i := range 80 {
		if err := machineStore.InsertTask(t.Context(), store.Task{
			ID: fmt.Sprintf("01ARZ3NDEKTSV4RRFFQ69G5F%02d", i+1), Title: "Long prompt retained",
			Cwd: t.TempDir(), Agent: "kin", Status: "succeeded", CreatedAt: int64(i + 1),
			RoutineID: "r-large", Prompt: longPrompt, RoutineTLDR: "A bounded summary",
		}); err != nil {
			t.Fatal(err)
		}
	}

	hub, master, conns := machinesServer(t)
	deviceID := dialMachine(t, hub, conns, master, &node.Responder{
		Roots:    []string{t.TempDir()},
		Routines: node.LocalRoutineCaller(machineHTTP.URL, func() string { return "test-token" }),
	})
	type page struct {
		Routines   []store.Routine `json:"routines"`
		Runs       []store.Task    `json:"runs"`
		NextCursor string          `json:"runs_next_cursor"`
		HasMore    bool            `json:"runs_has_more"`
	}
	readPage := func(query string) *httptest.ResponseRecorder {
		t.Helper()
		return askRoutine(t, hub, master, http.MethodGet,
			"/api/routines?device="+deviceID+"&"+query, "")
	}

	// This is the console's original request, sent first to prove that the old
	// contract really does fail through Hub -> Node -> the machine's real handler.
	old := readPage("runs=1&runs_limit=80")
	if old.Code != http.StatusNotImplemented || !strings.Contains(old.Body.String(), "over the") {
		t.Fatalf("the original unbounded query did not reproduce: %d %s", old.Code, old.Body.String())
	}

	first := readPage("limit=30&page=1&runs=1&runs_limit=30")
	if first.Code != http.StatusOK {
		t.Fatalf("the bounded first page failed: %d %s", first.Code, first.Body.String())
	}
	if first.Body.Len() > worker.MaxRoutineResponse {
		t.Fatalf("the first page still exceeds the frame: %d bytes", first.Body.Len())
	}
	var body page
	if err := json.Unmarshal(first.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Routines) != 1 || body.Routines[0].Prompt != "" {
		t.Fatalf("a list definition carried its full prompt: %+v", body.Routines)
	}
	if len(body.Runs) != 30 || !body.HasMore || body.NextCursor != body.Runs[29].ID {
		t.Fatalf("first run page = %d, more %v, cursor %q", len(body.Runs), body.HasMore, body.NextCursor)
	}
	for _, run := range body.Runs {
		if run.Prompt != "" || run.Dispatch != nil {
			t.Fatalf("a list run carried the conversation's input: %+v", run)
		}
		if run.Title != "Long prompt retained" || run.RoutineTLDR == "" {
			t.Fatalf("the summary lost the fields its row shows: %+v", run)
		}
	}
	own := readPage("page=1&limit=1&runs=1&runs_limit=10&routine_id=missing")
	var ownPage page
	err := json.Unmarshal(own.Body.Bytes(), &ownPage)
	if own.Code != http.StatusOK || err != nil || len(ownPage.Runs) != 0 {
		t.Fatalf("a scoped history must be an empty bounded page: %d, %v", own.Code, err)
	}
	if len(ownPage.Routines) != 1 || ownPage.Routines[0].Prompt != "" {
		t.Fatalf("routine history must not widen into another export: %+v", ownPage)
	}
	if own.Body.Len() > worker.MaxRoutineResponse {
		t.Fatalf("empty scoped history carried definitions over the frame: %d", own.Body.Len())
	}
	second := readPage("limit=30&page=1&runs=1&runs_limit=30&runs_cursor=" + body.NextCursor)
	if second.Code != http.StatusOK {
		t.Fatalf("the next run page failed: %d %s", second.Code, second.Body.String())
	}
	var next page
	if err := json.Unmarshal(second.Body.Bytes(), &next); err != nil {
		t.Fatal(err)
	}
	if len(next.Runs) != 30 || next.Runs[0].ID == body.Runs[0].ID {
		t.Fatalf("the cursor restarted the history: %+v", next.Runs)
	}

	// One row is deliberately close to the relayed request-body ceiling. Its list
	// read still fits, and the editor's own detail response returns all of it.
	// The old 128 KiB transport limit applied to the whole JSON request, even
	// though a persisted prompt could be just as large. This new prompt proves
	// that the boundary matches the stored language, not its encoding.
	huge := strings.Repeat("x", 128<<10)
	if err := machineStore.InsertRoutine(t.Context(), store.Routine{
		ID: "r-huge", Title: "Complete original", Cwd: t.TempDir(), Agent: "kin",
		Prompt: huge, IntervalSecs: 3600, Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}
	first = readPage("limit=30&page=1&runs=1&runs_limit=30")
	if first.Code != http.StatusOK || first.Body.Len() > worker.MaxRoutineResponse {
		t.Fatalf("a maximum-sized definition broke its list: %d / %d bytes", first.Code, first.Body.Len())
	}
	detail := askRoutine(t, hub, master, http.MethodGet, "/api/routines/r-huge?device="+deviceID, "")
	if detail.Code != http.StatusOK {
		t.Fatalf("the complete edit read failed: %d", detail.Code)
	}
	var stored store.Routine
	if err := json.Unmarshal(detail.Body.Bytes(), &stored); err != nil || stored.Prompt != huge {
		t.Fatalf("the original prompt did not round trip: %v / %d bytes", err, len(stored.Prompt))
	}

	// A prompt at the old transport boundary still has to fit when its JSON
	// field name and quotes accompany a real remote edit. The 640 KiB response
	// bound is irrelevant here: this direction carries a JSON request.
	changed := huge + " edited"
	changedJSON, err := json.Marshal(map[string]string{"prompt": changed})
	if err != nil {
		t.Fatal(err)
	}
	updated := askRoutine(t, hub, master, http.MethodPatch,
		"/api/routines/r-huge?device="+deviceID, string(changedJSON))
	if updated.Code != http.StatusOK {
		t.Fatalf("the readable prompt boundary could not be saved: %d %s", updated.Code, updated.Body.String())
	}
	var changedStored store.Routine
	if err := json.Unmarshal(updated.Body.Bytes(), &changedStored); err != nil || changedStored.Prompt != changed {
		t.Fatalf("the edited original prompt did not round trip: %v / %d bytes", err, len(changedStored.Prompt))
	}

	tooLargeJSON, err := json.Marshal(map[string]string{"prompt": strings.Repeat("x", worker.MaxRoutineBody)})
	if err != nil {
		t.Fatal(err)
	}
	if rec := askRoutine(t, hub, master, http.MethodPatch,
		"/api/routines/r-huge?device="+deviceID, string(tooLargeJSON)); rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("an oversized request was not bounded: %d %s", rec.Code, rec.Body.String())
	}

	// Seven unprojected 128 KiB definitions cannot fit one response, even though
	// each of their individual detail reads below that transport bound fits.
	for i := range 7 {
		if err := machineStore.InsertRoutine(t.Context(), store.Routine{
			ID: fmt.Sprintf("r-raw-%d", i), Title: "Raw original", Cwd: t.TempDir(), Agent: "kin",
			Prompt: huge, IntervalSecs: 3600, Enabled: true,
		}); err != nil {
			t.Fatal(err)
		}
	}
	// The frame limit stays a safety boundary, not the mechanism that makes a
	// list work. A raw legacy export is still refused.
	unbounded := readPage("")
	if unbounded.Code != http.StatusNotImplemented || !strings.Contains(unbounded.Body.String(), "over the") {
		t.Fatalf("the wire's protective bound was removed: %d", unbounded.Code)
	}

	// This is a list refusal, not a stopped schedule.
	stillScheduled, err := machineStore.GetRoutine(t.Context(), "r-huge")
	if err != nil || !stillScheduled.Enabled || stillScheduled.NextDueAt <= 0 {
		t.Fatalf("a read changed the saved schedule: %+v, %v", stillScheduled, err)
	}
}

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
