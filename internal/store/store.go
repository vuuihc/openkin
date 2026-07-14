package store

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

// Store is the SQLite persistence layer.
type Store struct {
	db *sql.DB
}

// Open opens (or creates) the database at path and applies pending migrations.
func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}

	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	// Single-writer friendly settings for a local daemon.
	if _, err := db.Exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;`); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("pragma: %w", err)
	}

	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

// Close closes the underlying database.
func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

// DB returns the underlying *sql.DB (for tests / later packages).
func (s *Store) DB() *sql.DB { return s.db }

// Task is a row in the tasks table (M0: list only).
type Task struct {
	ID         string  `json:"id"`
	Title      string  `json:"title"`
	Agent      string  `json:"agent"`
	Cwd        string  `json:"cwd"`
	Prompt     string  `json:"prompt"`
	Model      *string `json:"model,omitempty"`
	SessionRef *string `json:"session_ref,omitempty"`
	Status     string  `json:"status"`
	ExitCode   *int    `json:"exit_code,omitempty"`
	TokensIn   int     `json:"tokens_in"`
	TokensOut  int     `json:"tokens_out"`
	CostUSD    *float64 `json:"cost_usd,omitempty"`
	CreatedAt  int64   `json:"created_at"`
	StartedAt  *int64  `json:"started_at,omitempty"`
	FinishedAt *int64  `json:"finished_at,omitempty"`
}

// ListTasks returns tasks ordered by created_at descending.
// M0: no filters yet; always returns all rows (empty slice when none).
func (s *Store) ListTasks(ctx context.Context) ([]Task, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, title, agent, cwd, prompt, model, session_ref, status,
		       exit_code, tokens_in, tokens_out, cost_usd,
		       created_at, started_at, finished_at
		FROM tasks
		ORDER BY created_at DESC`)
	if err != nil {
		return nil, fmt.Errorf("list tasks: %w", err)
	}
	defer rows.Close()

	out := make([]Task, 0)
	for rows.Next() {
		var t Task
		var model, sessionRef sql.NullString
		var exitCode sql.NullInt64
		var costUSD sql.NullFloat64
		var startedAt, finishedAt sql.NullInt64
		if err := rows.Scan(
			&t.ID, &t.Title, &t.Agent, &t.Cwd, &t.Prompt,
			&model, &sessionRef, &t.Status,
			&exitCode, &t.TokensIn, &t.TokensOut, &costUSD,
			&t.CreatedAt, &startedAt, &finishedAt,
		); err != nil {
			return nil, fmt.Errorf("scan task: %w", err)
		}
		if model.Valid {
			t.Model = &model.String
		}
		if sessionRef.Valid {
			t.SessionRef = &sessionRef.String
		}
		if exitCode.Valid {
			v := int(exitCode.Int64)
			t.ExitCode = &v
		}
		if costUSD.Valid {
			t.CostUSD = &costUSD.Float64
		}
		if startedAt.Valid {
			t.StartedAt = &startedAt.Int64
		}
		if finishedAt.Valid {
			t.FinishedAt = &finishedAt.Int64
		}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}
