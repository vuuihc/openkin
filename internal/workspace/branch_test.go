package workspace

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestListBranches(t *testing.T) {
	requireGit(t)
	dir := t.TempDir()
	initRepo(t, dir)
	commitFile(t, dir, "README", "hi\n")
	gitCmd(t, dir, "branch", "feature/a")
	gitCmd(t, dir, "branch", "dev")

	m := NewManager(t.TempDir())
	st, err := m.ListBranches(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if !st.IsGit {
		t.Fatalf("expected git repo: %+v", st)
	}
	if st.Current == "" {
		t.Fatalf("empty current: %+v", st)
	}
	if st.Detached {
		t.Fatal("unexpected detached")
	}
	names := map[string]struct{}{}
	for _, b := range st.Branches {
		names[b.Name] = struct{}{}
	}
	if _, ok := names["dev"]; !ok {
		t.Fatalf("missing dev: %v", names)
	}
	if _, ok := names["feature/a"]; !ok {
		t.Fatalf("missing feature/a: %v", names)
	}
	// Current branch should be marked.
	foundCurrent := false
	for _, b := range st.Branches {
		if b.Name == st.Current && b.Current {
			foundCurrent = true
		}
	}
	if !foundCurrent {
		t.Fatalf("current %q not marked in %v", st.Current, st.Branches)
	}
}

func TestListBranchesNonGit(t *testing.T) {
	requireGit(t)
	dir := t.TempDir()
	m := NewManager(t.TempDir())
	st, err := m.ListBranches(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if st.IsGit {
		t.Fatalf("expected non-git: %+v", st)
	}
}

func TestCheckoutBranch(t *testing.T) {
	requireGit(t)
	dir := t.TempDir()
	initRepo(t, dir)
	commitFile(t, dir, "README", "hi\n")
	gitCmd(t, dir, "branch", "dev")

	m := NewManager(t.TempDir())
	if err := m.CheckoutBranch(context.Background(), dir, "dev"); err != nil {
		t.Fatal(err)
	}
	st, err := m.ListBranches(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if st.Current != "dev" {
		t.Fatalf("current=%q want dev", st.Current)
	}

	// Dirty refuses switch.
	target := "main"
	for _, b := range st.Branches {
		if b.Name != "dev" {
			target = b.Name
			break
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "dirty.txt"), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	err = m.CheckoutBranch(context.Background(), dir, target)
	if err == nil {
		t.Fatal("expected dirty error")
	}
	if err != ErrDirtySource {
		t.Fatalf("err=%v want ErrDirtySource", err)
	}
}

func TestCheckoutBranchMissing(t *testing.T) {
	requireGit(t)
	dir := t.TempDir()
	initRepo(t, dir)
	commitFile(t, dir, "README", "hi\n")
	m := NewManager(t.TempDir())
	err := m.CheckoutBranch(context.Background(), dir, "does-not-exist")
	if err == nil {
		t.Fatal("expected missing branch error")
	}
}

func TestValidateBranchName(t *testing.T) {
	cases := []struct {
		name string
		ok   bool
	}{
		{"main", true},
		{"feature/foo", true},
		{"", false},
		{"-evil", false},
		{"foo..bar", false},
		{"refs/heads/main", false},
		{"remote:main", false},
		{"has\x00nul", false},
	}
	for _, tc := range cases {
		err := validateBranchName(tc.name)
		if tc.ok && err != nil {
			t.Errorf("%q: unexpected err %v", tc.name, err)
		}
		if !tc.ok && err == nil {
			t.Errorf("%q: expected error", tc.name)
		}
	}
}

func TestParseBranchList(t *testing.T) {
	raw := []byte("main\x00*\ndev\x00 \nfeature/a\x00\n")
	got := parseBranchList(raw, "main")
	if len(got) != 3 {
		t.Fatalf("len=%d", len(got))
	}
	if !got[0].Current || got[0].Name != "main" {
		t.Fatalf("first=%+v", got[0])
	}
}
