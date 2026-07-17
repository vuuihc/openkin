package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
)

// KinMessage is one durable chat message for the Kin agent multi-turn path
// (ADR 0002 P1.5). Tool call payloads are stored as JSON text.
type KinMessage struct {
	Role       string          `json:"role"`
	Content    string          `json:"content,omitempty"`
	Name       string          `json:"name,omitempty"`
	ToolCallID string          `json:"tool_call_id,omitempty"`
	ToolCalls  json.RawMessage `json:"tool_calls,omitempty"` // JSON array or empty
}

// LoadKinMessages returns the durable Kin transcript for a task (idx order).
func (s *Store) LoadKinMessages(ctx context.Context, taskID string) ([]KinMessage, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT role, content, name, tool_call_id, tool_calls
		FROM kin_messages
		WHERE task_id = ?
		ORDER BY idx ASC`, taskID)
	if err != nil {
		return nil, fmt.Errorf("load kin_messages: %w", err)
	}
	defer rows.Close()

	out := make([]KinMessage, 0)
	for rows.Next() {
		var m KinMessage
		var toolCalls string
		if err := rows.Scan(&m.Role, &m.Content, &m.Name, &m.ToolCallID, &toolCalls); err != nil {
			return nil, fmt.Errorf("scan kin_message: %w", err)
		}
		if toolCalls != "" {
			m.ToolCalls = json.RawMessage(toolCalls)
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// ReplaceKinMessages overwrites the durable Kin transcript for a task.
// Empty msgs clears the table for that task.
func (s *Store) ReplaceKinMessages(ctx context.Context, taskID string, msgs []KinMessage) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin kin_messages tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx, `DELETE FROM kin_messages WHERE task_id = ?`, taskID); err != nil {
		return fmt.Errorf("clear kin_messages: %w", err)
	}
	for i, m := range msgs {
		tc := ""
		if len(m.ToolCalls) > 0 {
			tc = string(m.ToolCalls)
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO kin_messages (task_id, idx, role, content, name, tool_call_id, tool_calls)
			VALUES (?, ?, ?, ?, ?, ?, ?)`,
			taskID, i, m.Role, m.Content, m.Name, m.ToolCallID, tc,
		); err != nil {
			return fmt.Errorf("insert kin_message: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit kin_messages: %w", err)
	}
	return nil
}

// ClearKinMessages drops the durable transcript (agent handoff / interrupt).
func (s *Store) ClearKinMessages(ctx context.Context, taskID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM kin_messages WHERE task_id = ?`, taskID)
	if err != nil {
		return fmt.Errorf("clear kin_messages: %w", err)
	}
	return nil
}

// SearchEvents finds event rows whose payload contains q (case-insensitive),
// optionally scoped to one task. Used by session_search (ADR 0002 P2).
type EventHit struct {
	TaskID  string          `json:"task_id"`
	Seq     int             `json:"seq"`
	TS      int64           `json:"ts"`
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
	Snippet string          `json:"snippet"`
}

// SearchEvents returns up to limit events matching q. taskID empty → all tasks.
func (s *Store) SearchEvents(ctx context.Context, taskID, q string, limit int) ([]EventHit, error) {
	q = trimSearch(q)
	if q == "" {
		return nil, fmt.Errorf("query is required")
	}
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}
	// instr() is literal (no LIKE wildcards), so "_" in identifiers matches.
	var rows *sql.Rows
	var err error
	if taskID != "" {
		rows, err = s.db.QueryContext(ctx, `
			SELECT task_id, seq, ts, type, payload
			FROM events
			WHERE task_id = ? AND instr(lower(payload), lower(?)) > 0
			ORDER BY seq DESC
			LIMIT ?`, taskID, q, limit)
	} else {
		rows, err = s.db.QueryContext(ctx, `
			SELECT task_id, seq, ts, type, payload
			FROM events
			WHERE instr(lower(payload), lower(?)) > 0
			ORDER BY ts DESC, seq DESC
			LIMIT ?`, q, limit)
	}
	if err != nil {
		return nil, fmt.Errorf("search events: %w", err)
	}
	defer rows.Close()

	out := make([]EventHit, 0)
	for rows.Next() {
		var h EventHit
		var payload string
		if err := rows.Scan(&h.TaskID, &h.Seq, &h.TS, &h.Type, &payload); err != nil {
			return nil, err
		}
		h.Payload = json.RawMessage(payload)
		h.Snippet = snippetAround(payload, q, 160)
		out = append(out, h)
	}
	return out, rows.Err()
}

func trimSearch(q string) string {
	s := strings.TrimSpace(q)
	if len(s) > 120 {
		s = s[:120]
	}
	// Drop unescaped % wildcards only (pathological). Keep "_" so identifiers match.
	s = strings.ReplaceAll(s, "%", "")
	return s
}

func snippetAround(payload, q string, max int) string {
	if max <= 0 {
		max = 160
	}
	lower := make([]byte, len(payload))
	for i := 0; i < len(payload); i++ {
		c := payload[i]
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		lower[i] = c
	}
	ql := make([]byte, len(q))
	for i := 0; i < len(q); i++ {
		c := q[i]
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		ql[i] = c
	}
	idx := indexBytes(lower, ql)
	if idx < 0 {
		if len(payload) <= max {
			return payload
		}
		return payload[:max] + "…"
	}
	start := idx - max/3
	if start < 0 {
		start = 0
	}
	end := start + max
	if end > len(payload) {
		end = len(payload)
		start = end - max
		if start < 0 {
			start = 0
		}
	}
	snip := payload[start:end]
	if start > 0 {
		snip = "…" + snip
	}
	if end < len(payload) {
		snip = snip + "…"
	}
	return snip
}

func indexBytes(hay, needle []byte) int {
	if len(needle) == 0 || len(hay) < len(needle) {
		return -1
	}
	for i := 0; i <= len(hay)-len(needle); i++ {
		ok := true
		for j := 0; j < len(needle); j++ {
			if hay[i+j] != needle[j] {
				ok = false
				break
			}
		}
		if ok {
			return i
		}
	}
	return -1
}
