package api

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/vuuihc/openkin/internal/store"
)

// maxTranscriptQuery bounds the query in runes. A search box is read at a
// glance; a paragraph pasted into it is not a question about the transcript.
// Runes, not bytes: a 200-byte cap would refuse sixty-seven Chinese characters.
const maxTranscriptQuery = 200

// transcriptSearchTimeout keeps one search from holding the store's single
// connection while a reader waits.
const transcriptSearchTimeout = 3 * time.Second

type transcriptSearchResponse struct {
	Matches   []store.TranscriptHit `json:"matches"`
	Truncated bool                  `json:"truncated"`
}

// handleSearchTranscript answers which messages in the library contain a few
// characters.
//
// The console searches session titles and prompts through `/api/tasks?q=`; this
// is the other half — what the agent and the person actually said to each
// other. The store decodes the message payloads and returns prose, so the
// answer is a list a person can read, not JSON to parse.
//
// It is scoped like the task list: on a Hub with more than one account, a
// search must not become a way to read someone else's conversations. An empty
// query is refused rather than answered with everything.
func (s *Server) handleSearchTranscript(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	query := strings.TrimSpace(q.Get("q"))
	if query == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "q is required"})
		return
	}
	if utf8.RuneCountInString(query) > maxTranscriptQuery {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "q exceeds 200 characters",
		})
		return
	}
	// The store matches with a substring test, so the only characters that can
	// do harm are the ones a log line or a terminal would choke on. A control
	// character in a search box is never prose.
	for _, r := range query {
		if unicode.IsControl(r) {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error": "q contains a control character",
			})
			return
		}
	}
	limit := 20
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 {
			// Zero is not "no rows": the store would read it as "unset" and
			// answer with the default page, which is the opposite of the ask.
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid limit"})
			return
		}
		limit = n
	}
	if s.Store == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "store unavailable"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), transcriptSearchTimeout)
	defer cancel()
	matches, truncated, err := s.Store.SearchTranscript(ctx, store.TranscriptSearchOpts{
		Query: query,
		Limit: limit,
		Scope: taskScope(r),
	})
	if err != nil {
		// The store holds one connection; a search that ran out of its budget is
		// the daemon's answer to "too much to read", not a server fault.
		if errors.Is(err, context.DeadlineExceeded) {
			writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": "search timed out"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if matches == nil {
		matches = []store.TranscriptHit{}
	}
	writeJSON(w, http.StatusOK, transcriptSearchResponse{Matches: matches, Truncated: truncated})
}
