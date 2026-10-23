package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/vuuihc/openkin/internal/github"
	"github.com/vuuihc/openkin/internal/remote"
	"github.com/vuuihc/openkin/internal/store"
)

// The route's three answers are what the console keys off, so they are asserted
// here rather than inferred from the handler: an empty snapshot is 200 because
// having no pull request is normal, and 502 means the answer could not be
// assembled at all. A caller that had to tell those apart by reading the body
// would get it wrong the first time a task was not in a repository.
func TestTaskPRRouteStates(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })

	token := "test-token"
	s := &Server{
		Store: st, Auth: remote.NewAuth(token), Token: token,
		NetworkMode: "loopback",
	}
	handler := s.Handler()

	get := func(method, path string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, req)
		return rr
	}

	// No integration configured: the console shows "not configured on this
	// node" rather than an empty panel nobody can explain.
	if rr := get(http.MethodGet, "/api/tasks/t1/pr"); rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("unconfigured status = %d, want %d; body = %s",
			rr.Code, http.StatusServiceUnavailable, rr.Body.String())
	}

	s.GitHub = github.NewService(st)

	// A task with no workspace, or none at all, is an empty snapshot. The
	// array matters: the console iterates it, and a null there is the kind of
	// contract drift that only bites once something calls a method on it.
	rr := get(http.MethodGet, "/api/tasks/no-such-task/pr")
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body = %s", rr.Code, http.StatusOK, rr.Body.String())
	}
	if body := rr.Body.String(); !strings.Contains(body, `"observations":[]`) {
		t.Fatalf("observations are not an empty array: %s", body)
	}
	var snap struct {
		Observations []json.RawMessage `json:"observations"`
		Refreshing   bool              `json:"refreshing"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &snap); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(snap.Observations) != 0 || snap.Refreshing {
		t.Fatalf("snapshot = %+v, want an empty, settled one", snap)
	}

	// A store that cannot be read is not "no pull request": it is a failure,
	// and the console has a separate line for it.
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	if rr := get(http.MethodGet, "/api/tasks/no-such-task/pr"); rr.Code != http.StatusBadGateway {
		t.Fatalf("unreadable status = %d, want %d; body = %s",
			rr.Code, http.StatusBadGateway, rr.Body.String())
	}
}
