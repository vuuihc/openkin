package api

import (
	"net/http"
	"strings"
	"testing"
)

// TestAMemberCannotCreateAPairingSession is the first half of S3, and it pins
// the premise the device arm of store.ScopeForPrincipal rests on.
//
// A paired device is unscoped: it sees every task on this machine and reads the
// machine's own records. That is the product — a phone is the holder's own
// client, not a guest — and it stays sound exactly as long as every device
// credential was minted by whoever holds the machine. A member who could mint
// one would hold a credential strictly wider than their account: the task
// scope, the machine-records gate, and the cwd bound all key on an owner, and a
// device credential carries none.
//
// TestScopeForPrincipalNamesWhoHoldsTheMachine in internal/store is the other
// half. It records that the device answers "everything", and that this is the
// reason; this one records that the only way to become a device is to be given
// one by the holder.
//
// Over HTTP that is true by construction: a device credential is only ever
// written by the anonymous exchange below, which needs a live pairing session,
// and a session only comes from these two routes. The exception is not an HTTP
// one at all — `kin hub node-token` writes a credential straight into the Hub's
// database, which takes a shell on the Hub rather than an account on it, so it
// is outside what an account can reach.
func TestAMemberCannotCreateAPairingSession(t *testing.T) {
	s, _, code := newAuthTestServer(t)
	handler := s.Handler()

	owner := &authClient{t: t, h: handler}
	claimOwner(t, owner, code)

	member := joinMember(t, s, handler, "pairing-member", "pairing@example.com")

	// The console route and the relay one: both mint a pairing session, and the
	// session is the only thing that can be exchanged for a device token.
	for _, path := range []string{"/api/pairing/sessions", "/api/relay/pairing"} {
		if rec := member.post(path, `{"label":"phone"}`); rec.Code != http.StatusForbidden {
			t.Fatalf("member creating a pairing session at %s: %d %s, want 403",
				path, rec.Code, rec.Body.String())
		}
	}

	// The holder still can, so the refusals above are the gate rather than a
	// route that answers nobody.
	if rec := owner.post("/api/pairing/sessions", `{"label":"phone"}`); rec.Code == http.StatusForbidden {
		t.Fatalf("the holder was refused a pairing session: %d %s", rec.Code, rec.Body.String())
	}

	// Registering a worker is the one route in this family whose check is in the
	// handler rather than in middleware, and it refuses for a different reason:
	// it takes an existing device token, so the caller has to already be a
	// device. It mints nothing, which is the part that matters here. Asserted
	// separately because the holder is refused too — this is not a role gate, and
	// a table row asserting "the holder is not refused" would be wrong.
	for _, who := range []struct {
		name   string
		client *authClient
	}{{"a member", member}, {"the holder", owner}} {
		if rec := who.client.post("/api/workers/register", `{}`); rec.Code != http.StatusForbidden {
			t.Fatalf("%s registering a worker without a device token: %d %s, want 403",
				who.name, rec.Code, rec.Body.String())
		}
	}
}

// TestThePairingExchangeHandsOutNothingWithoutALiveCode covers the one route in
// this family an anonymous caller can reach, because the phone doing it has no
// account yet.
//
// What bounds it is not a gate but the code: a secret that names no live
// session hands out nothing, and the answer for one that never existed has to
// be the same as for one that expired or was already spent (the spent half is
// asserted in devices_test.go). This is where a device credential is actually
// created, so the check that it cannot be created from nothing belongs next to
// the test that says who may ask for a code.
//
// Each row pins the status it expects rather than accepting any refusal, so a
// change that answered "bad request" for an unknown secret — telling an attacker
// their guess was well formed — could not quietly satisfy this.
func TestThePairingExchangeHandsOutNothingWithoutALiveCode(t *testing.T) {
	s, _, _ := newAuthTestServer(t)
	handler := s.Handler()

	anon := &authClient{t: t, h: handler}
	cases := []struct {
		body   string
		why    string
		status int
	}{
		{`{}`, "no secret at all", http.StatusBadRequest},
		{`{"secret":""}`, "a blank secret", http.StatusBadRequest},
		{`{"secret":"0000000000000000000000000000000000000000000000000000000000000000"}`,
			"a well-formed secret that names no session", http.StatusUnauthorized},
	}
	for _, tc := range cases {
		rec := anon.post("/api/pairing/exchange", tc.body)
		if rec.Code != tc.status {
			t.Fatalf("exchange with %s (%s): %d %s, want %d",
				tc.body, tc.why, rec.Code, rec.Body.String(), tc.status)
		}
		if strings.Contains(rec.Body.String(), `"token"`) {
			t.Fatalf("exchange with %s answered with a credential: %s", tc.body, rec.Body.String())
		}
	}
}
