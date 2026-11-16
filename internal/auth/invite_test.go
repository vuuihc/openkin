package auth

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/store"
)

// An invitation is the second, and only other, way an account comes into being.
// These tests pin what it makes (a member, never an owner), that it is spent
// once, and the one state it must refuse -- an unowned Hub, where redeeming it
// would leave nobody able to claim the machine.

// testClock is a service clock the test moves by hand. Expiry is the whole
// point of a one-time code, and a test that waits seven days is a test nobody
// runs.
type testClock struct{ now time.Time }

func (c *testClock) Now() time.Time          { return c.now }
func (c *testClock) advance(d time.Duration) { c.now = c.now.Add(d) }

const (
	ownerEmail    = "owner@example.com"
	memberEmail   = "member@example.com"
	testPassword  = "hunter2hunter2"
	otherPassword = "correct-horse-battery"
)

// inviteTestService returns a service on a controllable clock, plus the clock.
func inviteTestService(t *testing.T) (*Service, *store.Store, *testClock) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	clock := &testClock{now: time.Date(2026, 10, 26, 12, 0, 0, 0, time.UTC)}
	return New(st, Config{Now: clock.Now}), st, clock
}

// claimedHub returns a service whose Hub already has an owner: the only state
// an invitation can be issued from, since issuing one is the owner's act.
func claimedHub(t *testing.T) (*Service, *store.Store, *testClock) {
	t.Helper()
	svc, st, clock := inviteTestService(t)
	ctx := context.Background()
	code, err := svc.IssueBootstrapCode(ctx)
	if err != nil {
		t.Fatalf("issue bootstrap code: %v", err)
	}
	if _, err := svc.ClaimWithPassword(ctx, code, ownerEmail, testPassword, "", SessionMeta{}); err != nil {
		t.Fatalf("claim the hub: %v", err)
	}
	return svc, st, clock
}

func TestAnInvitationCreatesAMemberAndNotAnOwner(t *testing.T) {
	svc, st, _ := claimedHub(t)
	ctx := context.Background()

	invite, err := svc.IssueInvite(ctx)
	if err != nil {
		t.Fatalf("issue invite: %v", err)
	}
	session, err := svc.RedeemInvite(ctx, invite.Code, memberEmail, otherPassword, "Second Person", SessionMeta{})
	if err != nil {
		t.Fatalf("redeem invite: %v", err)
	}

	// The role is the whole difference between the two ways in. Getting it wrong
	// hands a second person the machine.
	if session.User.Role != store.RoleMember {
		t.Fatalf("redeemed account role = %q, want %q", session.User.Role, store.RoleMember)
	}
	stored, err := st.GetUser(ctx, session.User.ID)
	if err != nil {
		t.Fatalf("read the joined account: %v", err)
	}
	if stored.Role != store.RoleMember {
		t.Fatalf("stored role = %q, want %q", stored.Role, store.RoleMember)
	}
	// And it is usable: the point of the account is that the person can sign in
	// with it afterwards, not only that a row exists.
	if _, err := svc.LoginPassword(ctx, memberEmail, otherPassword, SessionMeta{}); err != nil {
		t.Fatalf("the joined account cannot sign in: %v", err)
	}
}

func TestAnInvitationIsSpentOnce(t *testing.T) {
	svc, _, _ := claimedHub(t)
	ctx := context.Background()

	invite, err := svc.IssueInvite(ctx)
	if err != nil {
		t.Fatalf("issue invite: %v", err)
	}
	if _, err := svc.RedeemInvite(ctx, invite.Code, memberEmail, otherPassword, "", SessionMeta{}); err != nil {
		t.Fatalf("first redeem: %v", err)
	}
	// A leaked invitation that keeps working is the reason this table exists.
	_, err = svc.RedeemInvite(ctx, invite.Code, "third@example.com", otherPassword, "", SessionMeta{})
	if !errors.Is(err, ErrInviteUnavailable) {
		t.Fatalf("second redeem = %v, want ErrInviteUnavailable", err)
	}
}

func TestAnInvitationRejectsACodeThatWasNeverIssued(t *testing.T) {
	svc, _, _ := claimedHub(t)
	_, err := svc.RedeemInvite(context.Background(), "AAAAA-BBBBB-CCCCC-DDDDD", memberEmail, otherPassword, "", SessionMeta{})
	if !errors.Is(err, ErrInviteUnavailable) {
		t.Fatalf("unknown code = %v, want ErrInviteUnavailable", err)
	}
}

func TestAnInvitationExpires(t *testing.T) {
	svc, _, clock := claimedHub(t)
	ctx := context.Background()

	invite, err := svc.IssueInvite(ctx)
	if err != nil {
		t.Fatalf("issue invite: %v", err)
	}
	// The expiry the owner is shown is the one that was written, so it is worth
	// asserting rather than recomputing in the test.
	if want := clock.now.Add(DefaultInviteTTL); !invite.ExpiresAt.Equal(want) {
		t.Fatalf("invite expires at %s, want %s", invite.ExpiresAt, want)
	}
	clock.advance(DefaultInviteTTL + time.Minute)
	if _, err := svc.RedeemInvite(ctx, invite.Code, memberEmail, otherPassword, "", SessionMeta{}); !errors.Is(err, ErrInviteUnavailable) {
		t.Fatalf("expired invite = %v, want ErrInviteUnavailable", err)
	}
}

// Issuing an invitation must not revoke the ones already outstanding. This is
// where it deliberately differs from a claim code, which does exactly that: an
// owner hands these out one per person, and minting the second must not break
// the first.
func TestIssuingAnInvitationLeavesEarlierOnesUsable(t *testing.T) {
	svc, _, _ := claimedHub(t)
	ctx := context.Background()

	first, err := svc.IssueInvite(ctx)
	if err != nil {
		t.Fatalf("issue first: %v", err)
	}
	if _, err := svc.IssueInvite(ctx); err != nil {
		t.Fatalf("issue second: %v", err)
	}
	if _, err := svc.RedeemInvite(ctx, first.Code, memberEmail, otherPassword, "", SessionMeta{}); err != nil {
		t.Fatalf("the first invitation stopped working when a second was issued: %v", err)
	}
}

// The guard that keeps the machine claimable. An invitation is issued *by* an
// owner, so on a Hub with no owner there is nothing that could legitimately
// have issued one -- and redeeming one there would create a member, make
// CountUsers non-zero, stop the Hub offering to be claimed, and leave no
// account able to issue anything. That state has no way back through the API,
// which is why the check is worth having even though reaching it takes a
// hand-edited database.
func TestAnInvitationCannotTakeAnUnownedHub(t *testing.T) {
	svc, st, _ := inviteTestService(t)
	ctx := context.Background()

	// Write the row the API cannot produce, so the service is the only thing
	// standing between it and a machine nobody can claim.
	code := "AAAAA-BBBBB-CCCCC-DDDDD"
	if err := st.IssueInviteToken(ctx, HashToken(NormalizeCode(code)), store.NowMilli(), store.NowMilli()+int64(DefaultInviteTTL/time.Millisecond)); err != nil {
		t.Fatalf("seed an invitation on an unowned hub: %v", err)
	}

	_, err := svc.RedeemInvite(ctx, code, memberEmail, otherPassword, "", SessionMeta{})
	if !errors.Is(err, ErrInviteUnavailable) {
		t.Fatalf("redeem on an unowned hub = %v, want ErrInviteUnavailable", err)
	}
	needs, err := svc.NeedsBootstrap(ctx)
	if err != nil {
		t.Fatalf("needs bootstrap: %v", err)
	}
	if !needs {
		t.Fatal("the hub stopped being claimable; an invitation took a machine that had no owner")
	}
	// The refusal must also not have spent the code, or the owner could never
	// use it after claiming.
	if _, err := svc.ClaimWithPassword(ctx, mustIssueBootstrap(t, svc), ownerEmail, testPassword, "", SessionMeta{}); err != nil {
		t.Fatalf("claim after the refused redeem: %v", err)
	}
	if _, err := svc.RedeemInvite(ctx, code, memberEmail, otherPassword, "", SessionMeta{}); err != nil {
		t.Fatalf("the refused code was spent anyway: %v", err)
	}
}

func mustIssueBootstrap(t *testing.T, svc *Service) string {
	t.Helper()
	code, err := svc.IssueBootstrapCode(context.Background())
	if err != nil {
		t.Fatalf("issue bootstrap code: %v", err)
	}
	return code
}

// The invitation is redeemed at an unauthenticated, internet-facing endpoint,
// so guessing is the only attack it has. Its search space is what has to carry
// that, and the space is the code's length -- a claim code's ten characters
// would put it within reach of an online guesser in a way the Hub's other
// secrets are not.
func TestAnInvitationIsLongerThanAClaimCode(t *testing.T) {
	claim, err := newBootstrapCode()
	if err != nil {
		t.Fatalf("new claim code: %v", err)
	}
	invite, err := newInviteCode()
	if err != nil {
		t.Fatalf("new invite code: %v", err)
	}
	strip := func(s string) string { return strings.ReplaceAll(s, "-", "") }
	if len(strip(invite)) <= len(strip(claim)) {
		t.Fatalf("invite code is %d characters and a claim code is %d: the unauthenticated endpoint has no more room to guess in than the authenticated one",
			len(strip(invite)), len(strip(claim)))
	}
	// Both kinds are read aloud and typed by hand, so both must survive being
	// copied with or without their separators.
	for _, code := range []string{claim, invite} {
		if NormalizeCode(code) != strip(code) {
			t.Fatalf("a code does not normalize to its own characters: %q", code)
		}
	}
}
