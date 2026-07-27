package api

import (
	"errors"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/task"
)

// handleRequestWorkspace handles POST /api/tasks/{taskID}/workspace/request
func (s *Server) handleRequestWorkspace(w http.ResponseWriter, r *http.Request) {
	taskID := r.PathValue("taskID")
	if taskID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "task_id is required"})
		return
	}

	var req task.WorkspaceIntentRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	req.TaskID = taskID

	if req.ExecutionID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "execution_id is required"})
		return
	}

	ws, err := s.Engine.RequestWorkspace(r.Context(), req)
	if err != nil {
		if isNotFound(err) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
			return
		}
		if strings.Contains(err.Error(), "state") {
			writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"workspace_id": ws.ID,
		"generation":   ws.Generation,
		"state":        string(ws.State),
	})
}

// handleCompleteWorkspace handles POST /api/tasks/{taskID}/workspace/complete
func (s *Server) handleCompleteWorkspace(w http.ResponseWriter, r *http.Request) {
	taskID := r.PathValue("taskID")
	if taskID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "task_id is required"})
		return
	}

	var req task.WorkspaceIntentRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	req.TaskID = taskID

	if req.ExecutionID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "execution_id is required"})
		return
	}

	ws, err := s.Engine.CompleteWorkspace(r.Context(), req)
	if err != nil {
		if isNotFound(err) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
			return
		}
		if strings.Contains(err.Error(), "state") {
			writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"workspace_id": ws.ID,
		"generation":   ws.Generation,
		"state":        string(ws.State),
	})
}

func isNotFound(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, store.ErrNotFound) {
		return true
	}
	return strings.Contains(err.Error(), "not found")
}
