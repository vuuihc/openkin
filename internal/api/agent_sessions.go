package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/vuuihc/openkin/internal/agent"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/task"
)

type agentSessionResponse struct {
	ID            string   `json:"id"`
	AgentID       string   `json:"agent_id"`
	ExternalRef   string   `json:"external_ref"`
	Title         string   `json:"title"`
	Cwd           string   `json:"cwd"`
	ProjectID     string   `json:"project_id,omitempty"`
	ProjectLabel  string   `json:"project_label,omitempty"`
	Status        string   `json:"status"`
	Capabilities  []string `json:"capabilities,omitempty"`
	SourceCursor  string   `json:"source_cursor,omitempty"`
	ContentDigest string   `json:"content_digest,omitempty"`
	FirstSeenAt   int64    `json:"first_seen_at"`
	LastSeenAt    int64    `json:"last_seen_at"`
	UpdatedAt     int64    `json:"updated_at"`
	Linked        bool     `json:"linked"`
}

type agentSessionListPageResponse struct {
	Items      []agentSessionResponse `json:"items"`
	NextCursor string                 `json:"next_cursor,omitempty"`
}

type agentSessionHistoryResponse struct {
	Items      []agentHistoryItem `json:"items"`
	NextCursor string             `json:"next_cursor,omitempty"`
	SourceRev  string             `json:"source_rev,omitempty"`
}

type agentSessionAttachRequest struct {
	TaskID         string `json:"task_id,omitempty"`
	Prompt         string `json:"prompt,omitempty"`
	Cwd            string `json:"cwd,omitempty"`
	Title          string `json:"title,omitempty"`
	PermissionMode string `json:"permission_mode,omitempty"`
}

type agentSessionAttachResponse struct {
	Task    store.Task             `json:"task"`
	Binding store.TaskAgentSession `json:"binding"`
}

type agentHistoryItem struct {
	AgentID     string `json:"agent_id"`
	ExternalRef string `json:"external_ref"`
	MessageID   string `json:"message_id"`
	Role        string `json:"role"`
	Text        string `json:"text"`
	OccurredAt  int64  `json:"occurred_at"`
	SourceRev   string `json:"source_rev"`
}

func (s *Server) handleListAgentSessions(w http.ResponseWriter, r *http.Request) {
	limit := 100
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 500 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "limit must be between 1 and 500"})
			return
		}
		limit = n
	}
	var linked *bool
	if raw := r.URL.Query().Get("linked"); raw != "" {
		value, err := strconv.ParseBool(raw)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "linked must be a boolean"})
			return
		}
		linked = &value
	}
	opts := store.AgentSessionListOpts{
		AgentID: r.URL.Query().Get("agent"),
		Query:   r.URL.Query().Get("q"),
		Cwd:     r.URL.Query().Get("cwd"),
		Linked:  linked,
		Limit:   limit,
	}
	rows, err := s.Store.ListAgentSessions(r.Context(), opts)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	out := make([]agentSessionResponse, 0, len(rows))
	for _, row := range rows {
		out = append(out, s.agentSessionResponse(r, row))
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleListAgentSessionsPage(w http.ResponseWriter, r *http.Request) {
	limit, err := parseAgentSessionLimit(r.URL.Query().Get("limit"), 100, 500)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	var beforeUpdatedAt int64
	var beforeID string
	if cursor := strings.TrimSpace(r.URL.Query().Get("before")); cursor != "" {
		parts := strings.SplitN(cursor, ":", 2)
		if len(parts) != 2 || parts[1] == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid session cursor"})
			return
		}
		beforeUpdatedAt, err = strconv.ParseInt(parts[0], 10, 64)
		if err != nil || beforeUpdatedAt <= 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid session cursor"})
			return
		}
		beforeID = parts[1]
	}
	var linked *bool
	if raw := r.URL.Query().Get("linked"); raw != "" {
		value, err := strconv.ParseBool(raw)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "linked must be a boolean"})
			return
		}
		linked = &value
	}
	rows, err := s.Store.ListAgentSessions(r.Context(), store.AgentSessionListOpts{
		AgentID:         r.URL.Query().Get("agent"),
		Query:           r.URL.Query().Get("q"),
		Cwd:             r.URL.Query().Get("cwd"),
		Linked:          linked,
		BeforeUpdatedAt: beforeUpdatedAt,
		BeforeID:        beforeID,
		Limit:           limit,
	})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	out := make([]agentSessionResponse, 0, len(rows))
	for _, row := range rows {
		out = append(out, s.agentSessionResponse(r, row))
	}
	next := ""
	if len(rows) == limit {
		last := rows[len(rows)-1]
		next = fmt.Sprintf("%d:%s", last.UpdatedAt, last.ID)
	}
	writeJSON(w, http.StatusOK, agentSessionListPageResponse{Items: out, NextCursor: next})
}

func (s *Server) handleGetAgentSession(w http.ResponseWriter, r *http.Request) {
	row, err := s.Store.GetAgentSessionByID(r.Context(), chi.URLParam(r, "id"))
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "agent session not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, s.agentSessionResponse(r, row))
}

func parseAgentSessionLimit(raw string, fallback, maximum int) (int, error) {
	if raw == "" {
		return fallback, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 || n > maximum {
		return 0, fmt.Errorf("limit must be between 1 and %d", maximum)
	}
	return n, nil
}

func (s *Server) handleImportAgentSessions(w http.ResponseWriter, r *http.Request) {
	if s.Agents == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "agent session discovery is unavailable"})
		return
	}
	var body struct {
		Agents []string `json:"agents,omitempty"`
		Limit  int      `json:"limit,omitempty"`
	}
	if r.Body != nil {
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&body); err != nil &&
			!errors.Is(err, http.ErrBodyReadAfterClose) {
			// An empty body is equivalent to importing all providers.
			if err.Error() != "EOF" {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
				return
			}
		}
	}
	ids := body.Agents
	explicitAgents := len(ids) > 0
	if len(ids) > 32 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "agents must contain at most 32 ids"})
		return
	}
	if len(ids) == 0 {
		ids = s.Agents.IDs()
	}
	limit := body.Limit
	if limit <= 0 || limit > 500 {
		limit = 500
	}
	result := struct {
		Imported  int               `json:"imported"`
		Providers map[string]int    `json:"providers"`
		Errors    map[string]string `json:"errors,omitempty"`
	}{Providers: map[string]int{}, Errors: map[string]string{}}
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		sessions, err := s.Agents.ListSessions(r.Context(), id, agent.SessionQuery{Limit: limit})
		if err != nil {
			// Most registered agents are runnable task hosts, not session
			// providers. Omit those from the all-provider summary; an
			// explicitly requested agent still reports its capability gap.
			if errors.Is(err, agent.ErrSessionCatalogUnavailable) && !explicitAgents {
				continue
			}
			result.Errors[id] = err.Error()
			continue
		}
		for _, session := range sessions {
			row, err := s.Store.UpsertAgentSession(r.Context(), fromAgentSession(session))
			if err != nil {
				result.Errors[id] = err.Error()
				continue
			}
			result.Imported++
			result.Providers[row.AgentID]++
		}
	}
	if len(result.Errors) == 0 {
		result.Errors = nil
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleGetAgentSessionHistory(w http.ResponseWriter, r *http.Request) {
	if s.Agents == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "agent session history is unavailable"})
		return
	}
	row, err := s.Store.GetAgentSessionByID(r.Context(), chi.URLParam(r, "id"))
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "agent session not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	limit := 50
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 100 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "limit must be between 1 and 100"})
			return
		}
		limit = n
	}
	page, err := s.Agents.ReadSessionHistory(r.Context(), row.AgentID, row.ExternalRef, agent.HistoryQuery{
		Cursor: r.URL.Query().Get("cursor"),
		Limit:  limit,
	})
	if err != nil {
		if errors.Is(err, agent.ErrSessionCatalogUnavailable) || errors.Is(err, errors.ErrUnsupported) {
			writeJSON(w, http.StatusNotImplemented, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "provider session history unavailable"})
		return
	}
	items := make([]agentHistoryItem, 0, len(page.Items))
	for _, item := range page.Items {
		items = append(items, agentHistoryItem{
			AgentID: item.AgentID, ExternalRef: item.ExternalRef,
			MessageID: item.MessageID, Role: item.Role, Text: item.Text,
			OccurredAt: item.OccurredAt.UnixMilli(), SourceRev: item.SourceRev,
		})
	}
	writeJSON(w, http.StatusOK, agentSessionHistoryResponse{
		Items: items, NextCursor: page.NextCursor, SourceRev: page.SourceRev,
	})
}

func (s *Server) handleAttachAgentSession(w http.ResponseWriter, r *http.Request) {
	if s.Agents == nil || s.Engine == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "agent session attach is unavailable"})
		return
	}
	// Attach is a claim-and-bind operation. Serialize it inside the daemon so
	// two callers cannot both observe an unlinked source before one binds it.
	s.agentSessionAttachMu.Lock()
	defer s.agentSessionAttachMu.Unlock()
	row, err := s.Store.GetAgentSessionByID(r.Context(), chi.URLParam(r, "id"))
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "agent session not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if !hasSessionCapability(row.Capabilities, string(agent.CapabilitySessionAttach)) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "provider session attach is not supported"})
		return
	}
	if row.Linked {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "agent session is already attached"})
		return
	}
	if _, err := s.Agents.GetRunnable(r.Context(), row.AgentID); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": fmt.Sprintf("agent %q is unavailable", row.AgentID)})
		return
	}

	var body agentSessionAttachRequest
	if r.Body != nil {
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&body); err != nil &&
			err.Error() != "EOF" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
			return
		}
	}
	if strings.TrimSpace(body.TaskID) != "" {
		s.handleAttachToExistingTask(w, r, row, body)
		return
	}
	prompt := strings.TrimSpace(body.Prompt)
	if prompt == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "prompt is required when creating a Kin task"})
		return
	}
	cwd := strings.TrimSpace(body.Cwd)
	if cwd == "" {
		cwd = row.Cwd
	}
	if cwd == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "cwd is required"})
		return
	}
	req := task.CreateRequest{
		Agent:          row.AgentID,
		Cwd:            cwd,
		Prompt:         prompt,
		SessionRef:     row.ExternalRef,
		PermissionMode: body.PermissionMode,
	}
	if title := strings.TrimSpace(body.Title); title != "" {
		req.Title = &title
	} else if row.Title != "" {
		title := row.Title
		req.Title = &title
	}
	if err := s.validateTaskCreateRequest(r.Context(), req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	created, err := s.Engine.Create(r.Context(), req)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	binding, err := s.Store.InsertTaskAgentSession(r.Context(), store.TaskAgentSession{
		TaskID:         created.ID,
		AgentSessionID: row.ID,
		Role:           "host",
		State:          "attached",
	})
	if err != nil {
		if existing, lookupErr := s.activeTaskAgentSession(r.Context(), created.ID, row.ID); lookupErr == nil {
			writeJSON(w, http.StatusCreated, agentSessionAttachResponse{Task: created, Binding: existing})
			return
		}
		_, _ = s.Engine.Cancel(r.Context(), created.ID)
		_ = s.Store.DeleteTask(r.Context(), created.ID)
		writeJSON(w, http.StatusConflict, map[string]string{"error": "task created but session binding failed"})
		return
	}
	writeJSON(w, http.StatusCreated, agentSessionAttachResponse{Task: created, Binding: binding})
}

func (s *Server) handleAttachToExistingTask(w http.ResponseWriter, r *http.Request, row store.AgentSession, body agentSessionAttachRequest) {
	current, err := s.Engine.Get(r.Context(), strings.TrimSpace(body.TaskID))
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "task not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if current.Agent != row.AgentID {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "task agent does not match provider session"})
		return
	}
	if current.Cwd != "" && row.Cwd != "" && filepath.Clean(current.Cwd) != filepath.Clean(row.Cwd) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "task cwd does not match provider session"})
		return
	}
	if current.Status == task.StatusQueued || current.Status == task.StatusRunning ||
		current.Status == task.StatusWaitingApproval || current.Status == task.StatusWaitingInput {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "task is still active"})
		return
	}
	if current.SessionRef != nil && strings.TrimSpace(*current.SessionRef) != "" &&
		strings.TrimSpace(*current.SessionRef) != row.ExternalRef {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "task already has a different native session"})
		return
	}
	ref := row.ExternalRef
	if err := s.Store.UpdateTask(r.Context(), current.ID, store.TaskPatch{SessionRef: &ref}); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	binding, err := s.Store.InsertTaskAgentSession(r.Context(), store.TaskAgentSession{
		TaskID:         current.ID,
		AgentSessionID: row.ID,
		Role:           "host",
		State:          "attached",
	})
	if err != nil {
		restore := store.TaskPatch{ClearSessionRef: true}
		if current.SessionRef != nil {
			previous := strings.TrimSpace(*current.SessionRef)
			restore = store.TaskPatch{SessionRef: &previous}
		}
		_ = s.Store.UpdateTask(r.Context(), current.ID, restore)
		writeJSON(w, http.StatusConflict, map[string]string{"error": "session binding failed"})
		return
	}
	attached, err := s.Engine.Get(r.Context(), current.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if strings.TrimSpace(body.Prompt) != "" {
		attached, err = s.Engine.FollowUpWith(r.Context(), attached.ID, task.FollowUpRequest{
			Prompt: strings.TrimSpace(body.Prompt),
		})
		if err != nil {
			_ = s.Store.DetachTaskAgentSessions(r.Context(), current.ID, "attach follow-up failed")
			restore := store.TaskPatch{ClearSessionRef: true}
			if current.SessionRef != nil {
				previous := strings.TrimSpace(*current.SessionRef)
				restore = store.TaskPatch{SessionRef: &previous}
			}
			_ = s.Store.UpdateTask(r.Context(), current.ID, restore)
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
	}
	writeJSON(w, http.StatusOK, agentSessionAttachResponse{Task: attached, Binding: binding})
}

func (s *Server) activeTaskAgentSession(ctx context.Context, taskID, agentSessionID string) (store.TaskAgentSession, error) {
	bindings, err := s.Store.ListTaskAgentSessions(ctx, taskID)
	if err != nil {
		return store.TaskAgentSession{}, err
	}
	for _, binding := range bindings {
		if binding.AgentSessionID == agentSessionID && binding.State == "attached" {
			return binding, nil
		}
	}
	return store.TaskAgentSession{}, store.ErrNotFound
}

func hasSessionCapability(capabilities []string, want string) bool {
	for _, capability := range capabilities {
		if capability == want {
			return true
		}
	}
	return false
}

func (s *Server) agentSessionResponse(r *http.Request, row store.AgentSession) agentSessionResponse {
	projectID, _ := s.Store.ResolveProjectIDForCwd(r.Context(), row.Cwd)
	label := ""
	if projectID != "" {
		if project, err := s.Store.GetProject(r.Context(), projectID); err == nil {
			label = project.Name
		}
	}
	if label == "" && strings.TrimSpace(row.Cwd) != "" {
		label = filepath.Base(filepath.Clean(row.Cwd))
	}
	return agentSessionResponse{
		ID: row.ID, AgentID: row.AgentID, ExternalRef: row.ExternalRef,
		Title: row.Title, Cwd: row.Cwd, ProjectID: projectID, ProjectLabel: label,
		Status: row.Status, Capabilities: row.Capabilities,
		SourceCursor: row.SourceCursor, ContentDigest: row.ContentDigest,
		FirstSeenAt: row.FirstSeenAt, LastSeenAt: row.LastSeenAt,
		UpdatedAt: row.UpdatedAt, Linked: row.Linked,
	}
}

func fromAgentSession(session agent.SessionInfo) store.AgentSession {
	caps := make([]string, 0, len(session.Capabilities))
	for _, cap := range session.Capabilities {
		caps = append(caps, string(cap))
	}
	return store.AgentSession{
		AgentID: session.AgentID, ExternalRef: session.ExternalRef,
		SourceURI: session.SourceURI, Title: session.Title, Cwd: session.Cwd,
		Status: session.Status, Capabilities: caps,
		SourceCursor: session.SourceCursor, ContentDigest: session.ContentDigest,
		FirstSeenAt: session.CreatedAt.UnixMilli(),
		LastSeenAt:  session.UpdatedAt.UnixMilli(),
		UpdatedAt:   session.UpdatedAt.UnixMilli(),
	}
}
