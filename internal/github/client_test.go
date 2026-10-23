package github

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
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
	errs      map[string]error
	calls     []string
	// queries records the parameters each call carried. Discarding them was how
	// a wrong or dropped filter could pass the whole suite unnoticed.
	queries [][][2]string
}

func (f *fakeRunner) Name() string { return f.name }

func (f *fakeRunner) apiGet(_ context.Context, path string, query [][2]string) ([]byte, error) {
	if f.onCall != nil {
		f.onCall(path)
	}
	f.calls = append(f.calls, path)
	f.queries = append(f.queries, query)
	if err, ok := f.errs[path]; ok {
		return nil, err
	}
	if body, ok := f.responses[path]; ok {
		return body, nil
	}
	return nil, fmt.Errorf("unexpected path %s", path)
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
