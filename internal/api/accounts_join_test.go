package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/vuuihc/openkin/internal/auth"
	"github.com/vuuihc/openkin/internal/remote"
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
	if rec := owner.from("198.51.100.7:5000", http.MethodPost, "/api/auth/invite", ""); rec.Code != http.StatusOK {
		t.Fatalf("a stranger's failed joins denied the owner their own machine: %d %s", rec.Code, rec.Body.String())
	}
}

// The attempt limit keys on an address, and the address is not necessarily the
// caller's: a Hub behind a tunnel that does not preserve the peer sees every
// visitor as a single one. So the limit must not be able to spend somebody
// else's access. A caller presenting a valid credential is not guessing, and
// this pins that a flood of failures cannot turn their own session, or the
// machine's master token, into a 429 on a route they are entitled to.
//
// It is the companion to the test above: that one says the budget belongs to the
// caller, this one says an address that has spent its budget still cannot spend
// a credential it does not own.
func TestAStrangersFailedGuessesDoNotDenyAValidCredential(t *testing.T) {
	s, master, code := newAuthTestServer(t)
	owner := &authClient{t: t, h: s.Handler()}
	claimOwner(t, owner, code)

	// Both callers arrive from one address from here on.
	const shared = "198.51.100.7:5000"
	h := s.Handler()
	blocked := false
	for i := 0; i < 40 && !blocked; i++ {
		blocked = postJoinFrom(t, h, shared, "").Code == http.StatusTooManyRequests
	}
	if !blocked {
		t.Fatal("40 failed joins from one address were all answered; the limit is not applied to this peer at all")
	}
	// From here every request shares the address that has just been blocked, which
	// is the situation being tested.
	if rec := postJoinFrom(t, h, shared, ""); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("a blocked address was served: %d %s", rec.Code, rec.Body.String())
	}
	if rec := owner.from(shared, http.MethodGet, "/api/tasks", ""); rec.Code != http.StatusOK {
		t.Fatalf("the owner's session got %d from the blocked address, want 200: %s", rec.Code, rec.Body.String())
	}
	machine := &authClient{t: t, h: h, master: master}
	if rec := machine.from(shared, http.MethodGet, "/api/tasks", ""); rec.Code != http.StatusOK {
		t.Fatalf("the master token got %d from the blocked address, want 200: %s", rec.Code, rec.Body.String())
	}
	// And the block is still real: an unauthenticated caller from that address is
	// refused rather than merely unauthorized, so the limit was not traded away
	// for the two assertions above.
	if rec := (&authClient{t: t, h: h}).from(shared, http.MethodGet, "/api/tasks", ""); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("an unauthenticated caller from a blocked address got %d, want 429: %s", rec.Code, rec.Body.String())
	}
}

// The join route is reachable by anyone, so it must not answer questions about
// which addresses have accounts here.
//
// The check that improves the message for a fixable mistake -- "that email
// already has an account, sign in instead" -- necessarily answers differently
// for a registered and an unregistered address. Answered before the code is
// looked at, that difference is an oracle: a stranger holding no invitation at
// all reads off the Hub's account list one guess at a time, and the list is who
// to target for password guessing.
//
// Both halves are asserted together. A "fix" that stopped saying email_taken to
// anyone would pass the equality alone while destroying the property the message
// exists for, which is that an invited person who already has an account is not
// left burning one replacement link after another.
func TestJoinDoesNotAnswerWhetherAnAddressHasAnAccount(t *testing.T) {
	s, _, code := newAuthTestServer(t)
	owner := &authClient{t: t, h: s.Handler()}
	claimOwner(t, owner, code)
	joinedMember(t, s, invite(t, owner), "joiner@example.com")

	anonymous := &authClient{t: t, h: s.Handler()}
	refusals := make(map[string]string)
	for _, email := range []string{"joiner@example.com", "nobody@example.com"} {
		rec := anonymous.post("/api/auth/join",
			`{"code":"AAAAA-BBBBB-CCCCC-DDDDD","email":"`+email+`","password":"hunter2hunter2"}`)
		var body struct {
			Code string `json:"code"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("join refusal is not JSON: %v (%s)", err, rec.Body.String())
		}
		refusals[email] = body.Code
	}
	if refusals["joiner@example.com"] != "invite_invalid" {
		t.Fatalf("an invented invitation answers %q for a registered address, want invite_invalid (%s)",
			refusals["joiner@example.com"], refusals["joiner@example.com"])
	}
	if refusals["joiner@example.com"] != refusals["nobody@example.com"] {
		t.Fatalf("an invented invitation answers %q for a registered address and %q for an unregistered one; "+
			"the route tells an anonymous caller which addresses have accounts here",
			refusals["joiner@example.com"], refusals["nobody@example.com"])
	}
	// And a live invitation still gets the message that names the problem, so the
	// refusal above is about the code rather than about the message having been
	// deleted everywhere.
	live := &authClient{t: t, h: s.Handler()}
	rec := live.post("/api/auth/join",
		`{"code":"`+invite(t, owner)+`","email":"joiner@example.com","password":"hunter2hunter2"}`)
	var body struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("join refusal is not JSON: %v (%s)", err, rec.Body.String())
	}
	if body.Code != "email_taken" {
		t.Fatalf("a live invitation for an address that already has an account answers %q, want email_taken (%s)",
			body.Code, rec.Body.String())
	}
}

// postJoinFrom sends an anonymous join from a given peer, optionally claiming to
// be forwarded on behalf of somebody else.
func postJoinFrom(t *testing.T, h http.Handler, peer, forwardedFor string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/auth/join", bytes.NewReader([]byte(
		`{"code":"AAAAA-BBBBB-CCCCC-DDDDD","email":"joiner@example.com","password":"hunter2hunter2"}`)))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = peer
	if forwardedFor != "" {
		req.Header.Set("X-Forwarded-For", forwardedFor)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// The auth attempt limiter has to key on the connection, not on a header.
//
// The test above models a second client by giving the request a second peer
// address, which is only a model of "two clients" if a real client cannot pick
// its own address -- and middleware.RealIP rewrites RemoteAddr from
// X-Forwarded-For, which any caller can set. Without the peer captured ahead of
// it, one attacker gets unlimited guesses by varying the header, and the cap the
// test above asserts is decoration.
func TestAForwardedForHeaderDoesNotBuyAFreshBudget(t *testing.T) {
	s, _, code := newAuthTestServer(t)
	owner := &authClient{t: t, h: s.Handler()}
	claimOwner(t, owner, code)

	h := s.Handler()
	limited := false
	for i := 0; i < 40 && !limited; i++ {
		rec := postJoinFrom(t, h, "198.51.100.7:5000", fmt.Sprintf("203.0.113.%d", i))
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
		t.Fatal("a forged X-Forwarded-For bought a fresh budget every request; the limit keys on a caller-supplied value")
	}
}

// The session row records where the sign-in came from, and that column is audit
// data: it has to say where the connection was, not where the caller said it
// was. The same helper backs the limiter, so this is the other half of the test
// above -- a limiter keyed on the connection with an audit column keyed on the
// header would be the fix applied to one of the two readers.
func TestASessionRecordsThePeerNotAForwardedHeader(t *testing.T) {
	s, _, code := newAuthTestServer(t)
	owner := &authClient{t: t, h: s.Handler()}
	claimOwner(t, owner, code)

	req := httptest.NewRequest(http.MethodPost, "/api/auth/join", bytes.NewReader([]byte(
		`{"code":"`+invite(t, owner)+`","email":"joiner@example.com","password":"hunter2hunter2"}`)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Forwarded-For", "203.0.113.9")
	req.RemoteAddr = "198.51.100.7:5000"
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("join: %d %s", rec.Code, rec.Body.String())
	}

	var token string
	for _, c := range rec.Result().Cookies() {
		if c.Name == remote.SessionCookieName {
			token = c.Value
		}
	}
	if token == "" {
		t.Fatal("joining did not open a session")
	}
	session, _, err := s.Store.AuthenticateSession(t.Context(), remote.HashToken(token), store.NowMilli())
	if err != nil {
		t.Fatalf("read the session back: %v", err)
	}
	if session.IP != "198.51.100.7" {
		t.Fatalf("session recorded IP %q, want the peer 198.51.100.7; a forwarded header must not choose the audit column",
			session.IP)
	}
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

// An invitation is not spent by a join that could not have succeeded.
//
// The person this happens to is one who was invited twice, or who lost their
// session and clicked the link again: they already have an account, so the join
// cannot create one. Answering that by consuming the code first would turn a
// fixable mistake into a dead link -- the retry says "not valid", so they cannot
// tell a spent invitation from a wrong one, and every replacement the owner
// sends dies the same way.
func TestJoiningWithAnEmailThatAlreadyExistsKeepsTheInvitation(t *testing.T) {
	s, _, code := newAuthTestServer(t)
	owner := &authClient{t: t, h: s.Handler()}
	claimOwner(t, owner, code)

	joinedMember(t, s, invite(t, owner), "joiner@example.com")

	second := invite(t, owner)
	again := &authClient{t: t, h: s.Handler()}
	rec := again.post("/api/auth/join",
		`{"code":"`+second+`","email":"joiner@example.com","password":"hunter2hunter2","display_name":"Joiner"}`)
	if rec.Code == http.StatusOK {
		t.Fatalf("a second account was created for an address that already had one: %s", rec.Body.String())
	}
	var body struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("join refusal is not JSON: %v (%s)", err, rec.Body.String())
	}
	if body.Code != "email_taken" {
		t.Fatalf("join with an existing email = %q, want email_taken (%s)", body.Code, rec.Body.String())
	}

	// The invitation has to still be spendable, by somebody else. This is the
	// half that separates "the code survived" from "the code was burned and the
	// message merely improved".
	joinedMember(t, s, second, "somebody-else@example.com")

	// And nothing extra was written along the way: owner, and two members.
	n, err := s.Store.CountUsers(t.Context())
	if err != nil {
		t.Fatalf("count users: %v", err)
	}
	if n != 3 {
		t.Fatalf("users after the retry = %d, want 3 (owner + two members)", n)
	}
}
