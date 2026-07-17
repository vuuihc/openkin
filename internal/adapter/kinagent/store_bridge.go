package kinagent

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/vuuihc/kin/internal/provider"
	"github.com/vuuihc/kin/internal/store"
)

// StoreTranscript adapts *store.Store to TranscriptStore + SessionSearcher.
type StoreTranscript struct {
	Store *store.Store
}

// LoadKinMessages implements TranscriptStore.
func (s StoreTranscript) LoadKinMessages(ctx context.Context, taskID string) ([]provider.Message, error) {
	if s.Store == nil {
		return nil, nil
	}
	rows, err := s.Store.LoadKinMessages(ctx, taskID)
	if err != nil {
		return nil, err
	}
	out := make([]provider.Message, 0, len(rows))
	for _, r := range rows {
		m := provider.Message{
			Role:       r.Role,
			Content:    r.Content,
			Name:       r.Name,
			ToolCallID: r.ToolCallID,
		}
		if len(r.ToolCalls) > 0 {
			var tcs []provider.ToolCall
			if err := json.Unmarshal(r.ToolCalls, &tcs); err == nil {
				m.ToolCalls = tcs
			}
		}
		out = append(out, m)
	}
	return out, nil
}

// SaveKinMessages implements TranscriptStore.
func (s StoreTranscript) SaveKinMessages(ctx context.Context, taskID string, msgs []provider.Message) error {
	if s.Store == nil {
		return nil
	}
	rows := make([]store.KinMessage, 0, len(msgs))
	for _, m := range msgs {
		// Skip system — re-bound each Start from defaultSystemPrompt.
		if m.Role == provider.RoleSystem {
			continue
		}
		row := store.KinMessage{
			Role:       m.Role,
			Content:    m.Content,
			Name:       m.Name,
			ToolCallID: m.ToolCallID,
		}
		if len(m.ToolCalls) > 0 {
			raw, err := json.Marshal(m.ToolCalls)
			if err == nil {
				row.ToolCalls = raw
			}
		}
		rows = append(rows, row)
	}
	return s.Store.ReplaceKinMessages(ctx, taskID, rows)
}

// Search implements SessionSearcher for the session_search tool.
func (s StoreTranscript) Search(ctx context.Context, taskID, query string, limit int) (string, error) {
	if s.Store == nil {
		return "", fmt.Errorf("store not configured")
	}
	hits, err := s.Store.SearchEvents(ctx, taskID, query, limit)
	if err != nil {
		return "", err
	}
	if len(hits) == 0 {
		return "(no matches)", nil
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%d hit(s) for %q:\n", len(hits), query)
	for i, h := range hits {
		fmt.Fprintf(&b, "\n[%d] task=%s seq=%d type=%s\n%s\n", i+1, h.TaskID, h.Seq, h.Type, h.Snippet)
	}
	return b.String(), nil
}
