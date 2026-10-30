package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/remote"
	"github.com/vuuihc/openkin/internal/routines"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/task"
)

type noopAdapter struct{}

func (noopAdapter) Start(ctx context.Context, spec adapter.TaskSpec) (adapter.RunHandle, error) {
	return noopHandle{}, nil
}

type noopHandle struct{}

func (noopHandle) Events() <-chan adapter.Event {
	ch := make(chan adapter.Event)
	close(ch)
	return ch
}
func (noopHandle) Cancel() error { return nil }

func newRoutinesTestServer(t *testing.T) (*Server, *store.Store) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	auth := remote.NewAuth("test-token")
	eng := task.NewEngineFromAdapters(st, map[string]adapter.Adapter{"kin": noopAdapter{}}, task.NewBus(), 2)
	t.Cleanup(eng.Close)
	scheduler := &routines.Scheduler{Store: st, Engine: eng, TotalConcurrency: 2}
	s := &Server{
		Store:      st,
		Auth:       auth,
		Engine:     eng,
		RunRoutine: scheduler.RunNow,
		Version:    "test",
	}
	return s, st
}

func TestRoutinesCRUDAndRunNow(t *testing.T) {
	s, _ := newRoutinesTestServer(t)
	h := s.Handler()

	body := `{"cwd":"/tmp/p","prompt":"check PRs","interval_secs":3600,"title":"PRs","agent":"kin"}`
	req := httptest.NewRequest(http.MethodPost, "/api/routines", bytes.NewReader([]byte(body)))
	req.Header.Set("Authorization", "Bearer test-token")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", rr.Code, rr.Body.String())
	}
	var created store.Routine
	if err := json.Unmarshal(rr.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.ID == "" || created.Title != "PRs" {
		t.Fatalf("created=%+v", created)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/routines", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("list status=%d", rr.Code)
	}

	// Pause
	req = httptest.NewRequest(http.MethodPatch, "/api/routines/"+created.ID, bytes.NewReader([]byte(`{"enabled":false}`)))
	req.Header.Set("Authorization", "Bearer test-token")
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("patch status=%d body=%s", rr.Code, rr.Body.String())
	}
	var patched store.Routine
	_ = json.Unmarshal(rr.Body.Bytes(), &patched)
	if patched.Enabled {
		t.Fatal("expected disabled")
	}

	// run-now
	req = httptest.NewRequest(http.MethodPost, "/api/routines/"+created.ID+"/run-now", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("run-now status=%d body=%s", rr.Code, rr.Body.String())
	}
	var run store.Task
	if err := json.Unmarshal(rr.Body.Bytes(), &run); err != nil {
		t.Fatal(err)
	}
	if run.RoutineID != created.ID {
		t.Fatalf("run routine_id=%q", run.RoutineID)
	}

	// delete
	req = httptest.NewRequest(http.MethodDelete, "/api/routines/"+created.ID, nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusNoContent {
		t.Fatalf("delete status=%d", rr.Code)
	}

	// unread count endpoint
	req = httptest.NewRequest(http.MethodGet, "/api/routines/unread-count", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("unread status=%d body=%s", rr.Code, rr.Body.String())
	}
	_ = time.Second // silence unused in case
}

func TestMarkRoutineRunReadClearsUnread(t *testing.T) {
	s, st := newRoutinesTestServer(t)
	h := s.Handler()
	ctx := context.Background()
	now := time.Now().UnixMilli()

	if err := st.InsertRoutine(ctx, store.Routine{
		ID: "r1", Cwd: t.TempDir(), Agent: "kin", Prompt: "p",
		IntervalSecs: 60, Enabled: true, NextDueAt: now, CreatedAt: now, Title: "T",
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.InsertTask(ctx, store.Task{
		ID: "task-unread", Title: "run", Agent: "kin", Cwd: "/tmp", Prompt: "p",
		Status: "succeeded", CreatedAt: now, RoutineID: "r1",
		RoutineUnread: true, RoutineNoteworthy: true, RoutineTLDR: "hi",
	}); err != nil {
		t.Fatal(err)
	}

	// unread count = 1
	req := httptest.NewRequest(http.MethodGet, "/api/routines/unread-count", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("unread status=%d body=%s", rr.Code, rr.Body.String())
	}
	var count struct {
		Count int `json:"count"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &count)
	if count.Count != 1 {
		t.Fatalf("count=%d want 1", count.Count)
	}

	// mark read
	req = httptest.NewRequest(http.MethodPost, "/api/routines/runs/task-unread/read", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("mark-read status=%d body=%s", rr.Code, rr.Body.String())
	}
	var task store.Task
	if err := json.Unmarshal(rr.Body.Bytes(), &task); err != nil {
		t.Fatal(err)
	}
	if task.RoutineUnread {
		t.Fatalf("response still unread: %+v", task)
	}
	// JSON must include routine_unread:false (not omitempty-elided)
	if !bytes.Contains(rr.Body.Bytes(), []byte(`"routine_unread":false`)) {
		t.Fatalf("body missing routine_unread false: %s", rr.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/routines/unread-count", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	_ = json.Unmarshal(rr.Body.Bytes(), &count)
	if count.Count != 0 {
		t.Fatalf("count after mark=%d want 0", count.Count)
	}
}

// A routine can be given a wall-clock rule instead of an interval. What the
// HTTP boundary has to get right is the three things a client relies on: the
// rule is validated, the first run lands on the rule rather than on "now", and
// the interval the column requires is derived instead of demanded.

func postRoutine(t *testing.T, s *Server, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/routines", bytes.NewReader([]byte(body)))
	req.Header.Set("Authorization", "Bearer test-token")
	rr := httptest.NewRecorder()
	s.Handler().ServeHTTP(rr, req)
	return rr
}

func patchRoutine(t *testing.T, s *Server, id, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPatch, "/api/routines/"+id, bytes.NewReader([]byte(body)))
	req.Header.Set("Authorization", "Bearer test-token")
	rr := httptest.NewRecorder()
	s.Handler().ServeHTTP(rr, req)
	return rr
}

func TestCreateRoutineWithAWallClockRule(t *testing.T) {
	s, _ := newRoutinesTestServer(t)
	rule := `{"kind":"daily","hour":9,"minute":30,"time_zone":"Asia/Shanghai"}`
	rr := postRoutine(t, s, `{"cwd":"/tmp/p","prompt":"standup","recurrence":`+strconv.Quote(rule)+`}`)
	if rr.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", rr.Code, rr.Body.String())
	}
	var created store.Routine
	if err := json.Unmarshal(rr.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Recurrence != rule {
		t.Fatalf("recurrence = %q, want the rule back", created.Recurrence)
	}
	// The interval column still needs a value; it is the rule's own pace.
	if created.IntervalSecs != 86400 {
		t.Fatalf("interval_secs = %d, want 86400", created.IntervalSecs)
	}
	shanghai, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	next := time.UnixMilli(created.NextDueAt).In(shanghai)
	if next.Hour() != 9 || next.Minute() != 30 {
		t.Fatalf("next_due_at = %v, want 09:30 in the rule's zone", next)
	}
	// And it is genuinely in the future, not "as soon as the scheduler looks".
	if !next.After(time.Now().Add(-time.Minute)) {
		t.Fatalf("next_due_at = %v is not ahead of now", next)
	}
}

// A step rule is a wall-clock rule too: the first run lands on the next
// aligned hour of the rule's zone, and the interval column gets the step.
func TestCreateRoutineWithAStepRule(t *testing.T) {
	s, _ := newRoutinesTestServer(t)
	rule := `{"kind":"hours","every":6,"time_zone":"Asia/Shanghai"}`
	rr := postRoutine(t, s, `{"cwd":"/tmp/p","prompt":"sweep","recurrence":`+strconv.Quote(rule)+`}`)
	if rr.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", rr.Code, rr.Body.String())
	}
	var created store.Routine
	if err := json.Unmarshal(rr.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Recurrence != rule {
		t.Fatalf("recurrence = %q, want the rule back", created.Recurrence)
	}
	if created.IntervalSecs != 6*3600 {
		t.Fatalf("interval_secs = %d, want %d", created.IntervalSecs, 6*3600)
	}
	shanghai, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	next := time.UnixMilli(created.NextDueAt).In(shanghai)
	if next.Minute() != 0 || next.Second() != 0 || next.Hour()%6 != 0 {
		t.Fatalf("next_due_at = %v, want the next 6-hour mark", next)
	}
	if !next.After(time.Now()) {
		t.Fatalf("next_due_at = %v is not ahead of now", next)
	}

	// A step the daemon does not accept is refused at the boundary.
	rr = postRoutine(t, s, `{"cwd":"/tmp/p","prompt":"sweep","recurrence":"{\"kind\":\"minutes\",\"every\":7}"}`)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("bad step status = %d, want 400; body=%s", rr.Code, rr.Body.String())
	}
}

func TestCreateRoutineRejectsAnUnfireableRule(t *testing.T) {
	s, _ := newRoutinesTestServer(t)
	rr := postRoutine(t, s, `{"cwd":"/tmp/p","prompt":"standup","recurrence":"{\"kind\":\"weekly\"}"}`)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rr.Code, rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), "recurrence") {
		t.Fatalf("error does not name the rule: %s", rr.Body.String())
	}

	// A once rule whose instant has already passed has nothing to schedule.
	past := strconv.FormatInt(time.Now().Add(-time.Hour).UnixMilli(), 10)
	rr = postRoutine(t, s, `{"cwd":"/tmp/p","prompt":"x","recurrence":"{\"kind\":\"once\",\"at\":`+past+`}"}`)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("past once status = %d, want 400; body=%s", rr.Code, rr.Body.String())
	}
}

func TestPatchRoutineMovesTheNextRunWithTheRule(t *testing.T) {
	s, _ := newRoutinesTestServer(t)
	rr := postRoutine(t, s, `{"cwd":"/tmp/p","prompt":"check","interval_secs":3600}`)
	if rr.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", rr.Code, rr.Body.String())
	}
	var created store.Routine
	if err := json.Unmarshal(rr.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}

	// Switching to a rule moves the next run onto the rule.
	rule := `{"kind":"weekly","hour":8,"minute":0,"weekdays":[1],"time_zone":"Asia/Shanghai"}`
	rr = patchRoutine(t, s, created.ID, `{"recurrence":`+strconv.Quote(rule)+`}`)
	if rr.Code != http.StatusOK {
		t.Fatalf("patch status=%d body=%s", rr.Code, rr.Body.String())
	}
	var patched store.Routine
	if err := json.Unmarshal(rr.Body.Bytes(), &patched); err != nil {
		t.Fatal(err)
	}
	shanghai, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	next := time.UnixMilli(patched.NextDueAt).In(shanghai)
	if next.Weekday() != time.Monday || next.Hour() != 8 {
		t.Fatalf("next_due_at = %v, want Monday 08:00", next)
	}

	// Switching back to nothing hands the schedule to the interval again.
	rr = patchRoutine(t, s, created.ID, `{"recurrence":""}`)
	if rr.Code != http.StatusOK {
		t.Fatalf("clear status=%d body=%s", rr.Code, rr.Body.String())
	}
	var cleared store.Routine
	if err := json.Unmarshal(rr.Body.Bytes(), &cleared); err != nil {
		t.Fatal(err)
	}
	if cleared.Recurrence != "" {
		t.Fatalf("recurrence = %q, want empty", cleared.Recurrence)
	}
	if cleared.NextDueAt > time.Now().Add(2*time.Hour).UnixMilli() {
		t.Fatalf("next_due_at = %v, want the interval to take over from now",
			time.UnixMilli(cleared.NextDueAt))
	}
}

// Moving a routine to another directory has to move its project with it.
// Create resolves project_id from the cwd; a patch that only rewrote cwd left
// the routine attached to the project the old path belonged to, so its runs
// kept being filed under the wrong one.
func TestPatchRoutineMovesTheProjectWithTheDirectory(t *testing.T) {
	s, st := newRoutinesTestServer(t)
	ctx := context.Background()
	dirA, dirB := t.TempDir(), t.TempDir()
	for _, p := range []struct {
		id   string
		name string
		dir  string
	}{{"p-a", "A", dirA}, {"p-b", "B", dirB}} {
		err := st.InsertProject(ctx, store.Project{
			ID:          p.id,
			Name:        p.name,
			Mode:        store.ProjectModeShip,
			OnePagerRel: "onepager.md",
			CreatedAt:   1,
		}, []string{p.dir})
		if err != nil {
			t.Fatal(err)
		}
	}

	rr := postRoutine(t, s, `{"cwd":`+strconv.Quote(dirA)+`,"prompt":"report","interval_secs":3600,"agent":"kin"}`)
	if rr.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", rr.Code, rr.Body.String())
	}
	var created store.Routine
	if err := json.Unmarshal(rr.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.ProjectID != "p-a" {
		t.Fatalf("project after create = %q, want p-a", created.ProjectID)
	}

	rr = patchRoutine(t, s, created.ID, `{"cwd":`+strconv.Quote(dirB)+`}`)
	if rr.Code != http.StatusOK {
		t.Fatalf("patch status=%d body=%s", rr.Code, rr.Body.String())
	}
	var moved store.Routine
	if err := json.Unmarshal(rr.Body.Bytes(), &moved); err != nil {
		t.Fatal(err)
	}
	if moved.ProjectID != "p-b" {
		t.Fatalf("project after cwd patch = %q, want p-b", moved.ProjectID)
	}

	// A patch that does not move the routine must not move its project either.
	rr = patchRoutine(t, s, created.ID, `{"title":"renamed"}`)
	if rr.Code != http.StatusOK {
		t.Fatalf("title patch status=%d body=%s", rr.Code, rr.Body.String())
	}
	var renamed store.Routine
	if err := json.Unmarshal(rr.Body.Bytes(), &renamed); err != nil {
		t.Fatal(err)
	}
	if renamed.ProjectID != "p-b" {
		t.Fatalf("project after title patch = %q, want p-b", renamed.ProjectID)
	}

	// A directory that belongs to no project clears the attribution, the way
	// create does with an unmatched cwd.
	rr = patchRoutine(t, s, created.ID, `{"cwd":`+strconv.Quote(t.TempDir())+`}`)
	if rr.Code != http.StatusOK {
		t.Fatalf("unmatched cwd patch status=%d body=%s", rr.Code, rr.Body.String())
	}
	var unmatched store.Routine
	if err := json.Unmarshal(rr.Body.Bytes(), &unmatched); err != nil {
		t.Fatal(err)
	}
	if unmatched.ProjectID != "" {
		t.Fatalf("project after unmatched cwd = %q, want empty", unmatched.ProjectID)
	}

	// An explicit project wins over whatever the directory would resolve to.
	rr = patchRoutine(t, s, created.ID,
		`{"cwd":`+strconv.Quote(dirA)+`,"project_id":"p-b"}`)
	if rr.Code != http.StatusOK {
		t.Fatalf("explicit project patch status=%d body=%s", rr.Code, rr.Body.String())
	}
	var explicit store.Routine
	if err := json.Unmarshal(rr.Body.Bytes(), &explicit); err != nil {
		t.Fatal(err)
	}
	if explicit.ProjectID != "p-b" {
		t.Fatalf("project after explicit patch = %q, want p-b", explicit.ProjectID)
	}

	// Re-sending the directory it already has is not a move: the explicit
	// project above must survive it.
	rr = patchRoutine(t, s, created.ID, `{"cwd":`+strconv.Quote(dirA)+`}`)
	if rr.Code != http.StatusOK {
		t.Fatalf("same cwd patch status=%d body=%s", rr.Code, rr.Body.String())
	}
	var same store.Routine
	if err := json.Unmarshal(rr.Body.Bytes(), &same); err != nil {
		t.Fatal(err)
	}
	if same.ProjectID != "p-b" {
		t.Fatalf("project after same cwd = %q, want p-b", same.ProjectID)
	}

	// Create refuses an empty directory; so must a patch.
	rr = patchRoutine(t, s, created.ID, `{"cwd":"   "}`)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("empty cwd status=%d body=%s, want 400", rr.Code, rr.Body.String())
	}
}

// A routine's own run history is the routine-runs feed narrowed to one id.
// The store has supported the filter since the feed landed, but the tasks
// endpoint never passed it through, so a client could only read the global
// feed and filter after the fact — which loses runs older than the page.
func TestListTasksFiltersByRoutine(t *testing.T) {
	s, st := newRoutinesTestServer(t)
	ctx := context.Background()
	now := time.Now().UnixMilli()

	for _, r := range []store.Routine{
		{ID: "r1", Cwd: "/tmp", Agent: "kin", Prompt: "p1", IntervalSecs: 60, Enabled: true, NextDueAt: now, CreatedAt: now, Title: "One"},
		{ID: "r2", Cwd: "/tmp", Agent: "kin", Prompt: "p2", IntervalSecs: 60, Enabled: true, NextDueAt: now, CreatedAt: now, Title: "Two"},
	} {
		if err := st.InsertRoutine(ctx, r); err != nil {
			t.Fatal(err)
		}
	}
	for _, task := range []store.Task{
		{ID: "t-r1", Title: "one", Agent: "kin", Cwd: "/tmp", Prompt: "p", Status: "succeeded", CreatedAt: now, RoutineID: "r1"},
		{ID: "t-r2", Title: "two", Agent: "kin", Cwd: "/tmp", Prompt: "p", Status: "succeeded", CreatedAt: now + 1, RoutineID: "r2"},
	} {
		if err := st.InsertTask(ctx, task); err != nil {
			t.Fatal(err)
		}
	}

	list := func(query string) []store.Task {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, "/api/tasks"+query, nil)
		req.Header.Set("Authorization", "Bearer test-token")
		rr := httptest.NewRecorder()
		s.Handler().ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("list %s status=%d body=%s", query, rr.Code, rr.Body.String())
		}
		var tasks []store.Task
		if err := json.Unmarshal(rr.Body.Bytes(), &tasks); err != nil {
			t.Fatal(err)
		}
		return tasks
	}

	one := list("?routine_id=r1")
	if len(one) != 1 || one[0].ID != "t-r1" {
		t.Fatalf("routine_id=r1 returned %+v", one)
	}
	all := list("?routine_id=*")
	if len(all) != 2 {
		t.Fatalf("routine_id=* returned %d tasks, want 2", len(all))
	}
	none := list("?routine_id=missing")
	if len(none) != 0 {
		t.Fatalf("routine_id=missing returned %+v", none)
	}
}

// The model a routine remembers is what its runs start with: create stores it,
// patch replaces it, and an empty patch value clears back to the agent default.
func TestRoutineKeepsItsModel(t *testing.T) {
	s, _ := newRoutinesTestServer(t)
	rr := postRoutine(t, s,
		`{"cwd":"/tmp/p","prompt":"sweep","interval_secs":3600,"model":" claude-sonnet-5-5 "}`)
	if rr.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", rr.Code, rr.Body.String())
	}
	var created store.Routine
	if err := json.Unmarshal(rr.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Model != "claude-sonnet-5-5" {
		t.Fatalf("model = %q, want the trimmed id", created.Model)
	}

	rr = patchRoutine(t, s, created.ID, `{"model":" claude-opus-5-5 "}`)
	if rr.Code != http.StatusOK {
		t.Fatalf("patch status=%d body=%s", rr.Code, rr.Body.String())
	}
	var patched store.Routine
	if err := json.Unmarshal(rr.Body.Bytes(), &patched); err != nil {
		t.Fatal(err)
	}
	if patched.Model != "claude-opus-5-5" {
		t.Fatalf("model = %q, want the new id", patched.Model)
	}

	// A patch that says nothing about the model leaves it alone: renaming a
	// routine must not quietly put its unattended runs back on the default.
	rr = patchRoutine(t, s, created.ID, `{"title":"renamed"}`)
	if rr.Code != http.StatusOK {
		t.Fatalf("title patch status=%d body=%s", rr.Code, rr.Body.String())
	}
	var renamed store.Routine
	if err := json.Unmarshal(rr.Body.Bytes(), &renamed); err != nil {
		t.Fatal(err)
	}
	if renamed.Model != "claude-opus-5-5" {
		t.Fatalf("model after a title patch = %q, want it kept", renamed.Model)
	}

	// Empty is how the console says "let the agent decide".
	rr = patchRoutine(t, s, created.ID, `{"model":""}`)
	if rr.Code != http.StatusOK {
		t.Fatalf("clear status=%d body=%s", rr.Code, rr.Body.String())
	}
	var cleared store.Routine
	if err := json.Unmarshal(rr.Body.Bytes(), &cleared); err != nil {
		t.Fatal(err)
	}
	if cleared.Model != "" {
		t.Fatalf("model = %q, want empty", cleared.Model)
	}
}
