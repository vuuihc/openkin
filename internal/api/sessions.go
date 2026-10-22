package api

import (
	"net/http"
	"strconv"

	"github.com/vuuihc/openkin/internal/store"
)

// handleListSessions serves the global change feed.
//
// This is how a client that has been away catches up: it sends the cursor it
// last saw and gets back only what changed, in order, with the cursor to send
// next time. Without updated_since it returns the history from the beginning,
// oldest first, which is also how a client builds its first snapshot — paging
// until has_more is false.
//
// It is deliberately not the same endpoint as GET /api/tasks. That one answers
// "show me my tasks" with filters, search, and most-recent-first ordering; this
// one answers "what changed", which has exactly one correct order and must not
// be filtered by anything, or a filtered-out change would advance the cursor
// past a task the client never learned about.
func (s *Server) handleListSessions(w http.ResponseWriter, r *http.Request) {
	if s.Store == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "store unavailable"})
		return
	}
	q := r.URL.Query()
	var since int64
	if raw := q.Get("updated_since"); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || parsed < 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid updated_since"})
			return
		}
		since = parsed
	}
	limit := 0
	if raw := q.Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid limit"})
			return
		}
		limit = parsed
	}
	page, err := s.Store.ListTaskChangesSince(r.Context(), since, limit)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if page.Tasks == nil {
		page.Tasks = []store.Task{}
	}
	if page.Deleted == nil {
		page.Deleted = []string{}
	}
	writeJSON(w, http.StatusOK, page)
}
