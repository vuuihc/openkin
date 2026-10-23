package github

import (
	"bytes"
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/vuuihc/openkin/internal/toolpath"
	"github.com/vuuihc/openkin/internal/workspace"
)

func TestResolveGHRejectsOverridePointingAtWrapper(t *testing.T) {
	t.Setenv(ghPathEnv, "/tmp/gh-session-bin/deadbeef/gh")
	if _, err := ResolveGH(); err == nil {
		t.Fatal("ResolveGH accepted a wrapper path from the override")
	}
}

// gh runs helpers of its own, so it must never be handed an environment with no
// PATH at all — that fails in a way that reads like a gh bug rather than like
// something Kin did. The filtering itself is toolpath's; this pins that ghEnv
// is wired to it.
func TestGHEnvAlwaysCarriesAPath(t *testing.T) {
	t.Setenv("PATH", "/tmp/gh-session-bin/abc")
	var path string
	for _, entry := range ghEnv() {
		if name, value, ok := strings.Cut(entry, "="); ok && name == "PATH" {
			path = value
		}
	}
	if path == "" {
		t.Fatal("ghEnv dropped PATH entirely when every entry was filtered")
	}
	if strings.Contains(path, toolpath.SessionShimComponent) {
		t.Fatalf("PATH still names the wrapper: %q", path)
	}
}

// A truncated read must fail rather than look like a short but valid answer:
// half a JSON document can parse into something plausible.
func TestLimitWriterSignalsTruncation(t *testing.T) {
	var buf bytes.Buffer
	w := &limitWriter{w: &buf, n: 16}
	if _, err := w.Write(bytes.Repeat([]byte("a"), 16)); err != nil {
		t.Fatalf("write up to the cap: %v", err)
	}
	if _, err := w.Write([]byte("more")); err != nil {
		t.Fatalf("write past the cap: %v", err)
	}
	if buf.Len() != 16 {
		t.Fatalf("buffered %d bytes, want the cap of 16", buf.Len())
	}
}

// A workspace whose source checkout has been moved or deleted has no repository
// to read. That is the same answer as "not a GitHub project", not a failure —
// otherwise a tidied-up folder turns into a broken panel.
func TestRepoForDirTreatsAMissingDirectoryAsNotGitHub(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "gone")
	repo, ok, err := RepoForDir(context.Background(), workspace.NewAnchorResolver(), missing)
	if err != nil {
		t.Fatalf("a missing directory must not be an error: %v", err)
	}
	if ok {
		t.Fatalf("found a repository at a path that does not exist: %+v", repo)
	}
}

func TestClassifyGHError(t *testing.T) {
	cases := []struct {
		name   string
		stderr string
		want   error
	}{
		{"unauthorized", "gh: Bad credentials (HTTP 401)", ErrNotAuthenticated},
		{"forbidden", "gh: API rate limit exceeded (HTTP 403)", ErrRateLimited},
		{"missing", "gh: Not Found (HTTP 404)", ErrNotFound},
		{"logged out", "To get started with GitHub CLI, please run: gh auth login", ErrNotAuthenticated},
		{"unrecognized", "gh: something new happened", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := classifyGHError(tc.stderr)
			if tc.want == nil {
				if errors.Is(err, ErrNotAuthenticated) || errors.Is(err, ErrRateLimited) || errors.Is(err, ErrNotFound) {
					t.Fatalf("classifyGHError(%q) = %v, want an unclassified error", tc.stderr, err)
				}
				return
			}
			if !errors.Is(err, tc.want) {
				t.Fatalf("classifyGHError(%q) = %v, want %v", tc.stderr, err, tc.want)
			}
		})
	}
}
