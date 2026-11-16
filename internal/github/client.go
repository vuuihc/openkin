package github

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/vuuihc/openkin/internal/store"
)

// Source names where an observation came from.
//
// It is recorded because the two are not interchangeable: an anonymous read sees
// only public repositories and only public detail, so a later authenticated read
// is an upgrade and the reverse is a downgrade. Keeping them in one cache with
// the source attached — rather than in two caches — means a given pair has one
// answer at a time, and the console can say which kind it is.
const (
	SourceGH        = "gh"
	SourceAnonymous = "anonymous"
)

// CI states, in the vocabulary the console renders. The values are owned by the
// store, which is where they are persisted.
const (
	CINone    = store.CINone
	CIPending = store.CIPending
	CISuccess = store.CISuccess
	CIFailure = store.CIFailure
)

// CIStatus summarises the checks attached to one commit.
type CIStatus struct {
	State   string   `json:"state"`
	Total   int      `json:"total"`
	Passed  int      `json:"passed"`
	Failed  int      `json:"failed"`
	Pending int      `json:"pending"`
	Failing []string `json:"failing,omitempty"`
}

// PullRequest is what a successful query learned about one branch.
//
// Number is a pointer because "there is no pull request for this branch" and
// "there is one, number 42" are different answers to the same question, and the
// first one is not an absence of information.
type PullRequest struct {
	Number     *int
	URL        string
	Title      string
	State      string // open | closed | merged
	IsDraft    bool
	BaseBranch string
	HeadOID    string
	CI         CIStatus
}

// reader answers the one question this package asks.
type reader interface {
	// Lookup returns the pull request whose head is branch, nil if there
	// genuinely is none, and an error if the question could not be answered.
	Lookup(ctx context.Context, repo Repo, branch string) (*PullRequest, error)
	Name() string
}

// ---------------------------------------------------------------------------
// gh-backed reader
// ---------------------------------------------------------------------------

// apiPull mirrors the fields this package reads from GitHub's pull request
// payload. gh's own `--json` projection is deliberately not used: it is gh's
// schema and moves between gh releases, while the REST payload is the documented
// contract.
type apiPull struct {
	Number   int     `json:"number"`
	HTMLURL  string  `json:"html_url"`
	Title    string  `json:"title"`
	State    string  `json:"state"`
	Draft    bool    `json:"draft"`
	MergedAt *string `json:"merged_at"`
	Base     struct {
		Ref string `json:"ref"`
	} `json:"base"`
	Head struct {
		SHA string `json:"sha"`
	} `json:"head"`
}

type apiCheckRuns struct {
	CheckRuns []struct {
		Name       string `json:"name"`
		Status     string `json:"status"`
		Conclusion string `json:"conclusion"`
	} `json:"check_runs"`
}

type apiCombinedStatus struct {
	State    string `json:"state"`
	Statuses []struct {
		Context string `json:"context"`
		State   string `json:"state"`
	} `json:"statuses"`
}

// apiRunner is the one thing the readers need from a transport: run a request
// and give back a JSON body. Both the gh CLI and the anonymous HTTP client
// implement it, so the query logic is written once.
type apiRunner interface {
	apiGet(ctx context.Context, path string, query [][2]string) ([]byte, error)
	Name() string
}

// httpReader answers queries by calling the GitHub REST API directly. Used with
// no credential at all, which is enough for public repositories.
type httpReader struct {
	client  *http.Client
	baseURL string
}

func newHTTPReader() *httpReader {
	return &httpReader{
		client:  &http.Client{Timeout: 20 * time.Second},
		baseURL: "https://api.github.com",
	}
}

func (r *httpReader) Name() string { return SourceAnonymous }

func (r *httpReader) apiGet(ctx context.Context, path string, query [][2]string) ([]byte, error) {
	url := r.baseURL + path
	if len(query) > 0 {
		parts := make([]string, 0, len(query))
		for _, kv := range query {
			parts = append(parts, kv[0]+"="+escapeQuery(kv[1]))
		}
		url += "?" + strings.Join(parts, "&")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	// GitHub rejects requests without a User-Agent.
	req.Header.Set("User-Agent", "openkin")

	resp, err := r.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	// Bounded: a pull request payload is kilobytes, and the body of a failure
	// is worth reading only far enough to explain it.
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		return body, nil
	case resp.StatusCode == http.StatusNotFound:
		return nil, fmt.Errorf("%w: GET %s", ErrNotFound, path)
	case resp.StatusCode == http.StatusUnauthorized:
		return nil, fmt.Errorf("%w: GET %s", ErrNotAuthenticated, path)
	case resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusTooManyRequests:
		// A secondary rate limit also lands on 403, so the header is what
		// distinguishes "slow down" from "you may not read this".
		if resp.Header.Get("X-RateLimit-Remaining") == "0" || resp.StatusCode == http.StatusTooManyRequests {
			return nil, fmt.Errorf("%w: GET %s", ErrRateLimited, path)
		}
		return nil, fmt.Errorf("github refused GET %s: %s", path, firstLine(body))
	default:
		return nil, fmt.Errorf("GET %s: HTTP %d: %s", path, resp.StatusCode, firstLine(body))
	}
}

// ghReader answers queries by shelling out to the user's GitHub CLI, which is
// already authenticated as them. No token passes through Kin.
type ghReader struct {
	client GHClient
}

func (r ghReader) Name() string { return SourceGH }

func (r ghReader) apiGet(ctx context.Context, path string, query [][2]string) ([]byte, error) {
	args := []string{"api", "--method", "GET", strings.TrimPrefix(path, "/")}
	for _, kv := range query {
		args = append(args, "-f", kv[0]+"="+kv[1])
	}
	return r.client.Run(ctx, args...)
}

// ---------------------------------------------------------------------------
// Shared query logic
// ---------------------------------------------------------------------------

// LookupResult is one reader's answer, before it is written to the cache.
type LookupResult struct {
	// PR is nil when the query succeeded and there is no pull request.
	PR     *PullRequest
	Source string
}

// lookup runs the three-request sequence against one transport: find the pull
// request for the branch, then read its checks.
//
// The first call is what establishes read access. A 404 there is not "no pull
// request" — GitHub answers 404 for a repository the caller cannot see, which is
// also what a private repository looks like to an anonymous reader — so it is
// reported as an error and never as an empty answer.
func lookup(ctx context.Context, runner apiRunner, repo Repo, branch string) (LookupResult, error) {
	var pulls []apiPull
	body, err := runner.apiGet(ctx, fmt.Sprintf("/repos/%s/%s/pulls", repo.Owner, repo.Name), [][2]string{
		{"head", repo.Owner + ":" + branch},
		{"state", "all"},
		{"per_page", "1"},
	})
	if err != nil {
		return LookupResult{}, err
	}
	if err := json.Unmarshal(body, &pulls); err != nil {
		return LookupResult{}, fmt.Errorf("decode pull list from %s: %w", runner.Name(), err)
	}
	if len(pulls) == 0 {
		return LookupResult{Source: runner.Name()}, nil
	}

	// The list payload omits nothing that matters here, but a merged pull
	// request reports state "closed" plus a merge timestamp, so the two are
	// folded into the single word the console shows.
	pr := pulls[0]
	state := pr.State
	if pr.MergedAt != nil {
		state = "merged"
	}
	number := pr.Number
	out := &PullRequest{
		Number:     &number,
		URL:        pr.HTMLURL,
		Title:      pr.Title,
		State:      state,
		IsDraft:    pr.Draft,
		BaseBranch: pr.Base.Ref,
		HeadOID:    pr.Head.SHA,
		// "No checks are known" until some are read, never the zero value: an
		// empty state string would reach the console as an unrenderable third
		// thing alongside none/pending/success/failure.
		CI: CIStatus{State: CINone},
	}

	ci, err := readCI(ctx, runner, repo, pr.Head.SHA)
	if err != nil {
		// The pull request itself was read successfully; only its checks were
		// not. Reporting the pull request with an unknown CI state is more
		// useful than discarding a good answer, and the console renders
		// "none" as "not reported" rather than as success.
		return LookupResult{PR: out, Source: runner.Name()}, nil
	}
	out.CI = ci
	return LookupResult{PR: out, Source: runner.Name()}, nil
}

// readCI merges the two places a commit's CI state lives.
//
// Check runs are the newer API and most integrations report there, but the
// combined status API is not a legacy subset of it: it carries the results of the
// integrations that never adopted checks, so a commit can have passing check runs
// and a failing status from its external CI at the same time. Reading check runs
// and stopping when there are any reports "all passed" for exactly that commit,
// which is the one answer this must never give.
//
// Both are read, and both have to be: a source that cannot be read is not a
// source that reported nothing, so a failure on either leaves the state unknown —
// CINone, which the console renders as "not reported" — rather than half-read.
func readCI(ctx context.Context, runner apiRunner, repo Repo, sha string) (CIStatus, error) {
	if sha == "" {
		return CIStatus{State: CINone}, nil
	}
	base := fmt.Sprintf("/repos/%s/%s/commits/%s", repo.Owner, repo.Name, sha)

	runs, err := readCheckRuns(ctx, runner, base)
	if err != nil {
		return CIStatus{}, err
	}
	statuses, err := readCommitStatuses(ctx, runner, base)
	if err != nil {
		return CIStatus{}, err
	}
	return deriveCI(mergeChecks(runs, statuses)), nil
}

func readCheckRuns(ctx context.Context, runner apiRunner, base string) ([]checkResult, error) {
	body, err := runner.apiGet(ctx, base+"/check-runs", [][2]string{{"per_page", "100"}})
	if err != nil {
		return nil, err
	}
	var runs apiCheckRuns
	if err := json.Unmarshal(body, &runs); err != nil {
		return nil, fmt.Errorf("decode check runs: %w", err)
	}
	checks := make([]checkResult, 0, len(runs.CheckRuns))
	for _, run := range runs.CheckRuns {
		checks = append(checks, checkResult{
			name:       run.Name,
			status:     run.Status,
			conclusion: run.Conclusion,
		})
	}
	return checks, nil
}

func readCommitStatuses(ctx context.Context, runner apiRunner, base string) ([]checkResult, error) {
	body, err := runner.apiGet(ctx, base+"/status", nil)
	if err != nil {
		return nil, err
	}
	var combined apiCombinedStatus
	if err := json.Unmarshal(body, &combined); err != nil {
		return nil, fmt.Errorf("decode combined status: %w", err)
	}
	checks := make([]checkResult, 0, len(combined.Statuses))
	for _, s := range combined.Statuses {
		status, conclusion := commitStatusAsCheck(s.State)
		checks = append(checks, checkResult{name: s.Context, status: status, conclusion: conclusion})
	}
	return checks, nil
}

// mergeChecks appends the statuses to the check runs, dropping one whose name a
// check run already carries. One name is one check: an integration that reports
// through both APIs is one job, and counting it twice would show it as two, in
// the totals and in the list of what is failing. The check run is the copy kept,
// because that is the API being maintained.
func mergeChecks(runs, statuses []checkResult) []checkResult {
	named := make(map[string]bool, len(runs))
	for _, c := range runs {
		if c.name != "" {
			named[c.name] = true
		}
	}
	for _, c := range statuses {
		if c.name != "" && named[c.name] {
			continue
		}
		runs = append(runs, c)
	}
	return runs
}

// commitStatusAsCheck translates the commit-status vocabulary into the check-run
// one, so both feed the same derivation.
//
// They are not the same vocabulary, and the differences are both handled here
// rather than in deriveCI, which is written against check runs:
//
//   - "pending" is how a commit status says "still running", where a check run
//     has a status of its own.
//   - "error" is how a commit status says a check broke. Check runs have no such
//     conclusion, so left untranslated it would reach deriveCI as an unknown
//     conclusion, be counted as pending, and report "still running" for a check
//     that will never run again.
func commitStatusAsCheck(state string) (status, conclusion string) {
	switch state {
	case "pending":
		return "in_progress", state
	case "error":
		return "completed", "failure"
	default:
		return "completed", state
	}
}

type checkResult struct {
	name       string
	status     string
	conclusion string
}

// deriveCI collapses a set of checks into one word.
//
// Order matters: anything still running means the answer is not in yet, and an
// unfinished check must not be read as a passing one. A set with nothing to say
// is "none", which the console shows as "not reported" — never as success.
func deriveCI(checks []checkResult) CIStatus {
	out := CIStatus{State: CINone, Total: len(checks)}
	for _, c := range checks {
		if c.status != "completed" {
			out.Pending++
			continue
		}
		switch c.conclusion {
		case "success", "skipped", "neutral":
			out.Passed++
		case "failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale":
			out.Failed++
			out.Failing = append(out.Failing, c.name)
		default:
			// An unrecognized conclusion is not evidence of success.
			out.Pending++
		}
	}
	switch {
	case out.Total == 0:
		out.State = CINone
	case out.Pending > 0:
		out.State = CIPending
	case out.Failed > 0:
		out.State = CIFailure
	default:
		out.State = CISuccess
	}
	return out
}

// escapeQuery percent-encodes a query value. It walks bytes rather than runes so
// that a multi-byte character becomes its UTF-8 encoding, which is what a
// percent-encoded query parameter means; encoding the rune's code point instead
// would produce a value that decodes to something else.
//
// ":" and "/" are legal unescaped in a query, and leaving them alone keeps the
// `head=owner:kin/task/1/g1` filter readable in logs.
func escapeQuery(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9',
			c == '-', c == '_', c == '.', c == '~', c == ':', c == '/':
			b.WriteByte(c)
		default:
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

func firstLine(body []byte) string {
	s := strings.TrimSpace(string(body))
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	if len(s) > 200 {
		s = s[:200]
	}
	return s
}

// errBothFailed keeps the preferred source's error, which is the one that
// explains the machine rather than the fallback.
var errBothFailed = errors.New("neither credential source could answer")
