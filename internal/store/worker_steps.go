package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

// WorkerStep is the durable plan and latest attempt state for one delegated
// worker step. Plan identity is append-only per task execution.
type WorkerStep struct {
	TaskID        string `json:"task_id"`
	ExecutionID   string `json:"execution_id"`
	StepIndex     int    `json:"step_index"`
	Role          string `json:"role"`
	DependsOn     []int  `json:"depends_on,omitempty"`
	Agent         string `json:"agent"`
	Provider      string `json:"provider,omitempty"`
	Model         string `json:"model,omitempty"`
	Access        string `json:"access"`
	Status        string `json:"status"`
	Attempt       int    `json:"attempt"`
	ExecutionRef  string `json:"execution_ref,omitempty"`
	ResultSummary string `json:"result_summary,omitempty"`
	Error         string `json:"error,omitempty"`
	CreatedAt     int64  `json:"created_at"`
	UpdatedAt     int64  `json:"updated_at"`
}

func (s *Store) InsertWorkerPlan(ctx context.Context, steps []WorkerStep) error {
	if len(steps) == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin worker plan: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	for _, step := range steps {
		if step.TaskID == "" || step.ExecutionID == "" || step.Agent == "" || step.CreatedAt <= 0 {
			return fmt.Errorf("invalid worker step")
		}
		if step.Role == "" {
			step.Role = "worker"
		}
		if step.Access != "write" {
			step.Access = "read"
		}
		if step.Status == "" {
			step.Status = "planned"
		}
		if step.Attempt <= 0 {
			step.Attempt = 1
		}
		if step.UpdatedAt <= 0 {
			step.UpdatedAt = step.CreatedAt
		}
		deps, err := json.Marshal(step.DependsOn)
		if err != nil {
			return fmt.Errorf("encode worker dependencies: %w", err)
		}
		_, err = tx.ExecContext(ctx, `
			INSERT INTO task_worker_steps (
				task_id, execution_id, step_index, role, depends_on, agent,
				provider, model, access, status, attempt, execution_ref,
				result_summary, error, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(task_id, execution_id, step_index) DO NOTHING`,
			step.TaskID, step.ExecutionID, step.StepIndex, step.Role, string(deps),
			step.Agent, step.Provider, step.Model, step.Access, step.Status,
			step.Attempt, step.ExecutionRef, step.ResultSummary, step.Error,
			step.CreatedAt, step.UpdatedAt,
		)
		if err != nil {
			return fmt.Errorf("insert worker step %d: %w", step.StepIndex, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit worker plan: %w", err)
	}
	return nil
}

type WorkerStepPatch struct {
	Status        *string
	Provider      *string
	Model         *string
	Attempt       *int
	ExecutionRef  *string
	ResultSummary *string
	Error         *string
}

func (s *Store) UpdateWorkerStep(ctx context.Context, taskID, executionID string, stepIndex int, patch WorkerStepPatch, now int64) error {
	if taskID == "" || executionID == "" || now <= 0 {
		return fmt.Errorf("invalid worker step update")
	}
	sets := make([]string, 0, 7)
	args := make([]any, 0, 7)
	if patch.Status != nil {
		sets = append(sets, "status = ?")
		args = append(args, *patch.Status)
	}
	if patch.Provider != nil {
		sets = append(sets, "provider = ?")
		args = append(args, *patch.Provider)
	}
	if patch.Model != nil {
		sets = append(sets, "model = ?")
		args = append(args, *patch.Model)
	}
	if patch.Attempt != nil {
		sets = append(sets, "attempt = ?")
		args = append(args, *patch.Attempt)
	}
	if patch.ExecutionRef != nil {
		sets = append(sets, "execution_ref = ?")
		args = append(args, *patch.ExecutionRef)
	}
	if patch.ResultSummary != nil {
		sets = append(sets, "result_summary = ?")
		args = append(args, *patch.ResultSummary)
	}
	if patch.Error != nil {
		sets = append(sets, "error = ?")
		args = append(args, *patch.Error)
	}
	if len(sets) == 0 {
		return nil
	}
	sets = append(sets, "updated_at = ?")
	args = append(args, now, taskID, executionID, stepIndex)
	result, err := s.db.ExecContext(ctx, `
		UPDATE task_worker_steps SET `+strings.Join(sets, ", ")+`
		WHERE task_id = ? AND execution_id = ? AND step_index = ?
		  AND status IN ('planned', 'running')`, args...)
	if err != nil {
		return fmt.Errorf("update worker step: %w", err)
	}
	if changed, _ := result.RowsAffected(); changed == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) ListWorkerSteps(ctx context.Context, taskID, executionID string) ([]WorkerStep, error) {
	const maxRows = 256
	query := `
		SELECT task_id, execution_id, step_index, role, depends_on, agent,
			provider, model, access, status, attempt, execution_ref,
			result_summary, error, created_at, updated_at
		FROM task_worker_steps WHERE task_id = ?`
	args := []any{taskID}
	if executionID != "" {
		query += " AND execution_id = ?"
		args = append(args, executionID)
	}
	query += " ORDER BY created_at DESC, execution_id DESC, step_index ASC LIMIT ?"
	args = append(args, maxRows)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list worker steps: %w", err)
	}
	defer rows.Close()
	out := make([]WorkerStep, 0)
	for rows.Next() {
		var step WorkerStep
		var deps string
		if err := rows.Scan(
			&step.TaskID, &step.ExecutionID, &step.StepIndex, &step.Role, &deps,
			&step.Agent, &step.Provider, &step.Model, &step.Access, &step.Status,
			&step.Attempt, &step.ExecutionRef, &step.ResultSummary, &step.Error,
			&step.CreatedAt, &step.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan worker step: %w", err)
		}
		if err := json.Unmarshal([]byte(deps), &step.DependsOn); err != nil {
			return nil, fmt.Errorf("decode worker dependencies: %w", err)
		}
		out = append(out, step)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate worker steps: %w", err)
	}
	return out, nil
}

func (s *Store) MarkWorkerStepsTerminal(ctx context.Context, taskID, status, message string, now int64) error {
	if taskID == "" || now <= 0 {
		return fmt.Errorf("invalid worker terminal update")
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE task_worker_steps
		SET status = ?, error = ?, updated_at = ?
		WHERE task_id = ? AND status IN ('planned', 'running')`,
		status, message, now, taskID,
	)
	if err != nil {
		return fmt.Errorf("mark worker steps terminal: %w", err)
	}
	return nil
}
