package github

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

// Live checks against the machine's real credentials.
//
// Skipped unless KIN_GITHUB_LIVE is set, because the default suite must not
// depend on the network, on a login, or on a rate-limit window. This exists
// because the parts it covers cannot be tested any other way: whether the
// resolver picks the right binary out of an environment that contains a decoy,
// and whether the gh invocation shape actually returns what the caller expects.
//
// Run with: KIN_GITHUB_LIVE=1 go test ./internal/github/ -run Live -v
func requireLive(t *testing.T) {
	t.Helper()
	if testing.Short() {
		t.Skip("short mode")
	}
	if strings.TrimSpace(os.Getenv("KIN_GITHUB_LIVE")) == "" {
		t.Skip("set KIN_GITHUB_LIVE=1 to run checks that need the network and a login")
	}
}

func TestLiveResolveGHAvoidsTheSessionWrapper(t *testing.T) {
	requireLive(t)
	bin, err := ResolveGH()
	if err != nil {
		t.Fatalf("ResolveGH: %v", err)
	}
	// The whole point: a wrapper earlier on PATH must not win.
	if reason := rejectGHPath(bin.Path); reason != "" {
		t.Fatalf("resolved %q, which is refused: %s", bin.Path, reason)
	}
	t.Logf("resolved gh at %s", bin.Path)
}

func TestLiveLookupAgainstGitHub(t *testing.T) {
	requireLive(t)
	bin, err := ResolveGH()
	if err != nil {
		t.Fatalf("ResolveGH: %v", err)
	}
	client := GHClient{Bin: bin, Timeout: 45 * time.Second}
	ctx := context.Background()
	repo := Repo{Owner: "cli", Name: "cli"}

	// A branch that does not exist on the remote: the query must succeed and
	// report that there is no pull request, not fail.
	res, err := lookup(ctx, ghReader{client: client}, repo, "kin-live-check-no-such-branch")
	if err != nil {
		t.Fatalf("lookup for an absent branch: %v", err)
	}
	if res.PR != nil {
		t.Fatalf("expected no pull request, got %+v", res.PR)
	}
	if res.Source != SourceGH {
		t.Fatalf("source = %q, want %q", res.Source, SourceGH)
	}

	// A branch that has pull requests: the payload must decode into the shape
	// the cache stores.
	res, err = lookup(ctx, ghReader{client: client}, repo, "trunk")
	if err != nil {
		t.Fatalf("lookup for trunk: %v", err)
	}
	if res.PR == nil {
		t.Skip("no pull request currently open against cli:trunk; skipping the decode check")
	}
	if res.PR.Number == nil || *res.PR.Number <= 0 {
		t.Fatalf("number = %v", res.PR.Number)
	}
	if !strings.HasPrefix(res.PR.URL, "https://github.com/cli/cli/pull/") {
		t.Fatalf("url = %q", res.PR.URL)
	}
	switch res.PR.State {
	case "open", "closed", "merged":
	default:
		t.Fatalf("state = %q, want one of open/closed/merged", res.PR.State)
	}
	switch res.PR.CI.State {
	case CINone, CIPending, CISuccess, CIFailure:
	default:
		t.Fatalf("ci state = %q", res.PR.CI.State)
	}
	t.Logf("read #%d state=%s ci=%s (%d checks, %d failing)",
		*res.PR.Number, res.PR.State, res.PR.CI.State, res.PR.CI.Total, res.PR.CI.Failed)
}
