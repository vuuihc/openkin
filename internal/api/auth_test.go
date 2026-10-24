package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/auth"
	"github.com/vuuihc/openkin/internal/remote"
	"github.com/vuuihc/openkin/internal/store"
)

// newAuthTestServer returns a test server with the account system enabled and
// the plaintext bootstrap code, mirroring a freshly deployed Hub.
func newAuthTestServer(t *testing.T) (*Server, string, string) {
	t.Helper()
	s, master := newTestServer(t)
	s.Accounts = auth.New(s.Store, auth.Config{})
	code, err := s.Accounts.IssueBootstrapCode(t.Context())
	if err != nil {
		t.Fatalf("issue bootstrap code: %v", err)
	}
	return s, master, code
}

type authClient struct {
	t      *testing.T
	h      http.Handler
	cookie *http.Cookie
	master string
}

func (c *authClient) do(method, path, body string) *httptest.ResponseRecorder {
	c.t.Helper()
	var reader *bytes.Reader
	if body == "" {
		reader = bytes.NewReader(nil)
	} else {
		reader = bytes.NewReader([]byte(body))
	}
	req := httptest.NewRequest(method, path, reader)
	req.Header.Set("Content-Type", "application/json")
	if c.cookie != nil {
		req.AddCookie(c.cookie)
	}
	if c.master != "" {
		req.Header.Set("Authorization", "Bearer "+c.master)
	}
	rec := httptest.NewRecorder()
	c.h.ServeHTTP(rec, req)

	// Track the session cookie exactly as a browser would.
	for _, cookie := range rec.Result().Cookies() {
		if cookie.Name != remote.SessionCookieName {
			continue
		}
		if cookie.MaxAge < 0 || cookie.Value == "" {
			c.cookie = nil
			continue
		}
		c.cookie = cookie
	}
	return rec
}

func (c *authClient) post(path, body string) *httptest.ResponseRecorder {
	return c.do(http.MethodPost, path, body)
}

func (c *authClient) get(path string) *httptest.ResponseRecorder {
	return c.do(http.MethodGet, path, "")
}

func decodeStatus(t *testing.T, rec *httptest.ResponseRecorder) authStatus {
	t.Helper()
	var status authStatus
	if err := json.Unmarshal(rec.Body.Bytes(), &status); err != nil {
		t.Fatalf("decode status: %v (body %s)", err, rec.Body.String())
	}
	return status
}

func TestAuthStatusOnUnclaimedHub(t *testing.T) {
	s, master, _ := newAuthTestServer(t)
	client := &authClient{t: t, h: s.Handler(), master: master}

	status := decodeStatus(t, client.get("/api/auth/status"))
	if !status.NeedsBootstrap {
		t.Fatal("a hub with no accounts did not report needs_bootstrap")
	}
	if !status.Claimable {
		t.Fatal("an issued claim code was not reported as claimable")
	}
	if status.Authenticated {
		t.Fatal("an anonymous request was reported as authenticated")
	}
	if len(status.Providers) != 1 || status.Providers[0].ID != "password" {
		t.Fatalf("providers = %+v, want only password", status.Providers)
	}
}

func TestAuthStatusHidesClaimabilityBeforeCodeIssued(t *testing.T) {
	s, master := newTestServer(t)
	s.Accounts = auth.New(s.Store, auth.Config{})
	client := &authClient{t: t, h: s.Handler(), master: master}

	status := decodeStatus(t, client.get("/api/auth/status"))
	if !status.NeedsBootstrap {
		t.Fatal("expected needs_bootstrap")
	}
	if status.Claimable {
		t.Fatal("claimable is true before any code was issued")
	}
}

func TestBootstrapClaimsHubAndOpensSession(t *testing.T) {
	s, master, code := newAuthTestServer(t)
	client := &authClient{t: t, h: s.Handler(), master: master}

	rec := client.post("/api/auth/bootstrap", `{"code":"`+code+`","email":"Owner@Example.com","password":"hunter2hunter2","display_name":"Owner"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("bootstrap: %d %s", rec.Code, rec.Body.String())
	}
	if client.cookie == nil {
		t.Fatal("bootstrap did not set a session cookie")
	}
	if !client.cookie.HttpOnly {
		t.Fatal("session cookie is not HttpOnly")
	}

	status := decodeStatus(t, client.get("/api/auth/status"))
	if status.NeedsBootstrap {
		t.Fatal("hub still reports needs_bootstrap after being claimed")
	}
	if !status.Authenticated || status.User == nil {
		t.Fatal("the claiming session is not authenticated")
	}
	if status.User.Email != "owner@example.com" {
		t.Fatalf("email = %q, want normalized", status.User.Email)
	}
	if status.User.EmailVerified {
		t.Fatal("a locally-typed email was reported as verified")
	}
}

func TestBootstrapRejectsWrongCodeWithoutClaiming(t *testing.T) {
	s, master, _ := newAuthTestServer(t)
	client := &authClient{t: t, h: s.Handler(), master: master}

	rec := client.post("/api/auth/bootstrap", `{"code":"AAAAA-BBBBB","email":"owner@example.com","password":"hunter2hunter2"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("wrong code: %d %s", rec.Code, rec.Body.String())
	}
	if client.cookie != nil {
		t.Fatal("a failed claim issued a session")
	}
	if !decodeStatus(t, client.get("/api/auth/status")).NeedsBootstrap {
		t.Fatal("a failed claim consumed the hub")
	}
}

func TestBootstrapRefusedOnceClaimed(t *testing.T) {
	s, master, code := newAuthTestServer(t)
	owner := &authClient{t: t, h: s.Handler(), master: master}
	if rec := owner.post("/api/auth/bootstrap", `{"code":"`+code+`","email":"owner@example.com","password":"hunter2hunter2"}`); rec.Code != http.StatusOK {
		t.Fatalf("first claim: %d %s", rec.Code, rec.Body.String())
	}

	// A second visitor, including one holding a code, must not take the hub.
	other := &authClient{t: t, h: s.Handler(), master: master}
	fresh, err := s.Accounts.IssueBootstrapCode(t.Context())
	if err != nil {
		t.Fatalf("issue second code: %v", err)
	}
	rec := other.post("/api/auth/bootstrap", `{"code":"`+fresh+`","email":"attacker@example.com","password":"hunter2hunter2"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("second claim: %d %s", rec.Code, rec.Body.String())
	}
	if other.cookie != nil {
		t.Fatal("a second claim obtained a session")
	}
}

func TestLoginAndLogout(t *testing.T) {
	s, master, code := newAuthTestServer(t)
	h := s.Handler()
	owner := &authClient{t: t, h: h, master: master}
	if rec := owner.post("/api/auth/bootstrap", `{"code":"`+code+`","email":"owner@example.com","password":"hunter2hunter2"}`); rec.Code != http.StatusOK {
		t.Fatalf("claim: %d %s", rec.Code, rec.Body.String())
	}

	t.Run("wrong password is rejected", func(t *testing.T) {
		client := &authClient{t: t, h: h, master: master}
		rec := client.post("/api/auth/login", `{"email":"owner@example.com","password":"nope"}`)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("wrong password: %d %s", rec.Code, rec.Body.String())
		}
		if client.cookie != nil {
			t.Fatal("a failed login issued a session")
		}
	})

	t.Run("correct password opens a usable session", func(t *testing.T) {
		client := &authClient{t: t, h: h, master: master}
		rec := client.post("/api/auth/login", `{"email":"owner@example.com","password":"hunter2hunter2"}`)
		if rec.Code != http.StatusOK {
			t.Fatalf("login: %d %s", rec.Code, rec.Body.String())
		}
		// The cookie alone must be enough: this is what the console relies on.
		bare := &authClient{t: t, h: h, cookie: client.cookie}
		if rec := bare.get("/api/auth/me"); rec.Code != http.StatusOK {
			t.Fatalf("cookie-only request: %d %s", rec.Code, rec.Body.String())
		}

		if rec := client.post("/api/auth/logout", ""); rec.Code != http.StatusOK {
			t.Fatalf("logout: %d %s", rec.Code, rec.Body.String())
		}
		if client.cookie != nil {
			t.Fatal("logout did not clear the cookie")
		}
		// The token must be dead server-side, not merely dropped client-side.
		revoked := &authClient{t: t, h: h, cookie: bare.cookie}
		if rec := revoked.get("/api/auth/me"); rec.Code != http.StatusUnauthorized {
			t.Fatalf("reused revoked cookie: %d %s", rec.Code, rec.Body.String())
		}
	})
}

func TestAuthMeRejectsAnonymous(t *testing.T) {
	s, master, _ := newAuthTestServer(t)
	client := &authClient{t: t, h: s.Handler(), master: master}
	if rec := client.get("/api/auth/me"); rec.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous /api/auth/me: %d %s", rec.Code, rec.Body.String())
	}
}

func TestLoginAttemptsAreRateLimited(t *testing.T) {
	s, master, code := newAuthTestServer(t)
	h := s.Handler()
	owner := &authClient{t: t, h: h, master: master}
	if rec := owner.post("/api/auth/bootstrap", `{"code":"`+code+`","email":"owner@example.com","password":"hunter2hunter2"}`); rec.Code != http.StatusOK {
		t.Fatalf("claim: %d %s", rec.Code, rec.Body.String())
	}

	client := &authClient{t: t, h: h, master: master}
	var limited bool
	for i := 0; i < 40; i++ {
		if rec := client.post("/api/auth/login", `{"email":"owner@example.com","password":"wrong"}`); rec.Code == http.StatusTooManyRequests {
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("repeated failed logins were never rate limited")
	}
}

func TestAuthEndpointsDisabledWithoutAccounts(t *testing.T) {
	s, master := newTestServer(t)
	client := &authClient{t: t, h: s.Handler(), master: master}

	// A standalone daemon keeps serving the console's status probe.
	status := decodeStatus(t, client.get("/api/auth/status"))
	if status.NeedsBootstrap || status.Authenticated {
		t.Fatalf("standalone status = %+v, want inert", status)
	}
	if len(status.Providers) != 0 {
		t.Fatalf("standalone offered providers: %+v", status.Providers)
	}
	if rec := client.post("/api/auth/login", `{"email":"a@b.c","password":"whatever"}`); rec.Code != http.StatusNotFound {
		t.Fatalf("standalone login: %d %s", rec.Code, rec.Body.String())
	}
	if rec := client.get("/api/auth/oidc/start"); rec.Code != http.StatusNotFound {
		t.Fatalf("standalone oidc start: %d %s", rec.Code, rec.Body.String())
	}
}

func TestSafeReturnToRejectsOtherOrigins(t *testing.T) {
	cases := map[string]string{
		"":                         "/",
		"/sessions":                "/sessions",
		"/sessions?tab=active":     "/sessions?tab=active",
		"//evil.example.com":       "/",
		"//evil.example.com/path":  "/",
		"/\\evil.example.com":      "/",
		"https://evil.example.com": "/",
		"javascript:alert(1)":      "/",
		"  /settings  ":            "/settings",
	}
	for in, want := range cases {
		if got := safeReturnTo(in); got != want {
			t.Errorf("safeReturnTo(%q) = %q, want %q", in, got, want)
		}
	}
}

// claimOwner drives the console's first-run path and leaves c holding the
// owner's session cookie.
func claimOwner(t *testing.T, c *authClient, code string) {
	t.Helper()
	rec := c.post("/api/auth/bootstrap",
		`{"code":"`+code+`","email":"owner@example.com","password":"hunter2hunter2","display_name":"Owner"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("claim hub: %d %s", rec.Code, rec.Body.String())
	}
	if c.cookie == nil {
		t.Fatal("claiming the hub did not open a session")
	}
}

func TestOwnerSessionReachesOperatorRoutes(t *testing.T) {
	s, _, code := newAuthTestServer(t)
	handler := s.Handler()

	owner := &authClient{t: t, h: handler}
	claimOwner(t, owner, code)
	// Drop the master token: the cookie alone has to carry the request, which
	// is exactly what a browser on the Hub sends.
	owner.master = ""

	if rec := owner.get("/api/settings"); rec.Code != http.StatusOK {
		t.Fatalf("owner reading settings: %d %s", rec.Code, rec.Body.String())
	}
	if rec := owner.do(http.MethodPut, "/api/settings", `{"notify.bark_url":""}`); rec.Code != http.StatusOK {
		t.Fatalf("owner writing settings: %d %s", rec.Code, rec.Body.String())
	}
}

func TestDeviceTokenCannotReachOperatorRoutes(t *testing.T) {
	s, _, code := newAuthTestServer(t)
	handler := s.Handler()

	owner := &authClient{t: t, h: handler}
	claimOwner(t, owner, code)

	// A paired phone or desktop client drives tasks; it does not reconfigure
	// the daemon it is paired with.
	const deviceToken = "0011223344556677889900112233445566778899001122334455667788990011"
	if err := s.Store.InsertDeviceCredential(t.Context(), store.DeviceCredential{
		ID:        "device-test",
		TokenHash: remote.HashToken(deviceToken),
		Label:     "phone",
		CreatedAt: time.Now().UnixMilli(),
	}); err != nil {
		t.Fatalf("insert device credential: %v", err)
	}

	device := &authClient{t: t, h: handler, master: deviceToken}
	if rec := device.get("/api/settings"); rec.Code != http.StatusForbidden {
		t.Fatalf("device reading settings: %d %s, want 403", rec.Code, rec.Body.String())
	}
	// The same credential still reaches the routes a client legitimately uses.
	if rec := device.get("/api/tasks"); rec.Code != http.StatusOK {
		t.Fatalf("device listing tasks: %d %s", rec.Code, rec.Body.String())
	}
}

// joinMember writes a second account directly and returns a client holding its
// session cookie. Registration closes after the first claim, so nothing in the
// product creates one yet — the guards have to be right before that changes,
// which is why the row is written here rather than through an API.
//
// The role is left unset on purpose: an account that never had one recorded has
// to land on the unprivileged side rather than inherit the claim.
func joinMember(t *testing.T, s *Server, handler http.Handler, id, email string) *authClient {
	t.Helper()
	const password = "hunter2hunter2"
	hash, err := auth.HashPassword(password)
	if err != nil {
		t.Fatalf("hash password: %v", err)
	}
	now := time.Now().UnixMilli()
	if err := s.Store.CreateUserWithIdentity(t.Context(),
		store.User{ID: id, Email: email, DisplayName: "Member", CreatedAt: now},
		store.UserIdentity{
			ID: id + "-identity", UserID: id,
			Provider: store.ProviderPassword, Subject: email,
			SecretHash: hash, Label: "password", CreatedAt: now,
		}); err != nil {
		t.Fatalf("create member account: %v", err)
	}

	member := &authClient{t: t, h: handler}
	if rec := member.post("/api/auth/login",
		`{"email":"`+email+`","password":"`+password+`"}`); rec.Code != http.StatusOK {
		t.Fatalf("member login: %d %s", rec.Code, rec.Body.String())
	}
	if member.cookie == nil {
		t.Fatal("member login did not open a session")
	}
	return member
}

// TestMemberAccountCannotReachOperatorRoutes covers the case ADR 0026 exists
// for: a Hub holding more than one account.
func TestMemberAccountCannotReachOperatorRoutes(t *testing.T) {
	s, _, code := newAuthTestServer(t)
	handler := s.Handler()

	owner := &authClient{t: t, h: handler}
	claimOwner(t, owner, code)
	member := joinMember(t, s, handler, "member-account", "member@example.com")

	// Signed in, but not the account that claimed the Hub.
	if rec := member.get("/api/settings"); rec.Code != http.StatusForbidden {
		t.Fatalf("member reading settings: %d %s, want 403", rec.Code, rec.Body.String())
	}
	if rec := member.do(http.MethodPut, "/api/settings", `{"notify.bark_url":""}`); rec.Code != http.StatusForbidden {
		t.Fatalf("member writing settings: %d %s, want 403", rec.Code, rec.Body.String())
	}
	if rec := member.get("/api/devices"); rec.Code != http.StatusForbidden {
		t.Fatalf("member listing devices: %d %s, want 403", rec.Code, rec.Body.String())
	}
	// The routes a signed-in account legitimately uses still work.
	if rec := member.get("/api/tasks"); rec.Code != http.StatusOK {
		t.Fatalf("member listing tasks: %d %s", rec.Code, rec.Body.String())
	}
}

// The machine routes are the holder's, and the holder gate has two halves that
// are refused for different reasons: a member account, which is not the holder,
// and a device that is not paired. A paired phone passes — that is the product,
// a phone driving the machine it was paired to — so the device half is pinned by
// TestAPairedDeviceCanDiscoverMachinesButNotManageThem and this is the other one.
//
// It is worth its own test because these routes answer with the paths a machine
// works in (see machineResponse), and because a member is the principal the gate
// exists for: a guest on someone's Hub runs its own tasks and has no business
// reading where the holder keeps their checkouts. Every route in the family is
// listed rather than the one that was just added — they share a gate, and a route
// added to the family later without it is the regression this refuses.
func TestMemberAccountCannotReadTheMachineRoutes(t *testing.T) {
	s, _, code := newAuthTestServer(t)
	handler := s.Handler()

	owner := &authClient{t: t, h: handler}
	claimOwner(t, owner, code)
	member := joinMember(t, s, handler, "machine-member", "machine@example.com")

	// The owner is not refused, so a 403 below is the gate and not a route that
	// answers nothing to anyone.
	if rec := owner.get("/api/machines"); rec.Code != http.StatusOK {
		t.Fatalf("owner listing machines: %d %s", rec.Code, rec.Body.String())
	}

	for _, path := range []string{
		"/api/machines",
		"/api/machines/self/dirs?path=/",
		"/api/machines/self/repo/branches?url=https://github.com/owner/repo",
		"/api/git/branches?cwd=/tmp",
	} {
		if rec := member.get(path); rec.Code != http.StatusForbidden {
			t.Fatalf("member reading %s: %d %s, want 403", path, rec.Code, rec.Body.String())
		}
	}
	if rec := member.do(http.MethodPost, "/api/machines/self/repo/prepare", `{"url":"https://github.com/owner/repo"}`); rec.Code != http.StatusForbidden {
		t.Fatalf("member preparing a repository: %d %s, want 403", rec.Code, rec.Body.String())
	}
	if rec := member.do(http.MethodPost, "/api/git/checkout", `{"cwd":"/tmp","branch":"main"}`); rec.Code != http.StatusForbidden {
		t.Fatalf("member checking out a branch: %d %s, want 403", rec.Code, rec.Body.String())
	}
}

// TestTheApprovalGateFollowsTheTaskNotTheRole covers the human gate. These
// handlers once read no principal at all, which was correct while "the human"
// and "the owner" were the same actor; the gate is now a property of the task
// behind the row, so a member answering their own task's approval is the
// product working and a member answering someone else's is the leak.
func TestTheApprovalGateFollowsTheTaskNotTheRole(t *testing.T) {
	s, _, code := newAuthTestServer(t)
	handler := s.Handler()

	owner := &authClient{t: t, h: handler}
	claimOwner(t, owner, code)
	member := joinMember(t, s, handler, "gate-member", "gate@example.com")

	// An approval on the member's own task, and one on a task that is the
	// owner's business only.
	insertOwnedTaskForGate(t, s, "task-member", "gate-member")
	insertOwnedTaskForGate(t, s, "task-owner", "")
	insertApprovalForGate(t, s, "approval-member", "task-member")
	insertApprovalForGate(t, s, "approval-owner", "task-owner")

	// The member's inbox is its own, and an empty inbox is not a 403: refusing
	// outright would tell the member that somebody else's inbox exists.
	list := decodeApprovalIDs(t, member.get("/api/approvals"))
	if len(list) != 1 || list[0] != "approval-member" {
		t.Fatalf("member approvals = %v, want only its own", list)
	}
	if rec := member.post("/api/approvals/approval-owner/decision", `{"decision":"approved"}`); rec.Code != http.StatusNotFound {
		t.Fatalf("member deciding the owner's approval: %d %s, want 404", rec.Code, rec.Body.String())
	}
	if rec := member.post("/api/approvals/approval-member/decision", `{"decision":"approved"}`); rec.Code != http.StatusOK {
		t.Fatalf("member deciding its own approval: %d %s", rec.Code, rec.Body.String())
	}
	if rec := member.post("/api/user-questions/some-id/answer", `{"answer":"yes"}`); rec.Code != http.StatusNotFound {
		t.Fatalf("member answering an unknown question: %d %s, want 404", rec.Code, rec.Body.String())
	}

	// The owner keeps the whole gate, and so does a paired device: the approval
	// inbox on a phone is the product requirement this must not break.
	if rec := owner.get("/api/approvals"); rec.Code != http.StatusOK {
		t.Fatalf("owner listing approvals: %d %s", rec.Code, rec.Body.String())
	}
	const deviceToken = "0011223344556677889900112233445566778899001122334455667788990011"
	if err := s.Store.InsertDeviceCredential(t.Context(), store.DeviceCredential{
		ID:        "device-gate",
		TokenHash: remote.HashToken(deviceToken),
		Label:     "phone",
		CreatedAt: time.Now().UnixMilli(),
	}); err != nil {
		t.Fatalf("insert device credential: %v", err)
	}
	device := &authClient{t: t, h: handler, master: deviceToken}
	if rec := device.get("/api/approvals"); rec.Code != http.StatusOK {
		t.Fatalf("device listing approvals: %d %s, want 200", rec.Code, rec.Body.String())
	}
}

// insertOwnedTaskForGate creates a task with no engine behind it, which is all
// the scope checks read.
func insertOwnedTaskForGate(t *testing.T, s *Server, id, ownerUserID string) {
	t.Helper()
	if err := s.Store.InsertTask(t.Context(), store.Task{
		ID: id, Title: id, Agent: "codex", Cwd: "/tmp", Prompt: "p",
		Status: "running", CreatedAt: time.Now().UnixMilli(), OwnerUserID: ownerUserID,
	}); err != nil {
		t.Fatalf("insert task %s: %v", id, err)
	}
}

func insertApprovalForGate(t *testing.T, s *Server, id, taskID string) {
	t.Helper()
	if err := s.Store.InsertApproval(t.Context(), store.Approval{
		ID: id, TaskID: taskID, Kind: "tool_use",
		Payload: json.RawMessage(`{"tool":"Bash"}`), CreatedAt: time.Now().UnixMilli(),
	}); err != nil {
		t.Fatalf("insert approval %s: %v", id, err)
	}
}

func decodeApprovalIDs(t *testing.T, rec *httptest.ResponseRecorder) []string {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("list approvals: %d %s", rec.Code, rec.Body.String())
	}
	var list []store.Approval
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode approvals: %v (body %s)", err, rec.Body.String())
	}
	ids := make([]string, 0, len(list))
	for _, a := range list {
		ids = append(ids, a.ID)
	}
	return ids
}

// TestClaimRecordsTheOwnerRole pins the other half of the same rule: the guard
// above is only meaningful if claiming actually writes the role it checks.
func TestClaimRecordsTheOwnerRole(t *testing.T) {
	s, _, code := newAuthTestServer(t)
	handler := s.Handler()

	owner := &authClient{t: t, h: handler}
	claimOwner(t, owner, code)

	var id string
	if err := s.Store.DB().QueryRowContext(t.Context(),
		`SELECT id FROM users`).Scan(&id); err != nil {
		t.Fatalf("read claimed user: %v", err)
	}
	user, err := s.Store.GetUser(t.Context(), id)
	if err != nil {
		t.Fatalf("get user: %v", err)
	}
	if user.Role != store.RoleOwner {
		t.Fatalf("claimed account role = %q, want %q", user.Role, store.RoleOwner)
	}
	if !user.IsOwner() {
		t.Fatal("IsOwner() is false for the account that claimed the Hub")
	}
}

// TestOwnerAccountSeesEverythingOnItsOwnHub pins the other half of the scope
// rule. The owner is not "an account that happens to have a role" — they hold
// the machine, so they see the tasks that have no owner at all: everything a
// standalone daemon wrote before accounts existed, and everything a routine
// creates on a timer with no principal behind it.
func TestOwnerAccountSeesEverythingOnItsOwnHub(t *testing.T) {
	s, _, code := newAuthTestServer(t)
	handler := s.Handler()

	owner := &authClient{t: t, h: handler}
	claimOwner(t, owner, code)
	owner.master = ""

	// A task with no owner, of the kind only a routine or a pre-accounts
	// daemon produces.
	now := time.Now().UnixMilli()
	if err := s.Store.InsertTask(t.Context(), store.Task{
		ID: "task-unowned", Title: "routine run", Agent: "claude-code",
		Cwd: "/tmp/project", Prompt: "nightly", Status: "queued", CreatedAt: now,
	}); err != nil {
		t.Fatalf("insert unowned task: %v", err)
	}

	rec := owner.get("/api/tasks")
	if rec.Code != http.StatusOK {
		t.Fatalf("owner listing tasks: %d %s", rec.Code, rec.Body.String())
	}
	var listed []store.Task
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil {
		t.Fatalf("decode tasks: %v", err)
	}
	var found bool
	for _, task := range listed {
		if task.ID == "task-unowned" {
			found = true
		}
	}
	if !found {
		t.Fatalf("the owner could not see an unowned task; list = %+v", listed)
	}
	if rec := owner.get("/api/tasks/task-unowned"); rec.Code != http.StatusOK {
		t.Fatalf("owner reading an unowned task: %d %s", rec.Code, rec.Body.String())
	}
}

// TestMemberAccountCannotReachTheOwnersTasks is the end-to-end half of account
// isolation: two real sessions against the real routes. The store-level scope
// test proves the predicate; this proves the routes actually apply it.
func TestMemberAccountCannotReachTheOwnersTasks(t *testing.T) {
	s, _, code := newAuthTestServer(t)
	handler := s.Handler()

	owner := &authClient{t: t, h: handler}
	claimOwner(t, owner, code)
	owner.master = ""

	member := joinMember(t, s, handler, "scope-member", "scope@example.com")

	rec := owner.post("/api/tasks", `{"agent":"claude-code","cwd":"/tmp/project","prompt":"the owner's work"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("owner creating a task: %d %s", rec.Code, rec.Body.String())
	}
	var created store.Task
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode created task: %v", err)
	}
	if created.OwnerUserID == "" {
		t.Fatal("a task created from an account session recorded no owner")
	}

	// The list must not contain it, and the id must not be a way around that.
	rec = member.get("/api/tasks")
	if rec.Code != http.StatusOK {
		t.Fatalf("member listing tasks: %d %s", rec.Code, rec.Body.String())
	}
	var listed []store.Task
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil {
		t.Fatalf("decode member tasks: %v", err)
	}
	if len(listed) != 0 {
		t.Fatalf("a member saw %d of the owner's tasks: %+v", len(listed), listed)
	}
	if rec := member.get("/api/tasks/" + created.ID); rec.Code != http.StatusNotFound {
		t.Fatalf("member reading the owner's task: %d %s, want 404", rec.Code, rec.Body.String())
	}
	if rec := member.get("/api/tasks/" + created.ID + "/events"); rec.Code != http.StatusNotFound {
		t.Fatalf("member reading the owner's events: %d %s, want 404", rec.Code, rec.Body.String())
	}
	// A write is not a way in either.
	if rec := member.post("/api/tasks/"+created.ID+"/cancel", ""); rec.Code != http.StatusNotFound {
		t.Fatalf("member cancelling the owner's task: %d %s, want 404", rec.Code, rec.Body.String())
	}

	// The owner still reaches their own task, so the guard is not simply "deny".
	if rec := owner.get("/api/tasks/" + created.ID); rec.Code != http.StatusOK {
		t.Fatalf("owner reading their own task: %d %s", rec.Code, rec.Body.String())
	}

	// Two members do not see each other either: this is not a role check that
	// merely separates "the owner" from "everyone else".
	other := joinMember(t, s, handler, "scope-other", "other@example.com")
	rec = member.post("/api/tasks", `{"agent":"claude-code","cwd":"/tmp/member","prompt":"member work"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("member creating a task: %d %s", rec.Code, rec.Body.String())
	}
	var memberTask store.Task
	if err := json.Unmarshal(rec.Body.Bytes(), &memberTask); err != nil {
		t.Fatalf("decode member task: %v", err)
	}

	if rec := member.get("/api/tasks/" + memberTask.ID); rec.Code != http.StatusOK {
		t.Fatalf("member reading its own task: %d %s", rec.Code, rec.Body.String())
	}
	if rec := other.get("/api/tasks/" + memberTask.ID); rec.Code != http.StatusNotFound {
		t.Fatalf("a second member read the first member's task: %d %s, want 404", rec.Code, rec.Body.String())
	}
}

func TestAnonymousCannotReachOperatorRoutes(t *testing.T) {
	s, _, _ := newAuthTestServer(t)
	anon := &authClient{t: t, h: s.Handler()}
	if rec := anon.get("/api/settings"); rec.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous settings: %d, want 401", rec.Code)
	}
}

func TestMasterTokenStillReachesOperatorRoutes(t *testing.T) {
	s, master := newTestServer(t)
	client := &authClient{t: t, h: s.Handler(), master: master}
	if rec := client.get("/api/settings"); rec.Code != http.StatusOK {
		t.Fatalf("master reading settings: %d %s", rec.Code, rec.Body.String())
	}
}

func TestOwnerSessionNeverSeesTheMasterToken(t *testing.T) {
	s, master, code := newAuthTestServer(t)
	handler := s.Handler()

	owner := &authClient{t: t, h: handler}
	claimOwner(t, owner, code)
	owner.master = ""

	rec := owner.get("/api/settings")
	if rec.Code != http.StatusOK {
		t.Fatalf("owner reading settings: %d %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode settings: %v", err)
	}
	if tok, _ := body["token"].(string); tok != "" {
		t.Fatal("an account session was handed the daemon master token")
	}
	if connect, _ := body["connect_url"].(string); strings.Contains(connect, "token=") {
		t.Fatalf("connect_url leaked a master token: %q", connect)
	}

	// The master token holder still needs both to pair a desktop client. The
	// test harness does not wire Server.Token, so supply it here.
	s.Token = master
	masterClient := &authClient{t: t, h: handler, master: master}
	rec = masterClient.get("/api/settings")
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode master settings: %v", err)
	}
	if tok, _ := body["token"].(string); tok != master {
		t.Fatalf("master token was withheld from the master itself: %q", tok)
	}
}

// TestAMemberCannotReadTheMachinesOwnRecords covers the surfaces that describe
// the machine rather than one account's tasks: its projects, routines,
// artifacts, agent sessions, working directories, and usage.
//
// These were open to any signed-in account. They are not settings, so
// operatorOnly would be the wrong gate — a paired phone is a full client of the
// machine it was paired to, and refusing it would break the remote control this
// product exists for. What must not pass is a member: a guest on someone's Hub
// runs its own tasks and has no business reading the holder's project list,
// prompts, or file paths.
func TestAMemberCannotReadTheMachinesOwnRecords(t *testing.T) {
	s, _, code := newAuthTestServer(t)
	handler := s.Handler()

	owner := &authClient{t: t, h: handler}
	claimOwner(t, owner, code)
	owner.master = ""

	member := joinMember(t, s, handler, "holder-member", "holder@example.com")

	// Every one of these reads the holder's machine, not the caller's tasks.
	// The routing and agent-management reads are on the list for the same
	// reason as the rest: they name the machine's providers, profiles, and
	// installed CLIs, none of which a guest on someone's Hub administers.
	for _, path := range []string{
		"/api/projects",
		"/api/routines",
		"/api/routines/unread-count",
		"/api/artifacts",
		"/api/agent-sessions",
		"/api/recent-cwds",
		"/api/usage/summary",
		"/api/git/branches?cwd=/tmp",
		"/api/workers",
		"/api/connectors",
		"/api/agents/management",
		"/api/agent-providers",
		"/api/routing/options",
		"/api/routing/preview",
		"/api/routing/defaults",
		"/api/routing/profiles",
		"/api/routing/provider-profiles",
	} {
		if rec := member.get(path); rec.Code != http.StatusForbidden {
			t.Fatalf("member reading %s: %d %s, want 403", path, rec.Code, rec.Body.String())
		}
	}

	// The owner holds the machine, so nothing here changed for them. The
	// assertion is "not refused" rather than "200": a handler may still answer
	// 503 for its own reasons on a test server with no projects directory, and
	// that is not what this test is about.
	for _, path := range []string{"/api/projects", "/api/routines", "/api/artifacts", "/api/usage/summary"} {
		if rec := owner.get(path); rec.Code == http.StatusForbidden {
			t.Fatalf("the holder was refused %s: %d %s", path, rec.Code, rec.Body.String())
		}
	}

	// And the paired phone keeps them, which is the half a role check would have
	// broken.
	const deviceToken = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899"
	if err := s.Store.InsertDeviceCredential(t.Context(), store.DeviceCredential{
		ID:        "device-holder",
		TokenHash: remote.HashToken(deviceToken),
		Label:     "phone",
		CreatedAt: time.Now().UnixMilli(),
	}); err != nil {
		t.Fatalf("insert device credential: %v", err)
	}
	device := &authClient{t: t, h: handler, master: deviceToken}
	for _, path := range []string{"/api/projects", "/api/routines", "/api/artifacts", "/api/agent-sessions"} {
		if rec := device.get(path); rec.Code == http.StatusForbidden {
			t.Fatalf("a paired device was refused %s: %d %s", path, rec.Code, rec.Body.String())
		}
	}
}
