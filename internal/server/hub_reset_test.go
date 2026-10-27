package server

import (
	"context"
	"errors"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	authsvc "github.com/vuuihc/openkin/internal/auth"
	"github.com/vuuihc/openkin/internal/remote"
	"github.com/vuuihc/openkin/internal/store"
)

// passwordIn finds the generated password in what `kin hub reset-password`
// printed. The printed text is the interface: the operator copies that line
// into a phone, so it has to be extractable and it has to be the credential the
// Hub now accepts.
var passwordIn = regexp.MustCompile(`[A-Z0-9]{5}(?:-[A-Z0-9]{5}){3}`)

func TestRunHubResetPasswordPrintsAPasswordThatWorks(t *testing.T) {
	st := claimedHub(t)
	ctx := context.Background()
	accounts := authsvc.New(st, authsvc.Config{})

	// One session on the account being reset, and one on a second account that
	// the reset must leave alone.
	ownerSession, err := accounts.LoginPassword(ctx, "owner@example.com", "hunter2hunter2", authsvc.SessionMeta{})
	if err != nil {
		t.Fatalf("owner login: %v", err)
	}
	invite, err := accounts.IssueInvite(ctx)
	if err != nil {
		t.Fatalf("issue invite: %v", err)
	}
	memberSession, err := accounts.RedeemInvite(ctx, invite.Code,
		"member@example.com", "hunter2hunter2", "Member", authsvc.SessionMeta{})
	if err != nil {
		t.Fatalf("join: %v", err)
	}

	out := captureStdout(t, func() {
		if err := RunHubResetPassword(" Owner@Example.com "); err != nil {
			t.Fatalf("reset: %v", err)
		}
	})

	password := passwordIn.FindString(out)
	if password == "" {
		t.Fatalf("no password in the output:\n%s", out)
	}
	if !strings.Contains(out, "New password for owner@example.com") {
		t.Fatalf("the box does not name the normalized account:\n%s", out)
	}

	// The printed password is the only one that works, the reset account's
	// sessions are gone, and the other account is untouched.
	if _, err := accounts.LoginPassword(ctx, "owner@example.com", "hunter2hunter2", authsvc.SessionMeta{}); !errors.Is(err, authsvc.ErrInvalidCredentials) {
		t.Fatalf("old password after reset = %v, want ErrInvalidCredentials", err)
	}
	if _, err := accounts.LoginPassword(ctx, "owner@example.com", password, authsvc.SessionMeta{}); err != nil {
		t.Fatalf("the printed password does not log in: %v", err)
	}
	if _, err := accounts.Authenticate(ctx, ownerSession.Token); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("owner session after reset = %v, want ErrNotFound", err)
	}
	if _, err := accounts.Authenticate(ctx, memberSession.Token); err != nil {
		t.Fatalf("the reset ended another account's session: %v", err)
	}
}

// A typo is the likely cause of a failed reset, and the answer — the real
// addresses — costs nothing to print while the operator is already looking at
// the error.
func TestRunHubResetPasswordSuggestsAnAddressOnATypo(t *testing.T) {
	_ = claimedHub(t)

	var resetErr error
	out := captureStdout(t, func() { resetErr = RunHubResetPassword("typo@example.com") })
	if !errors.Is(resetErr, authsvc.ErrAccountNotFound) {
		t.Fatalf("unknown address = %v, want ErrAccountNotFound", resetErr)
	}
	if !strings.Contains(out, "owner@example.com") {
		t.Fatalf("the failure does not list the real addresses:\n%s", out)
	}
	if strings.Contains(out, "New password") {
		t.Fatalf("a failed reset still printed a password:\n%s", out)
	}
}

func TestRunHubResetPasswordNeedsAnAddress(t *testing.T) {
	t.Setenv(remote.StateDirEnv, t.TempDir())
	err := RunHubResetPassword("   ")
	if err == nil || !strings.Contains(err.Error(), "usage") {
		t.Fatalf("empty --email = %v, want a usage error", err)
	}
}

// Both halves of an account are user-supplied and neither is validated for
// characters. A display name carrying an escape sequence would run in the
// terminal of the operator who is already locked out — the worst possible
// audience for an OSC 52 clipboard write — and one carrying a bidi override can
// make the line below render as another account. Both have to be dropped.
func TestRunHubAccountsStripsInvisibleCharacters(t *testing.T) {
	st := claimedHub(t)
	ctx := context.Background()
	accounts := authsvc.New(st, authsvc.Config{})
	invite, err := accounts.IssueInvite(ctx)
	if err != nil {
		t.Fatalf("issue invite: %v", err)
	}
	// OSC 52 (clipboard write) + BEL + CSI erase, a right-to-left override and a
	// zero-width space, wrapped around a word that has to survive so the list
	// still says who the account is.
	const hostile = "Mallory\x1b]52;c;cHduZWQ=\x07\x1b[2J‮​"
	if _, err := accounts.RedeemInvite(ctx, invite.Code,
		"member@example.com", "hunter2hunter2", hostile, authsvc.SessionMeta{}); err != nil {
		t.Fatalf("join with a display name: %v", err)
	}

	out := captureStdout(t, func() {
		if err := RunHubAccounts(); err != nil {
			t.Fatal(err)
		}
	})
	for _, forbidden := range []string{"\x1b", "\x07", "‮", "​"} {
		if strings.Contains(out, forbidden) {
			t.Fatalf("the list carried %q to the terminal:\n%q", forbidden, out)
		}
	}
	if !strings.Contains(out, "member@example.com") || !strings.Contains(out, "Mallory") {
		t.Fatalf("sanitizing lost the readable part:\n%s", out)
	}
}

// The box is the interface, and its right border only lines up if every cell is
// one terminal column wide. The address therefore lives above the box: an IDN
// address is two columns per rune in a terminal, so inside the box it would
// shift and wrap the border no matter how the padding was computed.
func TestPrintNewPasswordKeepsTheBoxClosed(t *testing.T) {
	for name, email := range map[string]string{
		"long ascii": strings.Repeat("a", 300) + "@example.com",
		"non-ascii":  strings.Repeat("邮", 300) + "@example.com",
	} {
		t.Run(name, func(t *testing.T) {
			out := captureStdout(t, func() {
				printNewPassword(email, "ABCDE-FGHJK-MNPQR-STVWX")
			})
			lines := strings.Split(strings.Trim(out, "\n"), "\n")

			if !strings.HasPrefix(lines[0], "  New password for ") || !strings.HasSuffix(lines[0], "…") {
				t.Fatalf("line 0 is not the truncated address line:\n%s", out)
			}

			box := lines[2:]
			width := len([]rune(box[0]))
			for i, line := range box {
				r := []rune(line)
				if len(r) != width {
					t.Fatalf("box line %d is %d runes wide, want %d:\n%s", i, len(r), width, out)
				}
				// Both edges, on every line: a corner glyph swapped for an ASCII
				// character keeps the width and would slip past a width-only check.
				// The box is indented two spaces, so the left border is at index 2.
				if !strings.ContainsRune("┌│└", r[2]) || !strings.ContainsRune("┐│┘", r[len(r)-1]) {
					t.Fatalf("box line %d does not close its borders:\n%s", i, out)
				}
			}

			// Nothing of the address made it into the box.
			for _, line := range box {
				for _, r := range line {
					if r > 0x7f && !strings.ContainsRune("┌┐└┘│─", r) {
						t.Fatalf("the box carries %q from the address:\n%s", r, out)
					}
				}
			}
			if !strings.Contains(out, "ABCDE-FGHJK-MNPQR-STVWX") {
				t.Fatalf("the password is missing:\n%s", out)
			}
		})
	}
}

// An empty Hub is the one state where the command has something different to
// say: name the command that creates the first account instead of printing an
// empty list. RunHubAccounts opens its own handle, so the one used to create
// the schema is closed first.
func TestRunHubAccountsOnAnEmptyHub(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(remote.StateDirEnv, dir)
	st, err := store.Open(filepath.Join(dir, "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Close(); err != nil {
		t.Fatalf("close the empty database: %v", err)
	}

	out := captureStdout(t, func() {
		if err := RunHubAccounts(); err != nil {
			t.Fatal(err)
		}
	})
	if !strings.Contains(out, "kin hub claim-code") {
		t.Fatalf("an empty hub does not say how to create the first account:\n%s", out)
	}
}
