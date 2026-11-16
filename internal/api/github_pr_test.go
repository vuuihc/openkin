package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

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
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &snap); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(snap.Observations) != 0 {
		t.Fatalf("snapshot = %+v, want an empty one", snap)
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

// The refresh route is the one operator-gated action a paired device may take,
// and this is where that exception is written down: a phone has to be able to
// ask about a branch nobody has looked at yet, because it cannot open a terminal
// to do it. The test after this one holds the other side of the line.
func TestRefreshPRAllowsAPairedDevice(t *testing.T) {
	s, master, _ := newAuthTestServer(t)
	handler := s.Handler()
	s.GitHub = github.NewService(s.Store)

	const deviceToken = "0011223344556677889900112233445566778899001122334455667788990011"
	if err := s.Store.InsertDeviceCredential(t.Context(), store.DeviceCredential{
		ID:        "device-phone",
		TokenHash: remote.HashToken(deviceToken),
		Label:     "phone",
		CreatedAt: time.Now().UnixMilli(),
	}); err != nil {
		t.Fatalf("insert device credential: %v", err)
	}

	// The other half of the predicate, asserted here so that a change to
	// isOperator cannot quietly take the route away from the node's owner while
	// this test goes on passing for the device.
	operator := &authClient{t: t, h: handler, master: master}
	if rec := operator.post("/api/tasks/no-such-task/pr/refresh", ""); rec.Code != http.StatusOK {
		t.Fatalf("operator refreshing: %d %s, want 200", rec.Code, rec.Body.String())
	}

	device := &authClient{t: t, h: handler, master: deviceToken}
	if rec := device.post("/api/tasks/no-such-task/pr/refresh", ""); rec.Code != http.StatusOK {
		t.Fatalf("paired device refreshing: %d %s, want 200", rec.Code, rec.Body.String())
	}
	// The exception is one route wide: the same credential still cannot reach
	// the routes that reconfigure the node it is paired with.
	if rec := device.get("/api/settings"); rec.Code != http.StatusForbidden {
		t.Fatalf("device reading settings: %d %s, want 403", rec.Code, rec.Body.String())
	}
}

// The exception stops at devices. A member account is another person on this
// node, not one of the owner's clients, and stays refused — written now rather
// than when member registration opens, so that widening the gate later has to
// confront this test.
//
// The task belongs to the member on purpose. On a task they cannot see, the
// scope middleware answers 404 first and the gate is never consulted, so the
// test would pass whatever the gate said.
func TestRefreshPRRefusesAMember(t *testing.T) {
	s, _, _ := newAuthTestServer(t)
	handler := s.Handler()
	s.GitHub = github.NewService(s.Store)

	member := joinMember(t, s, handler, "acct-member", "member@example.com")
	insertOwnedTaskForGate(t, s, "task-member", "acct-member")

	// The control: reading is theirs, so a refusal below is the spending gate
	// and not the scope check wearing a different status code.
	if rec := member.get("/api/tasks/task-member/pr"); rec.Code != http.StatusOK {
		t.Fatalf("member reading the pull request: %d %s, want 200", rec.Code, rec.Body.String())
	}
	if rec := member.post("/api/tasks/task-member/pr/refresh", ""); rec.Code != http.StatusForbidden {
		t.Fatalf("member refreshing: %d %s, want 403", rec.Code, rec.Body.String())
	}
}
