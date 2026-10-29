package store

import (
	"context"
	"fmt"
	"strings"
)

// TranscriptHit is one message from a session's transcript that matched a
// query, with the line around the match.
//
// It is not `EventHit`: that one is the agent's `session_search` tool, which
// searches raw event payloads and wants the JSON to reason about. This one is
// for a person looking at a list — the text is decoded, the role named, and the
// snippet is prose rather than `\"text\":\"…`.
type TranscriptHit struct {
	TaskID    string `json:"task_id"`
	TaskTitle string `json:"task_title"`
	Seq       int64  `json:"seq"`
	TS        int64  `json:"ts"`
	Role      string `json:"role"`
	Snippet   string `json:"snippet"`
}

// TranscriptSearchOpts is one question about the whole library, or one task's.
type TranscriptSearchOpts struct {
	Query string
	// TaskID narrows the search to one session; empty searches them all.
	TaskID string
	Limit  int
	Scope  TaskScope
}

const (
	transcriptDefaultLimit = 20
	transcriptMaxLimit     = 50
	transcriptSnippetChars = 160
)

// SearchTranscript finds the messages that contain q and returns them newest
// first.
//
// It reads the derived `transcript_messages` table rather than the event log:
// streaming adapters store every delta as its own event, and a search over
// those answers with fragments (`ploy the release`) and one row per chunk. The
// index holds the text the console actually draws — chat bubbles and the note
// rows inside a process card, both of which the find bar reaches — one row per
// message. That makes the match a plain substring test over prose: no JSON
// keys, no escaped quotes, nothing to re-verify in Go.
func (s *Store) SearchTranscript(ctx context.Context, opts TranscriptSearchOpts) ([]TranscriptHit, bool, error) {
	q := strings.TrimSpace(opts.Query)
	if q == "" {
		return nil, false, fmt.Errorf("query is required")
	}
	// The match runs over the raw text, but the snippet is cut from
	// whitespace-collapsed text. Its needle has to be collapsed too, or a query
	// with a run of spaces would match the row and then be searched for in a
	// string that no longer contains it.
	needle := collapseWhitespace(q)
	limit := opts.Limit
	if limit <= 0 {
		limit = transcriptDefaultLimit
	}
	if limit > transcriptMaxLimit {
		limit = transcriptMaxLimit
	}

	var b strings.Builder
	args := make([]any, 0, 6)
	b.WriteString(`
		SELECT m.task_id, t.title, m.first_seq, m.ts, m.role, m.text
		FROM transcript_messages m
		JOIN tasks t ON t.id = m.task_id
		WHERE instr(lower(m.text), lower(?)) > 0`)
	args = append(args, q)
	scopeCond, scopeArgs := opts.Scope.predicate("t")
	b.WriteString(` AND ` + scopeCond)
	args = append(args, scopeArgs...)
	if opts.TaskID != "" {
		b.WriteString(` AND m.task_id = ?`)
		args = append(args, opts.TaskID)
	}
	// One row past the answer is what tells the caller the list was cut short.
	b.WriteString(` ORDER BY m.ts DESC, m.last_seq DESC LIMIT ?`)
	args = append(args, limit+1)

	rows, err := s.db.QueryContext(ctx, b.String(), args...)
	if err != nil {
		return nil, false, fmt.Errorf("search transcript: %w", err)
	}
	defer rows.Close()

	out := make([]TranscriptHit, 0, limit)
	truncated := false
	for rows.Next() {
		var hit TranscriptHit
		var text string
		if err := rows.Scan(&hit.TaskID, &hit.TaskTitle, &hit.Seq, &hit.TS, &hit.Role, &text); err != nil {
			return nil, false, err
		}
		if len(out) == limit {
			truncated = true
			break
		}
		hit.Snippet = snippetAround(collapseWhitespace(text), needle, transcriptSnippetChars)
		out = append(out, hit)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	return out, truncated, nil
}

func collapseWhitespace(s string) string {
	return strings.Join(strings.Fields(s), " ")
}
