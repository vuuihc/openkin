package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/vuuihc/openkin/internal/store"
)

func insertSessionTestTask(t *testing.T, s *Server, id string) {
	t.Helper()
	if err := s.Store.InsertTask(context.Background(), store.Task{
		ID: id, Title: id, Agent: "kin", Cwd: "/tmp", Prompt: "p",
		Status: "running", CreatedAt: store.NowMilli(),
	}); err != nil {
		t.Fatal(err)
	}
}

func getSessions(t *testing.T, s *Server, token, query string) (*httptest.ResponseRecorder, store.TaskChangePage) {
	t.Helper()
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/sessions"+query, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	s.Handler().ServeHTTP(rr, req)
	var page store.TaskChangePage
	if rr.Code == http.StatusOK {
		if err := json.Unmarshal(rr.Body.Bytes(), &page); err != nil {
			t.Fatalf("decode %s: %v", rr.Body.String(), err)
		}
	}
	return rr, page
}

// The console's whole reason for this endpoint: ask once with the cursor from
// last time and get back exactly what changed, without refetching the list.
func TestSessionsEndpointServesChangesSinceACursor(t *testing.T) {
	s, token := newTestServer(t)
	ctx := context.Background()
	insertSessionTestTask(t, s, "task-a")
	insertSessionTestTask(t, s, "task-b")

	rr := httptest.NewRecorder()
	s.Handler().ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/sessions", nil))
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d, want 401", rr.Code)
	}

	rr, first := getSessions(t, s, token, "")
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d body %s", rr.Code, rr.Body.String())
	}
	if len(first.Tasks) != 2 || first.NextCursor == 0 || first.HasMore {
		t.Fatalf("first page = %+v", first)
	}
	if first.Deleted == nil {
		t.Fatal("deleted must be [] rather than null: clients iterate it")
	}

	// Nothing changed: the cursor stays put.
	if _, idle := getSessions(t, s, token, fmt.Sprintf("?updated_since=%d", first.NextCursor)); len(idle.Tasks) != 0 {
		t.Fatalf("idle page = %+v", idle)
	}

	// One change: exactly that task comes back.
	title := "renamed"
	if err := s.Store.UpdateTask(ctx, "task-b", store.TaskPatch{Title: &title}); err != nil {
		t.Fatal(err)
	}
	if err := s.Store.DeleteTask(ctx, "task-a"); err != nil {
		t.Fatal(err)
	}
	_, delta := getSessions(t, s, token, fmt.Sprintf("?updated_since=%d", first.NextCursor))
	if len(delta.Tasks) != 1 || delta.Tasks[0].ID != "task-b" || delta.Tasks[0].Title != "renamed" {
		t.Fatalf("delta tasks = %+v", delta.Tasks)
	}
	if len(delta.Deleted) != 1 || delta.Deleted[0] != "task-a" {
		t.Fatalf("delta deleted = %v", delta.Deleted)
	}
	if delta.NextCursor <= first.NextCursor {
		t.Fatalf("cursor did not advance: %d -> %d", first.NextCursor, delta.NextCursor)
	}
}

func TestSessionsEndpointRejectsBadCursors(t *testing.T) {
	s, token := newTestServer(t)
	for _, query := range []string{"?updated_since=-1", "?updated_since=abc", "?limit=-5", "?limit=many"} {
		rr, _ := getSessions(t, s, token, query)
		if rr.Code != http.StatusBadRequest {
			t.Errorf("%s status = %d, want 400", query, rr.Code)
		}
	}
}

// A page that is cut short has to say so, or a client would stop at the first
// page and quietly render a partial list.
func TestSessionsEndpointReportsMorePages(t *testing.T) {
	s, token := newTestServer(t)
	for i := 0; i < 5; i++ {
		insertSessionTestTask(t, s, fmt.Sprintf("task-%02d", i))
	}
	rr, page := getSessions(t, s, token, "?limit=2")
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d", rr.Code)
	}
	if len(page.Tasks) != 2 || !page.HasMore {
		t.Fatalf("page = %d tasks, has_more=%v", len(page.Tasks), page.HasMore)
	}

	_, rest := getSessions(t, s, token, fmt.Sprintf("?limit=2&updated_since=%d", page.NextCursor))
	if len(rest.Tasks) != 2 || !rest.HasMore {
		t.Fatalf("second page = %d tasks, has_more=%v", len(rest.Tasks), rest.HasMore)
	}
	if rest.Tasks[0].ID != "task-02" {
		t.Fatalf("second page starts at %s, want task-02", rest.Tasks[0].ID)
	}
}
