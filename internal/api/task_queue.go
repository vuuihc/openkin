package api

import (
	"encoding/json"
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
	// Position is the delivery order: lower goes first, the id breaks a tie.
	// It is an ordering key, not an index -- a delivered prompt leaves a hole.
	Position int64 `json:"position"`
}

func queuedPromptEntries(pending []store.PendingPrompt) []queuedPromptEntry {
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
			Position:       p.Position,
		})
	}
	return entries
}

// handleListQueuedPrompts is GET /api/tasks/{id}/prompts: the messages accepted
// for this task that are still waiting for a turn, in delivery order.
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
	writeJSON(w, http.StatusOK, queuedPromptEntries(pending))
}

// handleUpdateQueuedPromptOrder is PUT /api/tasks/{id}/prompts/order: state
// which queued message the agent answers next.
//
// The body names every currently queued id, once, in the wanted delivery order.
// Order belongs to the daemon because the pop is what decides the next message
// the agent answers; a console-only arrangement would be a lie. The 200 is the
// whole queue in the GET shape, not a delta: a list applied to a queue that
// changed in between would compose an order that never existed, so the caller
// replaces its copy with this answer.
//
// No transcript event is written: the messages already exist and their wording
// does not change. The console already re-reads the queue when events land and
// polls while the task runs, so a reorder converges without a new event type.
//
// Every failure comes from the store's typed answer rather than a second read
// here, because a turn boundary can deliver the head between any read and the
// write: 400 for a list that cannot express an order, 404 for an unknown task,
// and 409 for a list that is not exactly the current queue. A delivered id and
// a never-queued id are the same observable state once the row is gone, so one
// stale-list code covers both and the client refetches.
func (s *Server) handleUpdateQueuedPromptOrder(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body struct {
		IDs *[]int64 `json:"ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.IDs == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid order"})
		return
	}
	pending, err := s.Store.SetPendingPromptOrder(r.Context(), id, *body.IDs)
	switch {
	case errors.Is(err, store.ErrPromptOrderInvalid):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid order"})
	case errors.Is(err, store.ErrNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
	case errors.Is(err, store.ErrConflict):
		writeJSON(w, http.StatusConflict, map[string]string{"error": "not the current queue"})
	case err != nil:
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
	default:
		writeJSON(w, http.StatusOK, queuedPromptEntries(pending))
	}
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
