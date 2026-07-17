package api

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"nhooyr.io/websocket"

	"github.com/vuuihc/kin/internal/notify"
	"github.com/vuuihc/kin/internal/remote"
	"github.com/vuuihc/kin/internal/store"
	"github.com/vuuihc/kin/internal/task"
)

// AgentInfo is one discovered agent for GET /api/agents.
type AgentInfo struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Binary    string `json:"binary,omitempty"`
	Installed bool   `json:"installed"`
	Available bool   `json:"available"`
	Default   bool   `json:"default"`
	Reason    string `json:"reason,omitempty"`
}

// Server holds HTTP handlers and dependencies for the Kin API.
type Server struct {
	Store   *store.Store
	Auth    *remote.Auth
	Engine  *task.Engine
	Version string
	// Static is the embedded (or on-disk) UI filesystem. May be nil in tests.
	Static http.Handler
	// UploadsDir is where POST /api/uploads stores image attachments. Empty disables uploads.
	UploadsDir string

	// ListAgents returns live agent discovery status (set by server.Serve).
	ListAgents func() []AgentInfo

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
		r.Get("/api/tasks", s.handleListTasks)
		r.Post("/api/tasks", s.handleCreateTask)
		r.Get("/api/tasks/{id}", s.handleGetTask)
		r.Get("/api/tasks/{id}/events", s.handleListEvents)
		r.Post("/api/tasks/{id}/cancel", s.handleCancelTask)
		r.Post("/api/tasks/{id}/prompt", s.handleFollowUp)
		r.Get("/api/approvals", s.handleListApprovals)
		r.Post("/api/approvals/{id}/decision", s.handleDecision)
		r.Get("/api/recent-cwds", s.handleRecentCwds)
		r.Get("/api/settings", s.handleGetSettings)
		r.Put("/api/settings", s.handlePutSettings)
		r.Post("/api/notify/test", s.handleNotifyTest)
		r.Get("/api/usage/summary", s.handleUsageSummary)
		r.Post("/api/uploads", s.handleUpload)
		r.Get("/api/uploads/{name}", s.handleServeUpload)
		r.Get("/api/ws", s.handleWS)
	})

	// Internal approval bridge: loopback + token (spec §6).
	r.Group(func(r chi.Router) {
		r.Use(loopbackOnly)
		r.Use(s.Auth.Middleware)
		r.Post("/internal/approvals", s.handleInternalCreateApproval)
		r.Get("/internal/approvals/{id}/wait", s.handleInternalWaitApproval)
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
		}
	}
	if list == nil {
		list = []AgentInfo{}
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) handleCreateTask(w http.ResponseWriter, r *http.Request) {
	var req task.CreateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	t, err := s.Engine.Create(r.Context(), req)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, t)
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
	// Cognition provider (OpenAI-compatible). api_key is masked on GET.
	ProviderKind    string `json:"provider.kind"`
	ProviderBaseURL string `json:"provider.base_url"`
	ProviderAPIKey  string `json:"provider.api_key"`
	ProviderModel   string `json:"provider.model"`
	AgentDefault    string `json:"agent.default"`
	NetworkMode     string `json:"network_mode"`
	ConnectURL      string `json:"connect_url"`
	Token           string `json:"token"`
}

// Allowed settings keys for PUT (subset of store keys).
var puttableSettings = map[string]bool{
	"notify.bark_url":   true,
	"notify.ntfy_topic": true,
	"ui.base_url":       true,
	"price_table":       true,
	"provider.kind":     true,
	"provider.base_url": true,
	"provider.api_key":  true,
	"provider.model":    true,
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
	apiKey := get("provider.api_key")
	writeJSON(w, http.StatusOK, settingsResponse{
		NotifyBarkURL:   get("notify.bark_url"),
		NotifyNtfyTopic: get("notify.ntfy_topic"),
		UIBaseURL:       base,
		PriceTable:      priceTable,
		ProviderKind:    firstNonEmpty(get("provider.kind"), "openai-compatible"),
		ProviderBaseURL: get("provider.base_url"),
		ProviderAPIKey:  maskSettingSecret(apiKey),
		ProviderModel:   get("provider.model"),
		AgentDefault:    get("agent.default"),
		NetworkMode:     s.NetworkMode,
		ConnectURL:      connect,
		Token:           tok,
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
	if body["provider.clear_api_key"] == "1" || body["provider.clear_api_key"] == "true" {
		_ = s.Store.SetSetting(ctx, "provider.api_key", "")
		delete(body, "provider.clear_api_key")
	}
	delete(body, "provider.clear_api_key")

	// Validate provider fields together when any present.
	if _, ok := body["provider.base_url"]; ok || body["provider.model"] != "" || body["provider.kind"] != "" {
		// Allow partial save of empty base_url to disable provider.
	}

	for k, v := range body {
		if !puttableSettings[k] {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown or read-only setting: " + k})
			return
		}
		if k == "provider.clear_api_key" {
			continue
		}
		if k == store.KeyPriceTable {
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
