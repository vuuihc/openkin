package github

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

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
	// Reviews is the JSON array of {author, state, body} the last reviews read
	// returned, oldest first. It is an answer only when ReviewsRead is set:
	// empty with ReviewsRead false means the read failed, or was never asked,
	// which is a different fact from an empty array. A failed read leaves the
	// observation's previous array in place rather than reporting "none".
	Reviews string
	// ReviewsRead reports that Reviews holds an answer from the forge.
	ReviewsRead bool
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

// headerRunner is a transport that can also report a response's Link header.
//
// Everything that reads a single object is happy with a body, so the extra
// capability is a second interface rather than a change to apiRunner: a
// transport that cannot report the header still answers the reviews read, one
// page deep. Both real transports can.
type headerRunner interface {
	apiGetWithHeaders(ctx context.Context, path string, query [][2]string) ([]byte, string, error)
}

// getWithHeaders asks for a body and, when the transport can, the Link header
// that names the other pages of a list.
func getWithHeaders(ctx context.Context, runner apiRunner, path string, query [][2]string) ([]byte, string, error) {
	if h, ok := runner.(headerRunner); ok {
		return h.apiGetWithHeaders(ctx, path, query)
	}
	body, err := runner.apiGet(ctx, path, query)
	return body, "", err
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
	body, _, err := r.apiGetWithHeaders(ctx, path, query)
	return body, err
}

// apiGetWithHeaders is apiGet plus the response's Link header, which is the
// only place GitHub names the other pages of a list.
func (r *httpReader) apiGetWithHeaders(ctx context.Context, path string, query [][2]string) ([]byte, string, error) {
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
		return nil, "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	// GitHub rejects requests without a User-Agent.
	req.Header.Set("User-Agent", "openkin")

	resp, err := r.client.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	// Bounded: a pull request payload is kilobytes, and the body of a failure
	// is worth reading only far enough to explain it.
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, "", err
	}
	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		return body, resp.Header.Get("Link"), nil
	case resp.StatusCode == http.StatusNotFound:
		return nil, "", fmt.Errorf("%w: GET %s", ErrNotFound, path)
	case resp.StatusCode == http.StatusUnauthorized:
		return nil, "", fmt.Errorf("%w: GET %s", ErrNotAuthenticated, path)
	case resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusTooManyRequests:
		// A secondary rate limit also lands on 403, so the header is what
		// distinguishes "slow down" from "you may not read this".
		if resp.Header.Get("X-RateLimit-Remaining") == "0" || resp.StatusCode == http.StatusTooManyRequests {
			return nil, "", fmt.Errorf("%w: GET %s", ErrRateLimited, path)
		}
		return nil, "", fmt.Errorf("github refused GET %s: %s", path, firstLine(body))
	default:
		return nil, "", fmt.Errorf("GET %s: HTTP %d: %s", path, resp.StatusCode, firstLine(body))
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

// apiGetWithHeaders asks gh to print the response headers too. That is the only
// way this transport can see the Link header, because gh's JSON output is the
// body alone.
func (r ghReader) apiGetWithHeaders(ctx context.Context, path string, query [][2]string) ([]byte, string, error) {
	args := []string{"api", "--method", "GET", "--include", strings.TrimPrefix(path, "/")}
	for _, kv := range query {
		args = append(args, "-f", kv[0]+"="+kv[1])
	}
	out, err := r.client.Run(ctx, args...)
	if err != nil {
		return nil, "", err
	}
	body, link := splitGHHeaders(out)
	return body, link, nil
}

// splitGHHeaders separates the header block `gh api --include` prints from the
// body and returns the Link header, if any.
//
// gh prints what the HTTP response carried, so the separator is CRLF; a version
// that printed LF would be a formatting change, not a different answer, and
// both are accepted. Output that does not start with a status line is body only
// — the command answered, and losing the body over a missing header block would
// turn a readable answer into a failed read.
func splitGHHeaders(out []byte) (body []byte, link string) {
	if !bytes.HasPrefix(out, []byte("HTTP/")) {
		return out, ""
	}
	for _, sep := range [][]byte{[]byte("\r\n\r\n"), []byte("\n\n")} {
		i := bytes.Index(out, sep)
		if i < 0 {
			continue
		}
		for _, line := range strings.Split(string(out[:i]), "\n") {
			line = strings.TrimRight(line, "\r")
			name, value, ok := strings.Cut(line, ":")
			if ok && strings.EqualFold(strings.TrimSpace(name), "Link") {
				link = strings.TrimSpace(value)
			}
		}
		return out[i+len(sep):], link
	}
	return out, ""
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

	// The pull request itself was read successfully; only its checks may not
	// have been. Reporting it with an unknown CI state is more useful than
	// discarding a good answer, and the console renders "none" as "not
	// reported" rather than as success.
	if ci, err := readCI(ctx, runner, repo, pr.Head.SHA); err == nil {
		out.CI = ci
	}
	// The reviews are a second question about a thing that exists, and one a
	// failed check read does not make unreadable. A reviews read that fails is
	// not a reviews answer: ReviewsRead stays false, and the writer leaves the
	// previous array in place rather than reporting "none".
	if reviews, err := readReviews(ctx, runner, repo, pr.Number); err == nil {
		out.Reviews = reviews
		out.ReviewsRead = true
	}
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

// Bounds on one snapshot of reviews. The payload is untrusted input — anyone
// who can review the pull request controls its text — so the boundary is where
// it is cut down, not the renderer.
const (
	maxReviews      = 20
	maxReviewAuthor = 100
	maxReviewBody   = 4000
)

// apiReview mirrors the fields this package reads from GitHub's review payload.
type apiReview struct {
	User struct {
		Login string `json:"login"`
	} `json:"user"`
	State string `json:"state"`
	Body  string `json:"body"`
}

// review is one review as the observation stores it. The state is the forge's
// word, not a Kin verdict; a word this build does not know is stored as
// UNKNOWN, which the panel renders as a neutral review.
type review struct {
	Author string `json:"author"`
	State  string `json:"state"`
	Body   string `json:"body"`
}

// readReviews reads a pull request's reviews into the JSON array the
// observation stores, or returns an error that leaves the previous array (or
// ”) in place.
//
// GitHub returns reviews oldest first, so the first page of a long history is
// the oldest one. per_page=100 asks for as much as one page holds, and the
// response's rel="last" link names the newest page, which is where "the newest
// twenty" lives. A transport that cannot report the Link header answers with
// the page it was given; that page is stored as it is and never relabelled
// "newest".
func readReviews(ctx context.Context, runner apiRunner, repo Repo, number int) (string, error) {
	path := fmt.Sprintf("/repos/%s/%s/pulls/%d/reviews", repo.Owner, repo.Name, number)
	body, link, err := getWithHeaders(ctx, runner, path, [][2]string{{"per_page", "100"}})
	if err != nil {
		return "", err
	}
	var raw []apiReview
	if err := json.Unmarshal(body, &raw); err != nil {
		return "", fmt.Errorf("decode reviews: %w", err)
	}
	if last := linkRel(link, "last"); last != "" {
		// Page one is the page already in hand; following a link back to it
		// would spend a request to learn nothing.
		if page := pageOf(last); page > 1 {
			query := [][2]string{{"per_page", "100"}, {"page", strconv.Itoa(page)}}
			pageBody, _, pageErr := getWithHeaders(ctx, runner, path, query)
			if pageErr != nil {
				// The newest page was named and could not be read. Answering
				// with the first page would store the oldest reviews as the
				// newest, so the read fails and the previous array stands.
				return "", pageErr
			}
			if err := json.Unmarshal(pageBody, &raw); err != nil {
				return "", fmt.Errorf("decode reviews: %w", err)
			}
		}
	}
	out, err := json.Marshal(newestReviews(raw, maxReviews))
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// newestReviews keeps the newest n of a list the forge returned oldest first,
// preserving their relative order, and bounds the text each one carries.
func newestReviews(raw []apiReview, n int) []review {
	if len(raw) > n {
		raw = raw[len(raw)-n:]
	}
	out := make([]review, 0, len(raw))
	for _, r := range raw {
		state := r.State
		switch state {
		case "APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING":
		default:
			// Never infer approval — or anything else — from a word this build
			// does not know.
			state = "UNKNOWN"
		}
		out = append(out, review{
			Author: boundRunes(r.User.Login, maxReviewAuthor),
			State:  state,
			Body:   boundRunes(r.Body, maxReviewBody),
		})
	}
	return out
}

// boundRunes truncates s to at most max runes, keeping the head and cutting at
// a rune boundary so the stored text stays valid UTF-8.
func boundRunes(s string, max int) string {
	if max <= 0 || utf8.RuneCountInString(s) <= max {
		return s
	}
	n := 0
	for i := range s {
		if n == max {
			return s[:i]
		}
		n++
	}
	return s
}

// linkRel returns the URL a Link header gives for one relation, or "".
//
// The header is a comma-separated list of <url>; rel="name" pairs. Parsing it
// rather than searching for the relation name keeps a URL that happens to
// contain `rel="last"` from being taken for the relation itself.
func linkRel(header, rel string) string {
	for _, part := range strings.Split(header, ",") {
		fields := strings.Split(part, ";")
		if len(fields) < 2 {
			continue
		}
		target := strings.TrimSpace(fields[0])
		if !strings.HasPrefix(target, "<") || !strings.HasSuffix(target, ">") {
			continue
		}
		target = target[1 : len(target)-1]
		for _, f := range fields[1:] {
			name, value, ok := strings.Cut(strings.TrimSpace(f), "=")
			if !ok || !strings.EqualFold(strings.TrimSpace(name), "rel") {
				continue
			}
			if strings.Trim(strings.TrimSpace(value), `"`) == rel {
				return target
			}
		}
	}
	return ""
}

// pageOf returns the page number a GitHub list URL points at, zero when it
// names none.
func pageOf(raw string) int {
	u, err := url.Parse(raw)
	if err != nil {
		return 0
	}
	n, err := strconv.Atoi(u.Query().Get("page"))
	if err != nil || n <= 0 {
		return 0
	}
	return n
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
