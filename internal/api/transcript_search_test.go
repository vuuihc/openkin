package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/vuuihc/openkin/internal/store"
)

func seedTranscriptMessage(t *testing.T, s *Server, taskID, title, role, text string) {
	t.Helper()
	ctx := context.Background()
	if err := s.Store.InsertTask(ctx, store.Task{
		ID: taskID, Title: title, Agent: "claude-code", Cwd: "/tmp", Prompt: "p",
		Status: "finished", CreatedAt: store.NowMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(map[string]any{
		"role":    role,
		"content": []map[string]any{{"type": "text", "text": text}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Store.AppendEvent(ctx, taskID, "message", payload); err != nil {
		t.Fatal(err)
	}
}

func searchTranscript(t *testing.T, s *Server, token, query string) (*httptest.ResponseRecorder, transcriptSearchResponse) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/search/transcript"+query, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rr := httptest.NewRecorder()
	s.Handler().ServeHTTP(rr, req)
	var body transcriptSearchResponse
	if rr.Code == http.StatusOK {
		if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode %s: %v", rr.Body.String(), err)
		}
	}
	return rr, body
}

func TestSearchTranscriptAnswersWithProse(t *testing.T) {
	s, token := newTestServer(t)
	seedTranscriptMessage(t, s, "task-search", "Deploy notes", "assistant",
		"The RELEASE_TOKEN rotates every Monday.")

	rr, body := searchTranscript(t, s, token, "?q=release_token")
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d body %s", rr.Code, rr.Body.String())
	}
	if len(body.Matches) != 1 || body.Truncated {
		t.Fatalf("body = %+v", body)
	}
	hit := body.Matches[0]
	if hit.TaskID != "task-search" || hit.TaskTitle != "Deploy notes" || hit.Role != "assistant" {
		t.Fatalf("hit = %+v", hit)
	}
	if !strings.Contains(hit.Snippet, "RELEASE_TOKEN rotates") {
		t.Fatalf("snippet = %q", hit.Snippet)
	}
}

func TestSearchTranscriptWithoutAMatchIsAnEmptyList(t *testing.T) {
	s, token := newTestServer(t)
	seedTranscriptMessage(t, s, "task-search", "t", "user", "nothing to see")

	rr, body := searchTranscript(t, s, token, "?q=absent_token")
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d", rr.Code)
	}
	// `[]`, not `null`: the console maps over it.
	if !strings.Contains(rr.Body.String(), `"matches":[]`) {
		t.Fatalf("body = %s", rr.Body.String())
	}
	if len(body.Matches) != 0 {
		t.Fatalf("matches = %+v", body.Matches)
	}
}

func TestSearchTranscriptRefusesBadQueries(t *testing.T) {
	s, token := newTestServer(t)
	cases := []struct{ name, query string }{
		{"missing", ""},
		{"blank", "?q=%20%20"},
		{"too long", "?q=" + strings.Repeat("a", maxTranscriptQuery+1)},
		{"control character", "?q=two%0Awords"},
		{"nul character", "?q=two%00words"},
		{"bad limit", "?q=ok&limit=many"},
		{"negative limit", "?q=ok&limit=-1"},
		{"zero limit", "?q=ok&limit=0"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rr, _ := searchTranscript(t, s, token, tc.query)
			if rr.Code != http.StatusBadRequest {
				t.Fatalf("status = %d body %s", rr.Code, rr.Body.String())
			}
		})
	}
}

func TestSearchTranscriptNeedsAuth(t *testing.T) {
	s, _ := newTestServer(t)
	rr, _ := searchTranscript(t, s, "", "?q=anything")
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d", rr.Code)
	}
}

func TestSearchTranscriptCapsAndSaysSo(t *testing.T) {
	s, token := newTestServer(t)
	for i := 0; i < 3; i++ {
		seedTranscriptMessage(t, s, "task-"+strings.Repeat("a", i+1), "t", "user", "CAP_TOKEN here")
	}

	_, body := searchTranscript(t, s, token, "?q=CAP_TOKEN&limit=2")
	if len(body.Matches) != 2 || !body.Truncated {
		t.Fatalf("body = %+v", body)
	}
}

// The cap counts characters, not bytes: a query in Chinese must not be refused
// for being three bytes a character.
func TestSearchTranscriptCountsRunesNotBytes(t *testing.T) {
	s, token := newTestServer(t)
	seedTranscriptMessage(t, s, "task-search", "t", "user", "CAP_TOKEN here")

	allowed := url.QueryEscape(strings.Repeat("中", maxTranscriptQuery))
	rr, _ := searchTranscript(t, s, token, "?q="+allowed)
	if rr.Code != http.StatusOK {
		t.Fatalf("200 characters: status = %d body %s", rr.Code, rr.Body.String())
	}

	refused := url.QueryEscape(strings.Repeat("中", maxTranscriptQuery+1))
	rr, _ = searchTranscript(t, s, token, "?q="+refused)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("201 characters: status = %d body %s", rr.Code, rr.Body.String())
	}
}

// The scope is read from the request, not remembered from the store: a request
// with no principal — one that never passed the auth middleware — must match
// nothing rather than the whole library.
func TestSearchTranscriptReadsTheScopeFromTheRequest(t *testing.T) {
	s, _ := newTestServer(t)
	seedTranscriptMessage(t, s, "task-search", "t", "user", "SCOPE_TOKEN here")

	rr := httptest.NewRecorder()
	s.handleSearchTranscript(rr, httptest.NewRequest(http.MethodGet, "/api/search/transcript?q=SCOPE_TOKEN", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d body %s", rr.Code, rr.Body.String())
	}
	var body transcriptSearchResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Matches) != 0 {
		t.Fatalf("an unscoped request read the library: %+v", body.Matches)
	}
}
