package api

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/task"
)

func (s *Server) handleListWorkerSteps(w http.ResponseWriter, r *http.Request) {
	taskID := chi.URLParam(r, "id")
	if _, err := s.Store.GetTask(r.Context(), taskID); errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	} else if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	steps, err := s.Store.ListWorkerSteps(r.Context(), taskID, r.URL.Query().Get("execution_id"))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if steps == nil {
		steps = []store.WorkerStep{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"steps": steps})
}

// handleCancelWorkerStep stops one delegated worker and leaves its task
// running. The step identity is the pair the plan table exposes: the run's
// execution id and the zero-based plan index. A step that ended without being
// stopped is a conflict rather than a no-op, because the caller is looking at
// a row it believes is live and should re-read it; asking twice for the same
// stop succeeds, because the step is already doing what was asked.
func (s *Server) handleCancelWorkerStep(w http.ResponseWriter, r *http.Request) {
	taskID := chi.URLParam(r, "id")
	executionID := chi.URLParam(r, "execution_id")
	stepIndex, err := strconv.Atoi(chi.URLParam(r, "step_index"))
	if err != nil || stepIndex < 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid step index"})
		return
	}
	// A task that does not exist is a 404, not "that worker is not running":
	// the caller is pointing at something that is not there, which is a
	// different mistake from a step that already settled.
	if _, err := s.Store.GetTask(r.Context(), taskID); errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	} else if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	err = s.Engine.CancelWorkerStep(r.Context(), taskID, executionID, stepIndex)
	switch {
	case err == nil:
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, task.ErrWorkerStepNotRunning):
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
	default:
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
	}
}
