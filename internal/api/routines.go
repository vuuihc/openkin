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

	"github.com/vuuihc/openkin/internal/routines"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/task"
)

type createRoutineBody struct {
	Title     string `json:"title"`
	ProjectID string `json:"project_id"`
	Cwd       string `json:"cwd"`
	Agent     string `json:"agent"`
	// Model is optional; empty means the agent's own default.
	Model           string `json:"model"`
	PermissionMode  string `json:"permission_mode"`
	Prompt          string `json:"prompt"`
	IntervalSecs    int64  `json:"interval_secs"`
	Enabled         *bool  `json:"enabled"`
	MissedRunPolicy string `json:"missed_run_policy"`
	Lane            string `json:"lane"`
	// Recurrence is a wall-clock rule as JSON, empty for an interval routine.
	Recurrence string `json:"recurrence"`
	// NextDueAt optional; default = now (fires on next tick / run-now).
	NextDueAt *int64 `json:"next_due_at"`
}

type patchRoutineBody struct {
	Title           *string `json:"title"`
	ProjectID       *string `json:"project_id"`
	Cwd             *string `json:"cwd"`
	Agent           *string `json:"agent"`
	Model           *string `json:"model"` // "" clears back to the agent default
	PermissionMode  *string `json:"permission_mode"`
	Prompt          *string `json:"prompt"`
	IntervalSecs    *int64  `json:"interval_secs"`
	Enabled         *bool   `json:"enabled"`
	NextDueAt       *int64  `json:"next_due_at"`
	MissedRunPolicy *string `json:"missed_run_policy"`
	Lane            *string `json:"lane"`
	Recurrence      *string `json:"recurrence"`
}

func (s *Server) handleListRoutines(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	opts := store.ListRoutinesOpts{
		ProjectID: q.Get("project_id"),
		Before:    q.Get("cursor"),
		Query:     q.Get("q"),
	}
	if v := q.Get("enabled"); v != "" {
		b := v == "1" || strings.EqualFold(v, "true")
		opts.Enabled = &b
	}
	if lim := q.Get("limit"); lim != "" {
		if n, err := strconv.Atoi(lim); err == nil {
			opts.Limit = n
		}
	}
	page, err := s.Store.ListRoutinesPage(r.Context(), opts)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if page.Routines == nil {
		page.Routines = []store.Routine{}
	}
	// Optional: include recent runs feed when ?runs=1
	if q.Get("runs") == "1" {
		limit := 50
		if lim := r.URL.Query().Get("runs_limit"); lim != "" {
			if n, err := strconv.Atoi(lim); err == nil && n > 0 {
				limit = n
			}
		}
		runs, err := s.Store.ListTasks(r.Context(), store.ListTasksOpts{RoutineID: "*", Limit: limit, Scope: taskScope(r)})
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		if runs == nil {
			runs = []store.Task{}
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"routines": page.Routines, "runs": runs,
			"next_cursor": page.NextCursor, "has_more": page.HasMore,
		})
		return
	}
	// Preserve the original array response for legacy clients that do not opt
	// into the cursor contract. New clients send page=1 or a cursor.
	if q.Get("page") == "" && q.Get("cursor") == "" && q.Get("q") == "" {
		writeJSON(w, http.StatusOK, page.Routines)
		return
	}
	writeJSON(w, http.StatusOK, page)
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
	recurrence, err := routines.ParseRecurrence(body.Recurrence)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	intervalSecs := body.IntervalSecs
	if recurrence != nil && intervalSecs <= 0 {
		// A wall-clock routine's pace is the rule's own period. Asking the
		// user for an interval they will never see honoured would be noise.
		intervalSecs = recurrence.NominalIntervalSeconds(time.Now())
	}
	if intervalSecs <= 0 {
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
	} else if recurrence != nil {
		// The first run is the rule's next occurrence, not "as soon as the
		// scheduler looks": creating a weekday-morning routine on a Tuesday
		// afternoon must not run it on Tuesday afternoon.
		at, ok := recurrence.Next(time.UnixMilli(now))
		if !ok {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "recurrence has no future occurrence"})
			return
		}
		next = at.UnixMilli()
	}
	agent := strings.TrimSpace(body.Agent)
	if agent == "" {
		agent = "kin"
	}
	perm := strings.TrimSpace(body.PermissionMode)
	if perm == "" {
		perm = "default"
	}
	model := strings.TrimSpace(body.Model)
	policy := strings.ToLower(strings.TrimSpace(body.MissedRunPolicy))
	if policy == "" {
		policy = "coalesce"
	}
	if policy != "coalesce" && policy != "skip" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missed_run_policy must be coalesce or skip"})
		return
	}
	if err := s.validateTaskCreateRequest(r.Context(), task.CreateRequest{
		Agent:          agent,
		PermissionMode: perm,
	}); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	lane := strings.TrimSpace(body.Lane)
	if lane == "" {
		lane = "routine"
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
		ID:              ulid.Make().String(),
		ProjectID:       projectID,
		Cwd:             body.Cwd,
		Agent:           agent,
		Model:           model,
		PermissionMode:  perm,
		Prompt:          body.Prompt,
		IntervalSecs:    intervalSecs,
		Enabled:         enabled,
		NextDueAt:       next,
		CreatedAt:       now,
		Title:           title,
		MissedRunPolicy: policy,
		Lane:            lane,
		Recurrence:      body.Recurrence,
	}
	if err := s.Store.InsertRoutine(r.Context(), rec); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, rec)
}

// nextDueAfterRuleChange is when a routine should next run after its rule was
// replaced — or after it was switched back to a plain interval, in which case
// the interval takes over from now rather than from the old rule's instant.
func nextDueAfterRuleChange(rule *routines.Recurrence, intervalSecs int64, now time.Time) (int64, bool) {
	if rule != nil {
		at, ok := rule.Next(now)
		if !ok {
			return 0, false
		}
		return at.UnixMilli(), true
	}
	if intervalSecs <= 0 {
		intervalSecs = 60
	}
	return now.Add(time.Duration(intervalSecs) * time.Second).UnixMilli(), true
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
		Title:           body.Title,
		ProjectID:       body.ProjectID,
		Cwd:             body.Cwd,
		Agent:           body.Agent,
		PermissionMode:  body.PermissionMode,
		Prompt:          body.Prompt,
		IntervalSecs:    body.IntervalSecs,
		Enabled:         body.Enabled,
		NextDueAt:       body.NextDueAt,
		MissedRunPolicy: body.MissedRunPolicy,
		Lane:            body.Lane,
	}
	if body.Model != nil {
		// Empty is meaningful here: it clears the model back to whatever the
		// agent chooses, which is how create spells "no model".
		model := strings.TrimSpace(*body.Model)
		patch.Model = &model
	}
	current, err := s.Store.GetRoutine(r.Context(), id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if body.MissedRunPolicy != nil {
		policy := strings.ToLower(strings.TrimSpace(*body.MissedRunPolicy))
		if policy != "coalesce" && policy != "skip" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missed_run_policy must be coalesce or skip"})
			return
		}
		patch.MissedRunPolicy = &policy
	}
	if body.Recurrence != nil {
		rule, err := routines.ParseRecurrence(*body.Recurrence)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		patch.Recurrence = body.Recurrence
		if body.NextDueAt == nil {
			// Changing the rule changes when it next runs. Without this a
			// routine switched to "weekdays at 09:00" would keep whatever
			// instant the old schedule left behind.
			at, ok := nextDueAfterRuleChange(rule, current.IntervalSecs, time.Now())
			if !ok {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "recurrence has no future occurrence"})
				return
			}
			patch.NextDueAt = &at
		}
	}
	if body.Cwd != nil {
		cwd := strings.TrimSpace(*body.Cwd)
		if cwd == "" {
			// Create refuses an empty directory; a patch that accepted one would
			// leave a routine no run could start in.
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "cwd must not be empty"})
			return
		}
		patch.Cwd = &cwd
		if body.ProjectID == nil && cwd != current.Cwd {
			// Create resolves the project from the directory; a patch that moves the
			// routine has to do the same, or its runs stay attributed to the project
			// the old path belonged to. A directory with no project clears it, which
			// is what create does with an unmatched cwd. An unchanged directory is
			// left alone: the caller did not ask to re-resolve it. A lookup that
			// fails is an error, not a silent move to an unattributed routine.
			resolved, err := s.Store.ResolveProjectIDForCwd(r.Context(), cwd)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
				return
			}
			patch.ProjectID = &resolved
		}
	}
	effectiveAgent := current.Agent
	if body.Agent != nil {
		effectiveAgent = strings.TrimSpace(*body.Agent)
		if effectiveAgent == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "agent must not be empty"})
			return
		}
		patch.Agent = &effectiveAgent
	}
	effectivePermission := current.PermissionMode
	if body.PermissionMode != nil {
		effectivePermission = strings.TrimSpace(*body.PermissionMode)
	}
	if err := s.validateTaskCreateRequest(r.Context(), task.CreateRequest{
		Agent:          effectiveAgent,
		PermissionMode: effectivePermission,
	}); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
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
		if errors.Is(err, store.ErrConflict) {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "routine has a dispatch in progress"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleRunRoutineNow(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if s.RunRoutine == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "routine scheduler unavailable"})
		return
	}
	t, err := s.RunRoutine(r.Context(), id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
			return
		}
		if errors.Is(err, store.ErrConflict) {
			writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
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

func (s *Server) handleRoutineHealth(w http.ResponseWriter, r *http.Request) {
	health, err := s.Store.RoutineHealthSnapshot(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, health)
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
	// Push task_update so sidebar unread pill and feed cards clear.
	if s.Engine != nil {
		s.Engine.PublishTask(t)
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
