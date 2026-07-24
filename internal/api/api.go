package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"nhooyr.io/websocket"

	"github.com/vuuihc/kin/internal/adapter"
	"github.com/vuuihc/kin/internal/adapter/detect"
	"github.com/vuuihc/kin/internal/notify"
	"github.com/vuuihc/kin/internal/provider"
	"github.com/vuuihc/kin/internal/remote"
	"github.com/vuuihc/kin/internal/store"
	"github.com/vuuihc/kin/internal/task"
	"github.com/vuuihc/kin/internal/terminal"
	"github.com/vuuihc/kin/internal/usagewindows"
	"github.com/vuuihc/kin/internal/workspace"
)

// AgentInfo is one discovered agent for GET /api/agents.
type AgentInfo struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Kind         string   `json:"kind,omitempty"`
	Capabilities []string `json:"capabilities,omitempty"`
	Binary       string   `json:"binary,omitempty"`
	Installed    bool     `json:"installed"`
	Available    bool     `json:"available"`
	Default      bool     `json:"default"`
	Reason       string   `json:"reason,omitempty"`
	// InstallURL is an official homepage/install doc for agents not present locally.
	InstallURL string `json:"install_url,omitempty"`
	// Models contains only choices supported by a trustworthy local source or
	// stable CLI aliases. The task routing catalog is intentionally not exposed.
	Models          []AgentModelOption `json:"models,omitempty"`
	ModelListSource string             `json:"model_list_source"`
	ModelListStatus string             `json:"model_list_status"`
}

// AgentModelOption is one selectable model for an agent.
type AgentModelOption struct {
	ID    string `json:"id"`
	Label string `json:"label,omitempty"`
	Tier  string `json:"tier,omitempty"`
}

// Server holds HTTP handlers and dependencies for the Kin API.
type Server struct {
	Store     *store.Store
	Auth      *remote.Auth
	Engine    *task.Engine
	Terminals *terminal.Manager
	Version   string
	// Static is the embedded (or on-disk) UI filesystem. May be nil in tests.
	Static http.Handler
	// UploadsDir is where POST /api/uploads stores image attachments. Empty disables uploads.
	UploadsDir string
	// ArtifactsDir is where artifact file bodies are stored. Empty disables artifacts.
	ArtifactsDir string
	// ProjectsDir is where project One-Pagers live (ADR 0008). Empty disables projects.
	ProjectsDir string

	// Workspace runs Git probe/branch operations for the UI (optional in tests).
	Workspace *workspace.Manager

	// ListAgents returns live agent discovery status (set by server.Serve).
	ListAgents func() []AgentInfo

	// mgmtCache caches version/auth probes for GET /api/agents/management.
	// Lazily created; process-local only. mgmtCacheMu guards the lazy init
	// since Handler() serves concurrent requests.
	mgmtCache   *detect.ManagementCache
	mgmtCacheMu sync.Mutex

	// UsageWindows probes provider subscription rate-limit windows (5h/weekly).
	// May be nil (feature disabled); the handler then returns an empty list.
	UsageWindows *usagewindows.Service

	// ProviderResolve returns the active cognition provider for short LLM jobs
	// (chat titles, model routing, …). May be nil.
	ProviderResolve func(ctx context.Context) (provider.Client, provider.Config, error)

	// M3 connection metadata for Settings (set by server.Serve).
	NetworkMode string
	BaseURL     string // ui.base_url without token
	ConnectURL  string // full URL with ?token= for QR
	Token       string // initial token; prefer TokenFn
	TokenFn     func() string
}

// peerAddrKey stores the TCP peer before RealIP rewrites RemoteAddr.
// Internal approval routes must authorize the real connection, not X-Forwarded-For.
type peerAddrKey struct{}

// Handler returns the root chi router.
func (s *Server) Handler() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	// Capture true peer before RealIP so /internal/* can enforce loopback safely.
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ctx := req.Context()
			ctx = context.WithValue(ctx, peerAddrKey{}, req.RemoteAddr)
			next.ServeHTTP(w, req.WithContext(ctx))
		})
	})
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)
	// Gzip/deflate for API JSON and HTML/static text (M5 polish).
	r.Use(middleware.Compress(5))

	r.Get("/api/health", s.handleHealth)
	r.Get("/api/version", s.handleVersion)

	// Public API (token auth).
	r.Group(func(r chi.Router) {
		r.Use(s.Auth.Middleware)
		r.Get("/api/agents", s.handleListAgents)
		r.Get("/api/agents/management", s.handleAgentsManagement)
		r.Get("/api/tasks", s.handleListTasks)
		r.Post("/api/tasks", s.handleCreateTask)
		r.Get("/api/tasks/{id}", s.handleGetTask)
		r.Get("/api/tasks/{id}/usage", s.handleTaskUsage)
		r.Get("/api/tasks/{id}/events", s.handleListEvents)
		r.Get("/api/tasks/{id}/workspace/list", s.handleListTaskWorkspace)
		r.Get("/api/tasks/{id}/workspace/file", s.handleReadTaskWorkspaceFile)
		r.Put("/api/tasks/{id}/workspace/file", s.handleWriteTaskWorkspaceFile)
		r.Post("/api/tasks/{id}/workspace/restore", s.handleRestoreTaskWorkspace)
		r.Post("/api/tasks/{id}/cancel", s.handleCancelTask)
		r.Delete("/api/tasks/{id}", s.handleDeleteTask)
		r.Post("/api/tasks/{id}/prompt", s.handleFollowUp)
		r.Post("/api/tasks/{id}/retry", s.handleRetry)
		r.Post("/api/tasks/{id}/fork", s.handleFork)
		r.Get("/api/approvals", s.handleListApprovals)
		r.Post("/api/approvals/{id}/decision", s.handleDecision)
		r.Get("/api/user-questions", s.handleListUserQuestions)
		r.Post("/api/user-questions/{id}/answer", s.handleAnswerUserQuestion)
		r.Get("/api/recent-cwds", s.handleRecentCwds)
		r.Get("/api/git/branches", s.handleGitBranches)
		r.Post("/api/git/checkout", s.handleGitCheckout)
		r.Get("/api/settings", s.handleGetSettings)
		r.Put("/api/settings", s.handlePutSettings)
		r.Get("/api/providers", s.handleListProviders)
		r.Post("/api/providers", s.handleCreateProvider)
		r.Put("/api/providers/{id}", s.handleUpdateProvider)
		r.Delete("/api/providers/{id}", s.handleDeleteProvider)
		r.Post("/api/providers/{id}/activate", s.handleActivateProvider)
		r.Post("/api/notify/test", s.handleNotifyTest)
		r.Get("/api/usage/summary", s.handleUsageSummary)
		r.Get("/api/usage/limits", s.handleUsageLimits)
		r.Get("/api/usage/windows", s.handleUsageWindows)
		r.Post("/api/uploads", s.handleUpload)
		r.Get("/api/uploads/{name}", s.handleServeUpload)
		r.Get("/api/artifacts", s.handleListArtifacts)
		r.Post("/api/artifacts", s.handleCreateArtifact)
		r.Get("/api/artifacts/{id}", s.handleGetArtifact)
		r.Get("/api/artifacts/{id}/content", s.handleGetArtifactContent)
		r.Post("/api/artifacts/{id}/status", s.handleSetArtifactStatus)
		r.Get("/api/projects", s.handleListProjects)
		r.Post("/api/projects", s.handleCreateProject)
		r.Post("/api/projects/ensure", s.handleEnsureProject)
		r.Get("/api/projects/by-root", s.handleFindProjectByRoot)
		r.Get("/api/projects/{id}", s.handleGetProject)
		r.Patch("/api/projects/{id}", s.handlePatchProject)
		r.Get("/api/projects/{id}/one-pager", s.handleGetOnePager)
		r.Put("/api/projects/{id}/one-pager", s.handlePutOnePager)
		r.Get("/api/projects/{id}/pulse", s.handleGetProjectPulse)
		r.Post("/api/projects/{id}/pulse/refresh", s.handleRefreshProjectPulse)
		r.Get("/api/projects/{id}/tasks", s.handleListProjectTasks)
		r.Get("/api/projects/{id}/artifacts", s.handleListProjectArtifacts)
		r.Get("/api/routines", s.handleListRoutines)
		r.Post("/api/routines", s.handleCreateRoutine)
		r.Get("/api/routines/unread-count", s.handleRoutineUnreadCount)
		r.Post("/api/routines/mark-all-read", s.handleMarkAllRoutineRunsRead)
		r.Get("/api/routines/{id}", s.handleGetRoutine)
		r.Patch("/api/routines/{id}", s.handlePatchRoutine)
		r.Delete("/api/routines/{id}", s.handleDeleteRoutine)
		r.Post("/api/routines/{id}/run-now", s.handleRunRoutineNow)
		r.Post("/api/routines/runs/{taskID}/read", s.handleMarkRoutineRunRead)
		r.Get("/api/ws", s.handleWS)
	})

	// Internal approval bridge: loopback + token (spec §6).
	r.Group(func(r chi.Router) {
		r.Use(loopbackOnly)
		r.Use(s.Auth.Middleware)
		r.Post("/internal/approvals", s.handleInternalCreateApproval)
		r.Get("/internal/approvals/{id}/wait", s.handleInternalWaitApproval)
		r.Post("/internal/user-questions", s.handleInternalCreateUserQuestion)
		r.Get("/internal/user-questions/{id}/wait", s.handleInternalWaitUserQuestion)
	})

	// Integrated terminal: local desktop only. Keep these routes outside the
	// remotely accessible authenticated API group.
	r.Group(func(r chi.Router) {
		r.Use(loopbackOnly)
		r.Use(s.Auth.Middleware)
		r.Get("/api/terminal/profiles", s.handleTerminalProfiles)
		r.Get("/api/terminal/sessions", s.handleTerminalSessions)
		r.Post("/api/terminal/sessions", s.handleCreateTerminalSession)
		r.Delete("/api/terminal/sessions/{id}", s.handleDeleteTerminalSession)
		r.Get("/api/terminal/sessions/{id}/ws", s.handleTerminalWS)
	})

	if s.Static != nil {
		r.Handle("/*", s.Static)
	}

	return r
}

func loopbackOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Prefer the TCP peer captured before RealIP (X-Forwarded-For must not
		// unlock or block the local MCP approve bridge).
		addr := r.RemoteAddr
		if v, ok := r.Context().Value(peerAddrKey{}).(string); ok && v != "" {
			addr = v
		}
		if !isLoopbackRemote(addr) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "loopback only"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func isLoopbackRemote(remote string) bool {
	host, _, err := net.SplitHostPort(remote)
	if err != nil {
		host = remote
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleVersion(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"version": s.Version})
}

func (s *Server) handleListTasks(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	opts := store.ListTasksOpts{
		Status: q.Get("status"),
		Before: q.Get("before"),
		Query:  q.Get("q"),
	}
	if lim := q.Get("limit"); lim != "" {
		n, err := strconv.Atoi(lim)
		if err != nil || n < 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid limit"})
			return
		}
		opts.Limit = n
	}
	tasks, err := s.Engine.List(r.Context(), opts)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if tasks == nil {
		tasks = []store.Task{}
	}
	writeJSON(w, http.StatusOK, tasks)
}

func (s *Server) handleListAgents(w http.ResponseWriter, r *http.Request) {
	if s.ListAgents != nil {
		list := s.ListAgents()
		if list == nil {
			list = []AgentInfo{}
		}
		for i := range list {
			applyAgentModelList(&list[i])
		}
		writeJSON(w, http.StatusOK, list)
		return
	}
	// Tests without discovery: mirror engine adapters.
	var list []AgentInfo
	def := ""
	if s.Engine != nil {
		def = s.Engine.DefaultAgent()
		for _, id := range s.Engine.AgentIDs() {
			list = append(list, AgentInfo{
				ID:        id,
				Name:      id,
				Installed: true,
				Available: true,
				Default:   id == def,
			})
			applyAgentModelList(&list[len(list)-1])
		}
	}
	if list == nil {
		list = []AgentInfo{}
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) handleAgentsManagement(w http.ResponseWriter, r *http.Request) {
	agents := s.managementAgentInfos()
	cache := s.managementCache()
	if r.URL.Query().Get("refresh") == "1" {
		cache.Invalidate()
	}
	key := detect.ManagementCacheKey(agents)
	writeJSON(w, http.StatusOK, cache.Get(key, agents))
}

func (s *Server) managementCache() *detect.ManagementCache {
	s.mgmtCacheMu.Lock()
	defer s.mgmtCacheMu.Unlock()
	if s.mgmtCache == nil {
		s.mgmtCache = detect.NewManagementCache(0)
	}
	return s.mgmtCache
}

func (s *Server) managementAgentInfos() []detect.Info {
	if s.ListAgents != nil {
		list := s.ListAgents()
		out := make([]detect.Info, 0, len(list))
		for _, a := range list {
			out = append(out, detect.Info{
				ID:        a.ID,
				Name:      a.Name,
				Binary:    a.Binary,
				Installed: a.Installed,
				Available: a.Available,
				Default:   a.Default,
				Reason:    a.Reason,
			})
		}
		return out
	}
	if s.Engine != nil {
		def := s.Engine.DefaultAgent()
		var out []detect.Info
		for _, id := range s.Engine.AgentIDs() {
			out = append(out, detect.Info{
				ID:        id,
				Name:      id,
				Installed: true,
				Available: true,
				Default:   id == def,
			})
		}
		return out
	}
	return detect.Scan("")
}

func (s *Server) handleCreateTask(w http.ResponseWriter, r *http.Request) {
	var req task.CreateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if err := s.validateGenericCLIPermission(r.Context(), req.Agent, req.PermissionMode); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	// Best-effort project context inject. Failures never block task creation.
	s.maybeInjectProjectContext(r.Context(), &req)
	t, err := s.Engine.Create(r.Context(), req)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, t)
}

// validateGenericCLIPermission rejects Tier-2 agents under default permission mode.
// Those agents have no Kin approval channel and require accept_edits or yolo.
func (s *Server) validateGenericCLIPermission(ctx context.Context, agentID, permissionMode string) error {
	_ = ctx
	agentID = strings.TrimSpace(agentID)
	if agentID == "" || !detect.IsGenericCLI(agentID) {
		return nil
	}
	perm := adapter.NormalizePermissionMode(permissionMode)
	if perm == adapter.PermissionAcceptEdits || perm == adapter.PermissionYOLO {
		return nil
	}
	return fmt.Errorf(
		"agent %q cannot use Kin approval inbox; choose permission_mode accept_edits or yolo",
		agentID,
	)
}

func (s *Server) handleGetTask(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	t, err := s.Engine.Get(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, t)
}

func (s *Server) handleListEvents(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	since := 0
	if v := r.URL.Query().Get("since_seq"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid since_seq"})
			return
		}
		since = n
	}
	evs, err := s.Engine.Events(r.Context(), id, since)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if evs == nil {
		evs = []store.Event{}
	}
	writeJSON(w, http.StatusOK, evs)
}

func (s *Server) handleDeleteTask(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	err := s.Engine.Delete(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleCancelTask(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	t, err := s.Engine.Cancel(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, t)
}

func (s *Server) handleFollowUp(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body task.FollowUpRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	t, err := s.Engine.FollowUpWith(r.Context(), id, body)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if errors.Is(err, task.ErrConflict) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, t)
}

func (s *Server) handleRestoreTaskWorkspace(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body struct {
		EventSeq int `json:"event_seq"`
	}
	if r.Body != nil {
		dec := json.NewDecoder(r.Body)
		dec.DisallowUnknownFields()
		if err := dec.Decode(&body); err != nil && !errors.Is(err, io.EOF) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
			return
		}
	}
	t, err := s.Engine.RestoreWorkspace(r.Context(), id, body.EventSeq)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if errors.Is(err, task.ErrConflict) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "task is not terminal"})
		return
	}
	if errors.Is(err, workspace.ErrCheckpointUnavailable) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	if errors.Is(err, workspace.ErrNotIsolated) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, t)
}

func (s *Server) handleRetry(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body task.RetryRequest
	if r.Body != nil {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil && !errors.Is(err, io.EOF) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
			return
		}
	}
	t, err := s.Engine.Retry(r.Context(), id, body)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if errors.Is(err, task.ErrNotTerminal) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "task is not terminal"})
		return
	}
	if errors.Is(err, task.ErrInvalidSeq) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid from_seq"})
		return
	}
	if errors.Is(err, workspace.ErrCheckpointUnavailable) || errors.Is(err, workspace.ErrNotIsolated) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, t)
}

func (s *Server) handleFork(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body task.ForkRequest
	if r.Body != nil {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil && !errors.Is(err, io.EOF) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
			return
		}
	}
	t, err := s.Engine.Fork(r.Context(), id, body)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if errors.Is(err, task.ErrInvalidSeq) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid from_seq"})
		return
	}
	if errors.Is(err, workspace.ErrCheckpointUnavailable) || errors.Is(err, workspace.ErrNotIsolated) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, t)
}

func (s *Server) handleListApprovals(w http.ResponseWriter, r *http.Request) {
	opts := store.ListApprovalsOpts{
		Status: r.URL.Query().Get("status"),
	}
	list, err := s.Engine.ListApprovals(r.Context(), opts)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if list == nil {
		list = []store.Approval{}
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) handleDecision(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body task.DecisionRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	decision := strings.TrimSpace(body.Decision)
	switch decision {
	case store.DecisionApproved, store.DecisionDenied:
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "decision must be approved or denied"})
		return
	}
	a, err := s.Engine.Decide(r.Context(), id, decision, "web")
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if errors.Is(err, task.ErrAlreadyDecided) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "already decided"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, a)
}

func (s *Server) handleInternalCreateApproval(w http.ResponseWriter, r *http.Request) {
	var req task.CreateApprovalRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	a, err := s.Engine.RequestApproval(r.Context(), req)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "task not found"})
		return
	}
	if errors.Is(err, task.ErrConflict) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, a)
}

func (s *Server) handleInternalWaitApproval(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	timeout := 30 * time.Second
	if v := r.URL.Query().Get("timeout"); v != "" {
		sec, err := strconv.Atoi(v)
		if err != nil || sec < 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid timeout"})
			return
		}
		if sec > 30 {
			sec = 30
		}
		timeout = time.Duration(sec) * time.Second
	}
	a, err := s.Engine.WaitApproval(r.Context(), id, timeout)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, a)
}

func (s *Server) handleListUserQuestions(w http.ResponseWriter, r *http.Request) {
	opts := store.ListUserQuestionsOpts{
		Status: r.URL.Query().Get("status"),
	}
	list, err := s.Engine.ListUserQuestions(r.Context(), opts)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if list == nil {
		list = []store.UserQuestion{}
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) handleAnswerUserQuestion(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body task.AnswerUserQuestionRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if len(body.Selected) == 0 && strings.TrimSpace(body.OtherText) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "selected or other_text is required"})
		return
	}
	q, err := s.Engine.AnswerUserQuestion(r.Context(), id, body, "web")
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if errors.Is(err, task.ErrAlreadyAnswered) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "already answered"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, q)
}

func (s *Server) handleInternalCreateUserQuestion(w http.ResponseWriter, r *http.Request) {
	var req task.CreateUserQuestionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	q, err := s.Engine.RequestUserQuestion(r.Context(), req)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "task not found"})
		return
	}
	if errors.Is(err, task.ErrConflict) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, q)
}

func (s *Server) handleInternalWaitUserQuestion(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	timeout := 30 * time.Second
	if v := r.URL.Query().Get("timeout"); v != "" {
		sec, err := strconv.Atoi(v)
		if err != nil || sec < 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid timeout"})
			return
		}
		if sec > 30 {
			sec = 30
		}
		timeout = time.Duration(sec) * time.Second
	}
	q, err := s.Engine.WaitUserQuestion(r.Context(), id, timeout)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, q)
}

func (s *Server) handleRecentCwds(w http.ResponseWriter, r *http.Request) {
	cwds, err := s.Engine.RecentCwds(r.Context(), 15)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if cwds == nil {
		cwds = []string{}
	}
	writeJSON(w, http.StatusOK, cwds)
}

// settingsResponse is GET /api/settings (spec §8 / §9 page 4).
type settingsResponse struct {
	NotifyBarkURL   string `json:"notify.bark_url"`
	NotifyNtfyTopic string `json:"notify.ntfy_topic"`
	UIBaseURL       string `json:"ui.base_url"`
	PriceTable      string `json:"price_table"`
	AgentLimits     string `json:"agent_limits"`
	// Cognition provider (OpenAI-compatible). api_key is masked on GET.
	// These fields mirror the *active* multi-provider entry for backward compat.
	ProviderKind     string `json:"provider.kind"`
	ProviderBaseURL  string `json:"provider.base_url"`
	ProviderAPIKey   string `json:"provider.api_key"`
	ProviderModel    string `json:"provider.model"`
	ProviderStream   string `json:"provider.stream"`
	ProviderActiveID string `json:"provider.active_id"`
	AgentDefault     string `json:"agent.default"`
	NetworkMode      string `json:"network_mode"`
	ConnectURL       string `json:"connect_url"`
	Token            string `json:"token"`
}

// Allowed settings keys for PUT (subset of store keys).
var puttableSettings = map[string]bool{
	"notify.bark_url":   true,
	"notify.ntfy_topic": true,
	"ui.base_url":       true,
	"price_table":       true,
	"agent_limits":      true,
	"provider.kind":     true,
	"provider.base_url": true,
	"provider.api_key":  true,
	"provider.model":    true,
	"provider.stream":   true,
	"agent.default":     true,
}

func (s *Server) handleGetSettings(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	get := func(key string) string {
		v, err := s.Store.GetSetting(ctx, key)
		if err != nil {
			return ""
		}
		return v
	}
	tok := s.Token
	if s.TokenFn != nil {
		if t := s.TokenFn(); t != "" {
			tok = t
		}
	}
	base := get("ui.base_url")
	if base == "" {
		base = s.BaseURL
	}
	// Always rebuild connect URL with the current token so rotate stays correct.
	connect := ""
	if base != "" && tok != "" {
		connect = strings.TrimRight(base, "/") + "/?token=" + tok
	} else if s.ConnectURL != "" {
		connect = s.ConnectURL
	}
	priceTable := get(store.KeyPriceTable)
	if strings.TrimSpace(priceTable) == "" {
		priceTable = store.DefaultPriceTableJSON
	}
	agentLimits := get(store.KeyAgentLimits)
	if strings.TrimSpace(agentLimits) == "" {
		agentLimits = "{}"
	}
	// Active cognition provider from multi-provider registry (legacy keys mirrored).
	provKind := firstNonEmpty(get("provider.kind"), "openai-compatible")
	provBase := get("provider.base_url")
	provKey := get("provider.api_key")
	provModel := get("provider.model")
	provStream := get(provider.KeyStream)
	if provStream == "" {
		provStream = "false"
	}
	provActive := get(provider.KeyActiveProvider)
	if reg, err := provider.LoadRegistry(ctx, s.Store); err == nil {
		provActive = reg.ActiveID
		if active, ok := reg.Active(); ok {
			provKind = firstNonEmpty(active.Kind, "openai-compatible")
			provBase = active.BaseURL
			provKey = active.APIKey
			provModel = active.Model
			if active.Stream {
				provStream = "true"
			} else {
				provStream = "false"
			}
		}
	}
	writeJSON(w, http.StatusOK, settingsResponse{
		NotifyBarkURL:    get("notify.bark_url"),
		NotifyNtfyTopic:  get("notify.ntfy_topic"),
		UIBaseURL:        base,
		PriceTable:       priceTable,
		AgentLimits:      agentLimits,
		ProviderKind:     provKind,
		ProviderBaseURL:  provBase,
		ProviderAPIKey:   maskSettingSecret(provKey),
		ProviderModel:    provModel,
		ProviderStream:   provStream,
		ProviderActiveID: provActive,
		AgentDefault:     get("agent.default"),
		NetworkMode:      s.NetworkMode,
		ConnectURL:       connect,
		Token:            tok,
	})
}

func maskSettingSecret(key string) string {
	key = strings.TrimSpace(key)
	if key == "" {
		return ""
	}
	if len(key) <= 8 {
		return "••••••••"
	}
	return key[:3] + "…" + key[len(key)-4:]
}

func firstNonEmpty(a, b string) string {
	if strings.TrimSpace(a) != "" {
		return a
	}
	return b
}

func (s *Server) handlePutSettings(w http.ResponseWriter, r *http.Request) {
	var body map[string]string
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	ctx := r.Context()

	// Provider clear flag (not stored as a real setting).
	clearProviderKey := body["provider.clear_api_key"] == "1" || body["provider.clear_api_key"] == "true"
	if clearProviderKey {
		_ = s.Store.SetSetting(ctx, "provider.api_key", "")
		delete(body, "provider.clear_api_key")
	}
	delete(body, "provider.clear_api_key")

	// Validate provider fields together when any present.
	if _, ok := body["provider.base_url"]; ok || body["provider.model"] != "" || body["provider.kind"] != "" {
		// Allow partial save of empty base_url to disable provider.
	}

	providerSlotTouched := clearProviderKey
	for k, v := range body {
		if !puttableSettings[k] {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown or read-only setting: " + k})
			return
		}
		if k == "provider.clear_api_key" {
			continue
		}
		if strings.HasPrefix(k, "provider.") {
			providerSlotTouched = true
		}
		if k == store.KeyPriceTable {
			// Empty value clears the override so GET/LoadPriceTable use the
			// embedded LiteLLM-curated defaults again.
			if strings.TrimSpace(v) != "" {
				if _, err := store.ParsePriceTable(v); err != nil {
					writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
					return
				}
				// Canonical compact form for storage.
				if t, err := store.ParsePriceTable(v); err == nil {
					if b, err := json.Marshal(t); err == nil {
						v = string(b)
					}
				}
			} else {
				v = ""
			}
		}
		if k == store.KeyAgentLimits {
			if _, err := store.ParseAgentLimits(v); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
		}
		if k == "agent.default" {
			v = strings.TrimSpace(v)
			if v != "" {
				if err := s.validateAgentDefault(r.Context(), v); err != nil {
					writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
					return
				}
			}
		}
		// Ignore masked api_key round-trips from GET.
		if k == "provider.api_key" && (v == "" || strings.Contains(v, "…") || strings.Contains(v, "••••")) {
			continue
		}
		if err := s.Store.SetSetting(ctx, k, v); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		if k == "ui.base_url" {
			s.BaseURL = strings.TrimRight(strings.TrimSpace(v), "/")
		}
	}
	// Keep multi-provider registry in sync when legacy single-slot keys are written.
	if providerSlotTouched {
		if err := syncRegistryFromLegacySettings(ctx, s.Store); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
	}
	// Return updated snapshot.
	s.handleGetSettings(w, r)
}

// notifyTestResponse is POST /api/notify/test.
type notifyTestResponse struct {
	OK      bool                   `json:"ok"`
	Results []notify.ChannelResult `json:"results"`
}

func (s *Server) handleNotifyTest(w http.ResponseWriter, r *http.Request) {
	sender := &notify.Sender{Store: s.Store}
	payload := notify.Payload{
		Title: "Kin test",
		Body:  "Notification test from kin",
		URL:   sender.DeepLink(r.Context(), "/settings"),
	}
	results := sender.Deliver(r.Context(), payload)
	if results == nil {
		results = []notify.ChannelResult{}
	}
	anyOK := false
	for _, res := range results {
		if res.OK {
			anyOK = true
			break
		}
	}
	// ok is true only when at least one channel succeeded.
	// Empty configuration returns ok=false with an empty results list.
	writeJSON(w, http.StatusOK, notifyTestResponse{OK: anyOK, Results: results})
}

func (s *Server) handleUsageSummary(w http.ResponseWriter, r *http.Request) {
	days := 30
	if d := r.URL.Query().Get("days"); d != "" {
		n, err := strconv.Atoi(d)
		if err != nil || n < 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid days"})
			return
		}
		days = n
	}
	rows, err := s.Store.UsageSummary(r.Context(), days)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if rows == nil {
		rows = []store.UsageRow{}
	}
	writeJSON(w, http.StatusOK, rows)
}

func (s *Server) handleUsageLimits(w http.ResponseWriter, r *http.Request) {
	statuses, err := s.Store.AgentLimitStatuses(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if statuses == nil {
		statuses = []store.AgentLimitStatus{}
	}
	writeJSON(w, http.StatusOK, statuses)
}

// handleUsageWindows returns the per-provider subscription rate-limit windows
// (5h + weekly). It is best-effort and display-only; when the feature is
// disabled it returns an empty list.
func (s *Server) handleUsageWindows(w http.ResponseWriter, r *http.Request) {
	if s.UsageWindows == nil {
		writeJSON(w, http.StatusOK, []usagewindows.Provider{})
		return
	}
	writeJSON(w, http.StatusOK, s.UsageWindows.Statuses(r.Context()))
}

func (s *Server) handleTaskUsage(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	usage, err := s.Store.TaskUsage(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "task not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, usage)
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Local daemon; same-origin UI and ?token= clients.
		InsecureSkipVerify: true,
	})
	if err != nil {
		return
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	sub := s.Engine.Bus().Subscribe()
	defer s.Engine.Bus().Unsubscribe(sub)

	ctx := r.Context()
	// Clients only ping; read loop detects disconnect.
	go func() {
		for {
			if _, _, err := conn.Read(ctx); err != nil {
				return
			}
		}
	}()

	for {
		select {
		case <-ctx.Done():
			return
		case msg, ok := <-sub:
			if !ok {
				return
			}
			data, err := json.Marshal(msg)
			if err != nil {
				continue
			}
			writeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			err = conn.Write(writeCtx, websocket.MessageText, data)
			cancel()
			if err != nil {
				return
			}
		}
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// validateAgentDefault ensures the preferred host agent is registered, locally
// present (skills discovery / PATH), and currently runnable.
func (s *Server) validateAgentDefault(ctx context.Context, id string) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return nil
	}
	if s.Engine == nil {
		return nil
	}
	if !s.Engine.HasAgent(id) {
		// Discovery-only ids (skills catalog) cannot be host until a Kin adapter exists.
		if detect.IsLocallyPresent(id) {
			return fmt.Errorf("agent %q is installed locally but not supported as a Kin host yet", id)
		}
		return fmt.Errorf("unknown agent %q", id)
	}
	// Local presence: skip for builtin kin (provider-backed); require for CLI ids.
	if id != "kin" && !detect.IsLocallyPresent(id) {
		// Still allow if the adapter Status reports available (e.g. custom KIN_*_BIN
		// path outside discovery heuristics) — GetRunnable is the final gate.
		if _, err := s.Engine.Agents().GetRunnable(ctx, id); err == nil {
			return nil
		}
		return fmt.Errorf("agent %q is not installed on this machine", id)
	}
	if _, err := s.Engine.Agents().GetRunnable(ctx, id); err != nil {
		return fmt.Errorf("agent %q is not available (%v)", id, err)
	}
	return nil
}

func applyAgentModelList(info *AgentInfo) {
	if info.ModelListSource != "" || info.ModelListStatus != "" {
		return
	}
	if len(info.Models) > 0 {
		info.ModelListSource = "configured"
		info.ModelListStatus = "available"
		return
	}
	switch info.ID {
	case "claude-code":
		info.Models = []AgentModelOption{
			{ID: "opus", Label: "Opus"},
			{ID: "sonnet", Label: "Sonnet"},
			{ID: "haiku", Label: "Haiku"},
		}
		info.ModelListSource = "recommended"
		info.ModelListStatus = "available"
	case "codex":
		info.Models = nil
		info.ModelListSource = "none"
		info.ModelListStatus = "default_only"
	case "kin":
		// Kin runs on the Cognition provider; model comes from Settings
		// (provider.model), not Claude-style short aliases.
		info.Models = nil
		info.ModelListSource = "none"
		info.ModelListStatus = "default_only"
	default:
		info.ModelListSource = "none"
		info.ModelListStatus = "unavailable"
	}
}
