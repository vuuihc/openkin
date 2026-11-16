package api

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/vuuihc/openkin/internal/store"
)

// queuedPromptEntry is one item in GET /api/tasks/{id}/prompts.
//
// The message itself is already in the transcript: it was written there when it
// was accepted, and `user_seq` is what ties this row to that message. A message
// whose seq is still listed here has not been answered yet, which is the whole
// state a client needs -- and the reason the queue is read rather than the
// transcript being rewritten, since events do not change once written.
type queuedPromptEntry struct {
	ID             int64   `json:"id"`
	Prompt         string  `json:"prompt"`
	Agent          string  `json:"agent,omitempty"`
	Model          *string `json:"model,omitempty"`
	PermissionMode *string `json:"permission_mode,omitempty"`
	UserSeq        int     `json:"user_seq"`
	QueuedAt       int64   `json:"queued_at"`
}

// handleListQueuedPrompts is GET /api/tasks/{id}/prompts: the messages accepted
// for this task that are still waiting for a turn, oldest first.
func (s *Server) handleListQueuedPrompts(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if _, err := s.Engine.Get(r.Context(), id); errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	} else if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	pending, err := s.Store.ListPendingPrompts(r.Context(), id)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	entries := make([]queuedPromptEntry, 0, len(pending))
	for _, p := range pending {
		entries = append(entries, queuedPromptEntry{
			ID:             p.ID,
			Prompt:         p.Prompt,
			Agent:          p.Agent,
			Model:          p.Model,
			PermissionMode: p.PermissionMode,
			UserSeq:        p.UserSeq,
			QueuedAt:       p.QueuedAt,
		})
	}
	writeJSON(w, http.StatusOK, entries)
}

// handleDeleteQueuedPrompt is DELETE /api/tasks/{id}/prompts/{promptID}: take a
// message back before it is delivered.
//
// This is the one edit the queue allows. A message that has not started yet is
// still the sender's to withdraw — a typo seen on the phone, a thought that
// changed, something pasted into the wrong task — and until now the only way out
// was cancelling the task, which drops everything queued with it.
//
// A prompt that already ran, or that another device withdrew first, answers 404:
// the row is gone either way, and the console refetches the queue from the same
// response path it already polls. The store writes the transcript note in the
// same transaction; this publishes it.
func (s *Server) handleDeleteQueuedPrompt(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	promptID, err := strconv.ParseInt(chi.URLParam(r, "promptID"), 10, 64)
	if err != nil || promptID <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid prompt id"})
		return
	}
	note, removed, err := s.Store.WithdrawPendingPrompt(r.Context(), id, promptID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if !removed {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not queued"})
		return
	}
	if note != nil {
		s.Engine.Bus().PublishEvent(*note)
	}
	w.WriteHeader(http.StatusNoContent)
}
