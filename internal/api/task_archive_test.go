package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/store"
)

func seedArchiveTask(t *testing.T, s *Server, id, cwd string) {
	t.Helper()
	if err := s.Store.InsertTask(context.Background(), store.Task{
		ID: id, Title: id, Agent: "claude-code", Cwd: cwd,
		Prompt: "do the thing", Status: "succeeded",
		CreatedAt: time.Now().UnixMilli(),
	}); err != nil {
		t.Fatalf("insert %s: %v", id, err)
	}
}

func doArchiveRequest(t *testing.T, s *Server, token, method, path string) *httptest.ResponseRecorder {
	t.Helper()
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	s.Handler().ServeHTTP(rr, req)
	return rr
}

func listTaskIDs(t *testing.T, s *Server, token, path string) []string {
	t.Helper()
	rr := doArchiveRequest(t, s, token, http.MethodGet, path)
	if rr.Code != http.StatusOK {
		t.Fatalf("GET %s = %d body %s", path, rr.Code, rr.Body.String())
	}
	var tasks []store.Task
	if err := json.Unmarshal(rr.Body.Bytes(), &tasks); err != nil {
		t.Fatalf("decode %s: %v", path, err)
	}
	ids := make([]string, 0, len(tasks))
	for _, item := range tasks {
		ids = append(ids, item.ID)
	}
	return ids
}

func containsID(ids []string, want string) bool {
	for _, id := range ids {
		if id == want {
			return true
		}
	}
	return false
}

// The whole loop over HTTP: put one chat away, see it leave the list and
// appear in the archive view, then put it back. Its two neighbours in the same
// project never move.
func TestArchivingAConversationThroughTheAPI(t *testing.T) {
	s, token := newTestServer(t)
	seedArchiveTask(t, s, "01TASKA", "/tmp/project")
	seedArchiveTask(t, s, "01TASKB", "/tmp/project")

	// The bus is how the phone and the desktop learn; a write with no message
	// would leave every other surface showing a row that is already gone.
	changes := s.Engine.Bus().Subscribe()
	defer s.Engine.Bus().Unsubscribe(changes)

	rr := doArchiveRequest(t, s, token, http.MethodPost, "/api/tasks/01TASKB/archive")
	if rr.Code != http.StatusOK {
		t.Fatalf("archive = %d body %s", rr.Code, rr.Body.String())
	}
	var archived store.Task
	if err := json.Unmarshal(rr.Body.Bytes(), &archived); err != nil {
		t.Fatalf("decode archived task: %v", err)
	}
	if archived.ArchivedAt == 0 {
		t.Fatalf("archive answered without a timestamp: %s", rr.Body.String())
	}

	select {
	case msg := <-changes:
		if msg.Kind != "task_update" {
			t.Fatalf("archive published %q, want task_update", msg.Kind)
		}
		payload, ok := msg.Data.(store.Task)
		if !ok || payload.ID != "01TASKB" || payload.ArchivedAt == 0 {
			t.Fatalf("archive published %+v, want the archived row", msg.Data)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("archive published nothing")
	}

	live := listTaskIDs(t, s, token, "/api/tasks")
	if containsID(live, "01TASKB") || !containsID(live, "01TASKA") {
		t.Fatalf("live list = %v, want only the neighbour", live)
	}
	// `0` is the live side spelled out, for a client that would rather say it
	// than rely on the default; it must answer the same list, not a 400.
	if explicit := listTaskIDs(t, s, token, "/api/tasks?archived=0"); containsID(explicit, "01TASKB") || !containsID(explicit, "01TASKA") {
		t.Fatalf("archived=0 = %v, want the live list", explicit)
	}
	archiveView := listTaskIDs(t, s, token, "/api/tasks?archived=1")
	if !containsID(archiveView, "01TASKB") || containsID(archiveView, "01TASKA") {
		t.Fatalf("archive view = %v, want only the archived row", archiveView)
	}

	rr = doArchiveRequest(t, s, token, http.MethodPost, "/api/tasks/01TASKB/unarchive")
	if rr.Code != http.StatusOK {
		t.Fatalf("unarchive = %d body %s", rr.Code, rr.Body.String())
	}
	live = listTaskIDs(t, s, token, "/api/tasks")
	if !containsID(live, "01TASKA") || !containsID(live, "01TASKB") {
		t.Fatalf("live list after restore = %v, want both", live)
	}
	if got := listTaskIDs(t, s, token, "/api/tasks?archived=1"); len(got) != 0 {
		t.Fatalf("archive view after restore = %v, want it empty", got)
	}
}

func TestArchiveRoutesRefuseWhatTheyCannotAnswer(t *testing.T) {
	s, token := newTestServer(t)

	if rr := doArchiveRequest(t, s, token, http.MethodPost, "/api/tasks/01NOPE/archive"); rr.Code != http.StatusNotFound {
		t.Fatalf("archiving an unknown task = %d, want 404", rr.Code)
	}
	// A list is one side of the archive or the other; an unknown value would
	// otherwise be answered with the live half and read as the archive view.
	if rr := doArchiveRequest(t, s, token, http.MethodGet, "/api/tasks?archived=maybe"); rr.Code != http.StatusBadRequest {
		t.Fatalf("archived=maybe = %d, want 400", rr.Code)
	}
}

// Archiving is the holder's call, not the operator's: a machine paired with
// this one is a full client of it, and the action is one call away from being
// undone. Delete stays operator-only — the two are different doors, and a
// phone that can tidy its list still cannot destroy what it does not hold.
func TestAPairedDeviceCanArchiveButNotDelete(t *testing.T) {
	s, master := newTestServer(t)
	seedArchiveTask(t, s, "01TASKA", "/tmp/project")
	deviceToken, _ := pairDevice(t, s.Handler(), master)

	if rr := doArchiveRequest(t, s, deviceToken, http.MethodPost, "/api/tasks/01TASKA/archive"); rr.Code != http.StatusOK {
		t.Fatalf("a paired device archiving = %d body %s", rr.Code, rr.Body.String())
	}
	if rr := doArchiveRequest(t, s, deviceToken, http.MethodPost, "/api/tasks/01TASKA/unarchive"); rr.Code != http.StatusOK {
		t.Fatalf("a paired device unarchiving = %d body %s", rr.Code, rr.Body.String())
	}
	if rr := doArchiveRequest(t, s, deviceToken, http.MethodDelete, "/api/tasks/01TASKA"); rr.Code != http.StatusForbidden {
		t.Fatalf("a paired device deleting = %d, want 403", rr.Code)
	}
}
