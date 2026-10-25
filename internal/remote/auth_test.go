package remote

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestEnsureTokenCreatesAndReuses(t *testing.T) {
	dir := t.TempDir()
	tok1, err := EnsureToken(dir)
	if err != nil {
		t.Fatalf("EnsureToken: %v", err)
	}
	if len(tok1) != 64 { // 32 bytes hex
		t.Fatalf("token len = %d, want 64", len(tok1))
	}
	tok2, err := EnsureToken(dir)
	if err != nil {
		t.Fatalf("EnsureToken reuse: %v", err)
	}
	if tok1 != tok2 {
		t.Fatalf("token changed on second call")
	}
	data, err := os.ReadFile(filepath.Join(dir, "token"))
	if err != nil {
		t.Fatal(err)
	}
	if got := string(data[:len(tok1)]); got != tok1 {
		t.Fatalf("file token = %q, want %q", got, tok1)
	}
}

func TestAuthMiddleware(t *testing.T) {
	const token = "aabbccdd00112233445566778899aabbccddeeff00112233445566778899aabb"
	a := NewAuth(token)
	h := a.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, ok := TokenFromContext(r.Context())
		if !ok || got != token {
			t.Fatalf("TokenFromContext = %q, %v; want request token", got, ok)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`[]`))
	}))

	// No token → 401
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/tasks", nil))
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("no token: status %d, want 401", rr.Code)
	}
	if got := rr.Result().Header.Values("WWW-Authenticate"); len(got) != 1 {
		t.Fatalf("WWW-Authenticate headers = %v, want one", got)
	}

	// Bearer → 200
	rr = httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/tasks", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("bearer: status %d, want 200", rr.Code)
	}

	// ?token= → 200
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/tasks?token="+token, nil)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("query token: status %d, want 200", rr.Code)
	}

	// Wrong token → 401
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/tasks", nil)
	req.Header.Set("Authorization", "Bearer wrong")
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("wrong token: status %d, want 401", rr.Code)
	}
}

func TestAuthMiddlewareStoresDeviceTokenInContext(t *testing.T) {
	const deviceToken = "device-token"
	a := NewAuth("master-token")
	a.SetDeviceLookup(func(_ context.Context, token string) (Principal, bool) {
		if token != deviceToken {
			return Principal{}, false
		}
		return Principal{Kind: PrincipalDevice, DeviceID: "dev-1", Label: "Phone"}, true
	})
	h := a.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := PrincipalFromContext(r.Context())
		if !ok || principal.Kind != PrincipalDevice || principal.DeviceID != "dev-1" {
			t.Fatalf("PrincipalFromContext = %+v, %v", principal, ok)
		}
		got, ok := TokenFromContext(r.Context())
		if !ok || got != deviceToken {
			t.Fatalf("TokenFromContext = %q, %v; want device token", got, ok)
		}
		w.WriteHeader(http.StatusOK)
	}))

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/tasks", nil)
	req.Header.Set("Authorization", "Bearer "+deviceToken)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("device token: status %d, want 200", rr.Code)
	}
}

func TestPrincipalIdentitySeparatesAccounts(t *testing.T) {
	// A session principal carries no device id. Keying identity on DeviceID
	// alone is the empty string for every account, which is how two different
	// people become the same caller in A2A ownership and MCP idempotency.
	alice := Principal{Kind: PrincipalUser, UserID: "user-alice"}
	bob := Principal{Kind: PrincipalUser, UserID: "user-bob"}
	if alice.Identity() == bob.Identity() {
		t.Fatalf("two accounts share identity %q", alice.Identity())
	}
	if got := alice.Identity(); got != "user-alice" {
		t.Fatalf("session identity = %q, want the account id", got)
	}

	// A device principal has no account, and keeps its device id.
	phone := Principal{Kind: PrincipalDevice, DeviceID: "device-phone"}
	if got := phone.Identity(); got != "device-phone" {
		t.Fatalf("device identity = %q, want the device id", got)
	}
	if phone.Identity() == alice.Identity() {
		t.Fatal("a device and an account must not share identity")
	}

	// The master token is a namespace of its own and is not an account.
	master := Principal{Kind: PrincipalMaster}
	if master.Identity() != "" {
		t.Fatalf("master identity = %q, want empty", master.Identity())
	}
}

// ClientIP backs both the auth attempt limit and the session audit column, so it
// is the single answer to "who is asking". The property that makes it worth
// having is that the answer cannot be chosen by the caller: middleware.RealIP
// rewrites RemoteAddr from X-Forwarded-For, so the peer captured ahead of it is
// the only trustworthy half. These tests pin the preference and both fallbacks,
// because each fallback is a path a request can actually arrive on.
func TestClientIPPrefersTheRecordedPeer(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/agents", nil)
	// What RealIP left behind after folding in a header the caller chose.
	req.RemoteAddr = "203.0.113.9:5000"
	ctx := WithPeerAddr(req.Context(), "198.51.100.7:41234")
	if got := ClientIP(req.WithContext(ctx)); got != "198.51.100.7" {
		t.Fatalf("ClientIP = %q, want the recorded peer 198.51.100.7; a forwarded header must not choose the answer", got)
	}
}

func TestClientIPFallsBackToRemoteAddr(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/agents", nil)
	req.RemoteAddr = "198.51.100.7:41234"
	if got := ClientIP(req); got != "198.51.100.7" {
		t.Fatalf("ClientIP = %q, want 198.51.100.7 from RemoteAddr", got)
	}
	// An empty recorded peer is the same as none: it is what a caller that
	// captured nothing hands over, and it must not blank the answer out.
	ctx := WithPeerAddr(req.Context(), "")
	if got := ClientIP(req.WithContext(ctx)); got != "198.51.100.7" {
		t.Fatalf("ClientIP with an empty peer = %q, want the RemoteAddr fallback", got)
	}
}

// Some requests arrive with a RemoteAddr that has no port to split off. The
// address is returned unchanged rather than dropped: a strange-looking key still
// limits the caller it names, whereas "" would file every such request under one
// shared bucket -- which is a global counter by another name, and the failure the
// limiter is most careful to avoid.
func TestClientIPWithNoPortReturnsTheAddressUnchanged(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/agents", nil)
	req.RemoteAddr = "unix-socket"
	if got := ClientIP(req); got != "unix-socket" {
		t.Fatalf("ClientIP = %q, want the address unchanged", got)
	}
}

func TestPeerAddrIsEmptyWithoutACapture(t *testing.T) {
	if got := PeerAddr(context.Background()); got != "" {
		t.Fatalf("PeerAddr on a bare context = %q, want empty", got)
	}
	ctx := WithPeerAddr(context.Background(), "198.51.100.7:41234")
	if got := PeerAddr(ctx); got != "198.51.100.7:41234" {
		t.Fatalf("PeerAddr = %q, want the address that was recorded, port included", got)
	}
}
