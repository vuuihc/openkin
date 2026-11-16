package workspace

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestCanonicalRemoteCollapsesTheSameRepository(t *testing.T) {
	const want = "github.com/vuuihc/openkin"
	tests := []struct {
		name    string
		raw     string
		want    string
		wantErr bool
	}{
		{name: "scp-like", raw: "git@github.com:vuuihc/openkin.git", want: want},
		{name: "https", raw: "https://github.com/vuuihc/openkin", want: want},
		{name: "https with .git and slash", raw: "https://github.com/vuuihc/openkin.git/\n", want: want},
		{name: "ssh with user and default port", raw: "ssh://git@github.com:22/vuuihc/openkin.git", want: want},
		{name: "host case", raw: "https://GitHub.COM/vuuihc/openkin", want: want},
		{name: "git protocol", raw: "git://github.com/vuuihc/openkin.git", want: want},
		{name: "path keeps its case", raw: "https://github.com/Vuuihc/OpenKin.git", want: "github.com/Vuuihc/OpenKin"},
		{name: "nested group", raw: "https://gitlab.example.test/group/sub/repo.git", want: "gitlab.example.test/group/sub/repo"},
		{name: "non-default port kept", raw: "ssh://git@example.test:2222/team/repo.git", want: "example.test:2222/team/repo"},
		{name: "empty", raw: "   ", wantErr: true},
		{name: "local path", raw: "/srv/repo", wantErr: true},
		{name: "windows path", raw: `C:/Users/me/repo`, wantErr: true},
		{name: "host only", raw: "https://github.com", wantErr: true},
		{name: "host only scp-like", raw: "git@github.com:", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := CanonicalRemote(tt.raw)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("CanonicalRemote(%q)=%q want error", tt.raw, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("CanonicalRemote(%q): %v", tt.raw, err)
			}
			if got != tt.want {
				t.Fatalf("CanonicalRemote(%q)=%q want %q", tt.raw, got, tt.want)
			}
		})
	}
}

// The remote URL is the one string from a machine's git config that the Hub
// stores and hands to other machines, so a credential embedded in it must not
// survive canonicalization (ADR 0022 D7).
func TestCanonicalRemoteDropsCredentials(t *testing.T) {
	for _, raw := range []string{
		"https://x-access-token:ghp_secretvalue@github.com/vuuihc/openkin.git",
		"https://ghp_secretvalue@github.com/vuuihc/openkin.git",
		"ssh://git@github.com/vuuihc/openkin.git",
	} {
		got, err := CanonicalRemote(raw)
		if err != nil {
			t.Fatalf("CanonicalRemote(%q): %v", raw, err)
		}
		if strings.Contains(got, "ghp_secretvalue") || strings.Contains(got, "@") {
			t.Fatalf("CanonicalRemote(%q)=%q kept a credential", raw, got)
		}
		if got != "github.com/vuuihc/openkin" {
			t.Fatalf("CanonicalRemote(%q)=%q", raw, got)
		}
	}
}

func TestDeriveAnchorNamesTheRepositoryAndThePathInsideIt(t *testing.T) {
	gitPath, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git not installed")
	}
	repo := t.TempDir()
	runGit(t, gitPath, repo, "init")
	runGit(t, gitPath, repo, "remote", "add", "origin", "git@github.com:vuuihc/openkin.git")
	sub := filepath.Join(repo, "internal", "task")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}

	resolver := NewAnchorResolver()
	tests := []struct {
		name         string
		dir          string
		wantKind     string
		wantRelative string
	}{
		{name: "repository root", dir: repo, wantKind: AnchorGitRemote, wantRelative: AnchorRepoRoot},
		{name: "subdirectory", dir: sub, wantKind: AnchorGitRemote, wantRelative: "internal/task"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			anchor, root, err := resolver.DeriveAnchor(context.Background(), tt.dir)
			if err != nil {
				t.Fatal(err)
			}
			if anchor.Kind != tt.wantKind {
				t.Fatalf("kind=%q want %q", anchor.Kind, tt.wantKind)
			}
			if anchor.RemoteURL != "github.com/vuuihc/openkin" {
				t.Fatalf("remote=%q", anchor.RemoteURL)
			}
			if anchor.RelativePath != tt.wantRelative {
				t.Fatalf("relative=%q want %q", anchor.RelativePath, tt.wantRelative)
			}
			if !samePath(t, root, repo) {
				t.Fatalf("root=%q want %q", root, repo)
			}
		})
	}
}

// A directory that is not a checkout is not an error: it is a workspace that
// exists on this machine only, and saying so is what lets another machine refuse
// it instead of running in a same-named directory that is not the same work.
func TestDeriveAnchorOutsideARepositoryIsDevicePath(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "scratch")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	resolver := NewAnchorResolver()
	if _, _, err := resolver.DeriveAnchor(context.Background(), dir); err != nil {
		t.Fatalf("a plain directory must not be an error: %v", err)
	}
	anchor, root, err := resolver.DeriveAnchor(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if anchor.Portable() || anchor.Kind != AnchorDevicePath {
		t.Fatalf("anchor=%+v want a device path anchor", anchor)
	}
	if root != "" {
		t.Fatalf("root=%q want empty for a non-repository", root)
	}
}

func TestDeriveAnchorWithoutAnOriginIsDevicePath(t *testing.T) {
	gitPath, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git not installed")
	}
	repo := t.TempDir()
	runGit(t, gitPath, repo, "init")
	anchor, root, err := NewAnchorResolver().DeriveAnchor(context.Background(), repo)
	if err != nil {
		t.Fatal(err)
	}
	if anchor.Portable() {
		t.Fatalf("anchor=%+v want a device path anchor for a repository with no origin", anchor)
	}
	if !samePath(t, root, repo) {
		t.Fatalf("root=%q want the checkout %q", root, repo)
	}
}

func TestDeriveAnchorRejectsAMissingDirectory(t *testing.T) {
	_, _, err := NewAnchorResolver().DeriveAnchor(context.Background(), filepath.Join(t.TempDir(), "gone"))
	if err == nil {
		t.Fatal("expected an error for a directory that is not there")
	}
}

func runGit(t *testing.T, gitPath, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command(gitPath, args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_CONFIG_SYSTEM=/dev/null",
		"GIT_TERMINAL_PROMPT=0",
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %s: %v: %s", strings.Join(args, " "), err, out)
	}
}
