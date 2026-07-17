package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// Artifact kind values.
const (
	ArtifactKindMarkdown = "markdown"
	ArtifactKindHTML     = "html"
	ArtifactKindText     = "text"
)

// Artifact status values.
const (
	ArtifactProposed = "proposed"
	ArtifactSaved    = "saved"
	ArtifactArchived = "archived"
)

// Artifact is a row in the artifacts table, optionally joined with task fields.
type Artifact struct {
	ID           string  `json:"id"`
	Title        string  `json:"title"`
	Kind         string  `json:"kind"`
	RelPath      string  `json:"-"`
	Size         int64   `json:"size"`
	Status       string  `json:"status"`
	SourceTaskID *string `json:"source_task_id,omitempty"`
	CreatedAt    int64   `json:"created_at"`
	UpdatedAt    int64   `json:"updated_at"`
	// Joined from tasks (list endpoint).
	SourceTaskTitle string `json:"source_task_title,omitempty"`
}

const artifactColumns = "id, title, kind, rel_path, size, status, source_task_id, created_at, updated_at"

func scanArtifact(scanner interface {
	Scan(dest ...any) error
}) (Artifact, error) {
	var a Artifact
	var sourceTaskID sql.NullString
	if err := scanner.Scan(
		&a.ID, &a.Title, &a.Kind, &a.RelPath, &a.Size, &a.Status,
		&sourceTaskID, &a.CreatedAt, &a.UpdatedAt,
	); err != nil {
		return Artifact{}, err
	}
	if sourceTaskID.Valid {
		a.SourceTaskID = &sourceTaskID.String
	}
	return a, nil
}

// InsertArtifact inserts a new artifact.
func (s *Store) InsertArtifact(ctx context.Context, a Artifact) error {
	if a.Status == "" {
		a.Status = ArtifactProposed
	}
	if a.CreatedAt == 0 {
		a.CreatedAt = NowMilli()
	}
	if a.UpdatedAt == 0 {
		a.UpdatedAt = NowMilli()
	}
	var sourceTaskID any
	if a.SourceTaskID != nil {
		sourceTaskID = *a.SourceTaskID
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO artifacts (
			id, title, kind, rel_path, size, status, source_task_id, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		a.ID, a.Title, a.Kind, a.RelPath, a.Size, a.Status, sourceTaskID, a.CreatedAt, a.UpdatedAt,
	)
	if err != nil {
		return fmt.Errorf("insert artifact: %w", err)
	}
	return nil
}

// GetArtifact returns a single artifact by id.
func (s *Store) GetArtifact(ctx context.Context, id string) (Artifact, error) {
	row := s.db.QueryRowContext(ctx, `SELECT `+artifactColumns+` FROM artifacts WHERE id = ?`, id)
	a, err := scanArtifact(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Artifact{}, ErrNotFound
	}
	if err != nil {
		return Artifact{}, fmt.Errorf("get artifact: %w", err)
	}
	return a, nil
}

// ListArtifactsOpts filters for ListArtifacts.
type ListArtifactsOpts struct {
	Status string // empty = all
	Limit  int
}

// ListArtifacts returns artifacts ordered by created_at desc, with source task title joined.
func (s *Store) ListArtifacts(ctx context.Context, opts ListArtifactsOpts) ([]Artifact, error) {
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
		SELECT a.id, a.title, a.kind, a.rel_path, a.size, a.status,
		       a.source_task_id, a.created_at, a.updated_at, t.title
		FROM artifacts a
		LEFT JOIN tasks t ON t.id = a.source_task_id
		WHERE 1=1`)
	if opts.Status != "" {
		b.WriteString(` AND a.status = ?`)
		args = append(args, opts.Status)
	}
	b.WriteString(` ORDER BY a.created_at DESC LIMIT ?`)
	args = append(args, limit)

	rows, err := s.db.QueryContext(ctx, b.String(), args...)
	if err != nil {
		return nil, fmt.Errorf("list artifacts: %w", err)
	}
	defer rows.Close()

	out := make([]Artifact, 0)
	for rows.Next() {
		var a Artifact
		var sourceTaskID sql.NullString
		var sourceTaskTitle sql.NullString
		if err := rows.Scan(
			&a.ID, &a.Title, &a.Kind, &a.RelPath, &a.Size, &a.Status,
			&sourceTaskID, &a.CreatedAt, &a.UpdatedAt,
			&sourceTaskTitle,
		); err != nil {
			return nil, fmt.Errorf("scan artifact: %w", err)
		}
		if sourceTaskID.Valid {
			a.SourceTaskID = &sourceTaskID.String
		}
		if sourceTaskTitle.Valid {
			a.SourceTaskTitle = sourceTaskTitle.String
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// UpdateArtifactStatus updates the status and updated_at of an artifact.
// Returns ErrNotFound if the row is missing.
func (s *Store) UpdateArtifactStatus(ctx context.Context, id, status string) (Artifact, error) {
	res, err := s.db.ExecContext(ctx, `
		UPDATE artifacts
		SET status = ?, updated_at = ?
		WHERE id = ?`,
		status, NowMilli(), id,
	)
	if err != nil {
		return Artifact{}, fmt.Errorf("update artifact status: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return Artifact{}, ErrNotFound
	}
	return s.GetArtifact(ctx, id)
}
