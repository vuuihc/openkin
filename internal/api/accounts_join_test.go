package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/vuuihc/openkin/internal/auth"
	"github.com/vuuihc/openkin/internal/store"
)

// These tests cover the one thing the rest of auth_test.go cannot: the account
// it fabricates. joinMember writes a member row straight through the store,
// because until now there was no other way for one to exist -- and that is
// exactly the gap this slice closes. Everything else about member isolation was
// already true and already tested; what is new is a production path that
// produces such an account, so these tests drive the real routes and then check
// the resulting session has the properties the fabricated one was assumed to
// have.

// invite issues an invitation as the owner and returns the plaintext code. It
// is read from the response because that is the only time it exists.
func invite(t *testing.T, owner *authClient) string {
	t.Helper()
	rec := owner.post("/api/auth/invite", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("issue an invitation: %d %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Code      string `json:"code"`
		ExpiresAt int64  `json:"expires_at"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invite response: %v (%s)", err, rec.Body.String())
	}
	if body.Code == "" || body.ExpiresAt == 0 {
		t.Fatalf("invitation came back without a code or an expiry: %s", rec.Body.String())
	}
	return body.Code
}

// joinedMember registers a second person the way the product does it: with an
// invitation and nothing else.
func joinedMember(t *testing.T, s *Server, code, email string) *authClient {
	t.Helper()
	member := &authClient{t: t, h: s.Handler()}
	rec := member.post("/api/auth/join",
		`{"code":"`+code+`","email":"`+email+`","password":"hunter2hunter2","display_name":"Joiner"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("join with an invitation: %d %s", rec.Code, rec.Body.String())
	}
	if member.cookie == nil {
		t.Fatal("joining did not open a session")
	}
	return member
}

// ownerTask creates a task as the owner and returns its id, checking on the way
// that the owner can actually see it. Without that half, the assertions below
// would also pass on a server where listing is broken for everybody.
func ownerTask(t *testing.T, owner *authClient, cwd, prompt string) string {
	t.Helper()
	rec := owner.post("/api/tasks", `{"agent":"claude-code","cwd":"`+cwd+`","prompt":"`+prompt+`"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("owner creates a task: %d %s", rec.Code, rec.Body.String())
	}
	var created store.Task
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil || created.ID == "" {
		t.Fatalf("create response: %v (%s)", err, rec.Body.String())
	}
	if seen := visibleTaskIDs(t, owner); len(seen) == 0 {
		t.Fatalf("the owner cannot see the task they just created: %v", seen)
	}
	return created.ID
}

func visibleTaskIDs(t *testing.T, c *authClient) []string {
	t.Helper()
	rec := c.get("/api/tasks")
	if rec.Code != http.StatusOK {
		t.Fatalf("list tasks: %d %s", rec.Code, rec.Body.String())
	}
	var tasks []store.Task
	if err := json.Unmarshal(rec.Body.Bytes(), &tasks); err != nil {
		t.Fatalf("task list: %v (%s)", err, rec.Body.String())
	}
	ids := make([]string, 0, len(tasks))
	for _, task := range tasks {
		ids = append(ids, task.ID)
	}
	return ids
}

// P5's acceptance criterion, through the real routes: a second person signs
// themselves up with an invitation, and the owner's machine is not handed over
// in the process.
func TestASecondPersonCanJoinAndSeesNothingOfTheOwners(t *testing.T) {
	s, _, code := newAuthTestServer(t)
	owner := &authClient{t: t, h: s.Handler()}
	claimOwner(t, owner, code)

	ownedTask := ownerTask(t, owner, t.TempDir(), "the owner's work")

	member := joinedMember(t, s, invite(t, owner), "joiner@example.com")

	// The role the join conferred, cross-checked against the stored account
	// rather than the response that created it. The API deliberately does not
	// put a role in its user view -- a client has no decisions to make with it,
	// and the gates answer for themselves -- so this reads what was written.
	me := member.get("/api/auth/me")
	if me.Code != http.StatusOK {
		t.Fatalf("the joined session does not authenticate: %d %s", me.Code, me.Body.String())
	}
	var who struct {
		User authUser `json:"user"`
	}
	if err := json.Unmarshal(me.Body.Bytes(), &who); err != nil {
		t.Fatalf("auth/me: %v (%s)", err, me.Body.String())
	}
	if who.User.ID == "" || who.User.Email != "joiner@example.com" {
		t.Fatalf("the joined session belongs to %s <%s>, want the account that just joined", who.User.ID, who.User.Email)
	}
	stored, err := s.Store.GetUser(context.Background(), who.User.ID)
	if err != nil {
		t.Fatalf("read the joined account: %v", err)
	}
	if stored.Role != store.RoleMember {
		t.Fatalf("the joined account is %q, want %q", stored.Role, store.RoleMember)
	}

	// Both halves of "cannot see or read anything of the holder's". The id is
	// refused with the same answer a made-up one gets: a 403 here would confirm
	// the task exists.
	if seen := visibleTaskIDs(t, member); len(seen) != 0 {
		t.Fatalf("a joined member sees the owner's tasks: %v", seen)
	}
	if rec := member.get("/api/tasks/" + ownedTask); rec.Code != http.StatusNotFound {
		t.Fatalf("a joined member reading the owner's task got %d, want 404: %s", rec.Code, rec.Body.String())
	}
	// And the owner still can, so the two refusals above are about the member
	// and not about the task having gone missing.
	if rec := owner.get("/api/tasks/" + ownedTask); rec.Code != http.StatusOK {
		t.Fatalf("the owner lost access to their own task: %d %s", rec.Code, rec.Body.String())
	}
}

// The joined member has to land in the same place the fabricated one does. This
// is the guard against S1 creating an account that is a member in name and an
// operator in reach.
func TestAJoinedMemberReachesNoOperatorRoute(t *testing.T) {
	s, _, code := newAuthTestServer(t)
	owner := &authClient{t: t, h: s.Handler()}
	claimOwner(t, owner, code)
	member := joinedMember(t, s, invite(t, owner), "joiner@example.com")

	if rec := owner.get("/api/devices"); rec.Code != http.StatusOK {
		t.Fatalf("owner listing devices: %d %s", rec.Code, rec.Body.String())
	}
	for _, path := range []string{"/api/devices", "/api/settings", "/api/machines"} {
		if rec := member.get(path); rec.Code != http.StatusForbidden {
			t.Fatalf("a joined member reading %s: %d %s, want 403", path, rec.Code, rec.Body.String())
		}
	}
	// Inviting is administering the machine. A member who can mint invitations
	// can mint themselves a second account, so this is the route that would
	// make the role meaningless.
	if rec := member.post("/api/auth/invite", ""); rec.Code != http.StatusForbidden {
		t.Fatalf("a joined member issued an invitation: %d %s", rec.Code, rec.Body.String())
	}
}

// The unauthenticated half of the same rule.
func TestInvitingNeedsAnAuthenticatedOperator(t *testing.T) {
	s, master, _ := newAuthTestServer(t)
	anonymous := &authClient{t: t, h: s.Handler()}
	if rec := anonymous.post("/api/auth/invite", ""); rec.Code == http.StatusOK {
		t.Fatalf("an anonymous caller issued an invitation: %s", rec.Body.String())
	}
	// The master token is the machine's holder, so it is an operator. Checking
	// this keeps the refusal above about authentication rather than about the
	// route answering nothing to anyone.
	asMaster := &authClient{t: t, h: s.Handler(), master: master}
	if rec := asMaster.post("/api/auth/invite", ""); rec.Code != http.StatusOK {
		t.Fatalf("the master token cannot issue an invitation: %d %s", rec.Code, rec.Body.String())
	}
}

// The join route is unauthenticated by necessity, so a wrong code has to be a
// plain refusal: no hint about which part was wrong, and no account.
func TestJoiningWithAnUnknownCodeCreatesNothing(t *testing.T) {
	s, _, code := newAuthTestServer(t)
	owner := &authClient{t: t, h: s.Handler()}
	claimOwner(t, owner, code)

	anonymous := &authClient{t: t, h: s.Handler()}
	rec := anonymous.post("/api/auth/join",
		`{"code":"AAAAA-BBBBB-CCCCC-DDDDD","email":"joiner@example.com","password":"hunter2hunter2"}`)
	if rec.Code == http.StatusOK {
		t.Fatalf("an invented invitation created an account: %s", rec.Body.String())
	}
	var body struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("the refusal is not the typed error shape: %v (%s)", err, rec.Body.String())
	}
	if body.Code != "invite_invalid" {
		t.Fatalf("refusal code = %q, want invite_invalid", body.Code)
	}
	// Nothing was created, so the refusal did not half-succeed.
	signIn := anonymous.post("/api/auth/login",
		`{"email":"joiner@example.com","password":"hunter2hunter2"}`)
	if signIn.Code == http.StatusOK {
		t.Fatalf("a refused join still produced a working account: %s", signIn.Body.String())
	}
}

// A spent invitation is not a second account. The store test proves the token
// is consumed once; this proves the route cannot be walked twice with the
// credential a first walk handed out.
func TestAnInvitationCannotBeRedeemedTwiceOverHTTP(t *testing.T) {
	s, _, code := newAuthTestServer(t)
	owner := &authClient{t: t, h: s.Handler()}
	claimOwner(t, owner, code)
	inviteCode := invite(t, owner)

	joinedMember(t, s, inviteCode, "first@example.com")

	second := &authClient{t: t, h: s.Handler()}
	rec := second.post("/api/auth/join",
		`{"code":"`+inviteCode+`","email":"second@example.com","password":"hunter2hunter2"}`)
	if rec.Code == http.StatusOK {
		t.Fatalf("one invitation produced a second account: %s", rec.Body.String())
	}
	// The account that did join still works, so the refusal is about the code.
	if rec := second.post("/api/auth/login",
		`{"email":"first@example.com","password":"hunter2hunter2"}`); rec.Code != http.StatusOK {
		t.Fatalf("the account that joined first cannot sign in: %d %s", rec.Code, rec.Body.String())
	}
}

// The join route is reachable without a session, so it is the one account route
// an internet caller can hammer. It shares the login limiter, and this pins
// that: a Hub that rate-limits sign-in but not sign-up has moved the guessing
// to the cheaper door.
func TestJoiningIsRateLimited(t *testing.T) {
	s, _, code := newAuthTestServer(t)
	owner := &authClient{t: t, h: s.Handler()}
	claimOwner(t, owner, code)

	anonymous := &authClient{t: t, h: s.Handler()}
	limited := false
	for i := 0; i < 40 && !limited; i++ {
		rec := anonymous.post("/api/auth/join",
			`{"code":"AAAAA-BBBBB-CCCCC-DDDDD","email":"joiner@example.com","password":"hunter2hunter2"}`)
		switch rec.Code {
		case http.StatusTooManyRequests:
			limited = true
		case http.StatusBadRequest:
			// Still guessing. Keep going.
		default:
			t.Fatalf("unexpected status from a wrong code: %d %s", rec.Code, rec.Body.String())
		}
	}
	if !limited {
		t.Fatal("40 wrong invitations in a row were all answered; the unauthenticated route has no attempt limit")
	}
	// And the budget is the caller's, not the machine's. The limiter keys on the
	// peer address, so this models a second client by giving the request one --
	// which is what a real second client has. The failure it guards against is a
	// global counter, where one stranger's guessing denies the owner their own
	// machine; note that callers sharing an address (behind a proxy that sets no
	// forwarding header) share one budget, which is the same failure by another
	// route and is why RealIP has to be configured for a Hub behind a tunnel.
	if rec := postFrom(t, s.Handler(), owner, "198.51.100.7:5000", "/api/auth/invite", ""); rec.Code != http.StatusOK {
		t.Fatalf("a stranger's failed joins denied the owner their own machine: %d %s", rec.Code, rec.Body.String())
	}
}

// postFrom sends an authenticated POST while claiming to come from a given
// peer, so a test can be two clients rather than one.
func postFrom(t *testing.T, h http.Handler, c *authClient, peer, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader([]byte(body)))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = peer
	if c.cookie != nil {
		req.AddCookie(c.cookie)
	}
	if c.master != "" {
		req.Header.Set("Authorization", "Bearer "+c.master)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// An invitation is issued by an owner, so a Hub that has none cannot have one.
// The store test covers the service; this covers the route, where the state
// would be reached by hand-editing a database.
func TestAnInvitationCannotClaimAnUnownedHubOverHTTP(t *testing.T) {
	s, _, _ := newAuthTestServer(t)
	// No claimOwner: the Hub is deliberately left unowned.
	const planted = "AAAAA-BBBBB-CCCCC-DDDDD"
	if err := s.Store.IssueInviteToken(context.Background(),
		auth.HashToken(auth.NormalizeCode(planted)), store.NowMilli(), store.NowMilli()+60000); err != nil {
		t.Fatalf("plant an invitation on an unowned hub: %v", err)
	}

	anonymous := &authClient{t: t, h: s.Handler()}
	rec := anonymous.post("/api/auth/join",
		`{"code":"`+planted+`","email":"joiner@example.com","password":"hunter2hunter2"}`)
	if rec.Code == http.StatusOK {
		t.Fatalf("an invitation took a hub that had no owner: %s", rec.Body.String())
	}
	// The Hub must still be claimable, which is the whole reason for refusing.
	status := decodeStatus(t, anonymous.get("/api/auth/status"))
	if !status.NeedsBootstrap {
		t.Fatal("the hub stopped offering to be claimed; an invitation took a machine that had no owner")
	}
	// And the bootstrap path still works afterwards.
	fresh, err := s.Accounts.IssueBootstrapCode(context.Background())
	if err != nil {
		t.Fatalf("issue bootstrap code: %v", err)
	}
	claimOwner(t, anonymous, fresh)
}
