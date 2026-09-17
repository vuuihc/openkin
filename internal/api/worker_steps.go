package api

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/vuuihc/openkin/internal/store"
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
