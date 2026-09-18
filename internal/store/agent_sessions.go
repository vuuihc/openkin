package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/oklog/ulid/v2"
)

const (
	AutoImportPrompt   = "prompt"
	AutoImportEnabled  = "enabled"
	AutoImportDisabled = "disabled"
	KeyAutoImportMode  = "agent_sessions.auto_import_mode"

	maxAgentSessionTitleRunes = 160
)

// NormalizeAutoImportMode validates the explicit local session import policy.
func NormalizeAutoImportMode(value string) (string, error) {
	value = strings.TrimSpace(strings.ToLower(value))
	switch value {
	case "":
		return AutoImportPrompt, nil
	case AutoImportPrompt, AutoImportEnabled, AutoImportDisabled:
		return value, nil
	default:
		return "", fmt.Errorf("agent session auto-import mode must be prompt, enabled, or disabled")
	}
}

// AgentSession is a metadata-only index row for a provider-owned session.
// Transcript content is intentionally not part of this model.
type AgentSession struct {
	ID            string            `json:"id"`
	AgentID       string            `json:"agent_id"`
	ExternalRef   string            `json:"external_ref"`
	SourceURI     string            `json:"-"`
	Title         string            `json:"title"`
	Cwd           string            `json:"cwd"`
	Status        string            `json:"status"`
	Capabilities  []string          `json:"capabilities,omitempty"`
	Metadata      map[string]string `json:"metadata,omitempty"`
	SourceCursor  string            `json:"source_cursor,omitempty"`
	ContentDigest string            `json:"content_digest,omitempty"`
	FirstSeenAt   int64             `json:"first_seen_at"`
	LastSeenAt    int64             `json:"last_seen_at"`
	UpdatedAt     int64             `json:"updated_at"`
	Linked        bool              `json:"linked"`
}

// AgentSessionListOpts bounds and filters an indexed session listing.
type AgentSessionListOpts struct {
	AgentID         string
	Query           string
	Cwd             string
	Linked          *bool
	BeforeUpdatedAt int64
	BeforeID        string
	Limit           int
}

// TaskAgentSession binds a provider session to a Kin task.
type TaskAgentSession struct {
	ID             string        `json:"id"`
	TaskID         string        `json:"task_id"`
	AgentSessionID string        `json:"agent_session_id"`
	Role           string        `json:"role"`
	State          string        `json:"state"`
	WorkspaceID    string        `json:"workspace_id,omitempty"`
	FirstTurnSeq   int           `json:"first_turn_seq"`
	LastTurnSeq    int           `json:"last_turn_seq"`
	AttachedAt     int64         `json:"attached_at"`
	DetachedAt     *int64        `json:"detached_at,omitempty"`
	LastError      string        `json:"last_error,omitempty"`
	AgentSession   *AgentSession `json:"agent_session,omitempty"`
}

func normalizeAgentSession(s AgentSession, now int64) (AgentSession, error) {
	s.AgentID = strings.TrimSpace(s.AgentID)
	s.ExternalRef = strings.TrimSpace(s.ExternalRef)
	if s.AgentID == "" || s.ExternalRef == "" {
		return AgentSession{}, fmt.Errorf("agent_id and external_ref are required")
	}
	if s.ID == "" {
		s.ID = ulid.Make().String()
	}
	if s.Status == "" {
		s.Status = "unknown"
	}
	if s.Title == "" {
		s.Title = s.ExternalRef
	}
	if runes := []rune(strings.TrimSpace(s.Title)); len(runes) > maxAgentSessionTitleRunes {
		s.Title = string(runes[:maxAgentSessionTitleRunes-1]) + "…"
	} else {
		s.Title = string(runes)
	}
	if s.FirstSeenAt <= 0 {
		s.FirstSeenAt = now
	}
	if s.LastSeenAt <= 0 {
		s.LastSeenAt = now
	}
	if s.UpdatedAt <= 0 {
		s.UpdatedAt = now
	}
	if s.Capabilities == nil {
		s.Capabilities = []string{}
	}
	if s.Metadata == nil {
		s.Metadata = map[string]string{}
	}
	return s, nil
}

// UpsertAgentSession inserts or updates one metadata-only provider index row.
func (s *Store) UpsertAgentSession(ctx context.Context, input AgentSession) (AgentSession, error) {
	now := time.Now().UnixMilli()
	input, err := normalizeAgentSession(input, now)
	if err != nil {
		return AgentSession{}, err
	}
	caps, err := json.Marshal(input.Capabilities)
	if err != nil {
		return AgentSession{}, fmt.Errorf("encode session capabilities: %w", err)
	}
	metadata, err := json.Marshal(input.Metadata)
	if err != nil {
		return AgentSession{}, fmt.Errorf("encode session metadata: %w", err)
	}
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO agent_sessions (
			id, agent_id, external_ref, source_uri, title, cwd, status,
			capabilities, metadata, source_cursor, content_digest,
			first_seen_at, last_seen_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(agent_id, external_ref) DO UPDATE SET
			source_uri = excluded.source_uri,
			title = excluded.title,
			cwd = excluded.cwd,
			status = excluded.status,
			capabilities = excluded.capabilities,
			metadata = excluded.metadata,
			source_cursor = excluded.source_cursor,
			content_digest = excluded.content_digest,
			last_seen_at = excluded.last_seen_at,
			updated_at = excluded.updated_at
	`, input.ID, input.AgentID, input.ExternalRef, input.SourceURI, input.Title,
		input.Cwd, input.Status, string(caps), string(metadata), input.SourceCursor,
		input.ContentDigest, input.FirstSeenAt, input.LastSeenAt, input.UpdatedAt)
	if err != nil {
		return AgentSession{}, fmt.Errorf("upsert agent session: %w", err)
	}
	return s.GetAgentSession(ctx, input.AgentID, input.ExternalRef)
}

// GetAgentSession loads a provider session by its namespaced external ID.
func (s *Store) GetAgentSession(ctx context.Context, agentID, externalRef string) (AgentSession, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, agent_id, external_ref, source_uri, title, cwd, status,
		       capabilities, metadata, source_cursor, content_digest,
		       first_seen_at, last_seen_at, updated_at,
		       EXISTS (
		         SELECT 1 FROM task_agent_sessions b
		         WHERE b.agent_session_id = agent_sessions.id
		           AND b.state = 'attached'
		       )
		FROM agent_sessions
		WHERE agent_id = ? AND external_ref = ?
	`, strings.TrimSpace(agentID), strings.TrimSpace(externalRef))
	return scanAgentSession(row)
}

// GetAgentSessionByID loads an indexed session by Kin row ID.
func (s *Store) GetAgentSessionByID(ctx context.Context, id string) (AgentSession, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, agent_id, external_ref, source_uri, title, cwd, status,
		       capabilities, metadata, source_cursor, content_digest,
		       first_seen_at, last_seen_at, updated_at,
		       EXISTS (
		         SELECT 1 FROM task_agent_sessions b
		         WHERE b.agent_session_id = agent_sessions.id
		           AND b.state = 'attached'
		       )
		FROM agent_sessions WHERE id = ?
	`, id)
	return scanAgentSession(row)
}

// ListAgentSessions returns bounded metadata rows ordered by source freshness.
func (s *Store) ListAgentSessions(ctx context.Context, opts AgentSessionListOpts) ([]AgentSession, error) {
	limit := opts.Limit
	if limit <= 0 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}
	args := make([]any, 0, 8)
	where := []string{"1 = 1"}
	if v := strings.TrimSpace(opts.AgentID); v != "" {
		where = append(where, "s.agent_id = ?")
		args = append(args, v)
	}
	if v := strings.TrimSpace(opts.Cwd); v != "" {
		where = append(where, "s.cwd = ?")
		args = append(args, v)
	}
	if v := strings.TrimSpace(opts.Query); v != "" {
		where = append(where, "(LOWER(s.title) LIKE LOWER(?) OR LOWER(s.cwd) LIKE LOWER(?) OR LOWER(s.agent_id) LIKE LOWER(?))")
		pattern := "%" + v + "%"
		args = append(args, pattern, pattern, pattern)
	}
	if opts.Linked != nil {
		want := 0
		if *opts.Linked {
			want = 1
		}
		where = append(where, fmt.Sprintf(`EXISTS (
			SELECT 1 FROM task_agent_sessions bx
			WHERE bx.agent_session_id = s.id AND bx.state = 'attached'
		) = %d`, want))
	}
	if opts.BeforeUpdatedAt > 0 {
		if opts.BeforeID != "" {
			where = append(where, "(s.updated_at < ? OR (s.updated_at = ? AND s.id < ?))")
			args = append(args, opts.BeforeUpdatedAt, opts.BeforeUpdatedAt, opts.BeforeID)
		} else {
			where = append(where, "s.updated_at < ?")
			args = append(args, opts.BeforeUpdatedAt)
		}
	}
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, `
		SELECT s.id, s.agent_id, s.external_ref, s.source_uri, s.title, s.cwd,
		       s.status, s.capabilities, s.metadata, s.source_cursor,
		       s.content_digest, s.first_seen_at, s.last_seen_at, s.updated_at,
		       EXISTS (
		         SELECT 1 FROM task_agent_sessions b
		         WHERE b.agent_session_id = s.id AND b.state = 'attached'
		       )
		FROM agent_sessions s
		WHERE `+strings.Join(where, " AND ")+`
		ORDER BY s.updated_at DESC, s.id DESC
		LIMIT ?
	`, args...)
	if err != nil {
		return nil, fmt.Errorf("list agent sessions: %w", err)
	}
	defer rows.Close()
	out := make([]AgentSession, 0)
	for rows.Next() {
		item, err := scanAgentSession(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func scanAgentSession(row interface{ Scan(...any) error }) (AgentSession, error) {
	var out AgentSession
	var capsRaw, metadataRaw string
	if err := row.Scan(
		&out.ID, &out.AgentID, &out.ExternalRef, &out.SourceURI, &out.Title,
		&out.Cwd, &out.Status, &capsRaw, &metadataRaw, &out.SourceCursor,
		&out.ContentDigest, &out.FirstSeenAt, &out.LastSeenAt, &out.UpdatedAt,
		&out.Linked,
	); err != nil {
		if err == sql.ErrNoRows {
			return AgentSession{}, ErrNotFound
		}
		return AgentSession{}, fmt.Errorf("scan agent session: %w", err)
	}
	if err := json.Unmarshal([]byte(capsRaw), &out.Capabilities); err != nil {
		return AgentSession{}, fmt.Errorf("decode session capabilities: %w", err)
	}
	if err := json.Unmarshal([]byte(metadataRaw), &out.Metadata); err != nil {
		return AgentSession{}, fmt.Errorf("decode session metadata: %w", err)
	}
	return out, nil
}

// InsertTaskAgentSession records a binding without copying provider history.
func (s *Store) InsertTaskAgentSession(ctx context.Context, binding TaskAgentSession) (TaskAgentSession, error) {
	binding.TaskID = strings.TrimSpace(binding.TaskID)
	binding.AgentSessionID = strings.TrimSpace(binding.AgentSessionID)
	if binding.TaskID == "" || binding.AgentSessionID == "" {
		return TaskAgentSession{}, fmt.Errorf("task_id and agent_session_id are required")
	}
	if binding.ID == "" {
		binding.ID = ulid.Make().String()
	}
	if binding.Role == "" {
		binding.Role = "host"
	}
	if binding.State == "" {
		binding.State = "attached"
	}
	if binding.AttachedAt <= 0 {
		binding.AttachedAt = time.Now().UnixMilli()
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO task_agent_sessions (
			id, task_id, agent_session_id, role, state, workspace_id,
			first_turn_seq, last_turn_seq, attached_at, detached_at, last_error
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, binding.ID, binding.TaskID, binding.AgentSessionID, binding.Role, binding.State,
		binding.WorkspaceID, binding.FirstTurnSeq, binding.LastTurnSeq,
		binding.AttachedAt, binding.DetachedAt, binding.LastError)
	if err != nil {
		return TaskAgentSession{}, fmt.Errorf("insert task agent session: %w", err)
	}
	return binding, nil
}

// DetachTaskAgentSessions closes active host bindings when a task hands off
// away from its native provider session.
func (s *Store) DetachTaskAgentSessions(ctx context.Context, taskID, reason string) error {
	now := time.Now().UnixMilli()
	_, err := s.db.ExecContext(ctx, `
		UPDATE task_agent_sessions
		SET state = 'detached', detached_at = ?, last_error = ?
		WHERE task_id = ? AND role = 'host' AND state = 'attached'
	`, now, strings.TrimSpace(reason), strings.TrimSpace(taskID))
	if err != nil {
		return fmt.Errorf("detach task agent sessions: %w", err)
	}
	return nil
}

// ListTaskAgentSessions lists all current and historical bindings for a task.
func (s *Store) ListTaskAgentSessions(ctx context.Context, taskID string) ([]TaskAgentSession, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT b.id, b.task_id, b.agent_session_id, b.role, b.state,
		       b.workspace_id, b.first_turn_seq, b.last_turn_seq,
		       b.attached_at, b.detached_at, b.last_error
		FROM task_agent_sessions b
		WHERE b.task_id = ?
		ORDER BY b.attached_at DESC, b.id DESC
	`, taskID)
	if err != nil {
		return nil, fmt.Errorf("list task agent sessions: %w", err)
	}
	defer rows.Close()
	out := make([]TaskAgentSession, 0)
	for rows.Next() {
		var item TaskAgentSession
		if err := rows.Scan(&item.ID, &item.TaskID, &item.AgentSessionID, &item.Role,
			&item.State, &item.WorkspaceID, &item.FirstTurnSeq, &item.LastTurnSeq,
			&item.AttachedAt, &item.DetachedAt, &item.LastError); err != nil {
			return nil, fmt.Errorf("scan task agent session: %w", err)
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, fmt.Errorf("close task agent sessions: %w", err)
	}
	// Store uses one SQLite connection. Load the referenced metadata only after
	// closing the result set, otherwise the nested query waits for itself.
	for i := range out {
		session, err := s.GetAgentSessionByID(ctx, out[i].AgentSessionID)
		if err == nil {
			out[i].AgentSession = &session
		} else if err != ErrNotFound {
			return nil, err
		}
	}
	return out, nil
}
