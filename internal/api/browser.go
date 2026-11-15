package api

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/vuuihc/openkin/internal/browserworker"
	"github.com/vuuihc/openkin/internal/store"
)

// handleBrowserAction attaches one structured Playwright action to an
// existing task. The worker blocks only this request; approval updates are
// broadcast through the normal task bus while it waits.
func (s *Server) handleBrowserAction(w http.ResponseWriter, r *http.Request) {
	if s.Browser == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "browser worker is not configured",
		})
		return
	}

	var raw json.RawMessage
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&raw); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	var action browserworker.Action
	if err := json.Unmarshal(raw, &action); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid browser action"})
		return
	}
	if action.Type == "" {
		var envelope struct {
			Action browserworker.Action `json:"action"`
		}
		if err := json.Unmarshal(raw, &envelope); err != nil || envelope.Action.Type == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "browser action type is required"})
			return
		}
		action = envelope.Action
	}

	taskID := chi.URLParam(r, "id")
	if err := s.Browser.Execute(r.Context(), taskID, action); err != nil {
		switch {
		case errors.Is(err, store.ErrNotFound):
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "task not found"})
		case errors.Is(err, browserworker.ErrTaskBusy):
			writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		default:
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"task_id": taskID,
		"status":  "completed",
	})
}
