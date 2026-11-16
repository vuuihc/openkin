package server

import (
	"context"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	authsvc "github.com/vuuihc/openkin/internal/auth"
	"github.com/vuuihc/openkin/internal/remote"
	"github.com/vuuihc/openkin/internal/store"
)

// inviteCodeIn finds the invitation in what `kin hub invite` printed. The whole
// point of the command is that an operator copies one line out of it, so the
// printed text is the interface.
var inviteCodeIn = regexp.MustCompile(`[A-Z0-9]{5}(?:-[A-Z0-9]{5}){3}`)

// claimedHub creates the state `kin hub invite` requires: a database with an
// owner in it. Everything below it is the real service against the real store,
// because the command's whole job is to reach the same database the daemon does.
func claimedHub(t *testing.T) *store.Store {
	t.Helper()
	dir := t.TempDir()
	t.Setenv(remote.StateDirEnv, dir)

	st, err := store.Open(filepath.Join(dir, "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })

	ctx := context.Background()
	accounts := authsvc.New(st, authsvc.Config{})
	code, err := accounts.IssueBootstrapCode(ctx)
	if err != nil {
		t.Fatalf("issue claim code: %v", err)
	}
	if _, err := accounts.ClaimWithPassword(ctx, code, "owner@example.com",
		"hunter2hunter2", "Owner", authsvc.SessionMeta{}); err != nil {
		t.Fatalf("claim the hub: %v", err)
	}
	return st
}

// The command exists to hand an operator a code that works. Anything less is a
// dead end that costs a round trip through a shell on the Hub to discover.
func TestRunHubInvitePrintsACodeThatJoins(t *testing.T) {
	st := claimedHub(t)

	out := captureStdout(t, func() {
		if err := RunHubInvite("kin.example.com"); err != nil {
			t.Fatal(err)
		}
	})

	code := inviteCodeIn.FindString(out)
	if code == "" {
		t.Fatalf("no invitation code in the output:\n%s", out)
	}
	// The link is the half a phone can open. It has to carry the same code, and
	// it has to point at the console root, which is where the gate lives.
	if want := "https://kin.example.com/?invite=" + code; !strings.Contains(out, want) {
		t.Fatalf("no %q in the output:\n%s", want, out)
	}

	// And the code the operator copied is the one the Hub will accept. Read back
	// through the service rather than the store so this covers normalization and
	// hashing too -- the two places a printed code could stop matching.
	session, err := authsvc.New(st, authsvc.Config{}).RedeemInvite(context.Background(),
		code, "joiner@example.com", "hunter2hunter2", "Joiner", authsvc.SessionMeta{})
	if err != nil {
		t.Fatalf("the printed invitation does not join: %v", err)
	}
	if session.User.Role != store.RoleMember {
		t.Fatalf("the printed invitation made a %q, want %q", session.User.Role, store.RoleMember)
	}
}

// A Hub with no owner has nobody to issue an invitation, and an invitation
// cannot claim one. The refusal names the command that fixes the state instead
// of printing a code that RedeemInvite would then reject.
func TestRunHubInviteRefusesAHubWithNoOwner(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(remote.StateDirEnv, dir)
	// The database has to exist for RunHubInvite to open it; it is closed again
	// because the command opens its own handle.
	st, err := store.Open(filepath.Join(dir, "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Close(); err != nil {
		t.Fatalf("close the empty database: %v", err)
	}

	var inviteErr error
	out := captureStdout(t, func() { inviteErr = RunHubInvite("") })
	if inviteErr == nil {
		t.Fatal("an unowned hub minted an invitation")
	}
	if !strings.Contains(inviteErr.Error(), "kin hub claim-code") {
		t.Fatalf("the refusal does not say what to do instead: %v", inviteErr)
	}
	if inviteCodeIn.MatchString(out) {
		t.Fatalf("a refusal still printed a code:\n%s", out)
	}
}

// Without a hostname there is no link to print. hubOrigin's fallback describes
// the Hub in a sentence, which is not a URL, and a link built from it would
// look right and resolve nowhere -- so the code is printed alone.
func TestInviteLinkNeedsAKnownHostname(t *testing.T) {
	const code = "AAAAA-BBBBB-CCCCC-DDDDD"
	if got := inviteLink("kin.example.com", code); got != "https://kin.example.com/?invite="+code {
		t.Fatalf("inviteLink with a domain = %q", got)
	}
	if got := inviteLink("  ", code); got != "" {
		t.Fatalf("inviteLink without a domain = %q, want no link at all", got)
	}
}
