package eval

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/oklog/ulid/v2"

	"github.com/vuuihc/openkin/internal/routing"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/task"
)

const (
	maxRepetitions = 50
	maxEvalTasks   = 100
	defaultPoll    = 250 * time.Millisecond
)

// Runner executes file-backed suites using the existing Task engine.
type Runner struct {
	Store        *store.Store
	Engine       *task.Engine
	SuitesDir    string
	ArtifactsDir string
	PollInterval time.Duration
}

// RunRequest selects one suite condition and route objective.
type RunRequest struct {
	Suite          string `json:"suite"`
	Condition      string `json:"condition,omitempty"`
	Repetitions    int    `json:"repetitions,omitempty"`
	RouteObjective string `json:"route_objective,omitempty"`
	Team           string `json:"team,omitempty"`
	FirstTaskID    string `json:"-"`
	RoutineID      string `json:"-"`
	Sequential     bool   `json:"-"`
}

// Start creates ordinary Tasks and completes the run in the background. Routine
// runs are serialized so one suite cannot flood the shared task FIFO.
func (r *Runner) Start(ctx context.Context, req RunRequest) (store.EvalRun, error) {
	if r == nil || r.Store == nil || r.Engine == nil {
		return store.EvalRun{}, fmt.Errorf("eval runner unavailable")
	}
	suite, err := LoadSuite(r.SuitesDir, req.Suite)
	if err != nil {
		return store.EvalRun{}, err
	}
	reps, condition, objective, err := normalizeRunRequest(suite, req)
	if err != nil {
		return store.EvalRun{}, err
	}
	now := time.Now().UnixMilli()
	run := store.EvalRun{
		ID:             ulid.Make().String(),
		Suite:          suite.Name,
		SuiteVersion:   suite.Version,
		Condition:      condition,
		RouteObjective: objective,
		Team:           strings.TrimSpace(req.Team),
		RoutineID:      strings.TrimSpace(req.RoutineID),
		NReps:          reps,
		Status:         "running",
		KinGitSHA:      strings.TrimSpace(os.Getenv("KIN_GIT_SHA")),
		StartedAt:      now,
		CreatedAt:      now,
	}
	if err := r.Store.InsertEvalRun(ctx, run); err != nil {
		return store.EvalRun{}, err
	}
	pending := make([]pendingCase, 0, len(suite.Cases)*reps)
	for _, c := range suite.Cases {
		for rep := 0; rep < reps; rep++ {
			taskID := ulid.Make().String()
			if req.FirstTaskID != "" && len(pending) == 0 {
				taskID = req.FirstTaskID
			}
			result := store.EvalResult{
				ID: ulid.Make().String(), RunID: run.ID, CaseID: c.ID, RepIdx: rep,
				TaskID: stringPtr(taskID), CheckerJSON: json.RawMessage(`{}`),
			}
			if err := r.Store.InsertEvalResult(ctx, result); err != nil {
				_ = r.finishRun(ctx, run, "failed", "", err.Error())
				return store.EvalRun{}, fmt.Errorf("persist eval manifest %s/%d: %w", c.ID, rep, err)
			}
			pending = append(pending, pendingCase{caseDef: c, rep: rep, taskID: taskID, resultID: result.ID})
		}
	}
	if req.Sequential {
		if _, err := r.createEvalTask(ctx, run, suite, pending[0]); err != nil {
			_ = r.finishRun(ctx, run, "failed", "", err.Error())
			return store.EvalRun{}, fmt.Errorf("create first eval task: %w", err)
		}
	} else {
		for _, item := range pending {
			if _, err := r.createEvalTask(ctx, run, suite, item); err != nil {
				for _, previous := range pending {
					_, _ = r.Engine.Cancel(ctx, previous.taskID)
				}
				_ = r.finishRun(ctx, run, "failed", "", err.Error())
				return store.EvalRun{}, fmt.Errorf("create eval task %s/%d: %w", item.caseDef.ID, item.rep, err)
			}
		}
	}
	go r.finish(context.Background(), run, pending, req.Sequential)
	return run, nil
}

func normalizeRunRequest(suite Suite, req RunRequest) (int, string, string, error) {
	reps := req.Repetitions
	if reps <= 0 {
		reps = 1
	}
	if reps > maxRepetitions {
		return 0, "", "", fmt.Errorf("repetitions must be <= %d", maxRepetitions)
	}
	if len(suite.Cases)*reps > maxEvalTasks {
		return 0, "", "", fmt.Errorf("suite fan-out must be <= %d tasks per run", maxEvalTasks)
	}
	condition := strings.TrimSpace(req.Condition)
	if condition == "" {
		condition = "cold"
	}
	if condition != "cold" {
		return 0, "", "", fmt.Errorf("eval condition %q is not implemented; use cold", condition)
	}
	objective := strings.TrimSpace(req.RouteObjective)
	if objective != "" && !routing.ValidDispatchObjective(routing.DispatchObjective(objective)) {
		return 0, "", "", fmt.Errorf("unknown route objective %q", objective)
	}
	if objective != "" && strings.TrimSpace(req.Team) == "" {
		return 0, "", "", fmt.Errorf("team is required for route objective %q", objective)
	}
	return reps, condition, objective, nil
}

func (r *Runner) createEvalTask(ctx context.Context, run store.EvalRun, suite Suite, item pendingCase) (store.Task, error) {
	createReq := task.CreateRequest{
		ID:             item.taskID,
		Cwd:            item.caseDef.Cwd,
		Prompt:         item.caseDef.Prompt,
		Agent:          item.caseDef.Agent,
		PermissionMode: item.caseDef.PermissionMode,
		ProjectID:      item.caseDef.ProjectID,
		Title:          stringPtr(fmt.Sprintf("eval/%s/%s/%d", run.ID, item.caseDef.ID, item.rep)),
		Dispatch:       markEvalDispatch(item.caseDef.Dispatch, run.ID),
		RoutineID:      run.RoutineID,
	}
	if run.RouteObjective != "" {
		dispatch, _ := json.Marshal(routing.DispatchSelection{
			Mode:      routing.DispatchAuto,
			Team:      run.Team,
			Objective: routing.DispatchObjective(run.RouteObjective),
		})
		createReq.Dispatch = markEvalDispatch(dispatch, run.ID)
	}
	created, err := r.Engine.Create(ctx, createReq)
	if err != nil {
		return store.Task{}, err
	}
	payload, err := json.Marshal(map[string]any{
		"run_id": run.ID, "suite": suite.Name, "suite_version": suite.Version,
		"case_id": item.caseDef.ID, "rep_idx": item.rep, "condition": run.Condition,
		"routine_id": run.RoutineID,
	})
	if err == nil {
		_, _ = r.Store.AppendEvent(ctx, created.ID, "eval_metadata", payload)
	}
	return created, nil
}

func markEvalDispatch(raw json.RawMessage, runID string) json.RawMessage {
	if strings.TrimSpace(runID) == "" {
		return raw
	}
	payload := map[string]any{}
	if len(strings.TrimSpace(string(raw))) > 0 {
		if json.Unmarshal(raw, &payload) != nil {
			return raw
		}
		if payload == nil {
			payload = map[string]any{}
		}
	}
	payload["eval_run_id"] = runID
	marked, err := json.Marshal(payload)
	if err != nil {
		return raw
	}
	return marked
}

type routineConfig struct {
	Suite          string `json:"suite"`
	Condition      string `json:"condition,omitempty"`
	Repetitions    int    `json:"repetitions,omitempty"`
	RouteObjective string `json:"route_objective,omitempty"`
	Team           string `json:"team,omitempty"`
}

// StartRoutine runs an eval lane Routine and uses the scheduler's reserved
// task id for the first case, keeping routine dispatch recovery durable.
func (r *Runner) StartRoutine(ctx context.Context, routine store.Routine, firstTaskID string) (store.Task, error) {
	var config routineConfig
	if err := json.Unmarshal([]byte(routine.Prompt), &config); err != nil {
		err = fmt.Errorf("parse eval routine: %w", err)
		_ = r.failRoutineStart(ctx, routine, err)
		return store.Task{}, err
	}
	configured := RunRequest{
		Suite: config.Suite, Condition: config.Condition, Repetitions: config.Repetitions,
		RouteObjective: config.RouteObjective, Team: config.Team, FirstTaskID: firstTaskID,
		RoutineID: routine.ID, Sequential: true,
	}
	suite, err := LoadSuite(r.SuitesDir, configured.Suite)
	if err != nil {
		_ = r.failRoutineStart(ctx, routine, err)
		return store.Task{}, err
	}
	if _, _, _, err := normalizeRunRequest(suite, configured); err != nil {
		_ = r.failRoutineStart(ctx, routine, err)
		return store.Task{}, err
	}
	_, err = r.Start(ctx, configured)
	if err != nil {
		return store.Task{}, err
	}
	return r.Engine.Get(ctx, firstTaskID)
}

func (r *Runner) failRoutineStart(ctx context.Context, routine store.Routine, cause error) error {
	failures := routine.ConsecFailures + 1
	enabled := routine.Enabled
	if failures >= store.RoutineMaxConsecFailures {
		enabled = false
	}
	outcome := "failed"
	lastError := cause.Error()
	return r.Store.UpdateRoutine(ctx, routine.ID, store.RoutinePatch{
		Enabled: &enabled, ConsecFailures: &failures,
		LastOutcome: &outcome, LastError: &lastError,
	})
}

type pendingCase struct {
	caseDef  Case
	rep      int
	taskID   string
	resultID string
}

func (r *Runner) finish(ctx context.Context, run store.EvalRun, pending []pendingCase, sequential bool) {
	interval := r.PollInterval
	if interval <= 0 {
		interval = defaultPoll
	}
	if sequential {
		r.finishSequential(ctx, run, pending, interval)
		return
	}
	remaining := append([]pendingCase(nil), pending...)
	for len(remaining) > 0 {
		next := remaining[:0]
		for _, item := range remaining {
			t, err := r.Store.GetTask(ctx, item.taskID)
			if err != nil {
				if errors.Is(err, store.ErrNotFound) {
					_ = r.finishRun(ctx, run, "failed", "", "eval task disappeared")
					return
				}
				next = append(next, item)
				continue
			}
			if !terminal(t.Status) {
				next = append(next, item)
				continue
			}
			if err := r.recordResult(ctx, run.ID, item, t); err != nil {
				_ = r.finishRun(ctx, run, "failed", "", err.Error())
				return
			}
		}
		remaining = next
		if len(remaining) > 0 {
			time.Sleep(interval)
		}
	}
	artifactID, err := r.writeReport(ctx, run)
	if err != nil {
		_ = r.finishRun(ctx, run, "failed", "", err.Error())
		return
	}
	_ = r.finishRun(ctx, run, "succeeded", artifactID, "")
}

func (r *Runner) finishSequential(ctx context.Context, run store.EvalRun, pending []pendingCase, interval time.Duration) {
	suite, err := LoadSuite(r.SuitesDir, run.Suite)
	if err != nil {
		_ = r.finishRun(ctx, run, "failed", "", err.Error())
		return
	}
	remaining := append([]pendingCase(nil), pending...)
	for len(remaining) > 0 {
		item := remaining[0]
		t, err := r.Store.GetTask(ctx, item.taskID)
		if errors.Is(err, store.ErrNotFound) {
			if _, createErr := r.createEvalTask(ctx, run, suite, item); createErr != nil {
				_ = r.finishRun(ctx, run, "failed", "", createErr.Error())
				return
			}
			continue
		}
		if err != nil {
			time.Sleep(interval)
			continue
		}
		if !terminal(t.Status) {
			time.Sleep(interval)
			continue
		}
		if err := r.recordResult(ctx, run.ID, item, t); err != nil {
			_ = r.finishRun(ctx, run, "failed", "", err.Error())
			return
		}
		remaining = remaining[1:]
	}
	artifactID, err := r.writeReport(ctx, run)
	if err != nil {
		_ = r.finishRun(ctx, run, "failed", "", err.Error())
		return
	}
	_ = r.finishRun(ctx, run, "succeeded", artifactID, "")
}

func (r *Runner) finishRun(ctx context.Context, run store.EvalRun, status, artifactID, lastError string) error {
	return r.Store.FinishEvalRunAndRoutine(
		ctx, run.ID, run.RoutineID, status, artifactID, lastError, time.Now().UnixMilli(),
	)
}

func (r *Runner) recordResult(ctx context.Context, runID string, item pendingCase, t store.Task) error {
	events, err := r.Store.ListEvents(ctx, t.ID, 0)
	if err != nil {
		return err
	}
	check := evaluate(item.caseDef.Expect, t, events)
	checkerJSON, _ := json.Marshal(check)
	usage, err := r.Store.TaskUsage(ctx, t.ID)
	if err != nil {
		return err
	}
	latency := time.Now().UnixMilli() - t.CreatedAt
	if t.StartedAt != nil && t.FinishedAt != nil {
		latency = *t.FinishedAt - *t.StartedAt
	}
	if latency < 0 {
		latency = 0
	}
	return r.Store.UpdateEvalResult(ctx, store.EvalResult{
		ID:          item.resultID,
		RunID:       runID,
		CaseID:      item.caseDef.ID,
		RepIdx:      item.rep,
		TaskID:      stringPtr(t.ID),
		Pass:        check.Pass,
		Turns:       countTurns(events, usage.RequestCount),
		TokensIn:    usage.TokensIn,
		TokensOut:   usage.TokensOut,
		CostUSD:     usage.CostUSD,
		LatencyMS:   latency,
		CheckerJSON: checkerJSON,
	})
}

// Resume re-arms runs that were interrupted by a daemon restart. Placeholder
// results make the task-to-case mapping durable before provider work starts.
func (r *Runner) Resume(ctx context.Context) error {
	runs, err := r.Store.ListEvalRuns(ctx, 500)
	if err != nil {
		return err
	}
	for _, run := range runs {
		if run.Status != "running" {
			continue
		}
		suite, err := LoadSuite(r.SuitesDir, run.Suite)
		if err != nil {
			continue
		}
		results, err := r.Store.ListEvalResults(ctx, run.ID)
		if err != nil {
			continue
		}
		inferredRoutine, inferredTeam := run.RoutineID, run.Team
		for _, result := range results {
			if result.TaskID == nil {
				continue
			}
			t, taskErr := r.Store.GetTask(ctx, *result.TaskID)
			if taskErr != nil {
				continue
			}
			if inferredRoutine == "" && t.RoutineID != "" {
				inferredRoutine = t.RoutineID
			}
			if inferredTeam == "" {
				inferredTeam = dispatchTeam(t.Dispatch)
			}
		}
		if inferredRoutine != run.RoutineID || inferredTeam != run.Team {
			run.RoutineID, run.Team = inferredRoutine, inferredTeam
			if err := r.Store.SetEvalRunRoutine(ctx, run.ID, run.RoutineID, run.Team); err != nil {
				return fmt.Errorf("backfill eval run routing %s: %w", run.ID, err)
			}
		}
		resultsByKey := make(map[string]store.EvalResult, len(results))
		for _, result := range results {
			resultsByKey[result.CaseID+":"+fmt.Sprint(result.RepIdx)] = result
		}
		pending := make([]pendingCase, 0, len(results))
		for _, c := range suite.Cases {
			for rep := 0; rep < run.NReps; rep++ {
				result, ok := resultsByKey[c.ID+":"+fmt.Sprint(rep)]
				if !ok || result.TaskID == nil || string(result.CheckerJSON) != "{}" {
					continue
				}
				pending = append(pending, pendingCase{
					caseDef: c, rep: rep, taskID: *result.TaskID, resultID: result.ID,
				})
			}
		}
		if len(results) > 0 {
			go r.finish(ctx, run, pending, run.RoutineID != "")
		}
	}
	return nil
}

func dispatchTeam(raw json.RawMessage) string {
	var selection struct {
		Mode string `json:"mode"`
		Team string `json:"team"`
	}
	if json.Unmarshal(raw, &selection) != nil || selection.Mode != string(routing.DispatchAuto) {
		return ""
	}
	return strings.TrimSpace(selection.Team)
}

type checkResult struct {
	Pass   bool     `json:"pass"`
	Errors []string `json:"errors,omitempty"`
}

func evaluate(expect Expectation, t store.Task, events []store.Event) checkResult {
	status := expect.Status
	if status == "" {
		status = task.StatusSucceeded
	}
	out := checkResult{Pass: t.Status == status}
	if !out.Pass {
		out.Errors = append(out.Errors, fmt.Sprintf("status=%s, want %s", t.Status, status))
	}
	turns := countTurns(events, 0)
	if expect.MinTurns > 0 && turns < expect.MinTurns {
		out.Pass = false
		out.Errors = append(out.Errors, fmt.Sprintf("turns=%d below min %d", turns, expect.MinTurns))
	}
	if expect.MaxTurns > 0 && turns > expect.MaxTurns {
		out.Pass = false
		out.Errors = append(out.Errors, fmt.Sprintf("turns=%d above max %d", turns, expect.MaxTurns))
	}
	if expect.EventType != "" {
		found := false
		for _, event := range events {
			if event.Type == expect.EventType {
				found = true
				break
			}
		}
		if !found {
			out.Pass = false
			out.Errors = append(out.Errors, "expected event "+expect.EventType)
		}
	}
	if len(expect.TextContains) > 0 {
		text := eventText(events)
		for _, needle := range expect.TextContains {
			if !strings.Contains(text, needle) {
				out.Pass = false
				out.Errors = append(out.Errors, "missing text "+needle)
			}
		}
	}
	return out
}

func countTurns(events []store.Event, fallback int) int {
	resultCount := 0
	usageCount := 0
	sawUsage := false
	for _, event := range events {
		if event.Type == "result" && !isOrchestratorResult(event.Payload) {
			resultCount++
		}
		if event.Type == "usage" {
			sawUsage = true
			if !isControllerUsage(event.Payload) {
				usageCount++
			}
		}
	}
	if sawUsage {
		return usageCount
	}
	if resultCount > 0 {
		return resultCount
	}
	return fallback
}

func isOrchestratorResult(payload json.RawMessage) bool {
	var metadata struct {
		Source string `json:"source"`
	}
	return json.Unmarshal(payload, &metadata) == nil &&
		strings.EqualFold(strings.TrimSpace(metadata.Source), "orchestrator")
}

func isControllerUsage(payload json.RawMessage) bool {
	var metadata struct {
		Source string `json:"source"`
	}
	return json.Unmarshal(payload, &metadata) == nil &&
		strings.EqualFold(strings.TrimSpace(metadata.Source), "controller")
}

func eventText(events []store.Event) string {
	var b strings.Builder
	for _, event := range events {
		if event.Type != "message" && event.Type != "result" {
			continue
		}
		b.Write(event.Payload)
		b.WriteByte('\n')
	}
	return b.String()
}

func (r *Runner) writeReport(ctx context.Context, run store.EvalRun) (string, error) {
	results, err := r.Store.ListEvalResults(ctx, run.ID)
	if err != nil {
		return "", err
	}
	expected := 0
	if suite, suiteErr := LoadSuite(r.SuitesDir, run.Suite); suiteErr == nil {
		expected = len(suite.Cases) * run.NReps
	}
	if expected == 0 || len(results) != expected {
		return "", fmt.Errorf("eval run incomplete: got %d results, want %d", len(results), expected)
	}
	report := buildReport(run, results)
	if r.ArtifactsDir == "" {
		return "", fmt.Errorf("eval artifacts directory is not configured")
	}
	id := ulid.Make().String()
	rel := filepath.Join("eval", run.ID+".md")
	full := filepath.Join(r.ArtifactsDir, rel)
	if !within(r.ArtifactsDir, full) {
		return "", fmt.Errorf("eval report path escapes artifacts directory")
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o700); err != nil {
		return "", err
	}
	if err := os.WriteFile(full, []byte(report), 0o600); err != nil {
		return "", err
	}
	if err := r.Store.InsertArtifact(ctx, store.Artifact{
		ID: id, Title: fmt.Sprintf("Eval %s report", run.Suite), Kind: store.ArtifactKindMarkdown,
		RelPath: rel, Size: int64(len(report)), Status: store.ArtifactSaved,
	}); err != nil {
		_ = os.Remove(full)
		return "", err
	}
	return id, nil
}

func buildReport(run store.EvalRun, results []store.EvalResult) string {
	var pass, tokensIn, tokensOut int64
	var cost, latency float64
	passValues := make([]float64, 0, len(results))
	for _, result := range results {
		if result.Pass {
			pass++
		}
		passValues = append(passValues, boolFloat(result.Pass))
		tokensIn += result.TokensIn
		tokensOut += result.TokensOut
		if result.CostUSD != nil {
			cost += *result.CostUSD
		}
		latency += float64(result.LatencyMS)
	}
	n := float64(len(results))
	passRate, meanLatency := 0.0, 0.0
	if n > 0 {
		passRate = float64(pass) / n
		meanLatency = latency / n
	}
	noise := standardDeviation(passValues)
	ci := 0.0
	if n > 0 {
		ci = 1.96 * noise / math.Sqrt(n)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "# Eval report: %s\n\n", run.Suite)
	fmt.Fprintf(&b, "- Suite version: `%s`\n- Condition: `%s`\n- Route objective: `%s`\n- Repetitions: `%d`\n\n",
		run.SuiteVersion, run.Condition, run.RouteObjective, run.NReps)
	fmt.Fprintf(&b, "| Metric | Value |\n|---|---:|\n| Pass rate | %.3f |\n| 95%% noise interval | ±%.3f |\n| Tokens in | %d |\n| Tokens out | %d |\n| Cost (USD) | %.6f |\n| Mean latency (ms) | %.1f |\n",
		passRate, ci, tokensIn, tokensOut, cost, meanLatency)
	b.WriteString("\nThe route is not promoted automatically. Review this summary before changing routing scores.\n")
	return b.String()
}

func standardDeviation(values []float64) float64 {
	if len(values) < 2 {
		return 0
	}
	var mean float64
	for _, value := range values {
		mean += value
	}
	mean /= float64(len(values))
	var sum float64
	for _, value := range values {
		delta := value - mean
		sum += delta * delta
	}
	return math.Sqrt(sum / float64(len(values)-1))
}

func boolFloat(value bool) float64 {
	if value {
		return 1
	}
	return 0
}

func terminal(status string) bool {
	return status == task.StatusSucceeded || status == task.StatusFailed || status == task.StatusCanceled
}

func stringPtr(value string) *string { return &value }
