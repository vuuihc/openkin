package server

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/vuuihc/openkin/internal/store"
)

// G17: backup writes an archive that verifies, restore brings the accounts and
// their tasks back, and neither prints a credential. The round trip runs
// against a throwaway state dir; the daemon is not running, which is exactly
// the precondition restore demands.
func TestHubBackupRestoreRoundTrip(t *testing.T) {
	dir, _ := emptyHub(t)

	// A Hub with one account and one project's worth of data.
	if err := RunHubInit("owner@example.com", "Owner", "kin.example.com", false); err != nil {
		t.Fatalf("hub init: %v", err)
	}
	st, err := store.Open(filepath.Join(dir, "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	ctx := t.Context()
	users, err := st.ListUsers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(users) != 1 {
		t.Fatalf("accounts after init = %d, want 1", len(users))
	}
	if err := st.InsertProject(ctx, store.Project{
		ID: "proj-1", Name: "proj-1", Mode: store.ProjectModeShip, Status: "active",
		OnePagerRel: "ONEPAGER.md", CreatedAt: store.NowMilli(), UpdatedAt: store.NowMilli(),
	}, []string{filepath.Join(dir, "projects", "proj-1")}); err != nil {
		t.Fatal(err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}

	archive := filepath.Join(dir, "backup.zip")
	backupOut := captureStdout(t, func() {
		if err := RunHubBackup(archive); err != nil {
			t.Fatalf("backup: %v", err)
		}
	})
	if strings.Contains(backupOut, "argon2") || strings.Contains(backupOut, "hash=") ||
		regexp.MustCompile(`[0-9a-f]{64}`).MatchString(backupOut) {
		t.Fatalf("backup output carried a secret-shaped string: %s", backupOut)
	}
	info, err := os.Stat(archive)
	if err != nil {
		t.Fatalf("archive missing: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("archive mode = %v, want 0600", info.Mode().Perm())
	}

	// Wipe the account table to prove the restore is what brings it back.
	st2, err := store.Open(filepath.Join(dir, "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st2.DB().ExecContext(ctx, `DELETE FROM users`); err != nil {
		t.Fatal(err)
	}
	st2.Close()

	restoreOut := captureStdout(t, func() {
		if err := RunHubRestore(archive, true); err != nil {
			t.Fatalf("restore: %v", err)
		}
	})
	if !strings.Contains(restoreOut, "login-link") {
		t.Fatalf("restore output does not name the re-entry path: %s", restoreOut)
	}

	st3, err := store.Open(filepath.Join(dir, "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st3.Close()
	usersAfter, err := st3.ListUsers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(usersAfter) != 1 || usersAfter[0].Email != "owner@example.com" {
		t.Fatalf("accounts after restore = %+v", usersAfter)
	}
	projects, err := st3.ListProjects(ctx, store.ListProjectsOpts{})
	if err != nil {
		t.Fatal(err)
	}
	if len(projects) != 1 || projects[0].ID != "proj-1" {
		t.Fatalf("projects after restore = %+v", projects)
	}
}

// Restore without --yes is refused before anything is touched.
func TestHubRestoreRequiresConfirmation(t *testing.T) {
	_, _ = emptyHub(t)
	if err := RunHubRestore("", false); err == nil {
		t.Fatal("an input-less restore was accepted")
	}
	if err := RunHubRestore("/nonexistent.zip", false); err == nil {
		t.Fatal("a restore without --yes was accepted")
	}
}
