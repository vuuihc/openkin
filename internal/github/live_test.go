package github

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/toolpath"
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
	if reason := toolpath.Refuse(bin.Path); reason != "" {
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

// The credential-free reader is the one that has to work on a machine whose gh
// login has expired, which is the machine this was written on. Everything else
// about it is tested against fakes; this is the only check that the URL it
// builds and the JSON it parses actually match what github.com serves.
//
// It costs one anonymous request against a quota of sixty an hour, shared with
// every other anonymous caller on this address, so it stays behind the same
// opt-in as the rest of this file.
func TestLiveAnonymousLookupAgainstGitHub(t *testing.T) {
	requireLive(t)
	repo := Repo{Owner: "cli", Name: "cli"}
	reader := newHTTPReader()
	ctx := context.Background()

	res, err := lookup(ctx, reader, repo, "kin-live-check-no-such-branch")
	if errors.Is(err, ErrRateLimited) {
		// Not a product failure: the anonymous quota belongs to the whole
		// address and sixty an hour is easy to spend from a machine that has
		// been testing this package. The service's own backoff is what handles
		// this state; a check that failed here would only report the weather.
		t.Skip("anonymous quota for this address is spent; run again after it refills")
	}
	if err != nil {
		t.Fatalf("anonymous lookup for an absent branch: %v", err)
	}
	if res.PR != nil {
		t.Fatalf("expected no pull request, got %+v", res.PR)
	}
	if res.Source != SourceAnonymous {
		t.Fatalf("source = %q, want %q", res.Source, SourceAnonymous)
	}

	// A real pull request, so the decode of number/url/state is exercised
	// against a live payload rather than a fixture we wrote ourselves.
	res, err = lookup(ctx, reader, repo, "trunk")
	if err != nil {
		t.Fatalf("anonymous lookup for trunk: %v", err)
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
	t.Logf("anonymous read #%d state=%s ci=%s", *res.PR.Number, res.PR.State, res.PR.CI.State)
}
