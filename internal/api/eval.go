package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/oklog/ulid/v2"

	"github.com/vuuihc/openkin/internal/eval"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/task"
)

func (s *Server) handleListEvalSuites(w http.ResponseWriter, r *http.Request) {
	if s.Eval == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "eval is not configured"})
		return
	}
	suites, err := eval.ListSuites(s.Eval.SuitesDir)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, suites)
}

func (s *Server) handleListEvalRuns(w http.ResponseWriter, r *http.Request) {
	limit := 100
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if _, err := fmt.Sscanf(raw, "%d", &limit); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid limit"})
			return
		}
	}
	runs, err := s.Store.ListEvalRuns(r.Context(), limit)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if runs == nil {
		runs = []store.EvalRun{}
	}
	writeJSON(w, http.StatusOK, runs)
}

func (s *Server) handleCreateEvalRun(w http.ResponseWriter, r *http.Request) {
	if s.Eval == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "eval is not configured"})
		return
	}
	var req eval.RunRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	run, err := s.Eval.Start(r.Context(), req)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusAccepted, run)
}

func (s *Server) handleCompareEvalRuns(w http.ResponseWriter, r *http.Request) {
	if s.Eval == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "eval is not configured"})
		return
	}
	var body struct {
		Suite       string   `json:"suite"`
		Condition   string   `json:"condition,omitempty"`
		Repetitions int      `json:"repetitions,omitempty"`
		Team        string   `json:"team"`
		Objectives  []string `json:"objectives,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if len(body.Objectives) == 0 {
		body.Objectives = []string{"balanced", "cost-min"}
	}
	if len(body.Objectives) > 2 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "at most two route objectives can be compared"})
		return
	}
	runs := make([]store.EvalRun, 0, len(body.Objectives))
	for _, objective := range body.Objectives {
		run, err := s.Eval.Start(r.Context(), eval.RunRequest{
			Suite: body.Suite, Condition: body.Condition, Repetitions: body.Repetitions,
			Team: body.Team, RouteObjective: strings.TrimSpace(objective),
		})
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		runs = append(runs, run)
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"runs": runs})
}

func (s *Server) handleCreateEvalRoutine(w http.ResponseWriter, r *http.Request) {
	if s.Eval == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "eval routine is not configured"})
		return
	}
	var body struct {
		Suite          string `json:"suite"`
		Condition      string `json:"condition,omitempty"`
		Repetitions    int    `json:"repetitions,omitempty"`
		RouteObjective string `json:"route_objective,omitempty"`
		Team           string `json:"team,omitempty"`
		Cwd            string `json:"cwd"`
		ProjectID      string `json:"project_id,omitempty"`
		IntervalSecs   int64  `json:"interval_secs"`
		Enabled        *bool  `json:"enabled,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if strings.TrimSpace(body.Suite) == "" || strings.TrimSpace(body.Cwd) == "" || body.IntervalSecs <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "suite, cwd, and positive interval_secs are required"})
		return
	}
	if body.Condition != "" && body.Condition != "cold" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "only cold eval condition is currently supported"})
		return
	}
	config, _ := json.Marshal(map[string]any{
		"suite": body.Suite, "condition": body.Condition, "repetitions": body.Repetitions,
		"route_objective": body.RouteObjective, "team": body.Team,
	})
	enabled := true
	if body.Enabled != nil {
		enabled = *body.Enabled
	}
	now := time.Now().UnixMilli()
	routine := store.Routine{
		ID: ulid.Make().String(), ProjectID: strings.TrimSpace(body.ProjectID), Cwd: body.Cwd,
		Agent: "kin", PermissionMode: "default", Prompt: string(config),
		IntervalSecs: body.IntervalSecs, Enabled: enabled, NextDueAt: now, CreatedAt: now,
		Title: "Eval · " + body.Suite, Lane: "eval", MissedRunPolicy: "coalesce",
	}
	if err := s.Store.InsertRoutine(r.Context(), routine); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, routine)
}

func (s *Server) handleGetEvalRun(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	run, err := s.Store.GetEvalRun(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	results, err := s.Store.ListEvalResults(r.Context(), id)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if results == nil {
		results = []store.EvalResult{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"run": run, "results": results})
}

func (s *Server) handleReplayTask(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body struct {
		Mode     string          `json:"mode"`
		FromSeq  int             `json:"from_seq,omitempty"`
		Prompt   string          `json:"prompt,omitempty"`
		Dispatch json.RawMessage `json:"dispatch,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	switch strings.ToLower(strings.TrimSpace(body.Mode)) {
	case "inspect":
		events, err := s.Engine.Events(r.Context(), id, 0)
		if err != nil {
			replayError(w, err)
			return
		}
		checkpoints, err := s.Store.ListCheckpoints(r.Context(), id)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"mode": "inspect", "events": events, "checkpoints": checkpoints})
	case "fork":
		t, err := s.Engine.Fork(r.Context(), id, task.ForkRequest{
			FromSeq: body.FromSeq, Prompt: body.Prompt,
		})
		if err != nil {
			replayError(w, err)
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"mode": "fork", "task": t})
	case "rerun":
		original, err := s.Engine.Get(r.Context(), id)
		if err != nil {
			replayError(w, err)
			return
		}
		prompt := strings.TrimSpace(body.Prompt)
		if prompt == "" {
			prompt = original.Prompt
		}
		t, err := s.Engine.Create(r.Context(), task.CreateRequest{
			Cwd: original.Cwd, Prompt: prompt, Agent: original.Agent,
			Model: original.Model, PermissionMode: original.PermissionMode,
			ProjectID: original.ProjectID, Dispatch: body.Dispatch,
			Title: stringPtr("Replay · " + original.Title),
		})
		if err != nil {
			replayError(w, err)
			return
		}
		payload, _ := json.Marshal(map[string]any{"source_task_id": id, "mode": "rerun"})
		_, _ = s.Store.AppendEvent(r.Context(), t.ID, "replay_metadata", payload)
		writeJSON(w, http.StatusAccepted, map[string]any{"mode": "rerun", "task": t})
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "mode must be inspect, fork, or rerun"})
	}
}

func replayError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
	case errors.Is(err, task.ErrConflict):
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
	}
}

func stringPtr(value string) *string { return &value }
