package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/oklog/ulid/v2"

	"github.com/vuuihc/kin/internal/store"
	"github.com/vuuihc/kin/internal/task"
)

type createRoutineBody struct {
	Title          string `json:"title"`
	ProjectID      string `json:"project_id"`
	Cwd            string `json:"cwd"`
	Agent          string `json:"agent"`
	PermissionMode string `json:"permission_mode"`
	Prompt         string `json:"prompt"`
	IntervalSecs   int64  `json:"interval_secs"`
	Enabled        *bool  `json:"enabled"`
	// NextDueAt optional; default = now (fires on next tick / run-now).
	NextDueAt *int64 `json:"next_due_at"`
}

type patchRoutineBody struct {
	Title          *string `json:"title"`
	ProjectID      *string `json:"project_id"`
	Cwd            *string `json:"cwd"`
	Agent          *string `json:"agent"`
	PermissionMode *string `json:"permission_mode"`
	Prompt         *string `json:"prompt"`
	IntervalSecs   *int64  `json:"interval_secs"`
	Enabled        *bool   `json:"enabled"`
	NextDueAt      *int64  `json:"next_due_at"`
}

func (s *Server) handleListRoutines(w http.ResponseWriter, r *http.Request) {
	opts := store.ListRoutinesOpts{ProjectID: r.URL.Query().Get("project_id")}
	if v := r.URL.Query().Get("enabled"); v != "" {
		b := v == "1" || strings.EqualFold(v, "true")
		opts.Enabled = &b
	}
	if lim := r.URL.Query().Get("limit"); lim != "" {
		if n, err := strconv.Atoi(lim); err == nil {
			opts.Limit = n
		}
	}
	list, err := s.Store.ListRoutines(r.Context(), opts)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if list == nil {
		list = []store.Routine{}
	}
	// Optional: include recent runs feed when ?runs=1
	if r.URL.Query().Get("runs") == "1" {
		limit := 50
		if lim := r.URL.Query().Get("runs_limit"); lim != "" {
			if n, err := strconv.Atoi(lim); err == nil && n > 0 {
				limit = n
			}
		}
		runs, err := s.Store.ListTasks(r.Context(), store.ListTasksOpts{RoutineID: "*", Limit: limit})
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		if runs == nil {
			runs = []store.Task{}
		}
		writeJSON(w, http.StatusOK, map[string]any{"routines": list, "runs": runs})
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) handleCreateRoutine(w http.ResponseWriter, r *http.Request) {
	var body createRoutineBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	body.Cwd = strings.TrimSpace(body.Cwd)
	body.Prompt = strings.TrimSpace(body.Prompt)
	if body.Cwd == "" || body.Prompt == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "cwd and prompt are required"})
		return
	}
	if body.IntervalSecs <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "interval_secs must be > 0"})
		return
	}
	now := time.Now().UnixMilli()
	enabled := true
	if body.Enabled != nil {
		enabled = *body.Enabled
	}
	next := now
	if body.NextDueAt != nil && *body.NextDueAt > 0 {
		next = *body.NextDueAt
	}
	agent := strings.TrimSpace(body.Agent)
	if agent == "" {
		agent = "kin"
	}
	perm := strings.TrimSpace(body.PermissionMode)
	if perm == "" {
		perm = "default"
	}
	projectID := strings.TrimSpace(body.ProjectID)
	if projectID == "" {
		if resolved, err := s.Store.ResolveProjectIDForCwd(r.Context(), body.Cwd); err == nil {
			projectID = resolved
		}
	}
	title := strings.TrimSpace(body.Title)
	if title == "" {
		// Truncate prompt as fallback title.
		runes := []rune(body.Prompt)
		if len(runes) > 48 {
			title = string(runes[:48]) + "…"
		} else {
			title = body.Prompt
		}
	}
	rec := store.Routine{
		ID:             ulid.Make().String(),
		ProjectID:      projectID,
		Cwd:            body.Cwd,
		Agent:          agent,
		PermissionMode: perm,
		Prompt:         body.Prompt,
		IntervalSecs:   body.IntervalSecs,
		Enabled:        enabled,
		NextDueAt:      next,
		CreatedAt:      now,
		Title:          title,
	}
	if err := s.Store.InsertRoutine(r.Context(), rec); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, rec)
}

func (s *Server) handleGetRoutine(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	rec, err := s.Store.GetRoutine(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, rec)
}

func (s *Server) handlePatchRoutine(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body patchRoutineBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if body.IntervalSecs != nil && *body.IntervalSecs <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "interval_secs must be > 0"})
		return
	}
	patch := store.RoutinePatch{
		Title:          body.Title,
		ProjectID:      body.ProjectID,
		Cwd:            body.Cwd,
		Agent:          body.Agent,
		PermissionMode: body.PermissionMode,
		Prompt:         body.Prompt,
		IntervalSecs:   body.IntervalSecs,
		Enabled:        body.Enabled,
		NextDueAt:      body.NextDueAt,
	}
	if err := s.Store.UpdateRoutine(r.Context(), id, patch); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	rec, err := s.Store.GetRoutine(r.Context(), id)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, rec)
}

func (s *Server) handleDeleteRoutine(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := s.Store.DeleteRoutine(r.Context(), id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleRunRoutineNow(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	rec, err := s.Store.GetRoutine(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if s.Engine == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "engine unavailable"})
		return
	}
	prompt := rec.Prompt
	if !strings.Contains(prompt, "noteworthy:") {
		prompt = prompt + task.ReportSignalTrailer
	}
	title := rec.Title
	if title == "" {
		title = "Routine"
	}
	titlePtr := title
	t, err := s.Engine.Create(r.Context(), task.CreateRequest{
		Agent:          rec.Agent,
		Cwd:            rec.Cwd,
		Prompt:         prompt,
		Title:          &titlePtr,
		PermissionMode: rec.PermissionMode,
		ProjectID:      rec.ProjectID,
		RoutineID:      rec.ID,
		UserPrompt:     rec.Prompt,
	})
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	// Manual run does not advance next_due_at (schedule stays intact).
	now := time.Now().UnixMilli()
	_ = s.Store.UpdateRoutine(r.Context(), rec.ID, store.RoutinePatch{LastRunAt: &now})
	writeJSON(w, http.StatusCreated, t)
}

func (s *Server) handleRoutineUnreadCount(w http.ResponseWriter, r *http.Request) {
	n, err := s.Store.CountUnreadRoutineRuns(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"count": n})
}

func (s *Server) handleMarkRoutineRunRead(w http.ResponseWriter, r *http.Request) {
	taskID := chi.URLParam(r, "taskID")
	if err := s.Store.MarkRoutineRunRead(r.Context(), taskID); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	t, err := s.Store.GetTask(r.Context(), taskID)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
		return
	}
	writeJSON(w, http.StatusOK, t)
}

func (s *Server) handleMarkAllRoutineRunsRead(w http.ResponseWriter, r *http.Request) {
	n, err := s.Store.MarkAllRoutineRunsRead(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"marked": n})
}
