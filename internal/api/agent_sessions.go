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
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/vuuihc/openkin/internal/agent"
	"github.com/vuuihc/openkin/internal/remote/worker"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/task"
)

type agentSessionResponse struct {
	ID            string   `json:"id"`
	AgentID       string   `json:"agent_id"`
	DeviceID      string   `json:"device_id,omitempty"`
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
	// Truncated says this page is not the whole rest of the transcript and
	// following NextCursor will not get the rest: the machine that read it hit
	// its own frame budget. Without it, a page that stopped early and a
	// transcript that ended are the same answer, and the console draws the same
	// short list for both.
	Truncated bool `json:"truncated,omitempty"`
}

type agentSessionAttachRequest struct {
	TaskID         string `json:"task_id,omitempty"`
	Prompt         string `json:"prompt,omitempty"`
	Cwd            string `json:"cwd,omitempty"`
	Title          string `json:"title,omitempty"`
	PermissionMode string `json:"permission_mode,omitempty"`
}

// agentSessionImportResponse is what one import did: how many rows it wrote,
// how many per provider, and the providers that could not be read, in the
// machine's own words.
//
// Both import paths answer with it — this machine's own scan and one asked of
// another machine — because the console asks either one and reads one shape.
type agentSessionImportResponse struct {
	Imported  int               `json:"imported"`
	Providers map[string]int    `json:"providers"`
	Errors    map[string]string `json:"errors,omitempty"`
	// Truncated reports that a machine had more sessions than one import
	// carries. It is its own field and not an entry in Errors, because nothing
	// went wrong: a caller counting failures would otherwise be told that
	// something had, and would look for a provider to fix.
	Truncated bool `json:"truncated,omitempty"`
}

type agentSessionAttachResponse struct {
	Task    store.Task             `json:"task"`
	Binding store.TaskAgentSession `json:"binding"`
}

type agentHistoryItem struct {
	AgentID     string `json:"agent_id"`
	ExternalRef string `json:"external_ref"`
	MessageID   string `json:"message_id"`
	Kind        string `json:"kind,omitempty"`
	Role        string `json:"role"`
	ToolName    string `json:"tool_name,omitempty"`
	Text        string `json:"text"`
	OccurredAt  int64  `json:"occurred_at"`
	SourceRev   string `json:"source_rev"`
	// Truncated says Text is the beginning of a longer message. It comes from
	// whoever read the transcript — this machine's catalog, or the machine that
	// answered — and this route's only job with it is not to lose it: a message
	// shown as complete when it was cut is a transcript that lies about what the
	// agent said, and it lies differently depending on which machine the reader
	// happened to ask.
	Truncated bool `json:"truncated,omitempty"`
}

// sessionMessageTime is a message's time as both history paths state it:
// milliseconds since the epoch, and zero for a provider that records no time.
//
// Zero rather than the zero time's UnixMilli — -62135596800000, which is the
// year 1 and is what this route used to answer for such a message. A number
// nobody can explain is worse than a sentinel a reader can be told about, and
// the wire already says zero for the same message (internal/node/sessions.go),
// so the two paths disagreed about one transcript when "this provider does not
// record when" has to read the same from either of them.
func sessionMessageTime(at time.Time) int64 {
	if at.IsZero() {
		return 0
	}
	return at.UnixMilli()
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
	var body struct {
		Agents []string `json:"agents,omitempty"`
		Limit  int      `json:"limit,omitempty"`
		// DeviceID names the machine whose sessions to import. Absent or "self"
		// is this one, which is what every caller before this field existed
		// meant, and what a console that has not thought about machines still
		// means.
		DeviceID string `json:"device_id,omitempty"`
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
	// The scan below is a scan of *this* filesystem: it walks the catalogs of
	// the CLIs installed here. Running it for another machine's id would land
	// that machine's name on this machine's sessions, which is the state the
	// device column exists to prevent — so a named machine is asked, not
	// scanned.
	if !s.localDevice(body.DeviceID) {
		s.importDeviceSessions(w, r, strings.TrimSpace(body.DeviceID), body.Agents, body.Limit)
		return
	}
	if s.Agents == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "agent session discovery is unavailable"})
		return
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
	result := agentSessionImportResponse{Providers: map[string]int{}, Errors: map[string]string{}}
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
			row, err := s.Store.UpsertAgentSession(r.Context(), fromAgentSession(session, s.DesktopID))
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

// importDeviceSessions asks one machine this Hub can reach for its sessions and
// lands them under that machine's id.
//
// The device id is the whole of the bookkeeping: a row is keyed by
// (device, agent, ref), so a session read from a Mac and a session read here
// with a coincidentally equal ref are two rows rather than one overwriting the
// other. It is also what one session's history is read back with, and what an
// attach records as the ref's provenance — the two columns P4 added for the
// task that runs here on a transcript that was written there.
//
// A named agent is asked for by name, one question per name, because that is
// what the name means: this machine's list of providers is the console's own,
// and a Hub that passed the whole list on would be asking the other machine to
// report failures for CLIs it has never heard of.
func (s *Server) importDeviceSessions(w http.ResponseWriter, r *http.Request, device string, agents []string, limit int) {
	if len(agents) > 32 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "agents must contain at most 32 ids"})
		return
	}
	if limit <= 0 || limit > worker.MaxAgentQuery {
		limit = worker.MaxAgentQuery
	}
	ids := agents
	if len(ids) == 0 {
		// One question with no agent is "every provider you have", which is the
		// same question the scan above asks this machine's registry.
		ids = []string{""}
	}
	result := agentSessionImportResponse{Providers: map[string]int{}, Errors: map[string]string{}}
	for _, id := range ids {
		id = strings.TrimSpace(id)
		// An empty name inside a list of names is not "every provider": the list
		// is what the caller chose, and a blank entry in it is nothing they can
		// have meant. The scan above skips these for the same reason — and here
		// the difference is not cosmetic, because a blank name that travels is
		// read by the other machine as "all of mine".
		if id == "" && len(agents) > 0 {
			continue
		}
		var answer worker.AgentSessionsResult
		params := worker.AgentSessionsParams{Agent: id, Limit: limit}
		if err := params.Validate(); err != nil {
			// A name no catalog can be asked about is not worth asking another
			// machine, and sending it anyway is how a caller's mistake comes back
			// as the machine's refusal — the phone blames a Mac for a name this
			// Hub could see was too long. The scan above answers the same problem
			// the same way: the provider is reported beside the others rather
			// than replacing the whole import.
			result.Errors[id] = err.Error()
			continue
		}
		if err := s.askDeviceQuietly(r.Context(), device, worker.QueryAgentSessions, params, &answer); err != nil {
			// A machine that is away, or that has no session catalog at all, is
			// an answer about the machine rather than about one provider of it.
			writeMachineQueryError(w, err)
			return
		}
		for provider, reason := range answer.Errors {
			result.Errors[provider] = reason
		}
		for _, session := range answer.Sessions {
			row, err := s.Store.UpsertAgentSession(r.Context(), fromAgentSession(agentSessionFromWire(session), device))
			if err != nil {
				result.Errors[session.AgentID] = err.Error()
				continue
			}
			result.Imported++
			result.Providers[row.AgentID]++
		}
		if answer.Truncated {
			// Not a failure: the import did what it said and this machine has
			// more. The scan above has no way to know the same thing about
			// itself — a catalog that returns exactly its limit looks like a
			// catalog with exactly that many sessions, which is why this is the
			// wire's answer to give and not a rule this route invents.
			result.Truncated = true
		}
	}
	if len(result.Errors) == 0 {
		result.Errors = nil
	}
	writeJSON(w, http.StatusOK, result)
}

// agentSessionFromWire reads one session out of a machine's answer, in the
// shape this package's own catalog produces.
//
// It goes through agent.SessionInfo rather than straight to the store so that
// there is one mapping from a catalog row to a stored row: a field added to the
// store's columns is then added in one place, and a session imported from
// another machine lands the same way one scanned here does.
func agentSessionFromWire(session worker.AgentSession) agent.SessionInfo {
	out := agent.SessionInfo{
		AgentID:       session.AgentID,
		ExternalRef:   session.ExternalRef,
		SourceURI:     session.SourceURI,
		Title:         session.Title,
		Cwd:           session.Cwd,
		Status:        session.Status,
		SourceCursor:  session.SourceCursor,
		ContentDigest: session.ContentDigest,
	}
	for _, capability := range session.Capabilities {
		out.Capabilities = append(out.Capabilities, agent.Capability(capability))
	}
	if session.CreatedAt != 0 {
		out.CreatedAt = time.UnixMilli(session.CreatedAt)
	}
	if session.UpdatedAt != 0 {
		out.UpdatedAt = time.UnixMilli(session.UpdatedAt)
	}
	return out
}

func (s *Server) handleGetAgentSessionHistory(w http.ResponseWriter, r *http.Request) {
	row, err := s.Store.GetAgentSessionByID(r.Context(), chi.URLParam(r, "id"))
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "agent session not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	// A session is only readable where it was recorded. The ref is namespaced by
	// the machine that minted it, so reading another machine's ref through this
	// machine's catalog would answer about a different conversation that happens
	// to share a name, or about nothing at all -- and the difference between
	// those two is invisible from here.
	if !s.localDevice(row.DeviceID) {
		s.handleDeviceAgentSessionHistory(w, r, row)
		return
	}
	if s.Agents == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "agent session history is unavailable"})
		return
	}
	limit, err := parseAgentSessionLimit(r.URL.Query().Get("limit"), 50, worker.MaxAgentHistoryItems)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	// The same bound the wire applies to a cursor, for the same reason it exists
	// there: the value is the provider's, and the only thing this route can say
	// about it is how long it may be. Applying it here too is what keeps one
	// session readable through either path — a cursor this route accepted and a
	// paired machine refused would be the same transcript paging differently
	// depending on where it was read from.
	cursor := r.URL.Query().Get("cursor")
	if len(cursor) > worker.MaxAgentHistoryCursor {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": fmt.Sprintf("cursor must be at most %d bytes", worker.MaxAgentHistoryCursor),
		})
		return
	}
	page, err := s.Agents.ReadSessionHistory(r.Context(), row.AgentID, row.ExternalRef, agent.HistoryQuery{
		Cursor: cursor,
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
			MessageID: item.MessageID, Kind: item.Kind, Role: item.Role,
			ToolName: item.ToolName, Text: item.Text,
			OccurredAt: sessionMessageTime(item.OccurredAt), SourceRev: item.SourceRev,
			Truncated: item.Truncated,
		})
	}
	writeJSON(w, http.StatusOK, agentSessionHistoryResponse{
		Items: items, NextCursor: page.NextCursor, SourceRev: page.SourceRev,
	})
}

// handleDeviceAgentSessionHistory reads one page of a session that lives on
// another machine, by asking that machine for it.
//
// The page is asked for exactly as a local one is — the same default of 50 and
// the same ceiling — because the same session read from a phone and read from
// the machine it lives on is the same session, and a reader that got fewer
// messages from one of them would be reading a different transcript depending on
// where it happened to live. The ceiling is worker.MaxAgentHistoryItems rather
// than a number of this route's own because the wire is what makes it real: the
// answering machine has to fit the page in one frame.
//
// What a page this machine's own frame budget could not carry looks like is the
// answering machine's to say, and it says it by leaving NextCursor empty: a
// reader sees the end of what it can read rather than a page that silently
// skipped the messages it dropped.
//
// The source revision comes back from the machine that read it, so a console
// can tell a transcript that changed from one that did not, exactly as it does
// for a session read here.
func (s *Server) handleDeviceAgentSessionHistory(w http.ResponseWriter, r *http.Request, row store.AgentSession) {
	limit, err := parseAgentSessionLimit(r.URL.Query().Get("limit"), 50, worker.MaxAgentHistoryItems)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	params := worker.AgentHistoryParams{
		Agent:  row.AgentID,
		Ref:    row.ExternalRef,
		Cursor: r.URL.Query().Get("cursor"),
		Limit:  limit,
	}
	if err := params.Validate(); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	var answer worker.AgentHistoryResult
	if err := s.askDeviceQuietly(r.Context(), row.DeviceID, worker.QueryAgentHistory, params, &answer); err != nil {
		// Offline and timed-out are told apart from refused here, which is more
		// than the local path can say: that one has a catalog that either
		// answers or does not, while this one has a machine that may simply be
		// away.
		writeMachineQueryError(w, err)
		return
	}
	items := make([]agentHistoryItem, 0, len(answer.Items))
	for _, item := range answer.Items {
		items = append(items, agentHistoryItem{
			AgentID: row.AgentID, ExternalRef: row.ExternalRef,
			MessageID: item.MessageID, Kind: item.Kind, Role: item.Role,
			ToolName: item.ToolName, Text: item.Text,
			OccurredAt: item.OccurredAt, SourceRev: item.SourceRev,
			Truncated: item.Truncated,
		})
	}
	writeJSON(w, http.StatusOK, agentSessionHistoryResponse{
		Items: items, NextCursor: answer.NextCursor, SourceRev: answer.SourceRev,
		// The answering machine's page budget is the reader's answer, not a
		// detail of the wire: it is the difference between "this session has
		// twelve messages" and "this session has more than I could send you".
		Truncated: answer.Truncated,
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
		Agent:      row.AgentID,
		Cwd:        cwd,
		Prompt:     prompt,
		SessionRef: row.ExternalRef,
		// The device the session was recorded on, which is not necessarily this
		// one: the row is fetched by id with no device filter, so a session
		// imported from another machine can be attached to a task that runs
		// here. Carrying it lets the resume path notice that this daemon's
		// adapters cannot resolve the ref, instead of handing it over blind.
		SessionRefDeviceID: row.DeviceID,
		PermissionMode:     body.PermissionMode,
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
	// The ref and the machine that can resolve it move together, in the write and
	// in both restores below: a restore that put the ref back without its
	// provenance would relabel another machine's session as this one's, which is
	// the state the resume path now checks for.
	attached := store.TaskPatch{SessionRef: &ref, SessionRefDeviceID: &row.DeviceID}
	if err := s.Store.UpdateTask(r.Context(), current.ID, attached); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	previous := store.TaskPatch{ClearSessionRef: true}
	if current.SessionRef != nil {
		prior := strings.TrimSpace(*current.SessionRef)
		previous = store.TaskPatch{SessionRef: &prior, SessionRefDeviceID: current.SessionRefDeviceID}
	}
	binding, err := s.Store.InsertTaskAgentSession(r.Context(), store.TaskAgentSession{
		TaskID:         current.ID,
		AgentSessionID: row.ID,
		Role:           "host",
		State:          "attached",
	})
	if err != nil {
		_ = s.Store.UpdateTask(r.Context(), current.ID, previous)
		writeJSON(w, http.StatusConflict, map[string]string{"error": "session binding failed"})
		return
	}
	attachedTask, err := s.Engine.Get(r.Context(), current.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if strings.TrimSpace(body.Prompt) != "" {
		attachedTask, err = s.Engine.FollowUpWith(r.Context(), attachedTask.ID, task.FollowUpRequest{
			Prompt: strings.TrimSpace(body.Prompt),
		})
		if err != nil {
			_ = s.Store.DetachTaskAgentSessions(r.Context(), current.ID, "attach follow-up failed")
			_ = s.Store.UpdateTask(r.Context(), current.ID, previous)
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return

		}
	}
	writeJSON(w, http.StatusOK, agentSessionAttachResponse{Task: attachedTask, Binding: binding})
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
	// The project is resolved from the path, on every machine, and that is
	// deliberate: the registry is this Hub's, and a session read from a paired
	// machine is still one this person's work is about — their machines mirror
	// the same checkouts, so the name they filed that directory under is the name
	// they know the work by. What keeps the heuristic honest is that it is only
	// ever a label: no route filters by a session's project and nothing links to
	// one, so a path that means different things on two machines produces a
	// wrong-looking name and never a wrong action. A machine's own answer is what
	// a directory question is asked of (see askMachine); this is a name for a
	// heading.
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
		ID: row.ID, AgentID: row.AgentID, DeviceID: row.DeviceID,
		ExternalRef: row.ExternalRef, Title: row.Title, Cwd: row.Cwd,
		ProjectID: projectID, ProjectLabel: label,
		Status: row.Status, Capabilities: row.Capabilities,
		SourceCursor: row.SourceCursor, ContentDigest: row.ContentDigest,
		FirstSeenAt: row.FirstSeenAt, LastSeenAt: row.LastSeenAt,
		UpdatedAt: row.UpdatedAt, Linked: row.Linked,
	}
}

// fromAgentSession maps a provider session into the catalog row for the machine
// it was read from: an import scans this daemon's own filesystem, so that
// machine is this one.
func fromAgentSession(session agent.SessionInfo, deviceID string) store.AgentSession {
	caps := make([]string, 0, len(session.Capabilities))
	for _, cap := range session.Capabilities {
		caps = append(caps, string(cap))
	}
	return store.AgentSession{
		DeviceID: strings.TrimSpace(deviceID),
		AgentID:  session.AgentID, ExternalRef: session.ExternalRef,
		SourceURI: session.SourceURI, Title: session.Title, Cwd: session.Cwd,
		Status: session.Status, Capabilities: caps,
		SourceCursor: session.SourceCursor, ContentDigest: session.ContentDigest,
		FirstSeenAt: session.CreatedAt.UnixMilli(),
		LastSeenAt:  session.UpdatedAt.UnixMilli(),
		UpdatedAt:   session.UpdatedAt.UnixMilli(),
	}
}
