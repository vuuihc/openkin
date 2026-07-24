package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// User question status values.
const (
	UQStatusPending  = "pending"
	UQStatusAnswered = "answered"
	UQStatusExpired  = "expired"
)

// DefaultUserQuestionTTL is how long a user question may stay pending.
const DefaultUserQuestionTTL = time.Hour

// UserQuestion is a row in the user_questions table, optionally joined with task fields.
// Execution* fields attribute the request to one concrete adapter run under
// the parent task. Historical rows leave them null.
type UserQuestion struct {
	ID          string          `json:"id"`
	TaskID      string          `json:"task_id"`
	Payload     json.RawMessage `json:"payload"`
	Status      string          `json:"status"`
	Response    json.RawMessage `json:"response,omitempty"`
	AnsweredVia *string         `json:"answered_via,omitempty"`
	CreatedAt   int64           `json:"created_at"`
	AnsweredAt  *int64          `json:"answered_at,omitempty"`
	// Execution attribution (nullable; additive).
	ExecutionID    *string `json:"execution_id,omitempty"`
	ExecutionAgent *string `json:"execution_agent,omitempty"`
	ExecutionStep  *int    `json:"execution_step,omitempty"`
	ExecutionModel *string `json:"execution_model,omitempty"`
	// Joined from tasks (list endpoint).
	TaskTitle string `json:"task_title,omitempty"`
	TaskAgent string `json:"task_agent,omitempty"`
}

const userQuestionColumns = `id, task_id, payload, status, response, answered_via, created_at, answered_at, execution_id, execution_agent, execution_step, execution_model`

func scanUserQuestion(scanner interface {
	Scan(dest ...any) error
}) (UserQuestion, error) {
	var q UserQuestion
	var payload string
	var response sql.NullString
	var answeredVia sql.NullString
	var answeredAt sql.NullInt64
	var execID, execAgent, execModel sql.NullString
	var execStep sql.NullInt64
	if err := scanner.Scan(
		&q.ID, &q.TaskID, &payload, &q.Status,
		&response, &answeredVia, &q.CreatedAt, &answeredAt,
		&execID, &execAgent, &execStep, &execModel,
	); err != nil {
		return UserQuestion{}, err
	}
	q.Payload = json.RawMessage(payload)
	if response.Valid && response.String != "" {
		q.Response = json.RawMessage(response.String)
	}
	if answeredVia.Valid {
		s := answeredVia.String
		q.AnsweredVia = &s
	}
	if answeredAt.Valid {
		v := answeredAt.Int64
		q.AnsweredAt = &v
	}
	if execID.Valid && execID.String != "" {
		s := execID.String
		q.ExecutionID = &s
	}
	if execAgent.Valid && execAgent.String != "" {
		s := execAgent.String
		q.ExecutionAgent = &s
	}
	if execStep.Valid {
		step := int(execStep.Int64)
		q.ExecutionStep = &step
	}
	if execModel.Valid && execModel.String != "" {
		s := execModel.String
		q.ExecutionModel = &s
	}
	return q, nil
}

func (s *Store) InsertUserQuestion(ctx context.Context, q UserQuestion) error {
	if q.Status == "" {
		q.Status = UQStatusPending
	}
	payload := string(q.Payload)
	if payload == "" {
		payload = "{}"
	}
	var response any
	if len(q.Response) > 0 {
		response = string(q.Response)
	}
	var answeredVia any
	if q.AnsweredVia != nil {
		answeredVia = *q.AnsweredVia
	}
	var answeredAt any
	if q.AnsweredAt != nil {
		answeredAt = *q.AnsweredAt
	}
	var execID, execAgent, execModel any
	if q.ExecutionID != nil {
		execID = *q.ExecutionID
	}
	if q.ExecutionAgent != nil {
		execAgent = *q.ExecutionAgent
	}
	var execStep any
	if q.ExecutionStep != nil {
		execStep = *q.ExecutionStep
	}
	if q.ExecutionModel != nil {
		execModel = *q.ExecutionModel
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO user_questions (
			id, task_id, payload, status, response, answered_via, created_at, answered_at,
			execution_id, execution_agent, execution_step, execution_model
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		q.ID, q.TaskID, payload, q.Status, response, answeredVia, q.CreatedAt, answeredAt,
		execID, execAgent, execStep, execModel,
	)
	if err != nil {
		return fmt.Errorf("insert user question: %w", err)
	}
	return nil
}

func (s *Store) GetUserQuestion(ctx context.Context, id string) (UserQuestion, error) {
	row := s.db.QueryRowContext(ctx, `SELECT `+userQuestionColumns+` FROM user_questions WHERE id = ?`, id)
	q, err := scanUserQuestion(row)
	if errors.Is(err, sql.ErrNoRows) {
		return UserQuestion{}, ErrNotFound
	}
	if err != nil {
		return UserQuestion{}, fmt.Errorf("get user question: %w", err)
	}
	return q, nil
}

// ListUserQuestionsOpts filters for ListUserQuestions.
type ListUserQuestionsOpts struct {
	Status string // empty = all; typically "pending"
	Limit  int
}

// ListUserQuestions returns user questions ordered by created_at desc, with task title/agent joined.
func (s *Store) ListUserQuestions(ctx context.Context, opts ListUserQuestionsOpts) ([]UserQuestion, error) {
	limit := opts.Limit
	if limit <= 0 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}

	var b strings.Builder
	args := make([]any, 0, 2)
	b.WriteString(`
		SELECT q.id, q.task_id, q.payload, q.status, q.response, q.answered_via, q.created_at, q.answered_at,
			q.execution_id, q.execution_agent, q.execution_step, q.execution_model,
			t.title, t.agent
		FROM user_questions q
		JOIN tasks t ON t.id = q.task_id
		WHERE 1=1`)
	if opts.Status != "" {
		b.WriteString(` AND q.status = ?`)
		args = append(args, opts.Status)
	}
	b.WriteString(` ORDER BY q.created_at DESC LIMIT ?`)
	args = append(args, limit)

	rows, err := s.db.QueryContext(ctx, b.String(), args...)
	if err != nil {
		return nil, fmt.Errorf("list user questions: %w", err)
	}
	defer rows.Close()

	out := make([]UserQuestion, 0)
	for rows.Next() {
		var q UserQuestion
		var payload string
		var response sql.NullString
		var answeredVia sql.NullString
		var answeredAt sql.NullInt64
		var execID, execAgent, execModel sql.NullString
		var execStep sql.NullInt64
		if err := rows.Scan(
			&q.ID, &q.TaskID, &payload, &q.Status,
			&response, &answeredVia, &q.CreatedAt, &answeredAt,
			&execID, &execAgent, &execStep, &execModel,
			&q.TaskTitle, &q.TaskAgent,
		); err != nil {
			return nil, fmt.Errorf("scan user question: %w", err)
		}
		q.Payload = json.RawMessage(payload)
		if response.Valid && response.String != "" {
			q.Response = json.RawMessage(response.String)
		}
		if answeredVia.Valid {
			s := answeredVia.String
			q.AnsweredVia = &s
		}
		if answeredAt.Valid {
			v := answeredAt.Int64
			q.AnsweredAt = &v
		}
		if execID.Valid && execID.String != "" {
			s := execID.String
			q.ExecutionID = &s
		}
		if execAgent.Valid && execAgent.String != "" {
			s := execAgent.String
			q.ExecutionAgent = &s
		}
		if execStep.Valid {
			step := int(execStep.Int64)
			q.ExecutionStep = &step
		}
		if execModel.Valid && execModel.String != "" {
			s := execModel.String
			q.ExecutionModel = &s
		}
		out = append(out, q)
	}
	return out, rows.Err()
}

// CountUserQuestions returns how many user questions match status.
func (s *Store) CountUserQuestions(ctx context.Context, status string) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM user_questions WHERE status = ?`, status,
	).Scan(&n)
	return n, err
}

// ErrAlreadyAnswered is returned when answering a non-pending user question.
var ErrAlreadyAnswered = errors.New("user question already answered")

// AnswerUserQuestion sets status/response/answered_at/answered_via only if still pending.
// Returns ErrNotFound if the row is missing; ErrAlreadyAnswered if no longer pending.
func (s *Store) AnswerUserQuestion(ctx context.Context, id string, response json.RawMessage, via string, answeredAt int64) (UserQuestion, error) {
	resp := string(response)
	if resp == "" {
		resp = `{}`
	}
	res, err := s.db.ExecContext(ctx, `
		UPDATE user_questions
		SET status = ?, response = ?, answered_via = ?, answered_at = ?
		WHERE id = ? AND status = ?`,
		UQStatusAnswered, resp, via, answeredAt, id, UQStatusPending,
	)
	if err != nil {
		return UserQuestion{}, fmt.Errorf("answer user question: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		if _, err := s.GetUserQuestion(ctx, id); errors.Is(err, ErrNotFound) {
			return UserQuestion{}, ErrNotFound
		}
		return UserQuestion{}, ErrAlreadyAnswered
	}
	return s.GetUserQuestion(ctx, id)
}

// ExpireUserQuestion flips a still-pending question to expired.
// Returns ErrNotFound if missing; ErrAlreadyAnswered if no longer pending.
func (s *Store) ExpireUserQuestion(ctx context.Context, id string, via string, answeredAt int64) (UserQuestion, error) {
	res, err := s.db.ExecContext(ctx, `
		UPDATE user_questions
		SET status = ?, answered_via = ?, answered_at = ?
		WHERE id = ? AND status = ?`,
		UQStatusExpired, via, answeredAt, id, UQStatusPending,
	)
	if err != nil {
		return UserQuestion{}, fmt.Errorf("expire user question: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		if _, err := s.GetUserQuestion(ctx, id); errors.Is(err, ErrNotFound) {
			return UserQuestion{}, ErrNotFound
		}
		return UserQuestion{}, ErrAlreadyAnswered
	}
	return s.GetUserQuestion(ctx, id)
}

// ListPendingUserQuestionsOlderThan returns pending questions with created_at < cutoffMs.
func (s *Store) ListPendingUserQuestionsOlderThan(ctx context.Context, cutoffMs int64) ([]UserQuestion, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT `+userQuestionColumns+`
		FROM user_questions
		WHERE status = ? AND created_at < ?
		ORDER BY created_at ASC`, UQStatusPending, cutoffMs)
	if err != nil {
		return nil, fmt.Errorf("list pending user questions older: %w", err)
	}
	defer rows.Close()

	out := make([]UserQuestion, 0)
	for rows.Next() {
		q, err := scanUserQuestion(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, q)
	}
	return out, rows.Err()
}

// ListPendingUserQuestionsForTask returns pending user questions for a task.
func (s *Store) ListPendingUserQuestionsForTask(ctx context.Context, taskID string) ([]UserQuestion, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT `+userQuestionColumns+`
		FROM user_questions
		WHERE task_id = ? AND status = ?
		ORDER BY created_at ASC`, taskID, UQStatusPending)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]UserQuestion, 0)
	for rows.Next() {
		q, err := scanUserQuestion(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, q)
	}
	return out, rows.Err()
}
