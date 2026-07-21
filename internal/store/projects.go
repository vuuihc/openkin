package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"
)

// Project mode values (ADR 0008).
const (
	ProjectModeShip     = "ship"
	ProjectModeLearn    = "learn"
	ProjectModeExplore  = "explore"
	ProjectModeMaintain = "maintain"
)

// Project status values.
const (
	ProjectActive   = "active"
	ProjectArchived = "archived"
)

// Soft progress ladder (no percentages).
const (
	SoftProgressFog        = "fog"
	SoftProgressCanExplain = "can_explain"
	SoftProgressCanBuild   = "can_build"
	SoftProgressCanShip    = "can_ship"
	SoftProgressCanTeach   = "can_teach"
)

// Project is a row in the projects table.
type Project struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Mode         string   `json:"mode"`
	Status       string   `json:"status"`
	OnePagerRel  string   `json:"-"`
	SoftProgress string   `json:"soft_progress,omitempty"`
	CreatedAt    int64    `json:"created_at"`
	UpdatedAt    int64    `json:"updated_at"`
	LastActiveAt int64    `json:"last_active_at"`
	Roots        []string `json:"roots,omitempty"`
}

// ProjectPatch is a partial update for projects.
type ProjectPatch struct {
	Name         *string
	Mode         *string
	Status       *string
	SoftProgress *string
	// TouchLastActive sets last_active_at to now when true.
	TouchLastActive bool
}

const projectColumns = "id, name, mode, status, one_pager_rel, soft_progress, created_at, updated_at, last_active_at"

func scanProject(scanner interface {
	Scan(dest ...any) error
}) (Project, error) {
	var p Project
	var soft sql.NullString
	if err := scanner.Scan(
		&p.ID, &p.Name, &p.Mode, &p.Status, &p.OnePagerRel, &soft,
		&p.CreatedAt, &p.UpdatedAt, &p.LastActiveAt,
	); err != nil {
		return Project{}, err
	}
	if soft.Valid {
		p.SoftProgress = soft.String
	}
	return p, nil
}

// ValidProjectMode reports whether mode is known.
func ValidProjectMode(mode string) bool {
	switch mode {
	case ProjectModeShip, ProjectModeLearn, ProjectModeExplore, ProjectModeMaintain:
		return true
	default:
		return false
	}
}

// InsertProject inserts a project and optional roots in one transaction.
func (s *Store) InsertProject(ctx context.Context, p Project, roots []string) error {
	if p.ID == "" || p.Name == "" || p.OnePagerRel == "" {
		return fmt.Errorf("project id, name, and one_pager_rel are required")
	}
	if !ValidProjectMode(p.Mode) {
		return fmt.Errorf("invalid project mode %q", p.Mode)
	}
	if p.Status == "" {
		p.Status = ProjectActive
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin insert project: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var soft any
	if p.SoftProgress != "" {
		soft = p.SoftProgress
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO projects (
			id, name, mode, status, one_pager_rel, soft_progress,
			created_at, updated_at, last_active_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, p.ID, p.Name, p.Mode, p.Status, p.OnePagerRel, soft,
		p.CreatedAt, p.UpdatedAt, p.LastActiveAt)
	if err != nil {
		return fmt.Errorf("insert project: %w", err)
	}
	for _, root := range roots {
		root = strings.TrimSpace(root)
		if root == "" {
			continue
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO project_roots (project_id, path) VALUES (?, ?)
		`, p.ID, root); err != nil {
			return fmt.Errorf("insert project root: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit insert project: %w", err)
	}
	return nil
}

// GetProject returns a project with roots.
func (s *Store) GetProject(ctx context.Context, id string) (Project, error) {
	row := s.db.QueryRowContext(ctx, `SELECT `+projectColumns+` FROM projects WHERE id = ?`, id)
	p, err := scanProject(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Project{}, ErrNotFound
	}
	if err != nil {
		return Project{}, fmt.Errorf("get project: %w", err)
	}
	roots, err := s.listProjectRoots(ctx, id)
	if err != nil {
		return Project{}, err
	}
	p.Roots = roots
	return p, nil
}

func (s *Store) listProjectRoots(ctx context.Context, projectID string) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT path FROM project_roots WHERE project_id = ? ORDER BY path
	`, projectID)
	if err != nil {
		return nil, fmt.Errorf("list project roots: %w", err)
	}
	defer rows.Close()
	out := make([]string, 0)
	for rows.Next() {
		var path string
		if err := rows.Scan(&path); err != nil {
			return nil, err
		}
		out = append(out, path)
	}
	return out, rows.Err()
}

// ListProjectsOpts filters for ListProjects.
type ListProjectsOpts struct {
	Status string // empty = all; typically "active"
	Limit  int
}

// ListProjects returns projects ordered by last_active_at desc.
func (s *Store) ListProjects(ctx context.Context, opts ListProjectsOpts) ([]Project, error) {
	limit := opts.Limit
	if limit <= 0 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}
	var b strings.Builder
	args := make([]any, 0, 2)
	b.WriteString(`SELECT ` + projectColumns + ` FROM projects WHERE 1=1`)
	if opts.Status != "" {
		b.WriteString(` AND status = ?`)
		args = append(args, opts.Status)
	}
	b.WriteString(` ORDER BY last_active_at DESC LIMIT ?`)
	args = append(args, limit)

	rows, err := s.db.QueryContext(ctx, b.String(), args...)
	if err != nil {
		return nil, fmt.Errorf("list projects: %w", err)
	}
	defer rows.Close()

	out := make([]Project, 0)
	for rows.Next() {
		p, err := scanProject(rows)
		if err != nil {
			return nil, fmt.Errorf("scan project: %w", err)
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// Load roots after closing the project rows (single-conn SQLite).
	for i := range out {
		roots, err := s.listProjectRoots(ctx, out[i].ID)
		if err != nil {
			return nil, err
		}
		out[i].Roots = roots
	}
	return out, nil
}

// UpdateProject applies a patch.
func (s *Store) UpdateProject(ctx context.Context, id string, patch ProjectPatch) (Project, error) {
	cur, err := s.GetProject(ctx, id)
	if err != nil {
		return Project{}, err
	}
	now := time.Now().UnixMilli()
	name := cur.Name
	mode := cur.Mode
	status := cur.Status
	soft := cur.SoftProgress
	lastActive := cur.LastActiveAt
	if patch.Name != nil {
		name = strings.TrimSpace(*patch.Name)
		if name == "" {
			return Project{}, fmt.Errorf("name cannot be empty")
		}
	}
	if patch.Mode != nil {
		if !ValidProjectMode(*patch.Mode) {
			return Project{}, fmt.Errorf("invalid project mode %q", *patch.Mode)
		}
		mode = *patch.Mode
	}
	if patch.Status != nil {
		switch *patch.Status {
		case ProjectActive, ProjectArchived:
			status = *patch.Status
		default:
			return Project{}, fmt.Errorf("invalid project status %q", *patch.Status)
		}
	}
	if patch.SoftProgress != nil {
		soft = strings.TrimSpace(*patch.SoftProgress)
	}
	if patch.TouchLastActive {
		lastActive = now
	}
	var softArg any
	if soft != "" {
		softArg = soft
	}
	_, err = s.db.ExecContext(ctx, `
		UPDATE projects SET name = ?, mode = ?, status = ?, soft_progress = ?,
			updated_at = ?, last_active_at = ?
		WHERE id = ?
	`, name, mode, status, softArg, now, lastActive, id)
	if err != nil {
		return Project{}, fmt.Errorf("update project: %w", err)
	}
	return s.GetProject(ctx, id)
}

// SetProjectRoots replaces all roots for a project.
func (s *Store) SetProjectRoots(ctx context.Context, projectID string, roots []string) error {
	if _, err := s.GetProject(ctx, projectID); err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `DELETE FROM project_roots WHERE project_id = ?`, projectID); err != nil {
		return fmt.Errorf("clear project roots: %w", err)
	}
	for _, root := range roots {
		root = strings.TrimSpace(root)
		if root == "" {
			continue
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO project_roots (project_id, path) VALUES (?, ?)
		`, projectID, root); err != nil {
			return fmt.Errorf("insert project root: %w", err)
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE projects SET updated_at = ? WHERE id = ?`, time.Now().UnixMilli(), projectID); err != nil {
		return err
	}
	return tx.Commit()
}

// FindProjectByRoot returns a project whose roots contain path (exact match).
func (s *Store) FindProjectByRoot(ctx context.Context, path string) (Project, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return Project{}, ErrNotFound
	}
	if abs, err := filepath.Abs(path); err == nil {
		path = abs
	}
	var id string
	err := s.db.QueryRowContext(ctx, `
		SELECT project_id FROM project_roots WHERE path = ? LIMIT 1
	`, path).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return Project{}, ErrNotFound
	}
	if err != nil {
		return Project{}, fmt.Errorf("find project by root: %w", err)
	}
	return s.GetProject(ctx, id)
}

// TouchProjectActivity bumps last_active_at.
func (s *Store) TouchProjectActivity(ctx context.Context, id string) error {
	_, err := s.UpdateProject(ctx, id, ProjectPatch{TouchLastActive: true})
	return err
}

// AttachTasksByCwd sets project_id for tasks with matching cwd and null project_id.
func (s *Store) AttachTasksByCwd(ctx context.Context, projectID, cwd string) error {
	if projectID == "" || cwd == "" {
		return fmt.Errorf("project id and cwd required")
	}
	if abs, err := filepath.Abs(cwd); err == nil {
		cwd = abs
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE tasks SET project_id = ?
		WHERE project_id IS NULL AND cwd = ?
	`, projectID, cwd)
	if err != nil {
		return fmt.Errorf("attach tasks by cwd: %w", err)
	}
	return nil
}

// ResolveProjectIDForCwd returns project id for exact root match, or empty.
func (s *Store) ResolveProjectIDForCwd(ctx context.Context, cwd string) (string, error) {
	cwd = strings.TrimSpace(cwd)
	if abs, err := filepath.Abs(cwd); err == nil {
		cwd = abs
	}
	p, err := s.FindProjectByRoot(ctx, cwd)
	if errors.Is(err, ErrNotFound) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return p.ID, nil
}

// ListTasksForProject returns tasks linked by project_id or matching any root cwd.
func (s *Store) ListTasksForProject(ctx context.Context, projectID string, roots []string, limit int) ([]Task, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	args := make([]any, 0, 2+len(roots))
	var b strings.Builder
	b.WriteString(`SELECT ` + taskColumns + ` FROM tasks WHERE (project_id = ?`)
	args = append(args, projectID)
	for _, root := range roots {
		root = strings.TrimSpace(root)
		if root == "" {
			continue
		}
		if abs, err := filepath.Abs(root); err == nil {
			root = abs
		}
		b.WriteString(` OR (project_id IS NULL AND cwd = ?)`)
		args = append(args, root)
	}
	b.WriteString(`) ORDER BY id DESC LIMIT ?`)
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, b.String(), args...)
	if err != nil {
		return nil, fmt.Errorf("list tasks for project: %w", err)
	}
	defer rows.Close()
	out := make([]Task, 0)
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}
