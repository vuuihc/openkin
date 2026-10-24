package github

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/toolpath"
	"github.com/vuuihc/openkin/internal/workspace"
)

func TestResolveGHRejectsOverridePointingAtWrapper(t *testing.T) {
	t.Setenv(ghPathEnv, "/tmp/gh-session-bin/deadbeef/gh")
	if _, err := ResolveGH(); err == nil {
		t.Fatal("ResolveGH accepted a wrapper path from the override")
	}
}

// A caller asks about ErrGHUnavailable; the resolver's own error says *why* a
// refusal is not a missing binary. Both have to stay askable, which means the
// cause is wrapped rather than formatted into the text.
func TestResolveGHKeepsBothCauses(t *testing.T) {
	t.Setenv(ghPathEnv, "/tmp/gh-session-bin/deadbeef/gh")
	_, err := ResolveGH()
	if !errors.Is(err, ErrGHUnavailable) {
		t.Fatalf("err = %v, want it to match ErrGHUnavailable", err)
	}
	if !errors.Is(err, toolpath.ErrUnavailable) {
		t.Fatalf("err = %v, want the resolver's own sentinel preserved", err)
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

// A write that crosses the cap is the case that matters: the bytes past it are
// dropped, but the write has to report the whole slice as accepted. os/exec
// copies the child's output through this writer, and a short write there is
// ErrShortWrite — a successful gh call reported as a failed query because it
// was talkative.
func TestLimitWriterAcceptsAWriteThatCrossesTheCap(t *testing.T) {
	var buf bytes.Buffer
	w := &limitWriter{w: &buf, n: 16}
	n, err := w.Write(bytes.Repeat([]byte("a"), 40))
	if err != nil {
		t.Fatalf("write across the cap: %v", err)
	}
	if n != 40 {
		t.Fatalf("Write accepted %d of 40 bytes, want the whole slice", n)
	}
	if buf.Len() != 16 {
		t.Fatalf("buffered %d bytes, want the cap of 16", buf.Len())
	}
	if _, err := w.Write([]byte("more")); err != nil {
		t.Fatalf("write past the cap: %v", err)
	}
	if buf.Len() != 16 {
		t.Fatalf("buffered %d bytes after a second overflow, want 16", buf.Len())
	}
}

// fakeGH writes an executable stand-in for the gh binary. What Run does with a
// real child process — what gh writes, and what it leaves behind — cannot be
// exercised with an in-process stub.
func fakeGH(t *testing.T, script string) GHClient {
	t.Helper()
	path := filepath.Join(t.TempDir(), "gh")
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return GHClient{Bin: GHBinary{Path: path}}
}

// gh writes warnings and progress to stderr, and past the cap those bytes are
// dropped. Dropped is fine; failed is not. The call exited 0 and its answer is
// on stdout, so the answer is what the caller gets.
func TestRunReportsAVerboseButSuccessfulCallAsSuccess(t *testing.T) {
	gh := fakeGH(t, `#!/bin/sh
i=0
while [ $i -lt 400 ]; do
  echo "warning: something noisy happened" >&2
  i=$((i + 1))
done
printf '{"number":42}'
`)
	out, err := gh.Run(context.Background(), "api", "/repos/owner/repo/pulls")
	if err != nil {
		t.Fatalf("a successful gh call with noisy stderr was reported as a failure: %v", err)
	}
	if string(out) != `{"number":42}` {
		t.Fatalf("stdout = %q, want the answer gh printed", out)
	}
}

// gh runs helpers of its own, and one of them can outlive it while holding the
// output pipe. The deadline a caller set is a promise about when Run returns,
// and a command that exited 0 is not a failure because of what it left behind.
func TestRunDoesNotWaitForAProcessThatOutlivesGH(t *testing.T) {
	gh := fakeGH(t, `#!/bin/sh
# A helper gh started and never reaped: it inherits the output pipes and stays
# alive long past the grace period this is about.
(sleep 30) &
printf 'done'
exit 0
`)
	start := time.Now()
	out, err := gh.Run(context.Background(), "api", "/repos/owner/repo/pulls")
	if err != nil {
		t.Fatalf("Run failed a command that exited 0: %v", err)
	}
	if string(out) != "done" {
		t.Fatalf("stdout = %q, want %q", out, "done")
	}
	if elapsed := time.Since(start); elapsed > 2*ghPipeGrace {
		t.Fatalf("Run took %s, want it bounded by the %s grace period", elapsed, ghPipeGrace)
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
