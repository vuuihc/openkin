// Package mcp exposes the public OpenKin control-plane MCP surface.
//
// The internal approvemcp package is intentionally separate: it is a
// task-scoped lifecycle bridge for managed workers, while this package is an
// authenticated, bounded control-plane adapter over the daemon services.
package mcp

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/oklog/ulid/v2"

	"github.com/vuuihc/openkin/internal/remote"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/task"
)

const (
	ScopeRead  = "read"
	ScopeWrite = "write"
	ScopeAdmin = "admin"

	maxRequestBytes  = 1 << 20
	maxResponseBytes = 256 << 10
	maxPageSize      = 100
)

type Principal struct {
	Kind string
	ID   string
}

type Server struct {
	Store        *store.Store
	Engine       *task.Engine
	ArtifactsDir string
	Version      string

	// RoutingStatus is optional so tests and minimal servers can omit routing
	// dependencies while the production server still exposes a useful status.
	RoutingStatus    func(context.Context) (any, error)
	ValidateCreate   func(context.Context, *task.CreateRequest) error
	PrepareCreate    func(context.Context, *task.CreateRequest)
	ValidateFollowUp func(context.Context, string, *task.FollowUpRequest) error
	RunRoutine       func(context.Context, string, store.MCPTaskOrigin) (any, error)

	now       func() int64
	idemMu    sync.Mutex
	idemLocks map[string]*idempotencyLock
	sessionMu sync.Mutex
	sessions  map[string]sessionState
}

type request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

type toolCallParams struct {
	Name      string         `json:"name"`
	Arguments map[string]any `json:"arguments"`
}

type authContext struct {
	Principal Principal
	ClientID  string
	SessionID string
	Scopes    map[string]bool
}

type sessionState struct {
	ExpiresAt       time.Time
	ProtocolVersion string
}

type callError struct {
	Code    int
	Message string
}

func (e *callError) Error() string { return e.Message }

type idempotencyEnvelope struct {
	State       string          `json:"state"`
	Tool        string          `json:"tool"`
	RequestHash string          `json:"request_hash"`
	Response    json.RawMessage `json:"response,omitempty"`
}

type idempotencyLock struct {
	mu   sync.Mutex
	refs int
}

func (s *Server) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, `{"error":"MCP requires POST"}`, http.StatusMethodNotAllowed)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxRequestBytes)
		var req request
		decoder := json.NewDecoder(r.Body)
		if err := decoder.Decode(&req); err != nil {
			writeHTTPJSON(w, http.StatusBadRequest, response{
				JSONRPC: "2.0",
				Error:   &rpcError{Code: -32700, Message: "invalid JSON"},
			})
			return
		}
		var trailing any
		if err := decoder.Decode(&trailing); err != io.EOF {
			writeHTTPJSON(w, http.StatusBadRequest, response{
				JSONRPC: "2.0",
				Error:   &rpcError{Code: -32600, Message: "one JSON-RPC request per HTTP body is required"},
			})
			return
		}
		if req.JSONRPC != "2.0" {
			writeHTTPJSON(w, http.StatusBadRequest, response{
				JSONRPC: "2.0",
				ID:      req.ID,
				Error:   &rpcError{Code: -32600, Message: "jsonrpc must be 2.0"},
			})
			return
		}
		if !validRequestID(req.ID) || (strings.HasPrefix(req.Method, "notifications/") && len(req.ID) > 0) {
			writeHTTPJSON(w, http.StatusBadRequest, response{
				JSONRPC: req.JSONRPC,
				ID:      req.ID,
				Error:   &rpcError{Code: -32600, Message: "invalid JSON-RPC request id"},
			})
			return
		}
		methodHeader := strings.TrimSpace(r.Header.Get("Mcp-Method"))
		nameHeader := strings.TrimSpace(r.Header.Get("Mcp-Name"))
		if methodHeader != "" && methodHeader != req.Method {
			writeHTTPJSON(w, http.StatusBadRequest, response{
				JSONRPC: req.JSONRPC,
				ID:      req.ID,
				Error:   &rpcError{Code: -32602, Message: "MCP method header does not match request"},
			})
			return
		}
		if nameHeader != "" && nameHeader != toolName(req) {
			writeHTTPJSON(w, http.StatusBadRequest, response{
				JSONRPC: req.JSONRPC,
				ID:      req.ID,
				Error:   &rpcError{Code: -32602, Message: "MCP tool header does not match request"},
			})
			return
		}
		if origin := strings.TrimSpace(r.Header.Get("Origin")); origin != "" && !allowedOrigin(origin, r.Host) {
			writeHTTPJSON(w, http.StatusForbidden, response{
				JSONRPC: req.JSONRPC,
				ID:      req.ID,
				Error:   &rpcError{Code: -32001, Message: "origin is not allowed"},
			})
			return
		}
		sessionID := strings.TrimSpace(r.Header.Get("MCP-Session-Id"))
		protocolHeader := strings.TrimSpace(r.Header.Get("MCP-Protocol-Version"))
		if protocolHeader == "2026-07-28" && req.Method != "initialize" &&
			bodyProtocolVersion(req.Params) != "" &&
			bodyProtocolVersion(req.Params) != protocolHeader {
			writeHTTPJSON(w, http.StatusBadRequest, response{
				JSONRPC: req.JSONRPC,
				ID:      req.ID,
				Error:   &rpcError{Code: -32602, Message: "body _meta protocol version does not match header"},
			})
			return
		}
		stateless := req.Method != "initialize" && sessionID == "" && protocolHeader == "2026-07-28"
		if req.Method != "initialize" && !stateless && !s.validSession(sessionID) {
			writeHTTPJSON(w, http.StatusBadRequest, response{
				JSONRPC: req.JSONRPC,
				ID:      req.ID,
				Error:   &rpcError{Code: -32002, Message: "MCP session is not initialized"},
			})
			return
		}
		if req.Method != "initialize" && !stateless {
			state := s.session(sessionID)
			if protocolHeader == "" || protocolHeader != state.ProtocolVersion {
				writeHTTPJSON(w, http.StatusBadRequest, response{
					JSONRPC: req.JSONRPC,
					ID:      req.ID,
					Error:   &rpcError{Code: -32602, Message: "MCP protocol version does not match session"},
				})
				return
			}
		}
		principal, ok := remote.PrincipalFromContext(r.Context())
		if !ok {
			writeHTTPJSON(w, http.StatusUnauthorized, response{
				JSONRPC: req.JSONRPC,
				ID:      req.ID,
				Error:   &rpcError{Code: -32001, Message: "authentication required"},
			})
			return
		}
		clientID := strings.TrimSpace(r.Header.Get("X-Kin-MCP-Client"))
		if clientID == "" {
			clientID = "http-client"
		}
		if stateless {
			sessionID = "stateless:" + principal.Kind + ":" + principal.DeviceID + ":" + clientID
		}
		scopeHeader := r.Header.Get("X-Kin-MCP-Scopes")
		auth := authContext{
			Principal: Principal{Kind: principal.Kind, ID: principal.DeviceID},
			ClientID:  clientID,
			SessionID: sessionID,
			Scopes:    scopesForPrincipal(principal, scopeHeader),
		}
		if len(req.ID) == 0 && req.Method == "tools/call" {
			_ = s.finish(r.Context(), req, auth, errorResponse(req, -32600, "tools/call notifications are not supported"))
			w.WriteHeader(http.StatusAccepted)
			return
		}
		resp := s.Handle(r.Context(), req, auth)
		if req.Method == "initialize" && resp.Error == nil {
			protocolVersion := negotiatedProtocolVersion(req.Params)
			w.Header().Set("MCP-Protocol-Version", protocolVersion)
			if protocolHeader != "2026-07-28" {
				sessionID = s.newSession(protocolVersion)
				w.Header().Set("MCP-Session-Id", sessionID)
			}
		}
		if len(req.ID) == 0 || string(req.ID) == "null" {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		status := http.StatusOK
		if resp.Error != nil && resp.Error.Code == -32001 {
			status = http.StatusForbidden
		}
		writeHTTPJSON(w, status, resp)
	})
}

func (s *Server) Handle(ctx context.Context, req request, auth authContext) response {
	if req.JSONRPC != "2.0" {
		return s.finish(ctx, req, auth, response{
			JSONRPC: "2.0",
			ID:      req.ID,
			Error:   &rpcError{Code: -32600, Message: "jsonrpc must be 2.0"},
		})
	}
	if req.Method == "initialize" {
		var params struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		if len(req.Params) == 0 || json.Unmarshal(req.Params, &params) != nil {
			return s.finish(ctx, req, auth, errorResponse(req, -32602, "initialize.protocolVersion is required"))
		}
		if !supportedProtocolVersion(params.ProtocolVersion) {
			return s.finish(ctx, req, auth, errorResponse(req, -32602, "unsupported MCP protocol version"))
		}
	}
	if req.Method == "" {
		return s.finish(ctx, req, auth, response{
			JSONRPC: req.JSONRPC,
			ID:      req.ID,
			Error:   &rpcError{Code: -32600, Message: "method is required"},
		})
	}

	var resp response
	switch req.Method {
	case "initialize":
		resp = response{
			JSONRPC: req.JSONRPC,
			ID:      req.ID,
			Result: map[string]any{
				"protocolVersion": negotiatedProtocolVersion(req.Params),
				"capabilities":    map[string]any{"tools": map[string]any{}},
				"serverInfo": map[string]any{
					"name":    "openkin",
					"version": defaultString(s.Version, "0.0.0-dev"),
				},
			},
		}
	case "server/discover":
		resp = response{
			JSONRPC: req.JSONRPC,
			ID:      req.ID,
			Result: map[string]any{
				"name":             "openkin",
				"protocolVersions": []string{"2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25", "2026-07-28"},
				"transports":       []string{"stdio", "streamable-http"},
			},
		}
	case "notifications/initialized":
		resp = response{JSONRPC: req.JSONRPC}
	case "ping":
		resp = response{JSONRPC: req.JSONRPC, ID: req.ID, Result: map[string]any{}}
	case "tools/list":
		resp = response{JSONRPC: req.JSONRPC, ID: req.ID, Result: map[string]any{"tools": toolDefinitions()}}
	case "tools/call":
		resp = s.handleToolCall(ctx, req, auth)
	default:
		resp = response{
			JSONRPC: req.JSONRPC,
			ID:      req.ID,
			Error:   &rpcError{Code: -32601, Message: "method not found: " + req.Method},
		}
	}
	return s.finish(ctx, req, auth, resp)
}

func (s *Server) finish(ctx context.Context, req request, auth authContext, resp response) response {
	if s.Store == nil {
		return resp
	}
	now := s.clock()
	_ = s.Store.PruneMCPData(ctx, now, now-90*24*time.Hour.Milliseconds())
	raw, err := json.Marshal(req.Params)
	if err != nil {
		return resp
	}
	errCode := ""
	if resp.Error != nil {
		errCode = strconv.Itoa(resp.Error.Code)
	}
	if err := s.Store.RecordMCPAuditCall(ctx, store.MCPAuditCall{
		ID:            ulid.Make().String(),
		OccurredAt:    now,
		PrincipalKind: auth.Principal.Kind,
		PrincipalID:   auth.Principal.ID,
		ClientID:      auth.ClientID,
		Method:        req.Method,
		Tool:          toolName(req),
		Scope:         scopeString(auth.Scopes),
		Success:       resp.Error == nil,
		ErrorCode:     errCode,
		RequestHash:   hashBytes(raw),
	}); err != nil && resp.Error == nil && len(req.ID) > 0 && string(req.ID) != "null" {
		return errorResponse(req, -32011, "MCP audit persistence failed")
	}
	return resp
}

func (s *Server) handleToolCall(ctx context.Context, req request, auth authContext) response {
	var params toolCallParams
	if err := json.Unmarshal(req.Params, &params); err != nil || params.Name == "" {
		return errorResponse(req, -32602, "tools/call requires name and arguments")
	}
	if params.Arguments == nil {
		params.Arguments = map[string]any{}
	}

	required := requiredScope(params.Name)
	if !allows(auth.Scopes, required) {
		return errorResponse(req, -32001, "MCP scope required: "+required)
	}
	if requiresIdempotency(params.Name) {
		key, _ := params.Arguments["idempotency_key"].(string)
		key = strings.TrimSpace(key)
		if key == "" {
			return errorResponse(req, -32602, "idempotency_key is required")
		}
		if s.Store != nil {
			principalID := auth.Principal.Kind + ":" + auth.Principal.ID
			unlock := s.lockIdempotency(principalID + "\x00" + auth.ClientID + "\x00" + key)
			defer unlock()
			requestRaw, err := json.Marshal(mapWithout(params.Arguments, "idempotency_key"))
			if err != nil {
				return errorResponse(req, -32602, "invalid idempotent arguments")
			}
			requestHash := hashBytes(requestRaw)
			cached, ok, err := s.Store.GetMCPIdempotency(
				ctx, principalID, auth.ClientID, key, s.clock(),
			)
			if err != nil {
				return errorResponse(req, -32000, err.Error())
			}
			if ok {
				var envelope idempotencyEnvelope
				if json.Unmarshal(cached, &envelope) != nil || envelope.State == "" {
					return errorResponse(req, -32000, "invalid persisted idempotency response")
				}
				if envelope.Tool != params.Name || envelope.RequestHash != requestHash {
					return errorResponse(req, -32602, "idempotency_key was reused with different arguments")
				}
				if envelope.State == "pending" {
					return errorResponse(req, -32010, "idempotent operation is already in progress")
				}
				var cachedResp response
				if json.Unmarshal(envelope.Response, &cachedResp) != nil {
					return errorResponse(req, -32000, "invalid persisted idempotency response")
				}
				cachedResp.ID = req.ID
				return cachedResp
			}
			pending, _ := json.Marshal(idempotencyEnvelope{
				State: "pending", Tool: params.Name, RequestHash: requestHash,
			})
			if err := s.Store.PutMCPIdempotency(
				ctx, principalID, auth.ClientID, key, pending, 24*time.Hour, s.clock(),
			); err != nil {
				if errors.Is(err, store.ErrMCPIdempotencyExists) {
					return errorResponse(req, -32010, "idempotent operation is already in progress")
				}
				return errorResponse(req, -32000, err.Error())
			}
			resp := s.executeTool(ctx, req, auth, params)
			raw, err := json.Marshal(resp)
			if err != nil {
				return errorResponse(req, -32000, "encode idempotency response: "+err.Error())
			}
			completed, _ := json.Marshal(idempotencyEnvelope{
				State: "completed", Tool: params.Name, RequestHash: requestHash, Response: raw,
			})
			if err := s.Store.CompleteMCPIdempotency(ctx, principalID, auth.ClientID, key, completed); err != nil {
				return errorResponse(req, -32000, "persist idempotency response: "+err.Error())
			}
			return resp
		}
	}
	return s.executeTool(ctx, req, auth, params)
}

func (s *Server) lockIdempotency(key string) func() {
	s.idemMu.Lock()
	if s.idemLocks == nil {
		s.idemLocks = make(map[string]*idempotencyLock)
	}
	lock := s.idemLocks[key]
	if lock == nil {
		lock = &idempotencyLock{}
		s.idemLocks[key] = lock
	}
	lock.refs++
	s.idemMu.Unlock()

	lock.mu.Lock()
	return func() {
		lock.mu.Unlock()
		s.idemMu.Lock()
		lock.refs--
		if lock.refs == 0 {
			delete(s.idemLocks, key)
		}
		s.idemMu.Unlock()
	}
}

func (s *Server) executeTool(ctx context.Context, req request, auth authContext, params toolCallParams) response {
	args := params.Arguments
	var result any
	var err error

	switch params.Name {
	case "list_tasks":
		result, err = s.listTasks(ctx, args)
	case "get_task":
		result, err = s.getTask(ctx, args)
	case "list_task_events":
		result, err = s.listTaskEvents(ctx, args)
	case "list_worker_steps":
		result, err = s.listWorkerSteps(ctx, args)
	case "list_projects":
		result, err = s.listProjects(ctx, args)
	case "list_artifacts":
		result, err = s.listArtifacts(ctx, args)
	case "read_artifact":
		result, err = s.readArtifact(ctx, args)
	case "list_routines":
		result, err = s.listRoutines(ctx, args)
	case "get_usage":
		result, err = s.getUsage(ctx, args)
	case "get_routing_status":
		result, err = s.getRoutingStatus(ctx)
	case "create_task":
		result, err = s.createTask(ctx, auth, args)
	case "send_task_message":
		result, err = s.sendTaskMessage(ctx, args)
	case "cancel_task":
		result, err = s.cancelTask(ctx, args)
	case "retry_task":
		result, err = s.retryTask(ctx, args)
	case "continue_task":
		result, err = s.continueTask(ctx, args)
	case "approve_task_action":
		result, err = s.approveTaskAction(ctx, auth, args)
	case "answer_task_question":
		result, err = s.answerTaskQuestion(ctx, args)
	case "resolve_idempotency":
		result, err = s.resolveIdempotency(ctx, auth, args)
	case "run_routine":
		result, err = s.runRoutine(ctx, auth, args)
	default:
		return errorResponse(req, -32602, "unknown tool: "+params.Name)
	}
	if err != nil {
		code := -32000
		if errors.Is(err, store.ErrNotFound) {
			code = -32004
		} else if errors.Is(err, task.ErrConflict) || errors.Is(err, store.ErrConflict) {
			code = -32009
		}
		return errorResponse(req, code, mcpErrorMessage(err))
	}
	result = sanitizeMCPResult(result)
	raw, err := json.Marshal(result)
	if err != nil {
		return errorResponse(req, -32000, "encode tool result: "+err.Error())
	}
	if len(raw) > maxResponseBytes {
		return errorResponse(req, -32000, "tool response exceeds size limit")
	}
	return response{
		JSONRPC: req.JSONRPC,
		ID:      req.ID,
		Result: map[string]any{
			"content": []map[string]string{{"type": "text", "text": string(raw)}},
			"isError": false,
		},
	}
}

func sanitizeMCPResult(value any) any {
	switch item := value.(type) {
	case store.Task:
		return publicTask(item)
	case *store.Task:
		if item == nil {
			return nil
		}
		return publicTask(*item)
	case []store.Task:
		out := make([]map[string]any, 0, len(item))
		for _, taskItem := range item {
			out = append(out, publicTask(taskItem))
		}
		return out
	default:
		return value
	}
}

func mcpErrorMessage(err error) string {
	if errors.Is(err, store.ErrNotFound) {
		return "not found"
	}
	if errors.Is(err, task.ErrConflict) || errors.Is(err, store.ErrConflict) {
		return "conflict"
	}
	message := err.Error()
	if strings.HasPrefix(message, "/") ||
		strings.Contains(message, " /") ||
		strings.Contains(message, "=/") ||
		strings.Contains(message, `:\`) {
		return "MCP operation failed"
	}
	return message
}

func (s *Server) listTasks(ctx context.Context, args map[string]any) (any, error) {
	limit := boundedInt(args, "limit", maxPageSize)
	opts := store.ListTasksOpts{
		Status: stringArg(args, "status"),
		Before: stringArg(args, "before"),
		Query:  stringArg(args, "query"),
		Limit:  limit,
	}
	var (
		items []store.Task
		err   error
	)
	if s.Engine != nil {
		items, err = s.Engine.List(ctx, opts)
	} else if s.Store != nil {
		items, err = s.Store.ListTasks(ctx, opts)
	} else {
		return nil, errors.New("task services unavailable")
	}
	public := make([]map[string]any, 0, len(items))
	for _, item := range items {
		public = append(public, publicTask(item))
	}
	return map[string]any{"tasks": public, "limit": limit}, err
}

func (s *Server) getTask(ctx context.Context, args map[string]any) (any, error) {
	if s.Engine != nil {
		item, err := s.Engine.Get(ctx, requiredString(args, "task_id"))
		if err != nil {
			return nil, err
		}
		return publicTask(item), nil
	}
	if s.Store != nil {
		item, err := s.Store.GetTask(ctx, requiredString(args, "task_id"))
		if err != nil {
			return nil, err
		}
		return publicTask(item), nil
	}
	return nil, errors.New("task services unavailable")
}

func (s *Server) listTaskEvents(ctx context.Context, args map[string]any) (any, error) {
	if s.Store == nil {
		return nil, errors.New("task services unavailable")
	}
	taskID := requiredString(args, "task_id")
	if _, err := s.Store.GetTask(ctx, taskID); err != nil {
		return nil, err
	}
	events, err := s.Store.ListEventsLimit(
		ctx,
		taskID,
		boundedInt(args, "since_seq", 0),
		boundedInt(args, "limit", maxPageSize),
	)
	return map[string]any{"events": events}, err
}

func (s *Server) listWorkerSteps(ctx context.Context, args map[string]any) (any, error) {
	if s.Store == nil {
		return nil, errors.New("task services unavailable")
	}
	if _, err := s.Store.GetTask(ctx, requiredString(args, "task_id")); err != nil {
		return nil, err
	}
	steps, err := s.Store.ListWorkerSteps(
		ctx,
		requiredString(args, "task_id"),
		stringArg(args, "execution_id"),
	)
	return map[string]any{"steps": steps}, err
}

func (s *Server) listProjects(ctx context.Context, args map[string]any) (any, error) {
	if s.Store == nil {
		return nil, errors.New("store unavailable")
	}
	items, err := s.Store.ListProjects(ctx, store.ListProjectsOpts{
		Status: stringArg(args, "status"),
		Limit:  boundedInt(args, "limit", maxPageSize),
	})
	public := make([]map[string]any, 0, len(items))
	for _, item := range items {
		public = append(public, publicProject(item))
	}
	return map[string]any{"projects": public}, err
}

func (s *Server) listArtifacts(ctx context.Context, args map[string]any) (any, error) {
	if s.Store == nil {
		return nil, errors.New("store unavailable")
	}
	items, err := s.Store.ListArtifacts(ctx, store.ListArtifactsOpts{
		Status:    stringArg(args, "status"),
		ProjectID: stringArg(args, "project_id"),
		Limit:     boundedInt(args, "limit", maxPageSize),
	})
	return map[string]any{"artifacts": items}, err
}

func (s *Server) readArtifact(ctx context.Context, args map[string]any) (any, error) {
	if s.Store == nil {
		return nil, errors.New("store unavailable")
	}
	a, err := s.Store.GetArtifact(ctx, requiredString(args, "artifact_id"))
	if err != nil {
		return nil, err
	}
	if s.ArtifactsDir == "" {
		return nil, errors.New("artifact storage unavailable")
	}
	root, err := filepath.Abs(s.ArtifactsDir)
	if err != nil {
		return nil, err
	}
	path, err := filepath.Abs(filepath.Join(root, a.RelPath))
	if err != nil {
		return nil, err
	}
	rel, err := filepath.Rel(root, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return nil, errors.New("artifact path escapes storage root")
	}
	evaluatedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, err
	}
	evaluatedPath, err := filepath.EvalSymlinks(path)
	if err != nil {
		return nil, err
	}
	evaluatedRel, err := filepath.Rel(evaluatedRoot, evaluatedPath)
	if err != nil || evaluatedRel == ".." || strings.HasPrefix(evaluatedRel, ".."+string(filepath.Separator)) {
		return nil, errors.New("artifact symlink escapes storage root")
	}
	maxBytes := boundedInt(args, "max_bytes", 128*1024)
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, int64(maxBytes)+1))
	if err != nil {
		return nil, err
	}
	truncated := len(data) > maxBytes
	if truncated {
		data = data[:maxBytes]
	}
	return map[string]any{"artifact": a, "content": string(data), "truncated": truncated}, nil
}

func (s *Server) listRoutines(ctx context.Context, args map[string]any) (any, error) {
	if s.Store == nil {
		return nil, errors.New("store unavailable")
	}
	page, err := s.Store.ListRoutinesPage(ctx, store.ListRoutinesOpts{
		Limit:  boundedInt(args, "limit", maxPageSize),
		Before: stringArg(args, "cursor"),
		Query:  stringArg(args, "query"),
	})
	public := make([]map[string]any, 0, len(page.Routines))
	for _, item := range page.Routines {
		public = append(public, publicRoutine(item))
	}
	return map[string]any{
		"routines":    public,
		"next_cursor": page.NextCursor,
		"has_more":    page.HasMore,
	}, err
}

func publicTask(item store.Task) map[string]any {
	return scrubJSON(item,
		"cwd",
		"workspace_source_root",
		"workspace_root",
		"execution_cwd",
	)
}

func publicProject(item store.Project) map[string]any {
	return scrubJSON(item, "roots")
}

func publicRoutine(item store.Routine) map[string]any {
	return scrubJSON(item, "cwd")
}

func scrubJSON(value any, fields ...string) map[string]any {
	raw, err := json.Marshal(value)
	if err != nil {
		return map[string]any{}
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return map[string]any{}
	}
	for _, field := range fields {
		delete(out, field)
	}
	return out
}

func (s *Server) getUsage(ctx context.Context, args map[string]any) (any, error) {
	if s.Store == nil {
		return nil, errors.New("store unavailable")
	}
	days := boundedInt(args, "days", 30)
	rows, err := s.Store.UsageSummary(ctx, days)
	return map[string]any{"days": days, "usage": rows}, err
}

func (s *Server) getRoutingStatus(ctx context.Context) (any, error) {
	if s.RoutingStatus != nil {
		return s.RoutingStatus(ctx)
	}
	return map[string]any{"status": "unavailable"}, nil
}

func (s *Server) createTask(ctx context.Context, auth authContext, args map[string]any) (any, error) {
	if s.Engine == nil {
		return nil, errors.New("task engine unavailable")
	}
	raw, err := json.Marshal(mapWithout(args, "idempotency_key"))
	if err != nil {
		return nil, err
	}
	var req task.CreateRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, fmt.Errorf("invalid create_task arguments: %w", err)
	}
	return s.createMCPTask(ctx, auth, req)
}

func (s *Server) createMCPTask(ctx context.Context, auth authContext, req task.CreateRequest) (any, error) {
	if req.RoutineID != "" {
		return nil, errors.New("routine_id may only be dispatched through run_routine")
	}
	if s.ValidateCreate != nil {
		if err := s.ValidateCreate(ctx, &req); err != nil {
			return nil, err
		}
	}
	if s.PrepareCreate != nil {
		s.PrepareCreate(ctx, &req)
	}
	if req.ID == "" {
		req.ID = ulid.Make().String()
	}
	originRecorded := false
	if s.Store != nil && auth.SessionID != "" {
		if err := s.Store.RecordMCPTaskOrigin(ctx, store.MCPTaskOrigin{
			TaskID:        req.ID,
			PrincipalKind: auth.Principal.Kind,
			PrincipalID:   auth.Principal.ID,
			ClientID:      auth.ClientID,
			SessionID:     auth.SessionID,
			CreatedAt:     s.clock(),
		}); err != nil {
			return nil, err
		}
		originRecorded = true
	}
	created, err := s.Engine.Create(ctx, req)
	if err != nil {
		if originRecorded {
			_ = s.Store.DeleteMCPTaskOrigin(ctx, req.ID)
		}
		return nil, err
	}
	return publicTask(created), nil
}

func (s *Server) sendTaskMessage(ctx context.Context, args map[string]any) (any, error) {
	if s.Engine == nil {
		return nil, errors.New("task engine unavailable")
	}
	raw, err := json.Marshal(mapWithout(args, "idempotency_key", "task_id"))
	if err != nil {
		return nil, err
	}
	var req task.FollowUpRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, fmt.Errorf("invalid send_task_message arguments: %w", err)
	}
	if s.ValidateFollowUp != nil {
		if err := s.ValidateFollowUp(ctx, requiredString(args, "task_id"), &req); err != nil {
			return nil, err
		}
	}
	return s.Engine.FollowUpWith(ctx, requiredString(args, "task_id"), req)
}

func (s *Server) cancelTask(ctx context.Context, args map[string]any) (any, error) {
	if s.Engine == nil {
		return nil, errors.New("task engine unavailable")
	}
	return s.Engine.Cancel(ctx, requiredString(args, "task_id"))
}

func (s *Server) retryTask(ctx context.Context, args map[string]any) (any, error) {
	if s.Engine == nil {
		return nil, errors.New("task engine unavailable")
	}
	raw, err := json.Marshal(mapWithout(args, "idempotency_key", "task_id"))
	if err != nil {
		return nil, err
	}
	var req task.RetryRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, fmt.Errorf("invalid retry_task arguments: %w", err)
	}
	return s.Engine.Retry(ctx, requiredString(args, "task_id"), req)
}

func (s *Server) continueTask(ctx context.Context, args map[string]any) (any, error) {
	if s.Engine == nil {
		return nil, errors.New("task engine unavailable")
	}
	raw, err := json.Marshal(mapWithout(args, "idempotency_key", "task_id"))
	if err != nil {
		return nil, err
	}
	var req task.LimitContinueRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, fmt.Errorf("invalid continue_task arguments: %w", err)
	}
	return s.Engine.LimitContinue(ctx, requiredString(args, "task_id"), req)
}

func (s *Server) approveTaskAction(ctx context.Context, auth authContext, args map[string]any) (any, error) {
	if s.Engine == nil {
		return nil, errors.New("task engine unavailable")
	}
	id := requiredString(args, "approval_id")
	a, err := s.Engine.GetApproval(ctx, id)
	if err != nil {
		return nil, err
	}
	if s.Store != nil && auth.SessionID != "" {
		origin, originErr := s.Store.GetMCPTaskOrigin(ctx, a.TaskID)
		if originErr != nil && !errors.Is(originErr, store.ErrNotFound) {
			return nil, fmt.Errorf("verify MCP task origin: %w", originErr)
		}
		if originErr == nil &&
			origin.PrincipalKind == auth.Principal.Kind &&
			origin.PrincipalID == auth.Principal.ID &&
			origin.ClientID == auth.ClientID {
			return nil, errors.New("originating MCP principal cannot approve its own action")
		}
	}
	decision := strings.TrimSpace(stringArg(args, "decision"))
	if decision != store.DecisionApproved && decision != store.DecisionDenied {
		return nil, errors.New("decision must be approved or denied")
	}
	return s.Engine.Decide(ctx, id, decision, "mcp:"+auth.ClientID)
}

func (s *Server) answerTaskQuestion(ctx context.Context, args map[string]any) (any, error) {
	if s.Engine == nil {
		return nil, errors.New("task engine unavailable")
	}
	selected := stringSliceArg(args, "selected")
	return s.Engine.AnswerUserQuestion(ctx, requiredString(args, "question_id"), task.AnswerUserQuestionRequest{
		Selected:  selected,
		OtherText: stringArg(args, "other_text"),
	}, "mcp")
}

func (s *Server) runRoutine(ctx context.Context, auth authContext, args map[string]any) (any, error) {
	if s.RunRoutine != nil {
		return s.RunRoutine(ctx, requiredString(args, "routine_id"), store.MCPTaskOrigin{
			PrincipalKind: auth.Principal.Kind,
			PrincipalID:   auth.Principal.ID,
			ClientID:      auth.ClientID,
			SessionID:     auth.SessionID,
		})
	}
	return nil, errors.New("routine scheduler unavailable")
}

func (s *Server) resolveIdempotency(ctx context.Context, auth authContext, args map[string]any) (any, error) {
	if s.Store == nil {
		return nil, errors.New("store unavailable")
	}
	if stringArg(args, "action") != "discard" {
		return nil, errors.New("action must be discard")
	}
	key := requiredString(args, "idempotency_key")
	principalID := auth.Principal.Kind + ":" + auth.Principal.ID
	cached, ok, err := s.Store.GetMCPIdempotency(ctx, principalID, auth.ClientID, key, s.clock())
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, store.ErrNotFound
	}
	var envelope idempotencyEnvelope
	if err := json.Unmarshal(cached, &envelope); err != nil || envelope.State != "pending" {
		return nil, errors.New("idempotency key is not pending")
	}
	if err := s.Store.DeleteMCPIdempotency(ctx, principalID, auth.ClientID, key); err != nil {
		return nil, err
	}
	return map[string]any{"discarded": true, "idempotency_key": key}, nil
}

func toolDefinitions() []map[string]any {
	read := map[string]any{"type": "object", "additionalProperties": true}
	write := map[string]any{"type": "object", "additionalProperties": true}
	return []map[string]any{
		{"name": "list_tasks", "description": "List bounded Kin tasks.", "inputSchema": read},
		{"name": "get_task", "description": "Read one Kin task.", "inputSchema": schema([]string{"task_id"}, map[string]any{"task_id": stringProp()})},
		{"name": "list_task_events", "description": "List bounded task events.", "inputSchema": schema([]string{"task_id"}, map[string]any{"task_id": stringProp(), "since_seq": intProp(), "limit": intProp()})},
		{"name": "list_worker_steps", "description": "List persisted multi-worker plan steps for a task.", "inputSchema": schema([]string{"task_id"}, map[string]any{"task_id": stringProp(), "execution_id": stringProp()})},
		{"name": "list_projects", "description": "List bounded projects.", "inputSchema": read},
		{"name": "list_artifacts", "description": "List bounded artifacts.", "inputSchema": read},
		{"name": "read_artifact", "description": "Read an indexed artifact with a bounded response.", "inputSchema": schema([]string{"artifact_id"}, map[string]any{"artifact_id": stringProp(), "max_bytes": intProp()})},
		{"name": "list_routines", "description": "List cursor-paginated Routines.", "inputSchema": read},
		{"name": "get_usage", "description": "Read bounded local usage summaries.", "inputSchema": read},
		{"name": "get_routing_status", "description": "Read current routing configuration status.", "inputSchema": read},
		{"name": "create_task", "description": "Create a Kin task under normal workspace and routing policy.", "inputSchema": schema([]string{"cwd", "prompt", "idempotency_key"}, map[string]any{"cwd": stringProp(), "prompt": stringProp(), "agent": stringProp(), "model": stringProp(), "permission_mode": stringProp(), "workspace_mode": stringProp(), "project_id": stringProp(), "dispatch": map[string]any{"type": "object"}, "idempotency_key": stringProp()})},
		{"name": "send_task_message", "description": "Send a follow-up to a Kin task.", "inputSchema": schema([]string{"task_id", "prompt", "idempotency_key"}, map[string]any{"task_id": stringProp(), "prompt": stringProp(), "agent": stringProp(), "model": stringProp(), "permission_mode": stringProp(), "idempotency_key": stringProp()})},
		{"name": "cancel_task", "description": "Cancel a Kin task.", "inputSchema": write},
		{"name": "retry_task", "description": "Retry a terminal Kin task.", "inputSchema": schema([]string{"task_id", "idempotency_key"}, map[string]any{"task_id": stringProp(), "from_seq": intProp(), "restore_files": map[string]any{"type": "boolean"}, "idempotency_key": stringProp()})},
		{"name": "continue_task", "description": "Continue a quota-limited task.", "inputSchema": schema([]string{"task_id", "idempotency_key"}, map[string]any{"task_id": stringProp(), "action": stringProp(), "agent": stringProp(), "provider": stringProp(), "model": stringProp(), "idempotency_key": stringProp()})},
		{"name": "approve_task_action", "description": "Approve or deny a pending action through the normal human gate.", "inputSchema": schema([]string{"approval_id", "decision"}, map[string]any{"approval_id": stringProp(), "decision": stringProp()})},
		{"name": "answer_task_question", "description": "Answer a pending task question.", "inputSchema": schema([]string{"question_id"}, map[string]any{"question_id": stringProp(), "selected": map[string]any{"type": "array", "items": stringProp()}, "other_text": stringProp()})},
		{"name": "resolve_idempotency", "description": "Admin-only explicit discard of a stuck pending idempotency operation; inspect task state before using.", "inputSchema": schema([]string{"idempotency_key", "action"}, map[string]any{"idempotency_key": stringProp(), "action": stringProp()})},
		{"name": "run_routine", "description": "Run one saved Routine now.", "inputSchema": schema([]string{"routine_id", "idempotency_key"}, map[string]any{"routine_id": stringProp(), "idempotency_key": stringProp()})},
	}
}

func requiredScope(tool string) string {
	switch tool {
	case "approve_task_action", "answer_task_question", "resolve_idempotency":
		return ScopeAdmin
	case "create_task", "send_task_message", "cancel_task", "retry_task", "continue_task", "run_routine":
		return ScopeWrite
	default:
		return ScopeRead
	}
}

func requiresIdempotency(tool string) bool {
	switch tool {
	case "create_task", "send_task_message", "retry_task", "continue_task", "run_routine":
		return true
	default:
		return false
	}
}

func scopesForPrincipal(p remote.Principal, requested string) map[string]bool {
	requested = strings.TrimSpace(requested)
	if p.Kind == remote.PrincipalDevice {
		if requested != "" {
			scopes, valid := parseScopes(requested)
			if !valid || !scopes[ScopeRead] {
				return map[string]bool{}
			}
		}
		return map[string]bool{ScopeRead: true}
	}
	if requested == "" {
		scopes := make(map[string]bool)
		scopes[ScopeRead] = true
		scopes[ScopeWrite] = true
		return scopes
	}
	scopes, valid := parseScopes(requested)
	if !valid {
		return map[string]bool{}
	}
	return scopes
}

func parseScopes(raw string) (map[string]bool, bool) {
	out := make(map[string]bool)
	valid := true
	for _, item := range strings.Split(raw, ",") {
		switch strings.TrimSpace(item) {
		case ScopeRead:
			out[ScopeRead] = true
		case ScopeWrite:
			out[ScopeWrite] = true
		case ScopeAdmin:
			out[ScopeAdmin] = true
			out[ScopeWrite] = true
			out[ScopeRead] = true
		case "":
			valid = false
		default:
			valid = false
		}
	}
	return out, valid && len(out) > 0
}

func allows(scopes map[string]bool, required string) bool {
	if required == ScopeRead {
		return scopes[ScopeRead] || scopes[ScopeWrite] || scopes[ScopeAdmin]
	}
	if required == ScopeWrite {
		return scopes[ScopeWrite] || scopes[ScopeAdmin]
	}
	return scopes[ScopeAdmin]
}

func errorResponse(req request, code int, message string) response {
	return response{JSONRPC: req.JSONRPC, ID: req.ID, Error: &rpcError{Code: code, Message: message}}
}

func toolName(req request) string {
	if req.Method != "tools/call" {
		return ""
	}
	var p toolCallParams
	_ = json.Unmarshal(req.Params, &p)
	return p.Name
}

func bodyProtocolVersion(raw json.RawMessage) string {
	var params struct {
		Meta map[string]any `json:"_meta"`
	}
	if len(raw) == 0 || json.Unmarshal(raw, &params) != nil {
		return ""
	}
	value, _ := params.Meta["io.modelcontextprotocol/protocolVersion"].(string)
	return strings.TrimSpace(value)
}

func (s *Server) clock() int64 {
	if s.now != nil {
		return s.now()
	}
	return time.Now().UnixMilli()
}

func (s *Server) validSession(id string) bool {
	_, ok := s.sessionState(id)
	return ok
}

func (s *Server) session(id string) sessionState {
	state, _ := s.sessionState(id)
	return state
}

func (s *Server) sessionState(id string) (sessionState, bool) {
	if id == "" {
		return sessionState{}, false
	}
	s.sessionMu.Lock()
	defer s.sessionMu.Unlock()
	if s.sessions == nil {
		return sessionState{}, false
	}
	state, ok := s.sessions[id]
	if !ok || !state.ExpiresAt.After(time.Now()) {
		if ok {
			delete(s.sessions, id)
		}
		return sessionState{}, false
	}
	return state, true
}

func (s *Server) newSession(protocolVersion string) string {
	id, err := remote.NewSecret()
	if err != nil {
		id = ulid.Make().String()
	}
	s.sessionMu.Lock()
	if s.sessions == nil {
		s.sessions = make(map[string]sessionState)
	}
	s.sessions[id] = sessionState{
		ExpiresAt:       time.Now().Add(24 * time.Hour),
		ProtocolVersion: protocolVersion,
	}
	s.sessionMu.Unlock()
	return id
}

func validRequestID(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return true
	}
	value := strings.TrimSpace(string(raw))
	if value == "null" || value == "" {
		return false
	}
	switch value[0] {
	case '"':
		var id string
		return json.Unmarshal(raw, &id) == nil
	default:
		var id json.Number
		return json.Unmarshal(raw, &id) == nil && id.String() != ""
	}
}

func allowedOrigin(origin, host string) bool {
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Host == "" {
		return false
	}
	if parsed.Host == host || parsed.Host == "localhost" || strings.HasPrefix(parsed.Host, "localhost:") ||
		parsed.Host == "127.0.0.1" || strings.HasPrefix(parsed.Host, "127.0.0.1:") ||
		parsed.Host == "[::1]" || strings.HasPrefix(parsed.Host, "[::1]:") {
		return true
	}
	return false
}

func supportedProtocolVersion(version string) bool {
	switch version {
	case "2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25", "2026-07-28":
		return true
	default:
		return false
	}
}

func negotiatedProtocolVersion(raw json.RawMessage) string {
	var params struct {
		ProtocolVersion string `json:"protocolVersion"`
	}
	_ = json.Unmarshal(raw, &params)
	if supportedProtocolVersion(params.ProtocolVersion) {
		return params.ProtocolVersion
	}
	return "2024-11-05"
}

func defaultString(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func hashBytes(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func scopeString(scopes map[string]bool) string {
	parts := make([]string, 0, 3)
	for _, value := range []string{ScopeRead, ScopeWrite, ScopeAdmin} {
		if scopes[value] {
			parts = append(parts, value)
		}
	}
	return strings.Join(parts, ",")
}

func boundedInt(args map[string]any, key string, fallback int) int {
	value, ok := args[key]
	if !ok {
		return fallback
	}
	number, ok := value.(float64)
	if !ok {
		return fallback
	}
	n := int(number)
	if n < 0 {
		return 0
	}
	if (key == "limit" || key == "max_bytes") && n == 0 {
		return fallback
	}
	if key == "max_bytes" && n > 256*1024 {
		return 256 * 1024
	}
	if key == "days" && n > 90 {
		return 90
	}
	if key == "since_seq" {
		return n
	}
	if n > maxPageSize {
		return maxPageSize
	}
	return n
}

func stringArg(args map[string]any, key string) string {
	value, _ := args[key].(string)
	return strings.TrimSpace(value)
}

func requiredString(args map[string]any, key string) string {
	return stringArg(args, key)
}

func stringSliceArg(args map[string]any, key string) []string {
	raw, _ := args[key].([]any)
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		if value, ok := item.(string); ok && strings.TrimSpace(value) != "" {
			out = append(out, value)
		}
	}
	return out
}

func mapWithout(src map[string]any, keys ...string) map[string]any {
	out := make(map[string]any, len(src))
	for key, value := range src {
		skip := false
		for _, remove := range keys {
			if key == remove {
				skip = true
				break
			}
		}
		if !skip {
			out[key] = value
		}
	}
	return out
}

func schema(required []string, properties map[string]any) map[string]any {
	return map[string]any{
		"type":                 "object",
		"additionalProperties": false,
		"required":             required,
		"properties":           properties,
	}
}

func stringProp() map[string]any { return map[string]any{"type": "string"} }
func intProp() map[string]any    { return map[string]any{"type": "integer", "minimum": 0} }

func writeHTTPJSON(w http.ResponseWriter, status int, value any) {
	raw, err := json.Marshal(value)
	if err != nil {
		http.Error(w, `{"error":"encode response"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(raw)
}

// RunStdio proxies a local MCP host to the daemon's authenticated Streamable
// HTTP endpoint. The master token remains in this process and is never placed
// in an MCP result or tool description.
func RunStdio(ctx context.Context, daemonURL, token, clientID, scopes string, in io.Reader, out io.Writer, errOut io.Writer) error {
	daemonURL = strings.TrimRight(strings.TrimSpace(daemonURL), "/")
	if daemonURL == "" || token == "" {
		return errors.New("MCP stdio requires daemon URL and token")
	}
	httpClient := &http.Client{Timeout: 60 * time.Second}
	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 0, 64*1024), maxRequestBytes)
	sessionID := ""
	protocolVersion := "2026-07-28"
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var meta struct {
			Method string          `json:"method"`
			Params json.RawMessage `json:"params,omitempty"`
		}
		_ = json.Unmarshal(line, &meta)
		if meta.Method == "initialize" {
			var initParams struct {
				ProtocolVersion string `json:"protocolVersion"`
			}
			_ = json.Unmarshal(meta.Params, &initParams)
			protocolVersion = initParams.ProtocolVersion
		}
		payload := line
		var err error
		if protocolVersion == "2026-07-28" && meta.Method != "initialize" {
			payload, err = withProtocolMeta(line, protocolVersion)
			if err != nil {
				return err
			}
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, daemonURL+"/mcp", bytes.NewReader(payload))
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		req.Header.Set("X-Kin-MCP-Client", defaultString(clientID, "stdio-client"))
		req.Header.Set("X-Kin-MCP-Scopes", scopes)
		req.Header.Set("Mcp-Method", meta.Method)
		if meta.Method == "tools/call" {
			var call toolCallParams
			_ = json.Unmarshal(meta.Params, &call)
			req.Header.Set("Mcp-Name", call.Name)
		}
		if protocolVersion != "" {
			req.Header.Set("MCP-Protocol-Version", protocolVersion)
		}
		if sessionID != "" {
			req.Header.Set("MCP-Session-Id", sessionID)
		}
		resp, err := httpClient.Do(req)
		if err != nil {
			return err
		}
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
		_ = resp.Body.Close()
		if readErr != nil {
			return readErr
		}
		if header := strings.TrimSpace(resp.Header.Get("MCP-Session-Id")); header != "" {
			sessionID = header
		}
		if header := strings.TrimSpace(resp.Header.Get("MCP-Protocol-Version")); header != "" {
			protocolVersion = header
		}
		if len(body) > maxResponseBytes {
			return errors.New("MCP response exceeds size limit")
		}
		if resp.StatusCode >= 400 {
			fmt.Fprintf(errOut, "kin mcp: daemon returned HTTP %s\n", resp.Status)
		}
		var envelope struct {
			ID json.RawMessage `json:"id,omitempty"`
		}
		_ = json.Unmarshal(line, &envelope)
		if len(envelope.ID) == 0 || string(envelope.ID) == "null" {
			continue
		}
		if _, err := out.Write(append(body, '\n')); err != nil {
			return err
		}
	}
	return scanner.Err()
}

func withProtocolMeta(line []byte, version string) ([]byte, error) {
	var req request
	if err := json.Unmarshal(line, &req); err != nil {
		return nil, err
	}
	var params map[string]any
	if len(req.Params) == 0 || string(req.Params) == "null" {
		params = map[string]any{}
	} else if err := json.Unmarshal(req.Params, &params); err != nil {
		return nil, err
	}
	meta, ok := params["_meta"].(map[string]any)
	if !ok || meta == nil {
		meta = map[string]any{}
	}
	meta["io.modelcontextprotocol/protocolVersion"] = version
	params["_meta"] = meta
	req.Params, _ = json.Marshal(params)
	return json.Marshal(req)
}
