package github

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/vuuihc/openkin/internal/store"
)

func TestParseCanonical(t *testing.T) {
	cases := []struct {
		in     string
		want   Repo
		wantOK bool
	}{
		{"github.com/owner/repo", Repo{Owner: "owner", Name: "repo"}, true},
		{"GitHub.com/owner/repo", Repo{Owner: "owner", Name: "repo"}, true},
		{"github.com/owner/repo/extra", Repo{}, false},
		{"github.com/owner", Repo{}, false},
		{"gitlab.com/owner/repo", Repo{}, false},
		{"github.com//repo", Repo{}, false},
		{"", Repo{}, false},
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			got, ok := ParseCanonical(tc.in)
			if ok != tc.wantOK {
				t.Fatalf("ParseCanonical(%q) ok = %v, want %v", tc.in, ok, tc.wantOK)
			}
			if ok && got != tc.want {
				t.Fatalf("ParseCanonical(%q) = %+v, want %+v", tc.in, got, tc.want)
			}
		})
	}
}

// GitHub treats owner and name case-insensitively, so two spellings of one
// repository must fold onto one cache key — otherwise each gets its own row and
// its own polling against the same quota.
func TestCanonicalFoldsCase(t *testing.T) {
	cases := []struct {
		repo Repo
		want string
	}{
		{Repo{Owner: "Owner", Name: "Repo"}, "github.com/owner/repo"},
		{Repo{Owner: "OWNER", Name: "REPO"}, "github.com/owner/repo"},
		{Repo{Owner: "owner", Name: "repo"}, "github.com/owner/repo"},
	}
	for _, tc := range cases {
		if got := tc.repo.Canonical(); got != tc.want {
			t.Errorf("Repo%+v.Canonical() = %q, want %q", tc.repo, got, tc.want)
		}
	}
}

func TestDeriveCI(t *testing.T) {
	cases := []struct {
		name        string
		checks      []checkResult
		wantState   string
		wantFailing []string
	}{
		{"nothing reported", nil, CINone, nil},
		{
			"all green",
			[]checkResult{{name: "build", status: "completed", conclusion: "success"}},
			CISuccess, nil,
		},
		{
			"skipped counts as passing",
			[]checkResult{{name: "docs", status: "completed", conclusion: "skipped"}},
			CISuccess, nil,
		},
		{
			"a failure",
			[]checkResult{{name: "test", status: "completed", conclusion: "failure"}},
			CIFailure, []string{"test"},
		},
		{
			"still running outranks a failure",
			[]checkResult{
				{name: "test", status: "completed", conclusion: "failure"},
				{name: "lint", status: "in_progress"},
			},
			CIPending, []string{"test"},
		},
		{
			"an unknown conclusion is not success",
			[]checkResult{{name: "mystery", status: "completed", conclusion: "brand_new"}},
			CIPending, nil,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := deriveCI(tc.checks)
			if got.State != tc.wantState {
				t.Fatalf("state = %q, want %q", got.State, tc.wantState)
			}
			if len(got.Failing) != len(tc.wantFailing) {
				t.Fatalf("failing = %v, want %v", got.Failing, tc.wantFailing)
			}
			for i := range tc.wantFailing {
				if got.Failing[i] != tc.wantFailing[i] {
					t.Fatalf("failing = %v, want %v", got.Failing, tc.wantFailing)
				}
			}
			if got.Total != len(tc.checks) {
				t.Fatalf("total = %d, want %d", got.Total, len(tc.checks))
			}
		})
	}
}

type fakeRunner struct {
	name      string
	onCall    func(string)
	responses map[string][]byte
	// links is the Link header each path answers with, keyed like responses. An
	// answer for one page of a list is keyed "path?page=N", so a read that
	// follows rel="last" gets a different body than the first page did.
	links map[string]string
	errs  map[string]error
	calls []string
	// queries records the parameters each call carried. Discarding them was how
	// a wrong or dropped filter could pass the whole suite unnoticed.
	queries [][][2]string
}

func (f *fakeRunner) Name() string { return f.name }

func (f *fakeRunner) apiGet(_ context.Context, path string, query [][2]string) ([]byte, error) {
	body, _, err := f.answer(path, query)
	return body, err
}

// apiGetWithHeaders is the header-aware call the reviews read uses. The other
// reads keep calling apiGet, which is the same answer without the Link.
func (f *fakeRunner) apiGetWithHeaders(_ context.Context, path string, query [][2]string) ([]byte, string, error) {
	return f.answer(path, query)
}

func (f *fakeRunner) answer(path string, query [][2]string) ([]byte, string, error) {
	if f.onCall != nil {
		f.onCall(path)
	}
	f.calls = append(f.calls, path)
	f.queries = append(f.queries, query)
	key := path
	for _, kv := range query {
		if kv[0] == "page" {
			key = path + "?page=" + kv[1]
		}
	}
	if err, ok := f.errs[key]; ok {
		return nil, "", err
	}
	if body, ok := f.responses[key]; ok {
		return body, f.links[key], nil
	}
	return nil, "", fmt.Errorf("unexpected path %s", path)
}

// The list request is the one that establishes read access and identifies the
// branch, so the question it asks has to be the intended one: filtered to this
// branch, over all states, and one row.
func TestLookupAsksAboutTheRightBranch(t *testing.T) {
	runner := &fakeRunner{
		name:      SourceGH,
		responses: map[string][]byte{"/repos/owner/repo/pulls": []byte(`[]`)},
	}
	if _, err := lookup(context.Background(), runner, Repo{Owner: "owner", Name: "repo"}, "kin/task/1/g1"); err != nil {
		t.Fatalf("lookup: %v", err)
	}
	if len(runner.queries) != 1 {
		t.Fatalf("made %d requests, want 1", len(runner.queries))
	}
	got := map[string]string{}
	for _, kv := range runner.queries[0] {
		got[kv[0]] = kv[1]
	}
	if got["head"] != "owner:kin/task/1/g1" {
		t.Fatalf("head = %q, want owner:kin/task/1/g1", got["head"])
	}
	if got["state"] != "all" {
		// A closed or merged pull request is still the answer for this branch.
		t.Fatalf("state = %q, want all", got["state"])
	}
	if got["per_page"] == "" {
		t.Fatal("no per_page limit, so a busy branch could return a page of rows")
	}
}

func TestLookupFindsPullRequestAndChecks(t *testing.T) {
	runner := &fakeRunner{
		name: SourceGH,
		responses: map[string][]byte{
			"/repos/owner/repo/pulls": []byte(`[{
				"number": 42, "html_url": "https://github.com/owner/repo/pull/42",
				"title": "Add the thing", "state": "open", "draft": false,
				"base": {"ref": "main"}, "head": {"sha": "abc123"}
			}]`),
			"/repos/owner/repo/commits/abc123/check-runs": []byte(`{
				"check_runs": [
					{"name": "build", "status": "completed", "conclusion": "success"},
					{"name": "test", "status": "completed", "conclusion": "failure"}
				]}`),
			// Both CI sources are read on every lookup, and a source that cannot
			// be read leaves the state unknown — so a fixture for a commit with
			// checks has to say what its commit statuses are, even when the answer
			// is "there are none".
			"/repos/owner/repo/commits/abc123/status": []byte(`{"state": "", "statuses": []}`),
		},
	}
	res, err := lookup(context.Background(), runner, Repo{Owner: "owner", Name: "repo"}, "kin/task/1/g1")
	if err != nil {
		t.Fatalf("lookup: %v", err)
	}
	if res.PR == nil {
		t.Fatal("expected a pull request")
	}
	if res.PR.Number == nil || *res.PR.Number != 42 {
		t.Fatalf("number = %v, want 42", res.PR.Number)
	}
	if res.PR.State != "open" || res.PR.BaseBranch != "main" {
		t.Fatalf("got %+v", res.PR)
	}
	if res.PR.CI.State != CIFailure {
		t.Fatalf("ci = %q, want %q", res.PR.CI.State, CIFailure)
	}
	if res.Source != SourceGH {
		t.Fatalf("source = %q, want %q", res.Source, SourceGH)
	}
}

func TestLookupEmptyListIsAnAnswerNotAnError(t *testing.T) {
	runner := &fakeRunner{
		name:      SourceGH,
		responses: map[string][]byte{"/repos/owner/repo/pulls": []byte(`[]`)},
	}
	res, err := lookup(context.Background(), runner, Repo{Owner: "owner", Name: "repo"}, "kin/task/1/g1")
	if err != nil {
		t.Fatalf("lookup: %v", err)
	}
	if res.PR != nil {
		t.Fatalf("expected no pull request, got %+v", res.PR)
	}
	if len(runner.calls) != 1 {
		t.Fatalf("calls = %v, want only the list request", runner.calls)
	}
}

// A 404 from the list endpoint means the repository is not visible to these
// credentials — which is also what a private repository looks like to an
// anonymous reader. Treating it as "no pull request" would invent a fact.
func TestLookupNotFoundIsAnError(t *testing.T) {
	runner := &fakeRunner{
		name: SourceAnonymous,
		errs: map[string]error{"/repos/owner/repo/pulls": fmt.Errorf("%w: nope", ErrNotFound)},
	}
	res, err := lookup(context.Background(), runner, Repo{Owner: "owner", Name: "repo"}, "b")
	if err == nil {
		t.Fatal("expected an error for a 404 on the repository")
	}
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
	if res.PR != nil {
		t.Fatalf("a failed lookup must not produce a pull request: %+v", res.PR)
	}
}

// The pull request is still worth reporting when only its checks could not be
// read; the console renders an unknown CI state as "not reported".
func TestLookupSurvivesUnreadableChecks(t *testing.T) {
	runner := &fakeRunner{
		name: SourceGH,
		responses: map[string][]byte{
			"/repos/owner/repo/pulls": []byte(`[{"number":7,"state":"open","head":{"sha":"abc"},"base":{"ref":"main"}}]`),
		},
		errs: map[string]error{
			"/repos/owner/repo/commits/abc/check-runs": errors.New("boom"),
			"/repos/owner/repo/commits/abc/status":     errors.New("boom"),
		},
	}
	res, err := lookup(context.Background(), runner, Repo{Owner: "owner", Name: "repo"}, "b")
	if err != nil {
		t.Fatalf("lookup: %v", err)
	}
	if res.PR == nil || res.PR.Number == nil || *res.PR.Number != 7 {
		t.Fatalf("expected pull request 7, got %+v", res.PR)
	}
	if res.PR.CI.State != CINone {
		t.Fatalf("ci = %q, want %q", res.PR.CI.State, CINone)
	}
}

// A commit can have passing check runs and a failing commit status at the same
// time, because the two APIs are fed by different integrations. Reading check
// runs and stopping when there are any reports "all passed" for that commit,
// which is the one answer the console must not give.
func TestLookupReadsBothCISourcesAndReportsTheFailure(t *testing.T) {
	runner := &fakeRunner{
		name: SourceGH,
		responses: map[string][]byte{
			"/repos/owner/repo/pulls": []byte(`[{"number":7,"state":"open","head":{"sha":"abc"},"base":{"ref":"main"}}]`),
			"/repos/owner/repo/commits/abc/check-runs": []byte(`{
				"check_runs": [{"name": "build", "status": "completed", "conclusion": "success"}]}`),
			// The integration that never adopted checks: it only ever reported here.
			"/repos/owner/repo/commits/abc/status": []byte(`{
				"state": "failure", "statuses": [{"context": "ci/external", "state": "failure"}]}`),
		},
	}
	res, err := lookup(context.Background(), runner, Repo{Owner: "owner", Name: "repo"}, "b")
	if err != nil {
		t.Fatalf("lookup: %v", err)
	}
	ci := res.PR.CI
	if ci.State != CIFailure {
		t.Fatalf("ci = %q (%+v), want %q — the external status was not read", ci.State, ci, CIFailure)
	}
	if ci.Total != 2 || ci.Passed != 1 || ci.Failed != 1 {
		t.Fatalf("ci = %+v, want both sources counted", ci)
	}
	if len(ci.Failing) != 1 || ci.Failing[0] != "ci/external" {
		t.Fatalf("failing = %v, want the external status named", ci.Failing)
	}
}

// An integration that reports through both APIs is one job, not two: counting it
// twice would double it in the totals and show it twice in the failing list.
func TestLookupCountsAJobReportedThroughBothAPIsOnce(t *testing.T) {
	runner := &fakeRunner{
		name: SourceGH,
		responses: map[string][]byte{
			"/repos/owner/repo/pulls": []byte(`[{"number":7,"state":"open","head":{"sha":"abc"},"base":{"ref":"main"}}]`),
			"/repos/owner/repo/commits/abc/check-runs": []byte(`{
				"check_runs": [{"name": "build", "status": "completed", "conclusion": "success"}]}`),
			"/repos/owner/repo/commits/abc/status": []byte(`{
				"state": "success", "statuses": [{"context": "build", "state": "success"}]}`),
		},
	}
	res, err := lookup(context.Background(), runner, Repo{Owner: "owner", Name: "repo"}, "b")
	if err != nil {
		t.Fatalf("lookup: %v", err)
	}
	if ci := res.PR.CI; ci.Total != 1 || ci.Passed != 1 || ci.State != CISuccess {
		t.Fatalf("ci = %+v, want one passing check", ci)
	}
}

// A source that cannot be read is not a source that reported nothing. The state
// stays unknown rather than reporting the half that answered as the whole answer.
func TestLookupLeavesCIUnknownWhenOneSourceCannotBeRead(t *testing.T) {
	for _, missing := range []string{"check-runs", "status"} {
		t.Run(missing, func(t *testing.T) {
			runner := &fakeRunner{
				name: SourceGH,
				responses: map[string][]byte{
					"/repos/owner/repo/pulls": []byte(`[{"number":7,"state":"open","head":{"sha":"abc"},"base":{"ref":"main"}}]`),
					"/repos/owner/repo/commits/abc/check-runs": []byte(`{
						"check_runs": [{"name": "build", "status": "completed", "conclusion": "success"}]}`),
					"/repos/owner/repo/commits/abc/status": []byte(`{
						"state": "success", "statuses": [{"context": "ci/external", "state": "success"}]}`),
				},
				errs: map[string]error{
					"/repos/owner/repo/commits/abc/" + missing: errors.New("boom"),
				},
			}
			res, err := lookup(context.Background(), runner, Repo{Owner: "owner", Name: "repo"}, "b")
			if err != nil {
				t.Fatalf("lookup: %v", err)
			}
			if res.PR == nil {
				t.Fatal("the pull request itself was read and must survive")
			}
			if res.PR.CI.State != CINone {
				t.Fatalf("ci = %q with %s unreadable, want %q", res.PR.CI.State, missing, CINone)
			}
		})
	}
}

func TestLookupFallsBackToCommitStatus(t *testing.T) {
	runner := &fakeRunner{
		name: SourceGH,
		responses: map[string][]byte{
			"/repos/owner/repo/pulls":                  []byte(`[{"number":7,"state":"open","head":{"sha":"abc"},"base":{"ref":"main"}}]`),
			"/repos/owner/repo/commits/abc/check-runs": []byte(`{"check_runs": []}`),
			"/repos/owner/repo/commits/abc/status":     []byte(`{"state":"success","statuses":[{"context":"ci/old","state":"success"}]}`),
		},
	}
	res, err := lookup(context.Background(), runner, Repo{Owner: "owner", Name: "repo"}, "b")
	if err != nil {
		t.Fatalf("lookup: %v", err)
	}
	if res.PR == nil || res.PR.CI.State != CISuccess {
		t.Fatalf("ci = %+v, want success", res.PR)
	}
}

// The commit-status vocabulary is not the check-run one. "error" means a check
// broke, and reading it as an unknown conclusion would report "still running"
// for a check that will never run again — forever, since nothing about the row
// changes on its own.
func TestCommitStatusVocabularyTranslates(t *testing.T) {
	cases := []struct {
		state      string
		wantStatus string
		wantConc   string
	}{
		{"success", "completed", "success"},
		{"failure", "completed", "failure"},
		{"error", "completed", "failure"},
		{"pending", "in_progress", "pending"},
	}
	for _, tc := range cases {
		t.Run(tc.state, func(t *testing.T) {
			status, conclusion := commitStatusAsCheck(tc.state)
			if status != tc.wantStatus || conclusion != tc.wantConc {
				t.Fatalf("commitStatusAsCheck(%q) = (%q, %q), want (%q, %q)",
					tc.state, status, conclusion, tc.wantStatus, tc.wantConc)
			}
			// And the translation must survive the derivation it feeds.
			got := deriveCI([]checkResult{{name: "ci/legacy", status: status, conclusion: conclusion}})
			switch tc.state {
			case "success":
				if got.State != CISuccess {
					t.Fatalf("state = %q, want success", got.State)
				}
			case "failure", "error":
				if got.State != CIFailure {
					t.Fatalf("state = %q, want failure", got.State)
				}
			case "pending":
				if got.State != CIPending {
					t.Fatalf("state = %q, want pending", got.State)
				}
			}
		})
	}
}

// A commit status reporting "error" arrives through the same path a person would
// see in the console, so the end-to-end shape is worth pinning too.
func TestLookupReadsAnErroredCommitStatusAsFailure(t *testing.T) {
	runner := &fakeRunner{
		name: SourceGH,
		responses: map[string][]byte{
			"/repos/owner/repo/pulls":                  []byte(`[{"number":7,"state":"open","head":{"sha":"abc"},"base":{"ref":"main"}}]`),
			"/repos/owner/repo/commits/abc/check-runs": []byte(`{"check_runs": []}`),
			"/repos/owner/repo/commits/abc/status":     []byte(`{"state":"error","statuses":[{"context":"ci/old","state":"error"}]}`),
		},
	}
	res, err := lookup(context.Background(), runner, Repo{Owner: "owner", Name: "repo"}, "b")
	if err != nil {
		t.Fatalf("lookup: %v", err)
	}
	if res.PR == nil || res.PR.CI.State != CIFailure {
		t.Fatalf("ci = %+v, want failure", res.PR)
	}
}

// A merged pull request reports state "closed" with a merge timestamp; the
// console shows one word, so the two are folded together here.
func TestLookupFoldsMergedIntoOneState(t *testing.T) {
	runner := &fakeRunner{
		name: SourceGH,
		responses: map[string][]byte{
			"/repos/owner/repo/pulls":                  []byte(`[{"number":7,"state":"closed","merged_at":"2026-01-01T00:00:00Z","head":{"sha":"abc"},"base":{"ref":"main"}}]`),
			"/repos/owner/repo/commits/abc/check-runs": []byte(`{"check_runs":[]}`),
			"/repos/owner/repo/commits/abc/status":     []byte(`{"state":"success","statuses":[]}`),
		},
	}
	res, err := lookup(context.Background(), runner, Repo{Owner: "owner", Name: "repo"}, "b")
	if err != nil {
		t.Fatalf("lookup: %v", err)
	}
	if res.PR.State != "merged" {
		t.Fatalf("state = %q, want merged", res.PR.State)
	}
}

// The anonymous reader's whole job is to turn an HTTP status into the right
// sentinel, because the caller's fallback logic keys on it. Getting 403 wrong
// matters most: an exhausted quota and a repository you may not read both
// arrive as 403, and only the rate-limit header tells them apart.
func TestHTTPReaderMapsStatusToSentinels(t *testing.T) {
	cases := []struct {
		name       string
		status     int
		headers    map[string]string
		want       error
		wantAsBody bool
	}{
		{name: "ok", status: 200, wantAsBody: true},
		{name: "not found", status: 404, want: ErrNotFound},
		{name: "unauthorized", status: 401, want: ErrNotAuthenticated},
		{
			name: "quota exhausted", status: 403,
			headers: map[string]string{"X-RateLimit-Remaining": "0"},
			want:    ErrRateLimited,
		},
		{
			// A secondary rate limit and a plain refusal are both 403; without
			// the header this must stay an unclassified error rather than be
			// reported to the user as "rate limited".
			name: "forbidden without a quota signal", status: 403,
		},
		{name: "too many requests", status: 429, want: ErrRateLimited},
		{name: "server error", status: 500},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if got := r.Header.Get("User-Agent"); got == "" {
					t.Error("request had no User-Agent, which GitHub rejects")
				}
				for k, v := range tc.headers {
					w.Header().Set(k, v)
				}
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(`{"message":"body"}`))
			}))
			defer srv.Close()

			r := &httpReader{client: srv.Client(), baseURL: srv.URL}
			body, err := r.apiGet(context.Background(), "/repos/o/r/pulls", nil)

			if tc.wantAsBody {
				if err != nil {
					t.Fatalf("apiGet: %v", err)
				}
				if len(body) == 0 {
					t.Fatal("expected a body")
				}
				return
			}
			if err == nil {
				t.Fatal("expected an error")
			}
			if tc.want == nil {
				if errors.Is(err, ErrNotFound) || errors.Is(err, ErrNotAuthenticated) || errors.Is(err, ErrRateLimited) {
					t.Fatalf("err = %v, want an unclassified error", err)
				}
				return
			}
			if !errors.Is(err, tc.want) {
				t.Fatalf("err = %v, want %v", err, tc.want)
			}
		})
	}
}

// Query parameters must survive into the request intact. The head filter
// carries a branch name with slashes in it, and a query parser that split on
// them would silently ask about a different branch.
func TestHTTPReaderSendsQueryParameters(t *testing.T) {
	var gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
		_, _ = w.Write([]byte(`[]`))
	}))
	defer srv.Close()

	r := &httpReader{client: srv.Client(), baseURL: srv.URL}
	if _, err := r.apiGet(context.Background(), "/repos/o/r/pulls", [][2]string{
		{"head", "o:kin/task/1/g1"},
		{"state", "all"},
		{"per_page", "1"},
	}); err != nil {
		t.Fatalf("apiGet: %v", err)
	}

	parsed, err := url.ParseQuery(gotQuery)
	if err != nil {
		t.Fatalf("parse query %q: %v", gotQuery, err)
	}
	if got := parsed.Get("head"); got != "o:kin/task/1/g1" {
		t.Fatalf("head = %q, want the branch name back verbatim", got)
	}
	if got := parsed.Get("state"); got != "all" {
		t.Fatalf("state = %q", got)
	}
	if parsed.Get("per_page") != "1" {
		t.Fatalf("per_page = %q", parsed.Get("per_page"))
	}
}

// A value with characters that really are delimiters has to be escaped, or the
// request asks a different question than intended.
func TestEscapeQueryEscapesDelimiters(t *testing.T) {
	cases := map[string]string{
		"a&b=c":  "a%26b%3Dc",
		"a b":    "a%20b",
		"a#b":    "a%23b",
		"a+b":    "a%2Bb",
		"a%b":    "a%25b",
		"plain1": "plain1",
	}
	for in, want := range cases {
		if got := escapeQuery(in); got != want {
			t.Errorf("escapeQuery(%q) = %q, want %q", in, got, want)
		}
	}
}

// Multi-byte characters must be encoded as their UTF-8 bytes. Encoding the rune
// instead produces a value that decodes to a different string, which is a silent
// way to ask about the wrong thing.
func TestEscapeQueryEncodesUTF8(t *testing.T) {
	cases := map[string]string{
		"café":   "caf%C3%A9",
		"日本語":    "%E6%97%A5%E6%9C%AC%E8%AA%9E",
		"emoji🚀": "emoji%F0%9F%9A%80",
	}
	for in, want := range cases {
		got := escapeQuery(in)
		if got != want {
			t.Errorf("escapeQuery(%q) = %q, want %q", in, got, want)
		}
		// The property that matters, independent of the exact spelling.
		decoded, err := url.QueryUnescape(got)
		if err != nil {
			t.Errorf("escapeQuery(%q) = %q, which does not unescape: %v", in, got, err)
			continue
		}
		if decoded != in {
			t.Errorf("escapeQuery(%q) round-tripped to %q", in, decoded)
		}
	}
}

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

// reviewListJSON encodes the review payload a fake forge answers with.
func reviewListJSON(t *testing.T, reviews []map[string]any) []byte {
	t.Helper()
	body, err := json.Marshal(reviews)
	if err != nil {
		t.Fatal(err)
	}
	return body
}

// A refresh reads the reviews too, and the row's array is the answer with the
// author, the forge's state and the body, oldest first as GitHub returns them.
func TestLookupReadsReviewsIntoTheObservation(t *testing.T) {
	runner := &fakeRunner{
		name: SourceGH,
		responses: map[string][]byte{
			"/repos/owner/repo/pulls":                  []byte(`[{"number":7,"state":"open","head":{"sha":"abc"},"base":{"ref":"main"}}]`),
			"/repos/owner/repo/commits/abc/check-runs": []byte(`{"check_runs":[]}`),
			"/repos/owner/repo/commits/abc/status":     []byte(`{"state":"","statuses":[]}`),
			"/repos/owner/repo/pulls/7/reviews": []byte(`[
				{"user":{"login":"alice"},"state":"COMMENTED","body":"Could you add a test?"},
				{"user":{"login":"bob"},"state":"APPROVED","body":"Looks good"}]`),
		},
	}
	res, err := lookup(context.Background(), runner, Repo{Owner: "owner", Name: "repo"}, "b")
	if err != nil {
		t.Fatalf("lookup: %v", err)
	}
	if res.PR == nil {
		t.Fatal("expected a pull request")
	}
	if !res.PR.ReviewsRead {
		t.Fatalf("the reviews were not read: %q", res.PR.Reviews)
	}
	var got []review
	if err := json.Unmarshal([]byte(res.PR.Reviews), &got); err != nil {
		t.Fatalf("reviews %q are not a JSON array: %v", res.PR.Reviews, err)
	}
	if len(got) != 2 {
		t.Fatalf("reviews = %+v, want both", got)
	}
	if got[0].Author != "alice" || got[0].State != "COMMENTED" || got[0].Body != "Could you add a test?" {
		t.Errorf("first review = %+v, want the oldest first", got[0])
	}
	if got[1].Author != "bob" || got[1].State != "APPROVED" || got[1].Body != "Looks good" {
		t.Errorf("second review = %+v", got[1])
	}
}

// A failed reviews read is not a reviews answer. The pull request and its checks
// are still a good observation, and the row keeps the array it already had —
// never ” and never [].
func TestLookupKeepsTheLastReviewsWhenTheReadFails(t *testing.T) {
	reader := &fakeRunner{
		name: SourceGH,
		responses: map[string][]byte{
			"/repos/owner/repo/pulls":                  []byte(`[{"number":7,"state":"open","head":{"sha":"abc"},"base":{"ref":"main"}}]`),
			"/repos/owner/repo/commits/abc/check-runs": []byte(`{"check_runs":[]}`),
			"/repos/owner/repo/commits/abc/status":     []byte(`{"state":"","statuses":[]}`),
		},
		errs: map[string]error{
			"/repos/owner/repo/pulls/7/reviews": errors.New("boom"),
		},
	}
	svc, st := newTestService(t, reader)
	ctx := context.Background()
	repo := Repo{Owner: "owner", Name: "repo"}
	previous := `[{"author":"a","state":"APPROVED","body":"ok"}]`
	old := time.Now().Add(-time.Hour).UnixMilli()
	if err := st.RecordPRObservation(ctx, store.PRObservation{
		Repo: repo.Canonical(), HeadBranch: "b", TaskID: "t", Number: number(7), State: "open",
		Reviews: previous, Source: SourceGH, ObservedAt: &old, AttemptedAt: old,
	}); err != nil {
		t.Fatal(err)
	}

	res, err := lookup(ctx, reader, repo, "b")
	if err != nil {
		t.Fatalf("lookup: %v", err)
	}
	if res.PR == nil {
		t.Fatal("the pull request itself was read and must survive")
	}
	if res.PR.ReviewsRead {
		t.Fatalf("a failed reviews read reported an answer: %q", res.PR.Reviews)
	}
	if err := svc.record(ctx, Target{TaskID: "t", Repo: repo, Branch: "b"}, res, time.Now()); err != nil {
		t.Fatalf("record: %v", err)
	}
	obs, ok, err := st.GetPRObservation(ctx, repo.Canonical(), "b")
	if err != nil || !ok {
		t.Fatalf("observation: ok=%v err=%v", ok, err)
	}
	if obs.Reviews != previous {
		t.Fatalf("reviews = %q, want the previous array kept", obs.Reviews)
	}
}

// "Read, and none" is an answer: it is stored as [], which replaces a previous
// array, and never as ” — the value that means nobody ever asked.
func TestLookupWritesAnEmptyArrayWhenTheReadSucceedsWithNone(t *testing.T) {
	reader := &fakeRunner{
		name: SourceGH,
		responses: map[string][]byte{
			"/repos/owner/repo/pulls":                  []byte(`[{"number":7,"state":"open","head":{"sha":"abc"},"base":{"ref":"main"}}]`),
			"/repos/owner/repo/commits/abc/check-runs": []byte(`{"check_runs":[]}`),
			"/repos/owner/repo/commits/abc/status":     []byte(`{"state":"","statuses":[]}`),
			"/repos/owner/repo/pulls/7/reviews":        []byte(`[]`),
		},
	}
	svc, st := newTestService(t, reader)
	ctx := context.Background()
	repo := Repo{Owner: "owner", Name: "repo"}

	res, err := lookup(ctx, reader, repo, "b")
	if err != nil {
		t.Fatalf("lookup: %v", err)
	}
	if res.PR == nil || !res.PR.ReviewsRead {
		t.Fatalf("an empty answer was not read: %+v", res.PR)
	}
	if err := svc.record(ctx, Target{TaskID: "t", Repo: repo, Branch: "b"}, res, time.Now()); err != nil {
		t.Fatalf("record: %v", err)
	}
	obs, ok, err := st.GetPRObservation(ctx, repo.Canonical(), "b")
	if err != nil || !ok {
		t.Fatalf("observation: ok=%v err=%v", ok, err)
	}
	if obs.Reviews != "[]" {
		t.Fatalf("reviews = %q, want [] — an empty answer is not a missing one", obs.Reviews)
	}
}

// The payload is untrusted input: a long review list is cut to its newest
// twenty, and text is bounded at the boundary rather than at a byte offset that
// could split a rune.
func TestReadReviewsKeepsTheNewestTwentyAndBoundsText(t *testing.T) {
	raw := make([]map[string]any, 0, 25)
	for i := 0; i < 25; i++ {
		raw = append(raw, map[string]any{
			"user":  map[string]string{"login": fmt.Sprintf("r%02d", i)},
			"state": "COMMENTED",
			"body":  fmt.Sprintf("body %d", i),
		})
	}
	// The newest review carries every bound at once.
	raw[24]["user"] = map[string]string{"login": strings.Repeat("a", 120)}
	raw[24]["body"] = strings.Repeat("b", 5000)
	raw[24]["state"] = "brand_new"
	// A multi-byte body, to prove the truncation lands on a rune boundary.
	raw[23]["body"] = strings.Repeat("日", 5000)

	runner := &fakeRunner{
		name:      SourceGH,
		responses: map[string][]byte{"/repos/owner/repo/pulls/7/reviews": reviewListJSON(t, raw)},
	}
	gotJSON, err := readReviews(context.Background(), runner, Repo{Owner: "owner", Name: "repo"}, 7)
	if err != nil {
		t.Fatalf("readReviews: %v", err)
	}
	var got []review
	if err := json.Unmarshal([]byte(gotJSON), &got); err != nil {
		t.Fatalf("reviews %q are not JSON: %v", gotJSON, err)
	}
	if len(got) != 20 {
		t.Fatalf("kept %d reviews, want the newest 20", len(got))
	}
	if got[0].Author != "r05" {
		t.Errorf("first kept review = %q, want r05 — the oldest five were dropped", got[0].Author)
	}
	if got[19].Author != strings.Repeat("a", 100) || got[19].Body != strings.Repeat("b", 4000) {
		t.Errorf("newest review = %q/%d runes, want the bounded author and a 4000-rune body",
			got[19].Author, utf8.RuneCountInString(got[19].Body))
	}
	if utf8.RuneCountInString(got[19].Author) != 100 {
		t.Errorf("author is %d runes, want 100", utf8.RuneCountInString(got[19].Author))
	}
	if got[19].State != "UNKNOWN" {
		t.Errorf("state = %q, want UNKNOWN for a word the forge never uses", got[19].State)
	}
	multi := got[18].Body
	if !utf8.ValidString(multi) {
		t.Error("a multi-byte body was cut mid-rune")
	}
	if utf8.RuneCountInString(multi) != 4000 || strings.Trim(multi, "日") != "" {
		t.Errorf("multi-byte body = %d runes of mixed text, want 4000 runes of 日",
			utf8.RuneCountInString(multi))
	}
}

// GitHub returns reviews oldest first, so the first page of a long history is
// the wrong end of it. The newest page is the one rel="last" names, and a
// snapshot must come from there rather than calling the oldest page newest.
func TestReadReviewsFollowsTheLastPageLink(t *testing.T) {
	first := []map[string]any{
		{"user": map[string]string{"login": "ancient"}, "state": "COMMENTED", "body": "oldest"},
	}
	lastRaw := make([]map[string]any, 0, 25)
	for i := 0; i < 25; i++ {
		lastRaw = append(lastRaw, map[string]any{
			"user":  map[string]string{"login": fmt.Sprintf("r%02d", i)},
			"state": "APPROVED",
			"body":  fmt.Sprintf("body %d", i),
		})
	}
	runner := &fakeRunner{
		name: SourceGH,
		responses: map[string][]byte{
			"/repos/owner/repo/pulls/7/reviews":        reviewListJSON(t, first),
			"/repos/owner/repo/pulls/7/reviews?page=3": reviewListJSON(t, lastRaw),
		},
		links: map[string]string{
			"/repos/owner/repo/pulls/7/reviews": `<https://api.github.com/repos/owner/repo/pulls/7/reviews?per_page=100&page=3>; rel="last", <https://api.github.com/repos/owner/repo/pulls/7/reviews?per_page=100&page=2>; rel="next"`,
		},
	}
	gotJSON, err := readReviews(context.Background(), runner, Repo{Owner: "owner", Name: "repo"}, 7)
	if err != nil {
		t.Fatalf("readReviews: %v", err)
	}
	var got []review
	if err := json.Unmarshal([]byte(gotJSON), &got); err != nil {
		t.Fatalf("reviews %q are not JSON: %v", gotJSON, err)
	}
	if len(got) != 20 || got[0].Author != "r05" || got[19].Author != "r24" {
		t.Fatalf("kept %d reviews from %q to %q, want the newest 20 of the last page",
			len(got), got[0].Author, got[len(got)-1].Author)
	}
	for _, r := range got {
		if r.Author == "ancient" {
			t.Fatal("the first page's oldest review was kept as if it were the newest")
		}
	}
	if len(runner.queries) != 2 {
		t.Fatalf("made %d requests, want the first page and the last", len(runner.queries))
	}
	page := ""
	for _, kv := range runner.queries[1] {
		if kv[0] == "page" {
			page = kv[1]
		}
	}
	if page != "3" {
		t.Fatalf("the second request asked for page %q, want 3", page)
	}
}

// gh prints the response headers ahead of the body; the Link header is the only
// thing the reviews read needs from them. Output without a header block is body
// only — that is a readable answer, not a failed read.
func TestSplitGHHeaders(t *testing.T) {
	body := `[{"id":1}]`
	link := `<https://api.github.com/repos/o/r/pulls/7/reviews?page=2>; rel="next"`
	out := "HTTP/2.0 200 OK\r\nContent-Type: application/json\r\nLink: " + link + "\r\n\r\n" + body
	gotBody, gotLink := splitGHHeaders([]byte(out))
	if string(gotBody) != body {
		t.Errorf("body = %q, want %q", gotBody, body)
	}
	if gotLink != link {
		t.Errorf("link = %q, want %q", gotLink, link)
	}

	gotBody, gotLink = splitGHHeaders([]byte(body))
	if string(gotBody) != body || gotLink != "" {
		t.Errorf("body-only output = (%q, %q), want (%q, \"\")", gotBody, gotLink, body)
	}
}
