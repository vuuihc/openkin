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

// printedLoginToken reads the one URL --print-url is allowed to print and
// returns the token from its fragment. The whole point of the mode is that a
// script can capture one line, so the printed text is the interface.
var printedLoginLink = regexp.MustCompile(`^https://kin\.example\.com/#login=([0-9a-f]{64})$`)

func emptyHub(t *testing.T) (dir string, dbPath string) {
	t.Helper()
	dir = t.TempDir()
	t.Setenv(remote.StateDirEnv, dir)
	t.Setenv("KIN_DOMAIN", "")
	dbPath = filepath.Join(dir, "kin.db")
	st, err := store.Open(dbPath)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	if err := st.Close(); err != nil {
		t.Fatalf("close store: %v", err)
	}
	return dir, dbPath
}

func loginTokenFromOutput(t *testing.T, out string) string {
	t.Helper()
	line := strings.TrimSpace(out)
	match := printedLoginLink.FindStringSubmatch(line)
	if match == nil {
		t.Fatalf("output is not one sign-in URL:\n%s", out)
	}
	return match[1]
}

// With no address `kin hub init` can only hand over the Hub: it prints a claim
// link, and the code in it is one the Hub accepts.
func TestRunHubInitPrintsAClaimLinkThatClaimsTheHub(t *testing.T) {
	_, dbPath := emptyHub(t)

	var initErr error
	out := captureStdout(t, func() { initErr = RunHubInit("", "", "kin.example.com", true) })
	if initErr != nil {
		t.Fatalf("init: %v", initErr)
	}
	link := strings.TrimSpace(out)
	const prefix = "https://kin.example.com/#claim="
	if !strings.HasPrefix(link, prefix) {
		t.Fatalf("claim link = %q, want prefix %q", link, prefix)
	}
	code := strings.TrimPrefix(link, prefix)

	st, err := store.Open(dbPath)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}
	defer st.Close()
	accounts := authsvc.New(st, authsvc.Config{})
	session, err := accounts.ClaimWithPassword(context.Background(), code,
		"owner@example.com", "hunter2hunter2", "Owner", authsvc.SessionMeta{})
	if err != nil {
		t.Fatalf("the printed claim link does not claim the hub: %v", err)
	}
	if !session.User.IsOwner() {
		t.Fatalf("claiming through the link made a %q, want owner", session.User.Role)
	}
}

// With an address it creates the owner and prints a sign-in link -- one command,
// one URL, no password for anybody to read off a terminal. The link has to sign
// in as that owner, or the installer handed over a credential to nothing.
func TestRunHubInitCreatesTheOwnerAndPrintsAWorkingLoginLink(t *testing.T) {
	_, dbPath := emptyHub(t)

	var initErr error
	out := captureStdout(t, func() {
		initErr = RunHubInit("Owner@Example.com", "Owner", "kin.example.com", true)
	})
	if initErr != nil {
		t.Fatalf("init: %v", initErr)
	}
	token := loginTokenFromOutput(t, out)

	st, err := store.Open(dbPath)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}
	defer st.Close()
	accounts := authsvc.New(st, authsvc.Config{})
	session, err := accounts.ConsumeLoginLink(context.Background(), token, authsvc.SessionMeta{})
	if err != nil {
		t.Fatalf("the printed sign-in link does not sign in: %v", err)
	}
	if !session.User.IsOwner() {
		t.Fatalf("the first account is a %q, want owner", session.User.Role)
	}
	if session.User.Email != "owner@example.com" {
		t.Fatalf("signed in as %q, want owner@example.com", session.User.Email)
	}
	// The generated password is not a second way in that nobody was told about:
	// the link is the credential that left the process.
	if _, err := accounts.LoginPassword(context.Background(), "owner@example.com", "hunter2hunter2", authsvc.SessionMeta{}); err == nil {
		t.Fatal("a guessed password signed in to an account created by kin hub init")
	}
}

// Running init again on a claimed Hub is how a locked-out owner gets back in.
func TestRunHubLoginLinkPrintsAWorkingLinkForAClaimedHub(t *testing.T) {
	st := claimedHub(t)

	var linkErr error
	out := captureStdout(t, func() {
		linkErr = RunHubLoginLink("Owner@Example.com", "kin.example.com", true)
	})
	if linkErr != nil {
		t.Fatalf("login-link: %v", linkErr)
	}
	token := loginTokenFromOutput(t, out)

	session, err := authsvc.New(st, authsvc.Config{}).ConsumeLoginLink(context.Background(), token, authsvc.SessionMeta{})
	if err != nil {
		t.Fatalf("the printed sign-in link does not sign in: %v", err)
	}
	if session.User.Email != "owner@example.com" {
		t.Fatalf("signed in as %q, want owner@example.com", session.User.Email)
	}
}

// An account that only signs in with a provider has no password identity, but
// it is still the account at that address and an operator still has to reach it.
func TestRunHubLoginLinkFindsAnAccountWithNoPassword(t *testing.T) {
	_, dbPath := emptyHub(t)
	st, err := store.Open(dbPath)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	accounts := authsvc.New(st, authsvc.Config{})
	code, err := accounts.IssueBootstrapCode(context.Background())
	if err != nil {
		t.Fatalf("issue claim code: %v", err)
	}
	if _, err := accounts.ClaimWithIdentity(context.Background(), code, authsvc.ExternalIdentity{
		Provider: authsvc.ProviderOIDCPrefix + "https://kin.example.com/dex",
		Subject:  "provider-subject",
		Email:    "owner@example.com",
		Label:    "GitHub",
	}, authsvc.SessionMeta{}); err != nil {
		t.Fatalf("claim with an identity: %v", err)
	}
	if err := st.Close(); err != nil {
		t.Fatalf("close store: %v", err)
	}

	var linkErr error
	out := captureStdout(t, func() {
		linkErr = RunHubLoginLink("owner@example.com", "kin.example.com", true)
	})
	if linkErr != nil {
		t.Fatalf("login-link: %v", linkErr)
	}
	token := loginTokenFromOutput(t, out)

	st, err = store.Open(dbPath)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}
	defer st.Close()
	session, err := authsvc.New(st, authsvc.Config{}).ConsumeLoginLink(context.Background(), token, authsvc.SessionMeta{})
	if err != nil {
		t.Fatalf("the printed link does not sign in: %v", err)
	}
	if session.User.Email != "owner@example.com" {
		t.Fatalf("signed in as %q, want owner@example.com", session.User.Email)
	}
}

// An address can name two accounts: users.email is not unique, and an account
// that claimed with a provider is a different identity from one created by an
// invitation with the same address. The password identity is the exact key a
// password login uses, so that account wins; picking the provider-only account
// would sign the operator into one they cannot otherwise reach.
func TestRunHubLoginLinkPrefersThePasswordIdentityAtAnAddress(t *testing.T) {
	_, dbPath := emptyHub(t)
	st, err := store.Open(dbPath)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	ctx := context.Background()
	accounts := authsvc.New(st, authsvc.Config{})
	code, err := accounts.IssueBootstrapCode(ctx)
	if err != nil {
		t.Fatalf("issue claim code: %v", err)
	}
	if _, err := accounts.ClaimWithIdentity(ctx, code, authsvc.ExternalIdentity{
		Provider: authsvc.ProviderOIDCPrefix + "https://kin.example.com/dex",
		Subject:  "owner-subject",
		Email:    "shared@example.com",
		Label:    "GitHub",
	}, authsvc.SessionMeta{}); err != nil {
		t.Fatalf("claim with an identity: %v", err)
	}
	invite, err := accounts.IssueInvite(ctx)
	if err != nil {
		t.Fatalf("issue invitation: %v", err)
	}
	member, err := accounts.RedeemInvite(ctx, invite.Code, "shared@example.com",
		"hunter2hunter2", "", authsvc.SessionMeta{})
	if err != nil {
		t.Fatalf("redeem invitation: %v", err)
	}
	if err := st.Close(); err != nil {
		t.Fatalf("close store: %v", err)
	}

	var linkErr error
	out := captureStdout(t, func() {
		linkErr = RunHubLoginLink("shared@example.com", "kin.example.com", true)
	})
	if linkErr != nil {
		t.Fatalf("login-link: %v", linkErr)
	}
	token := loginTokenFromOutput(t, out)

	st, err = store.Open(dbPath)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}
	defer st.Close()
	session, err := authsvc.New(st, authsvc.Config{}).ConsumeLoginLink(ctx, token, authsvc.SessionMeta{})
	if err != nil {
		t.Fatalf("consume link: %v", err)
	}
	if session.User.ID != member.User.ID {
		t.Fatalf("link signed in as %s (%s), want the password account %s (%s)",
			session.User.ID, session.User.Role, member.User.ID, member.User.Role)
	}
}

func TestRunHubInitWithoutAnAddressNamesTheFrontDoor(t *testing.T) {
	claimedHub(t)
	var initErr error
	out := captureStdout(t, func() { initErr = RunHubInit("", "", "kin.example.com", true) })
	if initErr != nil {
		t.Fatalf("init: %v", initErr)
	}
	if got := strings.TrimSpace(out); got != "https://kin.example.com/" {
		t.Fatalf("init without an address printed %q", got)
	}
}

// With no address and no hostname there is no front door to name either. The
// human-mode text must ask for the missing account rather than print "Sign in
// at /" as if a bare slash were an address.
func TestRunHubInitWithoutAnAddressOrAHostAsksForOne(t *testing.T) {
	claimedHub(t)
	var initErr error
	out := captureStdout(t, func() { initErr = RunHubInit("", "", "", false) })
	if initErr != nil {
		t.Fatalf("init: %v", initErr)
	}
	if strings.Contains(out, "Sign in at") {
		t.Fatalf("printed a front door without a hostname:\n%s", out)
	}
	if !strings.Contains(out, "--email") {
		t.Fatalf("output does not name the missing --email:\n%s", out)
	}
}

// A link without a host is not a link. Refusing is better than printing the
// hostname sentence hubOrigin falls back to, which looks like a URL and is not.
func TestLinkCommandsRefuseToPrintAURLWithoutAHost(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(remote.StateDirEnv, dir)
	t.Setenv("KIN_DOMAIN", "")
	st, err := store.Open(filepath.Join(dir, "kin.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()

	if err := RunHubInit("", "", "", true); err == nil ||
		!strings.Contains(err.Error(), "--domain") {
		t.Fatalf("init without a host = %v, want a --domain refusal", err)
	}
	if err := RunHubLoginLink("owner@example.com", "", true); err == nil ||
		!strings.Contains(err.Error(), "--domain") {
		t.Fatalf("login-link without a host = %v, want a --domain refusal", err)
	}
	if err := RunHubClaimCode("", true); err == nil ||
		!strings.Contains(err.Error(), "--domain") {
		t.Fatalf("claim-code without a host = %v, want a --domain refusal", err)
	}
}

// The container already carries its public hostname, so an exec'd command must
// not need the caller to repeat it.
func TestLinkCommandsFallBackToTheDomainInTheEnvironment(t *testing.T) {
	claimedHub(t)
	t.Setenv("KIN_DOMAIN", "kin.example.com")
	var linkErr error
	out := captureStdout(t, func() {
		linkErr = RunHubLoginLink("owner@example.com", "", true)
	})
	if linkErr != nil {
		t.Fatalf("login-link: %v", linkErr)
	}
	loginTokenFromOutput(t, out)
}
