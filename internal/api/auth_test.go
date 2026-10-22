package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/vuuihc/openkin/internal/auth"
	"github.com/vuuihc/openkin/internal/remote"
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
