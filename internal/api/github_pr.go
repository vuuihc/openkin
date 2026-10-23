package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

// handleTaskPR returns the pull-request state for a task's current workspace
// branch.
//
// A task that is not on a GitHub repository, has no workspace yet, or whose
// checkout has since been removed gets an empty snapshot with HTTP 200. Having
// no pull request is the normal state of a session nobody has published, not an
// error, and the console should not have to tell those apart by status code.
//
// A 502 therefore means what it says: the answer could not be assembled — the
// database did not read, or the anchor could not be resolved — rather than that
// there is nothing to report.
func (s *Server) handleTaskPR(w http.ResponseWriter, r *http.Request) {
	if s.GitHub == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "github unavailable"})
		return
	}
	snapshot, err := s.GitHub.SnapshotForTask(r.Context(), chi.URLParam(r, "id"), false)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

// handleRefreshTaskPR forces a query, bypassing the staleness floor.
//
// It is a separate route rather than a query parameter so that the one action
// which spends rate limit is explicit in the route table and can be granted
// separately from reading.
func (s *Server) handleRefreshTaskPR(w http.ResponseWriter, r *http.Request) {
	if s.GitHub == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "github unavailable"})
		return
	}
	snapshot, err := s.GitHub.SnapshotForTask(r.Context(), chi.URLParam(r, "id"), true)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}
