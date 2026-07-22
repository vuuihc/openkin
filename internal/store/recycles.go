package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
)

// Recycle batch status.
const (
	RecycleStatusPending  = "pending"
	RecycleStatusResolved = "resolved"
)

// Recycle suggestion status.
const (
	SuggestionPending        = "pending"
	SuggestionAccepted       = "accepted"
	SuggestionAcceptedEdited = "accepted_edited"
	SuggestionIgnored        = "ignored"
)

// RecycleEvidence points back to a task, artifact, or file path.
type RecycleEvidence struct {
	Kind  string `json:"kind"` // task | artifact | file
	ID    string `json:"id,omitempty"`
	Label string `json:"label,omitempty"`
	Path  string `json:"path,omitempty"` // project-relative for file
}

// RecycleSuggestion is one reviewable write-back proposal.
type RecycleSuggestion struct {
	Target     string            `json:"target"`
	Text       string            `json:"text"`
	Reason     string            `json:"reason,omitempty"`
	Evidence   []RecycleEvidence `json:"evidence,omitempty"`
	Confidence string            `json:"confidence,omitempty"` // low | medium | high
	Status     string            `json:"status"`
	FinalText  string            `json:"final_text,omitempty"`
	AcceptedAt *int64            `json:"accepted_at,omitempty"`
	IgnoredAt  *int64            `json:"ignored_at,omitempty"`
}

// ProjectRecycle is one wrap-up batch for a task.
type ProjectRecycle struct {
	ID                    string              `json:"id"`
	ProjectID             string              `json:"project_id"`
	TaskID                string              `json:"task_id"`
	BaseOnePagerUpdatedAt int64               `json:"base_one_pager_updated_at"`
	Summary               string              `json:"summary"`
	Suggestions           []RecycleSuggestion `json:"suggestions"`
	Status                string              `json:"status"`
	CreatedAt             int64               `json:"created_at"`
	ResolvedAt            *int64              `json:"resolved_at,omitempty"`
}

// InsertProjectRecycle stores a new recycle batch.
func (s *Store) InsertProjectRecycle(ctx context.Context, r ProjectRecycle) error {
	if r.ID == "" || r.ProjectID == "" || r.TaskID == "" {
		return fmt.Errorf("recycle id, project_id, and task_id are required")
	}
	if r.Status == "" {
		r.Status = RecycleStatusPending
	}
	raw, err := json.Marshal(r.Suggestions)
	if err != nil {
		return fmt.Errorf("marshal suggestions: %w", err)
	}
	var resolved any
	if r.ResolvedAt != nil {
		resolved = *r.ResolvedAt
	}
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO project_recycles (
			id, project_id, task_id, base_one_pager_updated_at,
			summary, suggestions_json, status, created_at, resolved_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, r.ID, r.ProjectID, r.TaskID, r.BaseOnePagerUpdatedAt,
		r.Summary, string(raw), r.Status, r.CreatedAt, resolved)
	if err != nil {
		return fmt.Errorf("insert project recycle: %w", err)
	}
	return nil
}

// GetProjectRecycle returns a recycle by id.
func (s *Store) GetProjectRecycle(ctx context.Context, id string) (ProjectRecycle, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, project_id, task_id, base_one_pager_updated_at,
		       summary, suggestions_json, status, created_at, resolved_at
		FROM project_recycles WHERE id = ?
	`, id)
	return scanRecycle(row)
}

// GetTaskRecycle returns the latest recycle for a task (pending preferred via ORDER).
func (s *Store) GetTaskRecycle(ctx context.Context, taskID string) (ProjectRecycle, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, project_id, task_id, base_one_pager_updated_at,
		       summary, suggestions_json, status, created_at, resolved_at
		FROM project_recycles
		WHERE task_id = ?
		ORDER BY
			CASE status WHEN 'pending' THEN 0 ELSE 1 END,
			created_at DESC
		LIMIT 1
	`, taskID)
	return scanRecycle(row)
}

// ListProjectRecycles returns recent recycles for a project.
func (s *Store) ListProjectRecycles(ctx context.Context, projectID string, limit int) ([]ProjectRecycle, error) {
	if limit <= 0 {
		limit = 20
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, project_id, task_id, base_one_pager_updated_at,
		       summary, suggestions_json, status, created_at, resolved_at
		FROM project_recycles
		WHERE project_id = ?
		ORDER BY created_at DESC
		LIMIT ?
	`, projectID, limit)
	if err != nil {
		return nil, fmt.Errorf("list project recycles: %w", err)
	}
	defer rows.Close()
	var out []ProjectRecycle
	for rows.Next() {
		r, err := scanRecycle(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ListPendingProjectRecycles returns pending recycles for a project (newest first).
func (s *Store) ListPendingProjectRecycles(ctx context.Context, projectID string, limit int) ([]ProjectRecycle, error) {
	if limit <= 0 {
		limit = 20
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, project_id, task_id, base_one_pager_updated_at,
		       summary, suggestions_json, status, created_at, resolved_at
		FROM project_recycles
		WHERE project_id = ? AND status = ?
		ORDER BY created_at DESC
		LIMIT ?
	`, projectID, RecycleStatusPending, limit)
	if err != nil {
		return nil, fmt.Errorf("list pending recycles: %w", err)
	}
	defer rows.Close()
	var out []ProjectRecycle
	for rows.Next() {
		r, err := scanRecycle(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// DeletePendingRecyclesForTask removes pending batches for a task (replace on regenerate).
func (s *Store) DeletePendingRecyclesForTask(ctx context.Context, taskID string) error {
	_, err := s.db.ExecContext(ctx, `
		DELETE FROM project_recycles WHERE task_id = ? AND status = ?
	`, taskID, RecycleStatusPending)
	if err != nil {
		return fmt.Errorf("delete pending recycles: %w", err)
	}
	return nil
}

// UpdateProjectRecycleSuggestions replaces suggestions_json and optional status.
func (s *Store) UpdateProjectRecycleSuggestions(ctx context.Context, id string, suggestions []RecycleSuggestion, status string, resolvedAt *int64) error {
	raw, err := json.Marshal(suggestions)
	if err != nil {
		return fmt.Errorf("marshal suggestions: %w", err)
	}
	if status == "" {
		status = RecycleStatusPending
	}
	var resolved any
	if resolvedAt != nil {
		resolved = *resolvedAt
	}
	res, err := s.db.ExecContext(ctx, `
		UPDATE project_recycles
		SET suggestions_json = ?, status = ?, resolved_at = ?
		WHERE id = ?
	`, string(raw), status, resolved, id)
	if err != nil {
		return fmt.Errorf("update recycle: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// RecycleIsFullyHandled reports whether every suggestion is non-pending.
func RecycleIsFullyHandled(suggestions []RecycleSuggestion) bool {
	if len(suggestions) == 0 {
		return true
	}
	for _, s := range suggestions {
		if s.Status == "" || s.Status == SuggestionPending {
			return false
		}
	}
	return true
}

// DedupeRecycleSuggestions drops same-batch duplicates by target+normalized text.
// Focus is limited to one entry (last wins). Ordinary targets capped at 3 total.
func DedupeRecycleSuggestions(in []RecycleSuggestion) []RecycleSuggestion {
	seen := map[string]struct{}{}
	var ordinary []RecycleSuggestion
	var focus *RecycleSuggestion
	for _, s := range in {
		s.Target = strings.TrimSpace(strings.ToLower(s.Target))
		s.Text = strings.TrimSpace(s.Text)
		if s.Text == "" || !ValidRecycleTarget(s.Target) {
			continue
		}
		if s.Status == "" {
			s.Status = SuggestionPending
		}
		key := s.Target + "\x00" + normalizeSuggestionText(s.Text)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		if s.Target == RecycleTargetFocus {
			cp := s
			focus = &cp
			continue
		}
		ordinary = append(ordinary, s)
	}
	if len(ordinary) > 3 {
		ordinary = ordinary[:3]
	}
	out := ordinary
	if focus != nil {
		out = append(out, *focus)
	}
	return out
}

type recycleScanner interface {
	Scan(dest ...any) error
}

func scanRecycle(scanner recycleScanner) (ProjectRecycle, error) {
	var r ProjectRecycle
	var suggestionsJSON string
	var resolved sql.NullInt64
	if err := scanner.Scan(
		&r.ID, &r.ProjectID, &r.TaskID, &r.BaseOnePagerUpdatedAt,
		&r.Summary, &suggestionsJSON, &r.Status, &r.CreatedAt, &resolved,
	); err != nil {
		if err == sql.ErrNoRows {
			return ProjectRecycle{}, ErrNotFound
		}
		return ProjectRecycle{}, fmt.Errorf("scan recycle: %w", err)
	}
	if resolved.Valid {
		v := resolved.Int64
		r.ResolvedAt = &v
	}
	if strings.TrimSpace(suggestionsJSON) != "" {
		if err := json.Unmarshal([]byte(suggestionsJSON), &r.Suggestions); err != nil {
			return ProjectRecycle{}, fmt.Errorf("unmarshal suggestions: %w", err)
		}
	}
	if r.Suggestions == nil {
		r.Suggestions = []RecycleSuggestion{}
	}
	return r, nil
}
