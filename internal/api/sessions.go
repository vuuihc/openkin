package api

import (
	"net/http"
	"strconv"

	"github.com/vuuihc/openkin/internal/store"
)

// handleSessionCursor returns the current end of the change feed.
//
// A client reads this before it builds its first snapshot from the ordinary list
// endpoints, so that everything it then hears about is either newer than the
// snapshot or already in it. Taking it here rather than after the snapshot is
// the whole point: the failure mode of the other order is a change that arrives
// while the snapshot is in flight and is never delivered at all.
func (s *Server) handleSessionCursor(w http.ResponseWriter, r *http.Request) {
	if s.Store == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "store unavailable"})
		return
	}
	cursor, err := s.Store.CurrentHubSeq(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]int64{"cursor": cursor})
}

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
// one answers "what changed", which has exactly one correct order and takes no
// user-facing filter at all — a change the caller narrowed away would still
// advance the cursor, and the client would never learn about the task it
// skipped.
//
// The account scope is the one narrowing that belongs here, because it is not a
// preference about which changes to show: a change outside the scope is one the
// caller is not allowed to have, so stepping the cursor over it is the point
// rather than a bug.
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
	page, err := s.Store.ListTaskChangesSince(r.Context(), since, limit, taskScope(r))
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
