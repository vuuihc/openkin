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

	"github.com/vuuihc/openkin/internal/a2a"
	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/adapter/detect"
	"github.com/vuuihc/openkin/internal/agent"
	"github.com/vuuihc/openkin/internal/auth"
	"github.com/vuuihc/openkin/internal/browserworker"
	"github.com/vuuihc/openkin/internal/cloudflare"
	"github.com/vuuihc/openkin/internal/connectors"
	"github.com/vuuihc/openkin/internal/eval"
	"github.com/vuuihc/openkin/internal/github"
	"github.com/vuuihc/openkin/internal/hub/workers"
	"github.com/vuuihc/openkin/internal/mcp"
	"github.com/vuuihc/openkin/internal/node"
	"github.com/vuuihc/openkin/internal/notify"
	"github.com/vuuihc/openkin/internal/provider"
	"github.com/vuuihc/openkin/internal/remote"
	"github.com/vuuihc/openkin/internal/remote/worker"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/task"
	"github.com/vuuihc/openkin/internal/terminal"
	"github.com/vuuihc/openkin/internal/workspace"
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
	Store                *store.Store
	Auth                 *remote.Auth
	Engine               *task.Engine
	MCP                  *mcp.Server
	Connectors           *connectors.Manager
	Terminals            *terminal.Manager
	Version              string
	DesktopID            string
	DesktopName          string
	agentSessionAttachMu sync.Mutex
	// Accounts is the Hub account system. Nil on a standalone daemon, which
	// keeps the token-only behavior it has always had.
	Accounts *auth.Service
	// OIDC is the optional federated identity provider. Nil when only local
	// passwords are enabled.
	OIDC *auth.OIDCProvider
	// FederationProxy publishes a same-origin identity provider under this
	// Hub, mounted at FederationProxyPath. Nil when the provider has its own
	// origin and is reached directly.
	FederationProxy     http.Handler
	FederationProxyPath string
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

	// GitHub reads pull-request state for a task's branch (optional in tests).
	GitHub *github.Service

	// ListAgents returns live agent discovery status (set by server.Serve).
	ListAgents func() []AgentInfo
	// ListAgentProviders returns unified discovery/session capability evidence.
	ListAgentProviders func() []agent.ProviderInfo
	// Agents is the opened local Agent registry used for session discovery.
	Agents *agent.Registry

	// SmokeAgents runs headless probes for installed Tier-2 agents (optional).
	SmokeAgents SmokeAgents

	// mgmtCache caches version/auth probes for GET /api/agents/management.
	// Lazily created; process-local only. mgmtCacheMu guards the lazy init
	// since Handler() serves concurrent requests.
	mgmtCache   *detect.ManagementCache
	mgmtCacheMu sync.Mutex

	// ProviderResolve returns the active cognition provider for short LLM jobs
	// (chat titles, model routing, …). May be nil.
	ProviderResolve func(ctx context.Context) (provider.Client, provider.Config, error)

	// RunRoutine dispatches a manual Routine through the shared scheduler.
	// Keeping this behind the application boundary ensures REST and MCP use
	// the same background capacity and durable dispatch ledger.
	RunRoutine func(context.Context, string) (store.Task, error)

	// RelaySnapshot returns the process-local Relay connection state. It is
	// optional so API tests and embedders do not need to configure Relay.
	RelaySnapshot func() RelayStatus
	// ConfigureRelay applies a Relay URL at runtime. Empty URL disables Relay.
	ConfigureRelay func(context.Context, string) (RelayStatus, error)
	// RefreshRelayPairing creates a fresh, short-lived phone pairing URL.
	RefreshRelayPairing func(context.Context) (RelayStatus, error)
	// Cloudflare optionally deploys the user-owned Relay Worker from Settings.
	Cloudflare *cloudflare.Service

	// Workers is the in-memory registry for optional user-owned headless
	// workers. Leases are intentionally ephemeral and workers reconnect after
	// daemon restart.
	Workers *workers.Registry
	// Nodes holds the live Node control-channel connections. Nil disables
	// /api/node, which is what a daemon that does not expect Nodes to dial in
	// (a test, an embedder) wants.
	Nodes *node.Connections
	// Queries is where questions asked of those connections wait for their
	// answers (see node.Queries). Nil disables every route that has to ask a
	// machine something, because a question with nowhere to wait is a request
	// that can only hang.
	Queries *node.Queries
	// LocalMachine answers questions about this daemon's own filesystem, in the
	// same words a paired machine answers them about its own. Nil means this
	// daemon has no directories to offer, which is the honest answer for a Hub
	// that owns no workspaces.
	LocalMachine *node.Responder
	// NodeFrames routes a frame that arrived on a Node connection and is not
	// part of the handshake or the heartbeat. The connection is the argument and
	// not just its device: a turn belongs to the socket that dispatched it, so
	// the answer to "whose frame is this" is the connection. Nil means nothing
	// consumes them yet, and the Hub answers with an error frame.
	NodeFrames func(ctx context.Context, sender node.Sender, frame worker.Frame) error
	// ApprovalRelay, when set, is where a permission question goes when it is
	// about a turn this daemon is running for a Hub. This machine is still the
	// one the agent asked — the question arrives on this daemon's loopback
	// approval API — but the person who has to answer it is looking at the Hub,
	// so the question travels (see node.ApprovalRelay). Nil means every approval
	// this daemon is asked about is its own.
	ApprovalRelay ApprovalRelay
	// Browser is the optional Playwright bridge for task-attached actions.
	Browser *browserworker.Runner
	// Eval is the optional file-backed replay/evaluation service.
	Eval *eval.Runner
	// A2A is the opt-in agent-level delegation facade.
	A2A *a2a.Server

	// M3 connection metadata for Settings (set by server.Serve).
	NetworkMode string
	BaseURL     string // ui.base_url without token
	ConnectURL  string // full URL with ?token= for QR
	Token       string // initial token; prefer TokenFn
	TokenFn     func() string
}

// RelayStatus is the Relay projection exposed to the master-only Settings UI.
// OpenURL and PairingURL contain credentials and must not be persisted or
// logged. They are returned only on this already master-authenticated surface.
type RelayStatus struct {
	URL        string `json:"relay.url"`
	State      string `json:"relay.state"`
	ConnectURL string `json:"relay.connect_url"`
	OpenURL    string `json:"relay.open_url"`
	PairingURL string `json:"relay.pairing_url"`
	LastError  string `json:"relay.last_error,omitempty"`
}

type CloudflareRelayStatus struct {
	Authenticated bool   `json:"cloudflare.authenticated"`
	AccountID     string `json:"cloudflare.account_id,omitempty"`
	AccountName   string `json:"cloudflare.account_name,omitempty"`
	ScriptName    string `json:"cloudflare.relay_script_name,omitempty"`
	WorkerURL     string `json:"cloudflare.relay_worker_url,omitempty"`
	CustomDomain  string `json:"cloudflare.relay_custom_domain,omitempty"`
	CustomURL     string `json:"cloudflare.relay_custom_domain_url,omitempty"`
	ZoneID        string `json:"cloudflare.relay_zone_id,omitempty"`
	ZoneName      string `json:"cloudflare.relay_zone_name,omitempty"`
	LastError     string `json:"cloudflare.relay_last_error,omitempty"`
}

// peerAddrKey stores the TCP peer before RealIP rewrites RemoteAddr.
// Internal approval routes must authorize the real connection, not X-Forwarded-For.
type peerAddrKey struct{}

// Handler returns the root chi router.
func (s *Server) Handler() http.Handler {
	r := chi.NewRouter()
	if s.Auth != nil && s.Store != nil {
		s.Auth.SetDeviceLookup(func(ctx context.Context, token string) (remote.Principal, bool) {
			credential, err := s.Store.AuthenticateDevice(ctx, remote.HashToken(token), time.Now().UnixMilli())
			if err != nil {
				return remote.Principal{}, false
			}
			return remote.Principal{
				Kind:     remote.PrincipalDevice,
				DeviceID: credential.ID,
				Label:    credential.Label,
			}, true
		})
	}
	if s.Auth != nil && s.Accounts != nil {
		s.Auth.SetSessionLookup(func(ctx context.Context, token string) (remote.Principal, bool) {
			user, err := s.Accounts.Authenticate(ctx, token)
			if err != nil {
				return remote.Principal{}, false
			}
			return remote.Principal{
				Kind:   remote.PrincipalUser,
				UserID: user.ID,
				Role:   user.Role,
				Label:  user.DisplayName,
			}, true
		})
	}
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
	r.Get("/api/cloudflare/oauth/callback", s.handleCloudflareOAuthCallback)
	r.Post("/api/pairing/exchange", s.handlePairingExchange)
	// Account endpoints are unauthenticated by necessity: they are how a client
	// obtains a session in the first place. Each applies its own attempt limit.
	r.Get("/api/auth/status", s.handleAuthStatus)
	r.Post("/api/auth/bootstrap", s.handleAuthBootstrap)
	r.Post("/api/auth/login", s.handleAuthLogin)
	r.Post("/api/auth/logout", s.handleAuthLogout)
	r.Get("/api/auth/me", s.handleAuthMe)
	r.Get("/api/auth/oidc/start", s.handleOIDCStart)
	r.Get("/api/auth/oidc/callback", s.handleOIDCCallback)
	if s.FederationProxy != nil && s.FederationProxyPath != "" {
		// A provider published behind this Hub keeps its own paths, its own
		// cookies, and its own CSRF defenses. Kin forwards and stays out of it.
		r.Handle(s.FederationProxyPath, s.FederationProxy)
		r.Handle(s.FederationProxyPath+"/*", s.FederationProxy)
	}
	if s.A2A != nil && s.A2A.Enabled {
		a2aHandler := s.A2A.Handler()
		r.Get("/.well-known/agent-card.json", func(w http.ResponseWriter, req *http.Request) {
			a2aHandler.ServeHTTP(w, req)
		})
	}

	// Public API (token auth).
	r.Group(func(r chi.Router) {
		r.Use(s.Auth.Middleware)
		if s.MCP != nil {
			r.Post("/mcp", func(w http.ResponseWriter, req *http.Request) {
				s.MCP.Handler().ServeHTTP(w, req)
			})
		}
		r.With(operatorOnly).Post("/api/pairing/sessions", s.handleCreatePairingSession)
		r.With(operatorOnly).Get("/api/devices", s.handleListDevices)
		r.With(operatorOnly).Post("/api/devices/{id}/revoke", s.handleRevokeDevice)
		r.With(holderOnly).Get("/api/workers", s.handleListWorkers)
		// A machine's own directories, for the console that has to pick one
		// before it can start anything. Holder-only: a guest on someone's Hub
		// runs its own tasks and has no business reading the holder's paths.
		r.With(holderOnly).Get("/api/machines/{device}/dirs", s.handleMachineDirs)
		// Starting a session on a repository the machine does not have yet, which
		// is the one thing a phone cannot do by browsing: it names a repository,
		// and the machine fetches it and says where it put it.
		//
		// Holder-only rather than operatorOnly, which is the same call the rest of
		// this block makes and not an oversight about writing: a paired phone is
		// enrolled by the holder and is a full client of the machine it was paired
		// to, which is the whole point of having one. The write is bounded on the
		// machine's side — the destination is derived there, inside its own
		// checkout root, and a directory that is not exactly that repository is
		// refused rather than replaced.
		r.With(holderOnly).Get("/api/machines/{device}/repo/branches", s.handleMachineRepoBranches)
		r.With(holderOnly).Post("/api/machines/{device}/repo/prepare", s.handleMachineRepoPrepare)
		r.With(operatorOnly).Post("/api/workers/{id}/revoke", s.handleRevokeWorker)
		r.Post("/api/workers/register", s.handleRegisterWorker)
		r.Post("/api/workers/heartbeat", s.handleHeartbeatWorker)
		r.Get("/api/agents", s.handleListAgents)
		r.With(holderOnly).Get("/api/agent-providers", s.handleListAgentProviders)
		r.With(holderOnly).Get("/api/agent-sessions", s.handleListAgentSessions)
		r.With(holderOnly).Get("/api/agent-sessions/page", s.handleListAgentSessionsPage)
		r.With(holderOnly).Get("/api/agent-sessions/{id}", s.handleGetAgentSession)
		r.With(operatorOnly).Post("/api/agent-sessions/import", s.handleImportAgentSessions)
		r.With(operatorOnly).Get("/api/agent-sessions/{id}/history", s.handleGetAgentSessionHistory)
		r.With(operatorOnly).Post("/api/agent-sessions/{id}/attach", s.handleAttachAgentSession)
		r.With(holderOnly).Get("/api/agents/management", s.handleAgentsManagement)
		r.With(operatorOnly).Post("/api/agents/smoke", s.handleAgentsSmoke)
		r.With(holderOnly).Get("/api/connectors", s.handleListConnectors)
		r.With(operatorOnly).Post("/api/connectors", s.handleRegisterConnector)
		r.With(operatorOnly).Patch("/api/connectors/{id}", s.handleUpdateConnector)
		r.With(operatorOnly).Delete("/api/connectors/{id}", s.handleDisableConnector)
		r.With(holderOnly).Get("/api/connectors/{id}/tools", s.handleListConnectorTools)
		r.With(operatorOnly).Post("/api/connectors/{id}/call", s.handleCallConnector)
		r.With(operatorOnly).Put("/api/connectors/credentials/{ref}", s.handleSetConnectorCredential)
		r.With(operatorOnly).Delete("/api/connectors/credentials/{ref}", s.handleDeleteConnectorCredential)
		r.Get("/api/tasks", s.handleListTasks)
		r.Get("/api/sessions", s.handleListSessions)
		r.Get("/api/sessions/cursor", s.handleSessionCursor)
		r.Post("/api/tasks", s.handleCreateTask)
		// Everything that names one task goes through taskInScope. Scoping only
		// the list would leave the id as a way around it.
		r.Route("/api/tasks/{id}", func(r chi.Router) {
			r.Use(s.taskInScope)
			r.Get("/", s.handleGetTask)
			r.Get("/usage", s.handleTaskUsage)
			r.Get("/events", s.handleListEvents)
			r.Post("/replay", s.handleReplayTask)
			r.Get("/workers", s.handleListWorkerSteps)
			r.Post("/browser/actions", s.handleBrowserAction)
			r.Get("/limit-wait", s.handleTaskLimitWait)
			r.Get("/workspaces", s.handleListTaskWorkspaces)
			r.Get("/workspaces/{workspace_id}/tree", s.handleListWorkspaceTree)
			r.Get("/workspaces/{workspace_id}/file", s.handleReadWorkspaceFile)
			r.With(operatorOnly).Put("/workspaces/{workspace_id}/file", s.handleWriteWorkspaceFile)
			r.Get("/workspaces/{workspace_id}/diff", s.handleGetWorkspaceDiff)
			r.Get("/pr", s.handleTaskPR)
			r.With(githubQueryOnly).Post("/pr/refresh", s.handleRefreshTaskPR)
			r.Get("/source/tree", s.handleListSourceTree)
			r.Get("/source/file", s.handleReadSourceFile)
			r.Get("/workspace/list", s.handleLegacyListWorkspace)
			r.Get("/workspace/file", s.handleLegacyReadWorkspaceFile)
			r.With(operatorOnly).Put("/workspace/file", s.handleLegacyWriteWorkspaceFile)
			r.With(operatorOnly).Post("/workspace/restore", s.handleRestoreTaskWorkspace)
			r.Post("/cancel", s.handleCancelTask)
			r.With(operatorOnly).Delete("/", s.handleDeleteTask)
			r.Post("/prompt", s.handleFollowUp)
			r.Post("/retry", s.handleRetry)
			r.Post("/limit/continue", s.handleLimitContinue)
			r.Post("/fork", s.handleFork)
		})
		r.Get("/api/approvals", s.handleListApprovals)
		r.With(s.approvalInScope).Post("/api/approvals/{id}/decision", s.handleDecision)
		r.Get("/api/user-questions", s.handleListUserQuestions)
		r.With(s.userQuestionInScope).Post("/api/user-questions/{id}/answer", s.handleAnswerUserQuestion)
		r.With(holderOnly).Get("/api/recent-cwds", s.handleRecentCwds)
		r.With(holderOnly).Get("/api/git/branches", s.handleGitBranches)
		r.With(operatorOnly).Post("/api/git/checkout", s.handleGitCheckout)
		r.With(operatorOnly).Get("/api/settings", s.handleGetSettings)
		r.With(operatorOnly).Put("/api/settings", s.handlePutSettings)
		r.With(operatorOnly).Post("/api/relay/pairing", s.handleRefreshRelayPairing)
		r.With(operatorOnly).Post("/api/cloudflare/oauth/start", s.handleCloudflareOAuthStart)
		r.With(operatorOnly).Get("/api/cloudflare/accounts", s.handleCloudflareAccounts)
		r.With(operatorOnly).Get("/api/cloudflare/zones", s.handleCloudflareZones)
		r.With(operatorOnly).Post("/api/cloudflare/relay/deploy", s.handleCloudflareRelayDeploy)
		r.With(operatorOnly).Post("/api/cloudflare/relay/domain", s.handleCloudflareRelayDomain)
		r.With(operatorOnly).Get("/api/providers", s.handleListProviders)
		r.With(operatorOnly).Post("/api/providers", s.handleCreateProvider)
		r.With(operatorOnly).Post("/api/providers/models", s.handleListProviderModels)
		r.With(operatorOnly).Put("/api/providers/{id}", s.handleUpdateProvider)
		r.With(operatorOnly).Delete("/api/providers/{id}", s.handleDeleteProvider)
		r.With(operatorOnly).Post("/api/providers/{id}/activate", s.handleActivateProvider)
		r.With(operatorOnly).Post("/api/notify/test", s.handleNotifyTest)
		r.With(holderOnly).Get("/api/usage/summary", s.handleUsageSummary)
		r.With(holderOnly).Get("/api/usage/limits", s.handleUsageLimits)
		r.With(holderOnly).Get("/api/routing/options", s.handleGetRoutingOptions)
		r.With(holderOnly).Get("/api/routing/preview", s.handleGetRoutingPreview)
		r.With(holderOnly).Get("/api/routing/defaults", s.handleGetRoutingDefaults)
		r.With(operatorOnly).Put("/api/routing/defaults", s.handlePutRoutingDefaults)
		r.With(holderOnly).Get("/api/routing/profiles", s.handleGetRoutingProfiles)
		r.With(operatorOnly).Put("/api/routing/profiles", s.handlePutRoutingProfiles)
		r.With(holderOnly).Get("/api/routing/provider-profiles", s.handleGetProviderProfiles)
		r.With(operatorOnly).Put("/api/routing/provider-profiles", s.handlePutProviderProfiles)
		r.With(operatorOnly).Post("/api/uploads", s.handleUpload)
		r.With(holderOnly).Get("/api/uploads/{name}", s.handleServeUpload)
		r.With(holderOnly).Get("/api/artifacts", s.handleListArtifacts)
		r.With(operatorOnly).Post("/api/artifacts", s.handleCreateArtifact)
		r.With(holderOnly).Get("/api/artifacts/{id}", s.handleGetArtifact)
		r.With(holderOnly).Get("/api/artifacts/{id}/content", s.handleGetArtifactContent)
		r.With(operatorOnly).Post("/api/artifacts/{id}/status", s.handleSetArtifactStatus)
		r.With(holderOnly).Get("/api/projects", s.handleListProjects)
		r.With(operatorOnly).Post("/api/projects", s.handleCreateProject)
		r.With(operatorOnly).Post("/api/projects/ensure", s.handleEnsureProject)
		r.With(holderOnly).Get("/api/projects/by-root", s.handleFindProjectByRoot)
		r.With(holderOnly).Get("/api/projects/{id}", s.handleGetProject)
		r.With(operatorOnly).Patch("/api/projects/{id}", s.handlePatchProject)
		r.With(holderOnly).Get("/api/projects/{id}/one-pager", s.handleGetOnePager)
		r.With(operatorOnly).Put("/api/projects/{id}/one-pager", s.handlePutOnePager)
		r.With(holderOnly).Get("/api/projects/{id}/pulse", s.handleGetProjectPulse)
		r.With(operatorOnly).Post("/api/projects/{id}/pulse/refresh", s.handleRefreshProjectPulse)
		r.With(holderOnly).Get("/api/projects/{id}/tasks", s.handleListProjectTasks)
		r.With(holderOnly).Get("/api/projects/{id}/artifacts", s.handleListProjectArtifacts)
		r.With(holderOnly).Get("/api/routines", s.handleListRoutines)
		r.With(operatorOnly).Post("/api/routines", s.handleCreateRoutine)
		r.With(holderOnly).Get("/api/routines/unread-count", s.handleRoutineUnreadCount)
		r.With(holderOnly).Get("/api/routines/health", s.handleRoutineHealth)
		r.With(operatorOnly).Post("/api/routines/mark-all-read", s.handleMarkAllRoutineRunsRead)
		r.With(holderOnly).Get("/api/routines/{id}", s.handleGetRoutine)
		r.With(operatorOnly).Patch("/api/routines/{id}", s.handlePatchRoutine)
		r.With(operatorOnly).Delete("/api/routines/{id}", s.handleDeleteRoutine)
		r.With(operatorOnly).Post("/api/routines/{id}/run-now", s.handleRunRoutineNow)
		r.With(holderOnly).Post("/api/routines/runs/{taskID}/read", s.handleMarkRoutineRunRead)
		r.With(holderOnly).Get("/api/evals/suites", s.handleListEvalSuites)
		r.With(holderOnly).Get("/api/evals/runs", s.handleListEvalRuns)
		r.With(holderOnly).Get("/api/evals/runs/{id}", s.handleGetEvalRun)
		r.With(holderOnly).Post("/api/evals/runs", s.handleCreateEvalRun)
		r.With(holderOnly).Post("/api/evals/compare", s.handleCompareEvalRuns)
		r.With(operatorOnly).Post("/api/evals/routines", s.handleCreateEvalRoutine)
		r.Get("/api/ws", s.handleWS)
		r.Get("/api/events", s.handleEventStream)
		r.Get("/api/sessions/wait", s.handleSessionsWait)
		// The Node control channel: a machine that runs turns dials out and
		// stays connected here. Authenticated by its paired device token.
		if s.Nodes != nil {
			r.Get("/api/node", s.handleNodeConnect)
		}
		if s.A2A != nil && s.A2A.Enabled {
			r.Mount("/a2a", s.A2A.Handler())
		}
	})

	// Internal approval bridge: loopback + token (spec §6).
	r.Group(func(r chi.Router) {
		r.Use(loopbackOnly)
		r.Use(s.Auth.Middleware)
		r.Use(operatorOnly)
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
		r.Use(operatorOnly)
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

// isMasterRequest reports whether the caller presented the daemon's own token
// rather than an account session or a paired-device token.
func isMasterRequest(r *http.Request) bool {
	principal, ok := remote.PrincipalFromContext(r.Context())
	return ok && principal.Kind == remote.PrincipalMaster
}

// operatorOnly guards the routes that administer this daemon: its settings,
// providers, connectors, devices, and files.
//
// A paired device token does not pass. A phone or a desktop client drives
// tasks; it does not reconfigure the daemon it talks to. The one exception is
// spelled out at canQueryGitHub rather than here, so that reading this
// middleware is enough to know the rule it enforces.
func operatorOnly(next http.Handler) http.Handler {
	return requirePrincipal(isOperator, next)
}

// isOperator reports whether a principal may act as this node's operator.
//
// Two qualify. The master token does, because whoever holds the machine holds
// the daemon. The owning account does, by role rather than by being signed in:
// a Hub can hold accounts that registered after the first claim, and those
// drive tasks without reconfiguring the daemon they talk to. The role is read
// from the account record, so an account whose role is missing or unrecognized
// falls through to the denial below.
func isOperator(principal remote.Principal) bool {
	return principal.Kind == remote.PrincipalMaster ||
		(principal.Kind == remote.PrincipalUser && principal.Role == store.RoleOwner)
}

// canQueryGitHub reports whether a principal may spend this node's GitHub
// quota.
//
// This is the one operator-gated action a paired device may take, and the
// exception is narrow enough to state. A query reads and writes nothing: it
// reports state that already exists on GitHub. What makes a device the owner's
// own client is that only an operator can mint one — POST /api/pairing/sessions
// is itself operator-gated — and the phone is the client that needs this most,
// because a branch nobody has looked at has to be asked about from somewhere
// and the phone cannot open a terminal to run gh in.
//
// What bounds it: not the hourly budget, which the background pass claims and
// this path does not. A forced query is spent because a person asked for it —
// their tap is the rate limit — and it is GitHub's own refusal, plus the
// backoff that follows it, that stops a hand that keeps tapping.
//
// Members stay refused. A member is another person on this node, not one of the
// owner's devices.
func canQueryGitHub(principal remote.Principal) bool {
	return isOperator(principal) || principal.Kind == remote.PrincipalDevice
}

// requirePrincipal refuses anything the predicate does not allow.
//
// A request with no principal in its context reaches the predicate as the zero
// value, so every predicate here has to answer false for it. Both do — an empty
// kind matches neither rule. Auth.Middleware refuses an unauthenticated request
// with 401 before this runs, so that is the second line rather than the first,
// but it is the line that still holds if a route is ever mounted outside that
// middleware.
func requirePrincipal(allowed func(remote.Principal) bool, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, _ := remote.PrincipalFromContext(r.Context())
		if !allowed(principal) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "operator access required"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

// githubQueryOnly is operatorOnly plus paired devices; see canQueryGitHub.
func githubQueryOnly(next http.Handler) http.Handler {
	return requirePrincipal(canQueryGitHub, next)
}

// taskActorOnly formerly guarded the human gate — listing, approving, or
// denying a task's pending actions, and answering a question a task is blocked
// on — by refusing every account that was not the owner.
//
// It is gone rather than narrowed. The gate is now a property of the row's task
// (see gateOnTaskOwner), which is what it was always approximating: a member
// answering their own task's approval is the product working, and a member
// answering someone else's is the leak the flat refusal was standing in for.
// Keeping a role test alongside the scope check would only be a second rule to
// drift from the first.

// approvalInScope refuses a request whose {id} names an approval belonging to a
// task the caller cannot see, and userQuestionInScope does the same for a
// question.
//
// Both were once a flat "members are refused", which was the right answer while
// a member could not own a task. Now that tasks carry an owner, approving is a
// per-task question and the honest one is whether this caller owns the task
// behind the row — a member answering their own task's approval is the product
// working, not a leak.
//
// The answer is 404 for the same reason it is on /api/tasks/{id}: whether
// someone else's approval exists is not this caller's to learn.
func (s *Server) approvalInScope(next http.Handler) http.Handler {
	return s.gateOnTaskOwner(func(ctx context.Context, id string) (string, bool) {
		a, err := s.Store.GetApproval(ctx, id)
		if err != nil {
			return "", false
		}
		return a.TaskID, true
	}, next)
}

func (s *Server) userQuestionInScope(next http.Handler) http.Handler {
	return s.gateOnTaskOwner(func(ctx context.Context, id string) (string, bool) {
		q, err := s.Store.GetUserQuestion(ctx, id)
		if err != nil {
			return "", false
		}
		return q.TaskID, true
	}, next)
}

// gateOnTaskOwner resolves the row named by {id} to the task behind it, and
// refuses unless that task falls inside the caller's scope.
func (s *Server) gateOnTaskOwner(resolve func(context.Context, string) (string, bool), next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		scope := taskScope(r)
		if scope.All {
			next.ServeHTTP(w, r)
			return
		}
		if s.Store == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
			return
		}
		taskID, ok := resolve(r.Context(), chi.URLParam(r, "id"))
		if !ok || !scope.MatchesOwner(s.Store.TaskOwner(taskID)) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

// holderOnly guards the routes that describe the machine itself — its projects,
// routines, artifacts, agent sessions, uploads, and usage — as opposed to one
// account's tasks.
//
// It is not operatorOnly, and the difference is the product. A paired phone is
// enrolled by the holder and is a full client of the machine it was paired to;
// refusing it here would break the remote control this exists for. A member
// account is the one that must not pass: a guest on someone's Hub runs its own
// tasks and has no business reading the holder's project list, prompts, or file
// paths.
//
// The rule is store.ScopeForPrincipal read the other way, deliberately. A
// second list of principal kinds here would be a second answer to "who holds
// this machine", and the day the two disagree the quieter one is a leak.
func holderOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, ok := remote.PrincipalFromContext(r.Context())
		if !ok || !store.ActsForHolder(p) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "machine holder access required"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

// taskScope returns what the caller of this request may see of the task list.
// The rule itself lives in store.ScopeForPrincipal so this package and MCP
// cannot drift apart on it.
func taskScope(r *http.Request) store.TaskScope {
	p, ok := remote.PrincipalFromContext(r.Context())
	if !ok {
		// No principal means no request context. Match nothing: an empty list
		// is a bug someone reports, a full list is a leak nobody notices.
		return store.TaskScope{}
	}
	return store.ScopeForPrincipal(p)
}

// taskInScope refuses a request whose {id} names a task the caller cannot see.
// It guards the whole /api/tasks/{id} subtree, because scoping the list alone
// would leave the id as a way around it.
//
// The answer is 404, not 403. Whether a task exists is itself something one
// account should not learn about another's, and the list endpoint already hides
// that; a 403 here would confirm the guess.
//
// An unscoped caller — the master token, or the account that claimed the Hub —
// skips the lookup entirely. That is the common case on a standalone daemon and
// on a single-owner Hub, and it keeps the guard off the hot path for them.
func (s *Server) taskInScope(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		scope := taskScope(r)
		if scope.All {
			next.ServeHTTP(w, r)
			return
		}
		id := chi.URLParam(r, "id")
		if id == "" {
			// No id to check. The route table always supplies one here, so this
			// is unreachable; refuse rather than fall through unscoped if it
			// ever stops being true.
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "task not found"})
			return
		}
		t, err := s.Store.GetTask(r.Context(), id)
		if err != nil || !scope.Matches(t) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "task not found"})
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
	// ok stays true so process liveness probes remain simple; bus_overflow is a
	// cumulative counter of slow WS subscribers dropped since process start
	// (execplan stream observability continuous gate).
	out := map[string]any{"ok": true, "bus_overflow": uint64(0)}
	if s.Engine != nil {
		out["bus_overflow"] = s.Engine.Bus().OverflowCount()
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleVersion(w http.ResponseWriter, r *http.Request) {
	out := map[string]string{"version": s.Version}
	if !s.versionRequestCanSeeIdentity(r) {
		writeJSON(w, http.StatusOK, out)
		return
	}
	if strings.TrimSpace(s.DesktopID) != "" {
		out["desktop_id"] = strings.TrimSpace(s.DesktopID)
	}
	if strings.TrimSpace(s.DesktopName) != "" {
		out["desktop_name"] = strings.TrimSpace(s.DesktopName)
	}
	writeJSON(w, http.StatusOK, out)
}

// versionRequestCanSeeIdentity reports whether the caller may learn which
// machine this daemon is. Every authenticated kind may: the master token, a
// paired device token, or a signed-in browser session. The console needs the
// identity to tell "this machine" from a paired Node, and a Hub console reached
// over the network carries only the session cookie — no bearer credential at
// all. Anonymous callers still get the version and nothing else.
func (s *Server) versionRequestCanSeeIdentity(r *http.Request) bool {
	if s.Auth == nil {
		return false
	}
	principal, ok := s.Auth.Identify(r)
	if !ok {
		return false
	}
	switch principal.Kind {
	case remote.PrincipalMaster, remote.PrincipalDevice, remote.PrincipalUser:
		return true
	}
	return false
}

func (s *Server) handleListTasks(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	opts := store.ListTasksOpts{
		Status:          q.Get("status"),
		Before:          q.Get("before"),
		Query:           q.Get("q"),
		OrderByActivity: q.Get("order") == "activity",
		Scope:           taskScope(r),
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
		writeJSON(w, http.StatusOK, hideAgentBinaries(r, list))
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
		}
	}
	if list == nil {
		list = []AgentInfo{}
	}
	writeJSON(w, http.StatusOK, hideAgentBinaries(r, list))
}

// hideAgentBinaries blanks the install path for a caller that does not hold the
// machine.
//
// This route is the one machine-describing read left open to members on purpose:
// choosing an agent to run a task needs the catalogue. An absolute install path
// is not part of that need — it is the holder's filesystem layout, and it is the
// kind of detail that is harmless alone and useful in aggregate.
func hideAgentBinaries(r *http.Request, list []AgentInfo) []AgentInfo {
	p, ok := remote.PrincipalFromContext(r.Context())
	if ok && store.ActsForHolder(p) {
		return list
	}
	// AgentInfo is a value type, so this copies rather than mutating whatever
	// ListAgents handed back — which may be shared with the management view.
	redacted := make([]AgentInfo, len(list))
	copy(redacted, list)
	for i := range redacted {
		redacted[i].Binary = ""
	}
	return redacted
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
	if err := s.validateTaskCreateRequest(r.Context(), req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	// Fill the owner from the authenticated principal, never from the body: a
	// client that could name its own owner could write a task into someone
	// else's list, or hide one from its own.
	if p, ok := remote.PrincipalFromContext(r.Context()); ok {
		req.OwnerUserID = p.UserID
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

func (s *Server) validateTaskCreateRequest(ctx context.Context, req task.CreateRequest) error {
	if strings.TrimSpace(req.Agent) == "" && s.Engine != nil {
		req.Agent = s.Engine.DefaultAgentContext(ctx)
	}
	if err := s.validateExecutingDevice(ctx, req.ExecutingDeviceID); err != nil {
		return err
	}
	return ValidateTaskCreateRequest(ctx, req)
}

// validateExecutingDevice rejects a task aimed at a machine this Hub does not
// know, or one it knows has been revoked.
func (s *Server) validateExecutingDevice(ctx context.Context, deviceID string) error {
	return ValidateExecutingDevice(ctx, s.Store, s.DesktopID, deviceID)
}

// ValidateExecutingDevice checks that a task's target is a machine this Hub can
// actually hand work to.
//
// It is a create-time check on purpose: a task naming a device that does not
// exist, or one that has been revoked and can never connect again, would
// otherwise be accepted, queued, and only fail when a turn started — long after
// whoever typed the id stopped looking. Shared by the REST and MCP surfaces so
// both answer the same way.
func ValidateExecutingDevice(ctx context.Context, st *store.Store, selfDeviceID, deviceID string) error {
	deviceID = strings.TrimSpace(deviceID)
	if deviceID == "" || st == nil {
		return nil
	}
	// This daemon is a valid answer for "where should this run", and it is not a
	// paired device of itself.
	if deviceID == strings.TrimSpace(selfDeviceID) {
		return nil
	}
	device, err := st.GetDevice(ctx, deviceID)
	if err != nil {
		return fmt.Errorf("unknown device %q", deviceID)
	}
	if device.RevokedAt != nil {
		// A revoked device cannot connect, so it can never run this: refusing now
		// is the difference between an error while the user is looking and a task
		// that fails later for a reason nobody sees.
		return fmt.Errorf("device %q has been revoked", deviceID)
	}
	return nil
}

// ValidateTaskCreateRequest is shared by REST and public MCP task creation.
func ValidateTaskCreateRequest(ctx context.Context, req task.CreateRequest) error {
	effectiveAgent := req.Agent
	if sel := parseDispatchSelection(req.Dispatch); sel.Mode == "manual" && sel.Agent != "" {
		effectiveAgent = sel.Agent
	}
	return validateGenericCLIPermission(ctx, effectiveAgent, req.PermissionMode)
}

// dispatchSelection is a minimal parse of the raw dispatch JSON for permission validation.
type dispatchSelection struct {
	Mode  string `json:"mode"`
	Agent string `json:"agent,omitempty"`
}

func parseDispatchSelection(raw json.RawMessage) dispatchSelection {
	if len(raw) == 0 {
		return dispatchSelection{}
	}
	var sel dispatchSelection
	_ = json.Unmarshal(raw, &sel)
	return sel
}

// validateGenericCLIPermission rejects Tier-2 agents under default permission mode.
// Those agents have no Kin approval channel and require accept_edits or yolo.
func (s *Server) validateGenericCLIPermission(ctx context.Context, agentID, permissionMode string) error {
	return validateGenericCLIPermission(ctx, agentID, permissionMode)
}

func validateGenericCLIPermission(ctx context.Context, agentID, permissionMode string) error {
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

func (s *Server) handleTaskLimitWait(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	wait, err := s.Store.GetTaskLimitWait(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, wait)
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
	if s.Browser != nil {
		s.Browser.Cancel(id)
	}
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
	if s.Browser != nil {
		s.Browser.Cancel(id)
	}
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
	if err := ValidateTaskFollowUpRequest(r.Context(), s.Engine, id, &body); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		} else {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		}
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

// ValidateTaskFollowUpRequest is shared by REST and public MCP handoffs.
func ValidateTaskFollowUpRequest(ctx context.Context, engine *task.Engine, id string, body *task.FollowUpRequest) error {
	if engine == nil || body == nil {
		return fmt.Errorf("task engine and follow-up are required")
	}
	if body.PermissionMode == nil && strings.TrimSpace(body.Agent) == "" {
		return nil
	}
	agentID := strings.TrimSpace(body.Agent)
	permMode := ""
	if body.PermissionMode != nil {
		permMode = *body.PermissionMode
	}
	if agentID == "" || body.PermissionMode == nil {
		cur, err := engine.Get(ctx, id)
		if err != nil {
			return err
		}
		if agentID == "" {
			agentID = cur.Agent
		}
		if body.PermissionMode == nil {
			permMode = cur.PermissionMode
		}
	}
	return validateGenericCLIPermission(ctx, agentID, permMode)
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

func (s *Server) handleLimitContinue(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body task.LimitContinueRequest
	if r.Body != nil {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil && !errors.Is(err, io.EOF) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
			return
		}
	}
	t, err := s.Engine.LimitContinue(r.Context(), id, body)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if errors.Is(err, task.ErrConflict) || errors.Is(err, task.ErrNotTerminal) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	if err != nil {
		// Validation-ish errors (bad action, missing agent) → 400
		msg := err.Error()
		if strings.Contains(msg, "invalid action") || strings.Contains(msg, "required") || strings.Contains(msg, "unknown or unavailable") || strings.Contains(msg, "already") {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": msg})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": msg})
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
		Scope:  taskScope(r),
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
	a, err := s.Engine.Decide(r.Context(), id, decision, clientTypeFromRequest(r))
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

// ApprovalRelay hands a permission question to the Hub this daemon works for.
//
// It is an interface so api does not depend on how the question travels, and so
// a daemon that is nobody's Node leaves it nil and answers everything itself.
type ApprovalRelay interface {
	// Owns reports whether that execution is a turn this machine runs for a Hub.
	Owns(executionID string) bool
	// Ask sends the question and returns the Hub's approval id.
	Ask(ctx context.Context, req task.CreateApprovalRequest) (string, error)
	// Waiting reports whether that approval id is one this machine forwarded.
	Waiting(approvalID string) bool
	// Decision blocks until the Hub has decided it.
	Decision(ctx context.Context, approvalID string) (string, error)
}

func (s *Server) handleInternalCreateApproval(w http.ResponseWriter, r *http.Request) {
	var req task.CreateApprovalRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if s.ApprovalRelay != nil && s.ApprovalRelay.Owns(req.ExecutionID) {
		// The agent is running a turn this machine took from its Hub. The row
		// belongs in the Hub's inbox: that is the one a person is watching, and
		// the one the decision has to come back from.
		id, err := s.ApprovalRelay.Ask(r.Context(), req)
		if err != nil {
			// Nothing was recorded anywhere, so the agent must hear that rather
			// than wait for an answer nobody will give.
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		// Only the id is read back by the agent's client — it is the Hub's row, and
		// the wait below finds it by that id. The rest is the shape a local create
		// returns, filled in from the request rather than from a row this daemon
		// does not hold: task_id and kind are what the caller just sent, and the
		// decision is pending because the Hub's row is.
		writeJSON(w, http.StatusCreated, map[string]any{
			"id":       id,
			"task_id":  req.TaskID,
			"kind":     req.Kind,
			"decision": store.DecisionPending,
		})
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
	if s.ApprovalRelay != nil && s.ApprovalRelay.Waiting(id) {
		// One this machine forwarded. The wait is the Hub's to end: it answers when
		// a person decides, or when the connection does, so `timeout` does not apply
		// here — the row is not in this daemon's store and there is nothing local to
		// poll. The agent's client long-polls, so a decision it was already given is
		// handed back to it rather than looked up again.
		decision, err := s.ApprovalRelay.Decision(r.Context(), id)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"id": id, "decision": decision})
		return
	}
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
		Scope:  taskScope(r),
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
	q, err := s.Engine.AnswerUserQuestion(r.Context(), id, body, clientTypeFromRequest(r))
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
	LimitPolicy      string `json:"limit_policy"`
	LimitFallback    string `json:"limit_policy.fallback_agents"`
	QuotaWaitNotify  string `json:"notify.quota_wait_after_secs"`
	AutoImportMode   string `json:"agent_sessions.auto_import_mode"`
	NetworkMode      string `json:"network_mode"`
	ConnectURL       string `json:"connect_url"`
	Token            string `json:"token"`
	RelayStatus
	CloudflareRelayStatus
}

// Allowed settings keys for PUT (subset of store keys).
var puttableSettings = map[string]bool{
	"notify.bark_url":              true,
	"notify.ntfy_topic":            true,
	"ui.base_url":                  true,
	"price_table":                  true,
	"agent_limits":                 true,
	"provider.kind":                true,
	"provider.base_url":            true,
	"provider.api_key":             true,
	"provider.model":               true,
	"provider.stream":              true,
	"agent.default":                true,
	"limit_policy":                 true,
	"limit_policy.fallback_agents": true,
	"notify.quota_wait_after_secs": true,
	store.KeyAutoImportMode:        true,
	"relay.url":                    true,
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
	// The master token is the daemon's own credential, and an account session
	// is not it. A Hub owner signing in from a laptop must not be handed a
	// token that outlives their session, works from anywhere, and would sit in
	// browser history as part of a connect URL.
	if !isMasterRequest(r) {
		tok = ""
	}
	base := get("ui.base_url")
	if base == "" {
		base = s.BaseURL
	}
	// Always rebuild connect URL with the current token so rotate stays correct.
	// The stored fallback carries a token too, so it is only for the master.
	connect := ""
	if base != "" && tok != "" {
		connect = strings.TrimRight(base, "/") + "/?token=" + tok
	} else if s.ConnectURL != "" && isMasterRequest(r) {
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
	autoImportMode, err := store.NormalizeAutoImportMode(get(store.KeyAutoImportMode))
	if err != nil {
		autoImportMode = store.AutoImportPrompt
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
	reg, err := provider.LoadRegistryMetadata(ctx, s.Store)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
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
	relayStatus := RelayStatus{URL: get("relay.url"), State: "disabled"}
	if s.RelaySnapshot != nil {
		relayStatus = s.RelaySnapshot()
	}
	cloudflareStatus := CloudflareRelayStatus{ScriptName: "kin-relay"}
	if s.Cloudflare != nil {
		status := s.Cloudflare.Status(ctx)
		cloudflareStatus = CloudflareRelayStatus{
			Authenticated: status.Authenticated,
			AccountID:     status.AccountID,
			AccountName:   status.AccountName,
			ScriptName:    status.ScriptName,
			WorkerURL:     status.WorkerURL,
			CustomDomain:  status.CustomDomain,
			CustomURL:     status.CustomURL,
			ZoneID:        status.ZoneID,
			ZoneName:      status.ZoneName,
			LastError:     status.LastError,
		}
	}
	networkMode := s.NetworkMode
	networkParts := make([]string, 0, 3)
	for _, part := range strings.Split(networkMode, "+") {
		if part != "" && part != "relay" {
			networkParts = append(networkParts, part)
		}
	}
	if relayStatus.URL != "" {
		networkParts = append(networkParts, "relay")
	}
	networkMode = strings.Join(networkParts, "+")
	if relayStatus.PairingURL != "" {
		connect = relayStatus.PairingURL
	}
	writeJSON(w, http.StatusOK, settingsResponse{
		NotifyBarkURL:         get("notify.bark_url"),
		NotifyNtfyTopic:       get("notify.ntfy_topic"),
		UIBaseURL:             base,
		PriceTable:            priceTable,
		AgentLimits:           agentLimits,
		ProviderKind:          provKind,
		ProviderBaseURL:       provBase,
		ProviderAPIKey:        provider.MaskAPIKey(provKey),
		ProviderModel:         provModel,
		ProviderStream:        provStream,
		ProviderActiveID:      provActive,
		AgentDefault:          get("agent.default"),
		LimitPolicy:           firstNonEmpty(get(task.KeyLimitPolicy), task.LimitPolicyWait),
		LimitFallback:         get(task.KeyLimitFallbackAgents),
		QuotaWaitNotify:       get(task.KeyQuotaWaitNotifyAfterSecs),
		AutoImportMode:        autoImportMode,
		NetworkMode:           networkMode,
		ConnectURL:            connect,
		Token:                 tok,
		RelayStatus:           relayStatus,
		CloudflareRelayStatus: cloudflareStatus,
	})
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
		if k == task.KeyLimitPolicy {
			v = task.NormalizeLimitPolicy(v)
		}
		if k == task.KeyLimitFallbackAgents {
			v = strings.TrimSpace(v)
			if v != "" && v != "[]" {
				var ids []string
				if err := json.Unmarshal([]byte(v), &ids); err != nil {
					writeJSON(w, http.StatusBadRequest, map[string]string{"error": "limit_policy.fallback_agents must be a JSON array of agent ids"})
					return
				}
				// Canonical compact form.
				if b, err := json.Marshal(ids); err == nil {
					v = string(b)
				}
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
		if k == store.KeyAutoImportMode {
			normalized, err := store.NormalizeAutoImportMode(v)
			if err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			v = normalized
		}
		body[k] = v
	}
	oldRelayURL, _ := s.Store.GetSetting(ctx, "relay.url")
	if oldRelayURL == "" && s.RelaySnapshot != nil {
		oldRelayURL = s.RelaySnapshot().URL
	}
	// Keep multi-provider registry and its legacy mirror in the same atomic
	// settings write as the rest of this request.
	if providerSlotTouched {
		if err := s.routingCatalog().SaveSettingsWithLegacyProvider(ctx, body, clearProviderKey); err != nil {
			writeRoutingCatalogError(w, err)
			return
		}
	} else if err := s.Store.SetSettings(ctx, body); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if relayURL, ok := body["relay.url"]; ok && s.ConfigureRelay != nil {
		if _, err := s.ConfigureRelay(ctx, strings.TrimSpace(relayURL)); err != nil {
			if rollbackErr := s.Store.SetSetting(ctx, "relay.url", oldRelayURL); rollbackErr != nil {
				_, _ = s.ConfigureRelay(ctx, oldRelayURL)
				writeJSON(w, http.StatusInternalServerError, map[string]string{
					"error": fmt.Sprintf("configure relay: %v; rollback relay setting: %v", err, rollbackErr),
				})
				return
			}
			_, _ = s.ConfigureRelay(ctx, oldRelayURL)
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
	}
	if value, ok := body["ui.base_url"]; ok {
		s.BaseURL = strings.TrimRight(strings.TrimSpace(value), "/")
	}
	// Return updated snapshot.
	s.handleGetSettings(w, r)
}

func (s *Server) handleRefreshRelayPairing(w http.ResponseWriter, r *http.Request) {
	if s.RefreshRelayPairing == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "relay is not available"})
		return
	}
	if _, err := s.RefreshRelayPairing(r.Context()); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	s.handleGetSettings(w, r)
}

func (s *Server) handleCloudflareOAuthStart(w http.ResponseWriter, r *http.Request) {
	if s.Cloudflare == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "Cloudflare integration is not available"})
		return
	}
	authURL, err := s.Cloudflare.BeginAuth(r.Context())
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"auth_url": authURL})
}

func (s *Server) handleCloudflareOAuthCallback(w http.ResponseWriter, r *http.Request) {
	if s.Cloudflare == nil {
		http.Error(w, "Cloudflare integration is not available", http.StatusNotImplemented)
		return
	}
	if errText := strings.TrimSpace(r.URL.Query().Get("error")); errText != "" {
		http.Error(w, "Cloudflare authorization failed: "+errText, http.StatusBadRequest)
		return
	}
	if err := s.Cloudflare.CompleteAuth(r.Context(), r.URL.Query().Get("state"), r.URL.Query().Get("code")); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	target := "kin://settings?cloudflare=connected"
	targetJSON, _ := json.Marshal(target)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = fmt.Fprintf(w, `<!doctype html><meta charset="utf-8"><title>Cloudflare connected</title><body style="font:14px -apple-system,BlinkMacSystemFont,sans-serif;padding:24px"><h1>Cloudflare connected</h1><p>Returning to Kin Desktop...</p><p><a href="%s">Open Kin Desktop</a></p><script>setTimeout(()=>window.location.href=%s,300);setTimeout(()=>window.close(),1200)</script></body>`, target, string(targetJSON))
}

func (s *Server) handleCloudflareAccounts(w http.ResponseWriter, r *http.Request) {
	if s.Cloudflare == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "Cloudflare integration is not available"})
		return
	}
	accounts, err := s.Cloudflare.Accounts(r.Context())
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"accounts": accounts})
}

func (s *Server) handleCloudflareZones(w http.ResponseWriter, r *http.Request) {
	if s.Cloudflare == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "Cloudflare integration is not available"})
		return
	}
	zones, err := s.Cloudflare.Zones(r.Context(), r.URL.Query().Get("account_id"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"zones": zones})
}

func (s *Server) handleCloudflareRelayDeploy(w http.ResponseWriter, r *http.Request) {
	if s.Cloudflare == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "Cloudflare integration is not available"})
		return
	}
	var body cloudflare.DeployRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&body); err != nil && !errors.Is(err, io.EOF) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	result, err := s.Cloudflare.DeployRelay(r.Context(), body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	oldRelayURL := ""
	if s.Store != nil {
		oldRelayURL, _ = s.Store.GetSetting(r.Context(), "relay.url")
	}
	if oldRelayURL == "" && s.RelaySnapshot != nil {
		oldRelayURL = s.RelaySnapshot().URL
	}
	if s.Store != nil {
		if err := s.Store.SetSetting(r.Context(), "relay.url", result.WorkerURL); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
	}
	if s.ConfigureRelay != nil {
		if _, err := s.ConfigureRelay(r.Context(), result.WorkerURL); err != nil {
			if s.Store != nil {
				if rollbackErr := s.Store.SetSetting(r.Context(), "relay.url", oldRelayURL); rollbackErr != nil {
					_, _ = s.ConfigureRelay(r.Context(), oldRelayURL)
					writeJSON(w, http.StatusInternalServerError, map[string]string{
						"error": fmt.Sprintf("configure relay: %v; rollback relay setting: %v", err, rollbackErr),
					})
					return
				}
			}
			_, _ = s.ConfigureRelay(r.Context(), oldRelayURL)
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
	}
	s.handleGetSettings(w, r)
}

func (s *Server) handleCloudflareRelayDomain(w http.ResponseWriter, r *http.Request) {
	if s.Cloudflare == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "Cloudflare integration is not available"})
		return
	}
	var body cloudflare.DomainRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&body); err != nil && !errors.Is(err, io.EOF) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	result, err := s.Cloudflare.BindRelayDomain(r.Context(), body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	oldRelayURL := ""
	if s.Store != nil {
		oldRelayURL, _ = s.Store.GetSetting(r.Context(), "relay.url")
	}
	if oldRelayURL == "" && s.RelaySnapshot != nil {
		oldRelayURL = s.RelaySnapshot().URL
	}
	if s.Store != nil {
		if err := s.Store.SetSetting(r.Context(), "relay.url", result.URL); err != nil {
			_ = s.Cloudflare.DetachRelayDomain(r.Context(), result.AccountID, result.ID)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
	}
	if s.ConfigureRelay != nil {
		if _, err := s.ConfigureRelay(r.Context(), result.URL); err != nil {
			_ = s.Cloudflare.DetachRelayDomain(r.Context(), result.AccountID, result.ID)
			if s.Store != nil {
				if rollbackErr := s.Store.SetSetting(r.Context(), "relay.url", oldRelayURL); rollbackErr != nil {
					_, _ = s.ConfigureRelay(r.Context(), oldRelayURL)
					writeJSON(w, http.StatusInternalServerError, map[string]string{
						"error": fmt.Sprintf("configure relay: %v; rollback relay setting: %v", err, rollbackErr),
					})
					return
				}
			}
			_, _ = s.ConfigureRelay(r.Context(), oldRelayURL)
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
	}
	if err := s.Cloudflare.RememberRelayDomain(r.Context(), result); err != nil {
		if s.Store != nil {
			_ = s.Store.SetSetting(r.Context(), "relay.url", oldRelayURL)
		}
		if s.ConfigureRelay != nil {
			_, _ = s.ConfigureRelay(r.Context(), oldRelayURL)
		}
		_ = s.Cloudflare.DetachRelayDomain(r.Context(), result.AccountID, result.ID)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
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

	// Scoped: this connection carries raw agent output, approval commands, and
	// full task rows. An unscoped subscription would make the socket a way
	// around everything taskInScope refuses on the REST side.
	sub := s.Engine.Bus().SubscribeFor(taskScope(r))
	if sub == nil {
		_ = conn.Close(websocket.StatusInternalError, "event stream unavailable")
		return
	}
	defer s.Engine.Bus().Unsubscribe(sub)

	ctx := r.Context()
	principal, _ := remote.PrincipalFromContext(ctx)
	var revokeTicker *time.Ticker
	if principal.Kind == remote.PrincipalDevice && principal.DeviceID != "" && s.Store != nil {
		revokeTicker = time.NewTicker(5 * time.Second)
		defer revokeTicker.Stop()
	}
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
		case <-tickerChannel(revokeTicker):
			active, err := s.Store.DeviceActive(ctx, principal.DeviceID)
			if err != nil || !active {
				return
			}
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

func tickerChannel(ticker *time.Ticker) <-chan time.Time {
	if ticker == nil {
		return nil
	}
	return ticker.C
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// clientTypeFromRequest extracts a client-type identifier for audit
// attribution (decided_via / answered_via).
// Returns "web" by default, or the value of the X-Client-Type header.
func clientTypeFromRequest(r *http.Request) string {
	if principal, ok := remote.PrincipalFromContext(r.Context()); ok &&
		principal.Kind == remote.PrincipalDevice && principal.DeviceID != "" {
		return "ios:" + principal.DeviceID
	}
	if ct := r.Header.Get("X-Client-Type"); ct != "" {
		ct = strings.TrimSpace(ct)
		if ct != "" && len(ct) <= 64 {
			return ct
		}
	}
	return "web"
}

// validateAgentDefault ensures the preferred host agent is registered and
// currently runnable.
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
	if _, err := s.Engine.Agents().GetRunnable(ctx, id); err != nil {
		return fmt.Errorf("agent %q is not available (%v)", id, err)
	}
	return nil
}
