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
}

// Start creates all ordinary Tasks immediately and completes the run in the
// background. The returned run is durable even if the daemon restarts.
func (r *Runner) Start(ctx context.Context, req RunRequest) (store.EvalRun, error) {
	if r == nil || r.Store == nil || r.Engine == nil {
		return store.EvalRun{}, fmt.Errorf("eval runner unavailable")
	}
	suite, err := LoadSuite(r.SuitesDir, req.Suite)
	if err != nil {
		return store.EvalRun{}, err
	}
	reps := req.Repetitions
	if reps <= 0 {
		reps = 1
	}
	if reps > maxRepetitions {
		return store.EvalRun{}, fmt.Errorf("repetitions must be <= %d", maxRepetitions)
	}
	if len(suite.Cases)*reps > maxEvalTasks {
		return store.EvalRun{}, fmt.Errorf("suite fan-out must be <= %d tasks per run", maxEvalTasks)
	}
	condition := strings.TrimSpace(req.Condition)
	if condition == "" {
		condition = "cold"
	}
	if condition != "cold" {
		return store.EvalRun{}, fmt.Errorf("eval condition %q is not implemented; use cold", condition)
	}
	objective := strings.TrimSpace(req.RouteObjective)
	if objective != "" && !routing.ValidDispatchObjective(routing.DispatchObjective(objective)) {
		return store.EvalRun{}, fmt.Errorf("unknown route objective %q", objective)
	}
	if objective != "" && strings.TrimSpace(req.Team) == "" {
		return store.EvalRun{}, fmt.Errorf("team is required for route objective %q", objective)
	}
	now := time.Now().UnixMilli()
	run := store.EvalRun{
		ID:             ulid.Make().String(),
		Suite:          suite.Name,
		SuiteVersion:   suite.Version,
		Condition:      condition,
		RouteObjective: objective,
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
				_ = r.Store.FinishEvalRun(ctx, run.ID, "failed", "", time.Now().UnixMilli())
				return store.EvalRun{}, fmt.Errorf("persist eval manifest %s/%d: %w", c.ID, rep, err)
			}
			pending = append(pending, pendingCase{caseDef: c, rep: rep, taskID: taskID, resultID: result.ID})
		}
	}
	pendingIndex := 0
	for _, c := range suite.Cases {
		for rep := 0; rep < reps; rep++ {
			item := pending[pendingIndex]
			pendingIndex++
			createReq := task.CreateRequest{
				Cwd:            c.Cwd,
				Prompt:         c.Prompt,
				Agent:          c.Agent,
				PermissionMode: c.PermissionMode,
				ProjectID:      c.ProjectID,
				Title:          stringPtr(fmt.Sprintf("eval/%s/%s/%d", run.ID, c.ID, rep)),
				Dispatch:       c.Dispatch,
				RoutineID:      req.RoutineID,
			}
			createReq.ID = item.taskID
			if objective != "" {
				dispatch, _ := json.Marshal(routing.DispatchSelection{
					Mode:      routing.DispatchAuto,
					Team:      req.Team,
					Objective: routing.DispatchObjective(objective),
				})
				createReq.Dispatch = dispatch
			}
			created, err := r.Engine.Create(ctx, createReq)
			if err != nil {
				for _, previous := range pending {
					_, _ = r.Engine.Cancel(ctx, previous.taskID)
				}
				_ = r.Store.FinishEvalRun(ctx, run.ID, "failed", "", time.Now().UnixMilli())
				return store.EvalRun{}, fmt.Errorf("create eval task %s/%d: %w", c.ID, rep, err)
			}
			if payload, marshalErr := json.Marshal(map[string]any{
				"run_id": run.ID, "suite": suite.Name, "suite_version": suite.Version,
				"case_id": c.ID, "rep_idx": rep, "condition": condition,
			}); marshalErr == nil {
				_, _ = r.Store.AppendEvent(ctx, created.ID, "eval_metadata", payload)
			}
		}
	}
	go r.finish(context.Background(), run, pending)
	return run, nil
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
		return store.Task{}, fmt.Errorf("parse eval routine: %w", err)
	}
	configured := RunRequest{
		Suite: config.Suite, Condition: config.Condition, Repetitions: config.Repetitions,
		RouteObjective: config.RouteObjective, Team: config.Team, FirstTaskID: firstTaskID,
		RoutineID: routine.ID,
	}
	_, err := r.Start(ctx, configured)
	if err != nil {
		return store.Task{}, err
	}
	return r.Engine.Get(ctx, firstTaskID)
}

type pendingCase struct {
	caseDef  Case
	rep      int
	taskID   string
	resultID string
}

func (r *Runner) finish(ctx context.Context, run store.EvalRun, pending []pendingCase) {
	interval := r.PollInterval
	if interval <= 0 {
		interval = defaultPoll
	}
	remaining := append([]pendingCase(nil), pending...)
	for len(remaining) > 0 {
		next := remaining[:0]
		for _, item := range remaining {
			t, err := r.Store.GetTask(ctx, item.taskID)
			if err != nil {
				if errors.Is(err, store.ErrNotFound) {
					_ = r.Store.FinishEvalRun(ctx, run.ID, "failed", "", time.Now().UnixMilli())
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
				_ = r.Store.FinishEvalRun(ctx, run.ID, "failed", "", time.Now().UnixMilli())
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
		_ = r.Store.FinishEvalRun(ctx, run.ID, "failed", "", time.Now().UnixMilli())
		return
	}
	_ = r.Store.FinishEvalRun(ctx, run.ID, "succeeded", artifactID, time.Now().UnixMilli())
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
		byCase := make(map[string]Case, len(suite.Cases))
		for _, c := range suite.Cases {
			byCase[c.ID] = c
		}
		results, err := r.Store.ListEvalResults(ctx, run.ID)
		if err != nil {
			continue
		}
		pending := make([]pendingCase, 0)
		for _, result := range results {
			if result.TaskID == nil || string(result.CheckerJSON) != "{}" {
				continue
			}
			c, ok := byCase[result.CaseID]
			if !ok {
				continue
			}
			pending = append(pending, pendingCase{
				caseDef: c, rep: result.RepIdx, taskID: *result.TaskID, resultID: result.ID,
			})
		}
		if len(results) > 0 {
			go r.finish(ctx, run, pending)
		}
	}
	return nil
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
	count := 0
	for _, event := range events {
		if event.Type == "task_started" || event.Type == "result" {
			count++
		}
	}
	if count == 0 {
		return fallback
	}
	return count
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
