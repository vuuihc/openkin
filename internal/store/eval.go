package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// EvalRun is one reproducible suite execution.
type EvalRun struct {
	ID               string `json:"id"`
	Suite            string `json:"suite"`
	SuiteVersion     string `json:"suite_version"`
	Condition        string `json:"condition"`
	RouteObjective   string `json:"route_objective,omitempty"`
	KinGitSHA        string `json:"kin_git_sha,omitempty"`
	NReps            int    `json:"n_reps"`
	Status           string `json:"status"`
	StartedAt        int64  `json:"started_at"`
	FinishedAt       *int64 `json:"finished_at,omitempty"`
	ReportArtifactID string `json:"report_artifact_id,omitempty"`
	CreatedAt        int64  `json:"created_at"`
}

// EvalResult is the deterministic result for one case repetition.
type EvalResult struct {
	ID          string          `json:"id"`
	RunID       string          `json:"run_id"`
	CaseID      string          `json:"case_id"`
	RepIdx      int             `json:"rep_idx"`
	TaskID      *string         `json:"task_id,omitempty"`
	Pass        bool            `json:"pass"`
	Turns       int             `json:"turns"`
	TokensIn    int64           `json:"tokens_in"`
	TokensOut   int64           `json:"tokens_out"`
	CostUSD     *float64        `json:"cost_usd,omitempty"`
	LatencyMS   int64           `json:"latency_ms"`
	CheckerJSON json.RawMessage `json:"checker"`
	CreatedAt   int64           `json:"created_at"`
}

const evalRunColumns = `id, suite, suite_version, condition, route_objective,
	kin_git_sha, n_reps, status, started_at, finished_at, report_artifact_id, created_at`

func scanEvalRun(scanner interface{ Scan(...any) error }) (EvalRun, error) {
	var run EvalRun
	var finished sql.NullInt64
	if err := scanner.Scan(&run.ID, &run.Suite, &run.SuiteVersion, &run.Condition,
		&run.RouteObjective, &run.KinGitSHA, &run.NReps, &run.Status, &run.StartedAt,
		&finished, &run.ReportArtifactID, &run.CreatedAt); err != nil {
		return EvalRun{}, err
	}
	if finished.Valid {
		run.FinishedAt = &finished.Int64
	}
	return run, nil
}

// InsertEvalRun creates a run in the running state.
func (s *Store) InsertEvalRun(ctx context.Context, run EvalRun) error {
	if strings.TrimSpace(run.ID) == "" || strings.TrimSpace(run.Suite) == "" {
		return fmt.Errorf("eval run id and suite are required")
	}
	if run.NReps <= 0 {
		return fmt.Errorf("eval run n_reps must be > 0")
	}
	if run.Status == "" {
		run.Status = "running"
	}
	if run.Condition == "" {
		run.Condition = "cold"
	}
	if run.StartedAt == 0 {
		run.StartedAt = NowMilli()
	}
	if run.CreatedAt == 0 {
		run.CreatedAt = run.StartedAt
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO eval_runs (
			id, suite, suite_version, condition, route_objective, kin_git_sha,
			n_reps, status, started_at, finished_at, report_artifact_id, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		run.ID, run.Suite, run.SuiteVersion, run.Condition, run.RouteObjective,
		run.KinGitSHA, run.NReps, run.Status, run.StartedAt, evalNullableInt64(run.FinishedAt),
		run.ReportArtifactID, run.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("insert eval run: %w", err)
	}
	return nil
}

// GetEvalRun returns one run.
func (s *Store) GetEvalRun(ctx context.Context, id string) (EvalRun, error) {
	run, err := scanEvalRun(s.db.QueryRowContext(ctx, `SELECT `+evalRunColumns+` FROM eval_runs WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return EvalRun{}, ErrNotFound
	}
	if err != nil {
		return EvalRun{}, fmt.Errorf("get eval run: %w", err)
	}
	return run, nil
}

// ListEvalRuns returns recent runs.
func (s *Store) ListEvalRuns(ctx context.Context, limit int) ([]EvalRun, error) {
	if limit <= 0 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}
	rows, err := s.db.QueryContext(ctx, `SELECT `+evalRunColumns+`
		FROM eval_runs ORDER BY started_at DESC, id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, fmt.Errorf("list eval runs: %w", err)
	}
	defer rows.Close()
	out := make([]EvalRun, 0)
	for rows.Next() {
		run, err := scanEvalRun(rows)
		if err != nil {
			return nil, fmt.Errorf("scan eval run: %w", err)
		}
		out = append(out, run)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// FinishEvalRun marks a run terminal and optionally attaches its report.
func (s *Store) FinishEvalRun(ctx context.Context, id, status, artifactID string, finishedAt int64) error {
	if status == "" {
		status = "succeeded"
	}
	res, err := s.db.ExecContext(ctx, `UPDATE eval_runs
		SET status = ?, finished_at = ?, report_artifact_id = ?
		WHERE id = ?`, status, finishedAt, artifactID, id)
	if err != nil {
		return fmt.Errorf("finish eval run: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// InsertEvalResult persists one case repetition.
func (s *Store) InsertEvalResult(ctx context.Context, result EvalResult) error {
	if result.ID == "" || result.RunID == "" || result.CaseID == "" {
		return fmt.Errorf("eval result id, run_id, and case_id are required")
	}
	if result.RepIdx < 0 {
		return fmt.Errorf("eval result rep_idx must be >= 0")
	}
	if result.CheckerJSON == nil {
		result.CheckerJSON = json.RawMessage(`{}`)
	}
	if result.CreatedAt == 0 {
		result.CreatedAt = NowMilli()
	}
	var taskID any
	if result.TaskID != nil {
		taskID = *result.TaskID
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO eval_results (
			id, run_id, case_id, rep_idx, task_id, pass, turns, tokens_in,
			tokens_out, cost_usd, latency_ms, checker_json, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		result.ID, result.RunID, result.CaseID, result.RepIdx, taskID, boolInt(result.Pass),
		result.Turns, result.TokensIn, result.TokensOut, result.CostUSD, result.LatencyMS,
		string(result.CheckerJSON), result.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("insert eval result: %w", err)
	}
	return nil
}

// UpdateEvalResult fills the durable placeholder after its task reaches a
// terminal state.
func (s *Store) UpdateEvalResult(ctx context.Context, result EvalResult) error {
	if result.ID == "" {
		return fmt.Errorf("eval result id is required")
	}
	if result.CheckerJSON == nil {
		result.CheckerJSON = json.RawMessage(`{}`)
	}
	res, err := s.db.ExecContext(ctx, `
		UPDATE eval_results SET pass = ?, turns = ?, tokens_in = ?, tokens_out = ?,
			cost_usd = ?, latency_ms = ?, checker_json = ?,
			created_at = COALESCE(NULLIF(?, 0), created_at)
		WHERE id = ?`,
		boolInt(result.Pass), result.Turns, result.TokensIn, result.TokensOut, result.CostUSD,
		result.LatencyMS, string(result.CheckerJSON), result.CreatedAt, result.ID)
	if err != nil {
		return fmt.Errorf("update eval result: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// ListEvalResults returns results ordered by case and repetition.
func (s *Store) ListEvalResults(ctx context.Context, runID string) ([]EvalResult, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, run_id, case_id, rep_idx, task_id, pass, turns, tokens_in,
		       tokens_out, cost_usd, latency_ms, checker_json, created_at
		FROM eval_results WHERE run_id = ? ORDER BY case_id, rep_idx`, runID)
	if err != nil {
		return nil, fmt.Errorf("list eval results: %w", err)
	}
	defer rows.Close()
	out := make([]EvalResult, 0)
	for rows.Next() {
		var result EvalResult
		var taskID sql.NullString
		var pass int
		var checker string
		var cost sql.NullFloat64
		if err := rows.Scan(&result.ID, &result.RunID, &result.CaseID, &result.RepIdx,
			&taskID, &pass, &result.Turns, &result.TokensIn, &result.TokensOut, &cost,
			&result.LatencyMS, &checker, &result.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan eval result: %w", err)
		}
		if taskID.Valid {
			result.TaskID = &taskID.String
		}
		result.Pass = pass != 0
		if cost.Valid {
			result.CostUSD = &cost.Float64
		}
		result.CheckerJSON = json.RawMessage(checker)
		out = append(out, result)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func evalNullableInt64(value *int64) any {
	if value == nil {
		return nil
	}
	return *value
}
