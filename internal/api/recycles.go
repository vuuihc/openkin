package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/oklog/ulid/v2"
	"github.com/vuuihc/kin/internal/provider"
	"github.com/vuuihc/kin/internal/store"
)

const (
	maxRecycleSummaryRunes    = 240
	maxRecycleSuggestionRunes = 280
	maxRecycleReasonRunes     = 200
	maxRecycleEvidencePerItem = 4
	recycleGenerationTimeout  = 45 * time.Second
)

// handleCreateTaskRecycle generates or replaces the pending recycle for a task.
func (s *Server) handleCreateTaskRecycle(w http.ResponseWriter, r *http.Request) {
	if !s.projectsConfigured(w) {
		return
	}
	taskID := chi.URLParam(r, "id")
	t, err := s.Store.GetTask(r.Context(), taskID)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "task not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if strings.TrimSpace(t.ProjectID) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "task is not linked to a project"})
		return
	}
	// Require at least one user/agent message so empty tasks cannot wrap up.
	evs, err := s.Store.ListEvents(r.Context(), taskID, 0)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if !taskHasReviewableContent(t, evs) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "task has no messages to recycle yet"})
		return
	}

	p, err := s.Store.GetProject(r.Context(), t.ProjectID)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "project not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	abs, err := s.onePagerAbs(p.OnePagerRel)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	mdBytes, err := os.ReadFile(abs)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "read one-pager: " + err.Error()})
		return
	}
	md := string(mdBytes)
	var baseUpdated int64
	if st, err := os.Stat(abs); err == nil {
		baseUpdated = st.ModTime().UnixMilli()
	}

	if s.ProviderResolve == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "provider not available"})
		return
	}
	cli, _, err := s.ProviderResolve(r.Context())
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "configure a cognition provider in Settings to recycle"})
		return
	}

	transcript := buildRecycleTranscript(t, evs)
	summary, suggestions, genErr := s.generateRecycleSuggestions(r.Context(), cli, p, t, md, transcript)
	if genErr != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "recycle generation failed: " + genErr.Error()})
		return
	}
	suggestions = store.DedupeRecycleSuggestions(suggestions)
	// Attach default task evidence when model omitted it.
	for i := range suggestions {
		if len(suggestions[i].Evidence) == 0 {
			suggestions[i].Evidence = []store.RecycleEvidence{{
				Kind:  "task",
				ID:    t.ID,
				Label: t.Title,
			}}
		}
		if suggestions[i].Status == "" {
			suggestions[i].Status = store.SuggestionPending
		}
	}

	// Replace any pending batch for this task.
	_ = s.Store.DeletePendingRecyclesForTask(r.Context(), taskID)

	now := time.Now().UnixMilli()
	rec := store.ProjectRecycle{
		ID:                    ulid.Make().String(),
		ProjectID:             p.ID,
		TaskID:                t.ID,
		BaseOnePagerUpdatedAt: baseUpdated,
		Summary:               summary,
		Suggestions:           suggestions,
		Status:                store.RecycleStatusPending,
		CreatedAt:             now,
	}
	// Empty suggestion set still creates a resolved-empty batch so UI can show "nothing to write".
	if store.RecycleIsFullyHandled(suggestions) {
		rec.Status = store.RecycleStatusResolved
		rec.ResolvedAt = &now
	}
	if err := s.Store.InsertProjectRecycle(r.Context(), rec); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	_ = s.Store.TouchProjectActivity(r.Context(), p.ID)
	writeJSON(w, http.StatusCreated, rec)
}

func (s *Server) handleGetTaskRecycle(w http.ResponseWriter, r *http.Request) {
	if !s.projectsConfigured(w) {
		return
	}
	taskID := chi.URLParam(r, "id")
	if _, err := s.Store.GetTask(r.Context(), taskID); errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "task not found"})
		return
	} else if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	rec, err := s.Store.GetTaskRecycle(r.Context(), taskID)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no recycle"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, rec)
}

func (s *Server) handleListProjectRecycles(w http.ResponseWriter, r *http.Request) {
	if !s.projectsConfigured(w) {
		return
	}
	id := chi.URLParam(r, "id")
	if _, err := s.Store.GetProject(r.Context(), id); errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	} else if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	limit := 20
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}
	pendingOnly := r.URL.Query().Get("status") == "pending"
	var list []store.ProjectRecycle
	var err error
	if pendingOnly {
		list, err = s.Store.ListPendingProjectRecycles(r.Context(), id, limit)
	} else {
		list, err = s.Store.ListProjectRecycles(r.Context(), id, limit)
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if list == nil {
		list = []store.ProjectRecycle{}
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) handleAcceptRecycleSuggestion(w http.ResponseWriter, r *http.Request) {
	if !s.projectsConfigured(w) {
		return
	}
	recID := chi.URLParam(r, "id")
	idx, err := strconv.Atoi(chi.URLParam(r, "index"))
	if err != nil || idx < 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid suggestion index"})
		return
	}
	var body struct {
		FinalText         string `json:"final_text"`
		OnePagerUpdatedAt int64  `json:"one_pager_updated_at"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}

	rec, err := s.Store.GetProjectRecycle(r.Context(), recID)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "recycle not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if idx >= len(rec.Suggestions) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "suggestion index out of range"})
		return
	}
	sug := rec.Suggestions[idx]

	// Idempotent accept.
	if sug.Status == store.SuggestionAccepted || sug.Status == store.SuggestionAcceptedEdited {
		writeJSON(w, http.StatusOK, map[string]any{"recycle": rec, "idempotent": true})
		return
	}
	if sug.Status == store.SuggestionIgnored {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "suggestion already ignored"})
		return
	}

	p, err := s.Store.GetProject(r.Context(), rec.ProjectID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	abs, err := s.onePagerAbs(p.OnePagerRel)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	st, err := os.Stat(abs)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "stat one-pager: " + err.Error()})
		return
	}
	curUpdated := st.ModTime().UnixMilli()
	// Prefer client-provided version; fall back to base recorded at generation.
	expected := body.OnePagerUpdatedAt
	if expected == 0 {
		expected = rec.BaseOnePagerUpdatedAt
	}
	if expected != 0 && expected != curUpdated {
		mdBytes, _ := os.ReadFile(abs)
		writeJSON(w, http.StatusConflict, map[string]any{
			"error":      "one-pager was modified",
			"updated_at": curUpdated,
			"markdown":   string(mdBytes),
			"summary":    store.ParseOnePagerSummary(string(mdBytes), p.Name, p.Mode),
		})
		return
	}

	finalText := strings.TrimSpace(body.FinalText)
	if finalText == "" {
		finalText = sug.Text
	}
	finalText = trimRunesLocal(finalText, maxRecycleSuggestionRunes)

	mdBytes, err := os.ReadFile(abs)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "read one-pager: " + err.Error()})
		return
	}
	newMD, err := store.ApplyRecycleSuggestion(string(mdBytes), sug.Target, finalText)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if err := os.WriteFile(abs, []byte(newMD), 0o600); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	st2, _ := os.Stat(abs)
	var newUpdated int64
	if st2 != nil {
		newUpdated = st2.ModTime().UnixMilli()
	} else {
		newUpdated = time.Now().UnixMilli()
	}

	now := time.Now().UnixMilli()
	edited := finalText != strings.TrimSpace(sug.Text)
	if edited {
		rec.Suggestions[idx].Status = store.SuggestionAcceptedEdited
	} else {
		rec.Suggestions[idx].Status = store.SuggestionAccepted
	}
	rec.Suggestions[idx].FinalText = finalText
	rec.Suggestions[idx].AcceptedAt = &now
	// Bump base version so subsequent accepts in the same batch compare correctly.
	rec.BaseOnePagerUpdatedAt = newUpdated

	status := rec.Status
	var resolvedAt *int64
	if store.RecycleIsFullyHandled(rec.Suggestions) {
		status = store.RecycleStatusResolved
		resolvedAt = &now
	}
	if err := s.Store.UpdateProjectRecycleSuggestions(r.Context(), rec.ID, rec.Suggestions, status, resolvedAt); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	rec.Status = status
	rec.ResolvedAt = resolvedAt
	_, _ = s.Store.UpdateProject(r.Context(), p.ID, store.ProjectPatch{TouchLastActive: true})

	writeJSON(w, http.StatusOK, map[string]any{
		"recycle":    rec,
		"markdown":   newMD,
		"updated_at": newUpdated,
	})
}

func (s *Server) handleIgnoreRecycleSuggestion(w http.ResponseWriter, r *http.Request) {
	if !s.projectsConfigured(w) {
		return
	}
	recID := chi.URLParam(r, "id")
	idx, err := strconv.Atoi(chi.URLParam(r, "index"))
	if err != nil || idx < 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid suggestion index"})
		return
	}
	rec, err := s.Store.GetProjectRecycle(r.Context(), recID)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "recycle not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if idx >= len(rec.Suggestions) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "suggestion index out of range"})
		return
	}
	// Idempotent ignore / already terminal.
	if rec.Suggestions[idx].Status == store.SuggestionIgnored {
		writeJSON(w, http.StatusOK, map[string]any{"recycle": rec, "idempotent": true})
		return
	}
	if rec.Suggestions[idx].Status == store.SuggestionAccepted || rec.Suggestions[idx].Status == store.SuggestionAcceptedEdited {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "suggestion already accepted"})
		return
	}
	now := time.Now().UnixMilli()
	rec.Suggestions[idx].Status = store.SuggestionIgnored
	rec.Suggestions[idx].IgnoredAt = &now
	status := rec.Status
	var resolvedAt *int64
	if store.RecycleIsFullyHandled(rec.Suggestions) {
		status = store.RecycleStatusResolved
		resolvedAt = &now
	}
	if err := s.Store.UpdateProjectRecycleSuggestions(r.Context(), rec.ID, rec.Suggestions, status, resolvedAt); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	rec.Status = status
	rec.ResolvedAt = resolvedAt
	writeJSON(w, http.StatusOK, map[string]any{"recycle": rec})
}

// --- generation helpers ---

type recycleModelOut struct {
	Summary     string `json:"summary"`
	Suggestions []struct {
		Target     string `json:"target"`
		Text       string `json:"text"`
		Reason     string `json:"reason"`
		Confidence string `json:"confidence"`
		Evidence   []struct {
			Kind  string `json:"kind"`
			ID    string `json:"id"`
			Label string `json:"label"`
			Path  string `json:"path"`
		} `json:"evidence"`
	} `json:"suggestions"`
}

func (s *Server) generateRecycleSuggestions(
	ctx context.Context,
	cli provider.Client,
	p store.Project,
	t store.Task,
	onePagerMD, transcript string,
) (string, []store.RecycleSuggestion, error) {
	sys := `You help the user wrap up a project session by proposing short One-Pager updates.
Return ONLY valid JSON (no markdown fences) with this shape:
{
  "summary": "one sentence of what got done",
  "suggestions": [
    {
      "target": "conclusions|open_questions|next|focus",
      "text": "1-2 lines to write back",
      "reason": "why this is worth writing",
      "confidence": "low|medium|high",
      "evidence": [{"kind":"task","id":"...","label":"..."}]
    }
  ]
}
Rules:
- At most 3 ordinary suggestions (conclusions, open_questions, next combined).
- Optionally one focus suggestion (replaces Current Focus entirely).
- Never suggest North Star changes.
- Prefer empty suggestions array when nothing durable was learned.
- Text must be concrete, short, user-owned language (no KPI, no % complete).
- Do not invent files or artifacts that are not in the transcript.`

	user := fmt.Sprintf(`Project: %s
Mode: %s
Mode strategy: %s

Current One-Pager (bounded):
-----
%s
-----

Task id: %s
Task title: %s
Task prompt: %s

Session transcript (bounded):
-----
%s
-----

Propose wrap-up now.`,
		p.Name, p.Mode, store.ModeStrategyLine(p.Mode),
		trimRunesLocal(onePagerMD, 5000),
		t.ID, t.Title, trimRunesLocal(t.Prompt, 800),
		trimRunesLocal(transcript, 6000),
	)

	ctx, cancel := context.WithTimeout(ctx, recycleGenerationTimeout)
	defer cancel()
	resp, err := cli.Chat(ctx, provider.ChatRequest{
		Messages: []provider.Message{
			{Role: provider.RoleSystem, Content: sys},
			{Role: provider.RoleUser, Content: user},
		},
	})
	if err != nil {
		return "", nil, err
	}
	raw := strings.TrimSpace(resp.Content)
	raw = stripJSONFence(raw)
	var out recycleModelOut
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		// Try to extract a JSON object substring.
		if obj := extractJSONObject(raw); obj != "" {
			if err2 := json.Unmarshal([]byte(obj), &out); err2 != nil {
				return "", nil, fmt.Errorf("invalid model json: %w", err)
			}
		} else {
			return "", nil, fmt.Errorf("invalid model json: %w", err)
		}
	}

	summary := strings.TrimSpace(out.Summary)
	if summary == "" {
		summary = "Session wrap-up"
	}
	summary = trimRunesLocal(summary, maxRecycleSummaryRunes)

	var suggestions []store.RecycleSuggestion
	for _, s0 := range out.Suggestions {
		target := strings.TrimSpace(strings.ToLower(s0.Target))
		text := strings.TrimSpace(s0.Text)
		if text == "" || !store.ValidRecycleTarget(target) {
			continue
		}
		if target == "north_star" || target == "northstar" {
			continue
		}
		text = trimRunesLocal(text, maxRecycleSuggestionRunes)
		reason := trimRunesLocal(strings.TrimSpace(s0.Reason), maxRecycleReasonRunes)
		conf := strings.TrimSpace(strings.ToLower(s0.Confidence))
		switch conf {
		case "low", "medium", "high":
		default:
			conf = "medium"
		}
		var evidence []store.RecycleEvidence
		for _, e := range s0.Evidence {
			if len(evidence) >= maxRecycleEvidencePerItem {
				break
			}
			kind := strings.TrimSpace(strings.ToLower(e.Kind))
			switch kind {
			case "task", "artifact", "file":
			default:
				continue
			}
			evidence = append(evidence, store.RecycleEvidence{
				Kind:  kind,
				ID:    strings.TrimSpace(e.ID),
				Label: strings.TrimSpace(e.Label),
				Path:  strings.TrimSpace(e.Path),
			})
		}
		suggestions = append(suggestions, store.RecycleSuggestion{
			Target:     target,
			Text:       text,
			Reason:     reason,
			Confidence: conf,
			Evidence:   evidence,
			Status:     store.SuggestionPending,
		})
	}
	return summary, suggestions, nil
}

func stripJSONFence(s string) string {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "```") {
		s = strings.TrimPrefix(s, "```")
		s = strings.TrimSpace(s)
		if strings.HasPrefix(strings.ToLower(s), "json") {
			s = strings.TrimSpace(s[4:])
		}
		if i := strings.LastIndex(s, "```"); i >= 0 {
			s = s[:i]
		}
	}
	return strings.TrimSpace(s)
}

func extractJSONObject(s string) string {
	start := strings.Index(s, "{")
	end := strings.LastIndex(s, "}")
	if start < 0 || end <= start {
		return ""
	}
	return s[start : end+1]
}

func taskHasReviewableContent(t store.Task, evs []store.Event) bool {
	if strings.TrimSpace(t.Prompt) != "" {
		return true
	}
	for _, ev := range evs {
		if ev.Type == "message" {
			return true
		}
	}
	return false
}

func buildRecycleTranscript(t store.Task, evs []store.Event) string {
	var b strings.Builder
	fmt.Fprintf(&b, "User prompt: %s\n", strings.TrimSpace(t.Prompt))
	for _, ev := range evs {
		if ev.Type != "message" && ev.Type != "result" {
			continue
		}
		text := extractEventText(ev.Payload)
		if text == "" {
			continue
		}
		fmt.Fprintf(&b, "[%s] %s\n", ev.Type, trimRunesLocal(text, 500))
		if b.Len() > 8000 {
			break
		}
	}
	return b.String()
}

func extractEventText(payload json.RawMessage) string {
	if len(payload) == 0 {
		return ""
	}
	var m map[string]any
	if err := json.Unmarshal(payload, &m); err != nil {
		return ""
	}
	if s, ok := m["text"].(string); ok && strings.TrimSpace(s) != "" {
		return s
	}
	// content: [{type:text,text:...}]
	if arr, ok := m["content"].([]any); ok {
		var parts []string
		for _, it := range arr {
			mm, ok := it.(map[string]any)
			if !ok {
				continue
			}
			if mm["type"] == "text" {
				if s, ok := mm["text"].(string); ok && s != "" {
					parts = append(parts, s)
				}
			}
		}
		return strings.Join(parts, "\n")
	}
	if s, ok := m["result"].(string); ok {
		return s
	}
	return ""
}

// runeLen is a tiny helper for tests.
func runeLen(s string) int { return utf8.RuneCountInString(s) }
