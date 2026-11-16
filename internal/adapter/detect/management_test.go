package detect

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCheckAuthSignedIn(t *testing.T) {
	home := t.TempDir()
	oldHome := HomeDir
	HomeDir = func() (string, error) { return home, nil }
	t.Cleanup(func() { HomeDir = oldHome })

	cred := filepath.Join(home, ".claude", ".credentials.json")
	if err := os.MkdirAll(filepath.Dir(cred), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cred, []byte(`{"token":"x"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	status, detail := CheckAuth("claude-code")
	if status != "signed_in" {
		t.Fatalf("status=%q detail=%q", status, detail)
	}
	if detail != cred {
		t.Fatalf("detail=%q want %q", detail, cred)
	}
}

func TestCheckAuthNotSignedIn(t *testing.T) {
	home := t.TempDir()
	oldHome := HomeDir
	HomeDir = func() (string, error) { return home, nil }
	t.Cleanup(func() { HomeDir = oldHome })

	// Known paths but no files.
	status, _ := CheckAuth("codex")
	if status != "not_signed_in" {
		t.Fatalf("status=%q", status)
	}
}

func TestCheckAuthUnknown(t *testing.T) {
	status, detail := CheckAuth("no-such-agent")
	if status != "unknown" || detail != "" {
		t.Fatalf("status=%q detail=%q", status, detail)
	}
}

func TestCheckVersionOK(t *testing.T) {
	old := RunVersion
	RunVersion = func(ctx context.Context, binary, flag string) (string, error) {
		if binary != "/bin/fake" || flag != "--version" {
			t.Fatalf("binary=%q flag=%q", binary, flag)
		}
		return "fake 1.2.3", nil
	}
	t.Cleanup(func() { RunVersion = old })

	got, err := CheckVersion(context.Background(), "/bin/fake", "")
	if err != nil {
		t.Fatal(err)
	}
	if got != "fake 1.2.3" {
		t.Fatalf("got %q", got)
	}
}

func TestCheckVersionTimeout(t *testing.T) {
	old := RunVersion
	RunVersion = func(ctx context.Context, binary, flag string) (string, error) {
		<-ctx.Done()
		return "", ctx.Err()
	}
	t.Cleanup(func() { RunVersion = old })

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_, err := CheckVersion(ctx, "/bin/slow", "--version")
	if err == nil {
		t.Fatal("expected timeout error")
	}
}

func TestScanManagementInstallCmds(t *testing.T) {
	old := RunVersion
	RunVersion = func(ctx context.Context, binary, flag string) (string, error) {
		return "v9", nil
	}
	t.Cleanup(func() { RunVersion = old })

	home := t.TempDir()
	oldHome := HomeDir
	HomeDir = func() (string, error) { return home, nil }
	t.Cleanup(func() { HomeDir = oldHome })

	agents := []Info{
		{ID: "claude-code", Binary: "/usr/bin/claude", Installed: true, Available: true},
		{ID: "cursor", Installed: false, Available: false},
	}
	rows := ScanManagement(agents)
	if len(rows) != 2 {
		t.Fatalf("len=%d", len(rows))
	}
	if rows[0].InstallCmd == "" || rows[0].Version != "v9" {
		t.Fatalf("claude row: %+v", rows[0])
	}
	if rows[1].InstallCmd != "" && rows[1].Version != "" {
		// cursor has no install cmd in our map; version should be empty
	}
	if rows[1].Version != "" {
		t.Fatalf("not-installed should not probe version: %+v", rows[1])
	}
}

func TestManagementCacheTTLAndInvalidate(t *testing.T) {
	calls := 0
	old := RunVersion
	RunVersion = func(ctx context.Context, binary, flag string) (string, error) {
		calls++
		return "v1", nil
	}
	t.Cleanup(func() { RunVersion = old })

	home := t.TempDir()
	oldHome := HomeDir
	HomeDir = func() (string, error) { return home, nil }
	t.Cleanup(func() { HomeDir = oldHome })

	c := NewManagementCache(50 * time.Millisecond)
	agents := []Info{{ID: "codex", Binary: "/bin/codex", Installed: true}}
	key := ManagementCacheKey(agents)

	_ = c.Get(key, agents)
	_ = c.Get(key, agents)
	if calls != 1 {
		t.Fatalf("expected 1 version probe, got %d", calls)
	}

	c.Invalidate()
	_ = c.Get(key, agents)
	if calls != 2 {
		t.Fatalf("expected re-probe after invalidate, got %d", calls)
	}

	// Expire TTL.
	time.Sleep(60 * time.Millisecond)
	_ = c.Get(key, agents)
	if calls != 3 {
		t.Fatalf("expected re-probe after TTL, got %d", calls)
	}
}
