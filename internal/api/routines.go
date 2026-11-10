package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/vuuihc/openkin/internal/remote/worker"
	"github.com/vuuihc/openkin/internal/routines"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/task"
)

// routineDevice sends a routine request to the machine that owns the routines,
// or answers it here when that machine is this one.
//
// A routine is a machine fact, not a session fact: its cwd, its agent, its
// credentials, and its schedule all live on one machine, and only that machine
// can run it. A Hub that kept its own copy would be a second source of truth —
// the routine would be created on the phone, run on the Hub, and be invisible
// to the machine the person was actually looking at. So the Hub authorizes the
// caller (which its route middleware has already done) and relays the request;
// it does not translate it, copy it, or schedule it.
//
// The relay is the raw request rather than a translation, and that is the point:
// the answering machine runs it through the same handler its own console uses,
// so validation, defaults, scheduling, and the response shape cannot disagree
// between "created on the machine" and "created from a phone".
//
// device names a machine the Hub knows: its own id, "self", a paired device, or
// nothing at all. The three ways to say "this machine" are the same three
// localDevice already knows, and they take the local path below — no loopback
// HTTP, no wire, just the handler.
func (s *Server) routineDevice(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		device := strings.TrimSpace(r.URL.Query().Get("device"))
		if s.localDevice(device) {
			next.ServeHTTP(w, r)
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, worker.MaxRoutineBody))
		if err != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{
					"error": "the routine request body is too large",
				})
				return
			}
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		// The machine is asked in the console's own vocabulary — the same path
		// and query its local console would have received — minus the parameter
		// that named the machine, which is this Hub's word and not the machine's.
		//
		// The escaped path, not the decoded one: a path segment holding an
		// encoded "?" would otherwise turn into a query separator again on the
		// machine, and a parameter this Hub believed it had stripped would
		// reappear there.
		query := r.URL.Query()
		query.Del("device")
		path := r.URL.EscapedPath()
		if encoded := query.Encode(); encoded != "" {
			path += "?" + encoded
		}
		asked := worker.RoutinesParams{Method: r.Method, Path: path, Body: body}
		// Checked here as well as there: a request this Hub would not put on the
		// wire should be refused before a machine is made to answer it, and the
		// reason should name the request rather than a version skew.
		if err := asked.Validate(); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		var answer worker.ConsoleResult
		if err := s.askDeviceQuietly(r.Context(), device, worker.QueryRoutines, asked, &answer); err != nil {
			writeMachineQueryError(w, err)
			return
		}
		writeConsoleAnswer(w, answer)
	})
}

// previewRoutineBody asks what a rule would mean before it is saved.
type previewRoutineBody struct {
	Recurrence string `json:"recurrence"`
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
		runs, err := s.Store.ListTasks(r.Context(), store.ListTasksOpts{RoutineID: "*", Limit: limit, Scope: taskScope(r), Archived: store.ArchivedExclude})
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
	var body routines.CreateParams
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	rec, err := routines.Create(r.Context(), s.Store, s.validateTaskCreateRequest, body)
	if err != nil {
		var invalid *routines.ValidationError
		if errors.As(err, &invalid) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": invalid.Error()})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, rec)
}

// ruleFirstRun is the instant a wall-clock rule's next run lands on, in unix
// ms. Create, patch and the console's preview all read a rule through this, so
// the form cannot promise a time the daemon would not use.
func ruleFirstRun(rule *routines.Recurrence, now time.Time) (int64, bool) {
	return routines.FirstRun(rule, now)
}

// nextDueAfterRuleChange is when a routine should next run after its rule was
// replaced — or after it was switched back to a plain interval, in which case
// the interval takes over from now rather than from the old rule's instant.
func nextDueAfterRuleChange(rule *routines.Recurrence, intervalSecs int64, now time.Time) (int64, bool) {
	if rule != nil {
		return ruleFirstRun(rule, now)
	}
	if intervalSecs <= 0 {
		intervalSecs = 60
	}
	return now.Add(time.Duration(intervalSecs) * time.Second).UnixMilli(), true
}

// handlePreviewRoutine answers what a rule means before it is saved: the
// instant its next run would land on.
//
// The console asks this instead of computing `Next` itself. A second
// implementation would eventually disagree with the daemon about zones, DST or
// the step alignment, and the form would then promise a time the routine never
// fires at — worse than no preview, because the reader would trust it.
func (s *Server) handlePreviewRoutine(w http.ResponseWriter, r *http.Request) {
	var body previewRoutineBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	rule, err := routines.ParseRecurrence(body.Recurrence)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if rule == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "recurrence is required"})
		return
	}
	now := time.Now()
	next, ok := ruleFirstRun(rule, now)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "recurrence has no future occurrence"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]int64{
		"next_due_at": next,
	})
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
