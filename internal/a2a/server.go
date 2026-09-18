// Package a2a exposes an opt-in, task-level Agent2Agent facade. It deliberately
// has no tool or memory methods; delegated work is always an ordinary Kin task.
package a2a

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/oklog/ulid/v2"
	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/adapter/detect"
	"github.com/vuuihc/openkin/internal/remote"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/task"
)

const (
	a2aReservationReclaimAge = 30 * time.Second
	maxA2ABodyBytes          = 1 << 20
	maxA2AEventsPerPoll      = 500
)

// Server is the dependency boundary for the A2A facade.
type Server struct {
	Store   *store.Store
	Engine  *task.Engine
	Version string
	Enabled bool
}

// AgentCard is the public capability declaration.
type AgentCard struct {
	Name           string         `json:"name"`
	Description    string         `json:"description"`
	URL            string         `json:"url"`
	Version        string         `json:"version"`
	Protocol       string         `json:"protocol"`
	Authentication Authentication `json:"authentication"`
	Capabilities   Capabilities   `json:"capabilities"`
}

type Authentication struct {
	Schemes []string `json:"schemes"`
}

type Capabilities struct {
	Streaming bool `json:"streaming"`
	Tasks     bool `json:"tasks"`
	Artifacts bool `json:"artifacts"`
}

type taskRequest struct {
	IdempotencyKey string          `json:"idempotency_key"`
	Message        Message         `json:"message"`
	Cwd            string          `json:"cwd"`
	Agent          string          `json:"agent,omitempty"`
	Model          *string         `json:"model,omitempty"`
	PermissionMode string          `json:"permission_mode,omitempty"`
	ProjectID      string          `json:"project_id,omitempty"`
	Dispatch       json.RawMessage `json:"dispatch,omitempty"`
}

type Message struct {
	Role  string `json:"role"`
	Parts []Part `json:"parts"`
}

type Part struct {
	Kind string `json:"kind"`
	Text string `json:"text,omitempty"`
}

type followUpRequest struct {
	Message        Message  `json:"message"`
	QuestionID     string   `json:"question_id,omitempty"`
	Selected       []string `json:"selected,omitempty"`
	OtherText      string   `json:"other_text,omitempty"`
	ApprovalID     string   `json:"approval_id,omitempty"`
	Decision       string   `json:"decision,omitempty"`
	IdempotencyKey string   `json:"idempotency_key,omitempty"`
}

type a2aTask struct {
	ID        string               `json:"id"`
	ContextID string               `json:"context_id"`
	Status    string               `json:"status"`
	Task      store.Task           `json:"task"`
	Events    []store.Event        `json:"events,omitempty"`
	Artifacts []store.Artifact     `json:"artifacts,omitempty"`
	Approvals []store.Approval     `json:"approvals,omitempty"`
	Questions []store.UserQuestion `json:"questions,omitempty"`
}

// Handler returns the authenticated subrouter. Callers decide where to mount
// it; when Enabled is false it returns 404 for every endpoint.
func (s *Server) Handler() http.Handler {
	r := chi.NewRouter()
	r.Get("/.well-known/agent-card.json", s.handleAgentCard)
	r.Post("/v1/tasks", s.handleCreateTask)
	r.Get("/v1/tasks/{id}", s.handleGetTask)
	r.Get("/v1/tasks/{id}/events", s.handleEvents)
	r.Get("/v1/tasks/{id}/stream", s.handleStream)
	r.Post("/v1/tasks/{id}:cancel", s.handleCancel)
	r.Post("/v1/tasks/{id}:message", s.handleMessage)
	return r
}

func (s *Server) enabled(w http.ResponseWriter) bool {
	if s == nil || !s.Enabled || s.Store == nil || s.Engine == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "a2a is disabled"})
		return false
	}
	return true
}

func (s *Server) handleAgentCard(w http.ResponseWriter, r *http.Request) {
	if s == nil || !s.Enabled {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "a2a is disabled"})
		return
	}
	writeJSON(w, http.StatusOK, AgentCard{
		Name: "OpenKin", Description: "Local-first task delegation control plane",
		URL: "/a2a/v1", Version: s.Version, Protocol: "a2a",
		Authentication: Authentication{Schemes: []string{"bearer"}},
		Capabilities:   Capabilities{Streaming: true, Tasks: true, Artifacts: true},
	})
}

func (s *Server) handleCreateTask(w http.ResponseWriter, r *http.Request) {
	if !s.enabled(w) {
		return
	}
	var body taskRequest
	r.Body = http.MaxBytesReader(w, r.Body, maxA2ABodyBytes)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if strings.TrimSpace(body.IdempotencyKey) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "idempotency_key is required"})
		return
	}
	prompt := messageText(body.Message)
	if strings.TrimSpace(body.Cwd) == "" || prompt == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "cwd and message text are required"})
		return
	}
	if adapter.NormalizePermissionMode(body.PermissionMode) == adapter.PermissionYOLO {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "a2a does not grant yolo execution"})
		return
	}
	if detect.IsGenericCLI(effectiveA2AAgent(body)) && adapter.NormalizePermissionMode(body.PermissionMode) != adapter.PermissionAcceptEdits {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "generic CLI agents require permission_mode accept_edits"})
		return
	}
	principal := principalID(r)
	requestBytes, _ := json.Marshal(body)
	requestSum := sha256.Sum256(requestBytes)
	requestHash := hex.EncodeToString(requestSum[:])
	reservedID := ulid.Make().String()
	taskID, reserved, err := s.Store.ReserveA2AIdempotency(r.Context(), principal, body.IdempotencyKey, reservedID, requestHash)
	if err != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	if !reserved {
		if _, getErr := s.Engine.Get(r.Context(), taskID); errors.Is(getErr, store.ErrNotFound) {
			// A daemon may have crashed after reserving the key. Reclaim only
			// an old, still-orphaned reservation; concurrent creators remain 409.
			reclaimed, reclaimErr := s.Store.A2AIdempotencyReclaimable(
				r.Context(), principal, body.IdempotencyKey, taskID, a2aReservationReclaimAge.Milliseconds(),
			)
			if reclaimErr != nil {
				writeJSON(w, http.StatusConflict, map[string]string{"error": reclaimErr.Error()})
				return
			}
			if reclaimed {
				reserved = true
			} else {
				writeJSON(w, http.StatusConflict, map[string]string{"error": "a2a task creation is still pending"})
				return
			}
		}
	}
	if !reserved {
		s.writeTask(w, r, taskID)
		return
	}
	created, err := s.Engine.Create(r.Context(), task.CreateRequest{
		ID:  taskID,
		Cwd: body.Cwd, Prompt: prompt, Agent: body.Agent, Model: body.Model,
		PermissionMode: body.PermissionMode, ProjectID: body.ProjectID, Dispatch: body.Dispatch,
	})
	if err != nil {
		if _, getErr := s.Engine.Get(r.Context(), taskID); errors.Is(getErr, store.ErrNotFound) {
			_ = s.Store.DeleteA2AIdempotency(r.Context(), principal, body.IdempotencyKey)
		}
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	s.writeTaskStatus(w, r, http.StatusAccepted, created)
}

func (s *Server) handleGetTask(w http.ResponseWriter, r *http.Request) {
	if !s.enabled(w) {
		return
	}
	id := chi.URLParam(r, "id")
	if !s.authorizeTask(w, r, id) {
		return
	}
	s.writeTask(w, r, id)
}

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	if !s.enabled(w) {
		return
	}
	id := chi.URLParam(r, "id")
	if !s.authorizeTask(w, r, id) {
		return
	}
	events, err := s.Store.ListEventsLimit(r.Context(), id, 0, maxA2AEventsPerPoll)
	if err != nil {
		a2aError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, events)
}

func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	if !s.enabled(w) {
		return
	}
	id := chi.URLParam(r, "id")
	if !s.authorizeTask(w, r, id) {
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "streaming unsupported"})
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	seq := 0
	for {
		events, err := s.Store.ListEventsLimit(r.Context(), id, seq, maxA2AEventsPerPoll)
		if err != nil {
			a2aError(w, err)
			return
		}
		for _, event := range events {
			seq = event.Seq
			payload, _ := json.Marshal(map[string]any{"type": "event", "event": event})
			fmt.Fprintf(w, "data: %s\n\n", payload)
			flusher.Flush()
		}
		current, err := s.Engine.Get(r.Context(), id)
		if err != nil {
			a2aError(w, err)
			return
		}
		if terminal(current.Status) {
			payload, _ := json.Marshal(map[string]any{"type": "task", "task": current})
			fmt.Fprintf(w, "data: %s\n\n", payload)
			flusher.Flush()
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *Server) handleCancel(w http.ResponseWriter, r *http.Request) {
	if !s.enabled(w) {
		return
	}
	id := chi.URLParam(r, "id")
	if !s.authorizeTask(w, r, id) {
		return
	}
	t, err := s.Engine.Cancel(r.Context(), id)
	if err != nil {
		a2aError(w, err)
		return
	}
	s.writeTaskStatus(w, r, http.StatusOK, t)
}

func (s *Server) handleMessage(w http.ResponseWriter, r *http.Request) {
	if !s.enabled(w) {
		return
	}
	id := chi.URLParam(r, "id")
	if !s.authorizeTask(w, r, id) {
		return
	}
	var body followUpRequest
	r.Body = http.MaxBytesReader(w, r.Body, maxA2ABodyBytes)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	prompt := messageText(body.Message)
	if body.QuestionID == "" && body.ApprovalID == "" && prompt == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "message text is required"})
		return
	}
	principal := principalID(r)
	var operationKey string
	if strings.TrimSpace(body.IdempotencyKey) != "" {
		operationKey = body.IdempotencyKey
		requestBytes, _ := json.Marshal(body)
		sum := sha256.Sum256(requestBytes)
		op, err := s.Store.ReserveA2AOperation(r.Context(), principal, id, operationKey, hex.EncodeToString(sum[:]))
		if err != nil {
			a2aError(w, err)
			return
		}
		if !op.Created {
			if op.State == "completed" && len(op.Response) > 0 {
				writeRawJSON(w, op.Status, op.Response)
				return
			}
			if op.State == "failed" && len(op.Response) > 0 {
				writeRawJSON(w, op.Status, op.Response)
				return
			}
			writeJSON(w, http.StatusConflict, map[string]string{"error": "a2a operation is already in progress"})
			return
		}
	}
	if body.QuestionID != "" {
		question, err := s.Engine.GetUserQuestion(r.Context(), body.QuestionID)
		if err != nil {
			s.failOperation(r, principal, id, operationKey, a2aStatus(err), err)
			a2aError(w, err)
			return
		}
		if question.TaskID != id {
			err := errors.New("question does not belong to task")
			s.failOperation(r, principal, id, operationKey, http.StatusForbidden, err)
			writeJSON(w, http.StatusForbidden, map[string]string{"error": err.Error()})
			return
		}
		q, err := s.Engine.AnswerUserQuestion(r.Context(), body.QuestionID, task.AnswerUserQuestionRequest{
			Selected: body.Selected, OtherText: body.OtherText,
		}, "a2a")
		if err != nil {
			s.failOperation(r, principal, id, operationKey, a2aStatus(err), err)
			a2aError(w, err)
			return
		}
		s.completeOperation(r, principal, id, operationKey, http.StatusOK, q)
		writeJSON(w, http.StatusOK, q)
		return
	}
	if body.ApprovalID != "" {
		approval, err := s.Store.GetApproval(r.Context(), body.ApprovalID)
		if err != nil {
			s.failOperation(r, principal, id, operationKey, a2aStatus(err), err)
			a2aError(w, err)
			return
		}
		if approval.TaskID != id {
			err := errors.New("approval does not belong to task")
			s.failOperation(r, principal, id, operationKey, http.StatusForbidden, err)
			writeJSON(w, http.StatusForbidden, map[string]string{"error": err.Error()})
			return
		}
		updated, err := s.Engine.Decide(r.Context(), body.ApprovalID, body.Decision, "a2a")
		if err != nil {
			s.failOperation(r, principal, id, operationKey, a2aStatus(err), err)
			a2aError(w, err)
			return
		}
		s.completeOperation(r, principal, id, operationKey, http.StatusOK, updated)
		writeJSON(w, http.StatusOK, updated)
		return
	}
	updated, err := s.Engine.FollowUp(r.Context(), id, prompt)
	if err != nil {
		s.failOperation(r, principal, id, operationKey, a2aStatus(err), err)
		a2aError(w, err)
		return
	}
	s.completeOperation(r, principal, id, operationKey, http.StatusAccepted, updated)
	s.writeTaskStatus(w, r, http.StatusAccepted, updated)
}

func (s *Server) completeOperation(r *http.Request, principal, taskID, key string, status int, value any) {
	if key == "" {
		return
	}
	response, err := json.Marshal(value)
	if err == nil {
		_ = s.Store.CompleteA2AOperation(r.Context(), principal, taskID, key, status, response)
	}
}

func (s *Server) failOperation(r *http.Request, principal, taskID, key string, status int, err error) {
	if key == "" {
		return
	}
	response, marshalErr := json.Marshal(map[string]string{"error": err.Error()})
	if marshalErr == nil {
		_ = s.Store.FailA2AOperation(r.Context(), principal, taskID, key, status, response)
	}
}

func (s *Server) authorizeTask(w http.ResponseWriter, r *http.Request, taskID string) bool {
	principal, ok := remote.PrincipalFromContext(r.Context())
	if ok && principal.Kind == remote.PrincipalMaster {
		return true
	}
	owned, err := s.Store.IsA2ATaskOwner(r.Context(), principalID(r), taskID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return false
	}
	if !owned {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "a2a task is owned by another principal"})
		return false
	}
	return true
}

func a2aStatus(err error) int {
	if errors.Is(err, store.ErrNotFound) {
		return http.StatusNotFound
	}
	if errors.Is(err, task.ErrConflict) {
		return http.StatusConflict
	}
	return http.StatusBadRequest
}

func (s *Server) writeTask(w http.ResponseWriter, r *http.Request, id string) {
	t, err := s.Engine.Get(r.Context(), id)
	if err != nil {
		a2aError(w, err)
		return
	}
	s.writeTaskStatus(w, r, http.StatusOK, t)
}

func (s *Server) writeTaskStatus(w http.ResponseWriter, r *http.Request, status int, t store.Task) {
	artifacts, _ := s.Store.ListArtifacts(r.Context(), store.ListArtifactsOpts{TaskID: t.ID})
	approvals, _ := s.Store.ListPendingForTask(r.Context(), t.ID)
	questions, _ := s.Store.ListPendingUserQuestionsForTask(r.Context(), t.ID)
	writeJSON(w, status, a2aTask{
		ID: t.ID, ContextID: t.ID, Status: normalizeStatus(t.Status), Task: t, Artifacts: artifacts,
		Approvals: approvals, Questions: questions,
	})
}

func principalID(r *http.Request) string {
	// The auth middleware has already authenticated the request. Device tokens
	// are isolated from each other; the master token uses a stable namespace.
	if principal, ok := remote.PrincipalFromContext(r.Context()); ok {
		return "a2a:" + principal.Kind + ":" + principal.DeviceID
	}
	sum := sha256.Sum256([]byte(r.Header.Get("Authorization")))
	return "a2a:" + hex.EncodeToString(sum[:])
}

func messageText(message Message) string {
	var parts []string
	for _, part := range message.Parts {
		if part.Kind == "" || part.Kind == "text" {
			parts = append(parts, part.Text)
		}
	}
	return strings.TrimSpace(strings.Join(parts, "\n"))
}

func effectiveA2AAgent(body taskRequest) string {
	agent := body.Agent
	var dispatch struct {
		Mode  string `json:"mode"`
		Agent string `json:"agent"`
	}
	if json.Unmarshal(body.Dispatch, &dispatch) == nil && dispatch.Mode == "manual" && dispatch.Agent != "" {
		agent = dispatch.Agent
	}
	return agent
}

func normalizeStatus(status string) string {
	switch status {
	case task.StatusQueued, task.StatusRunning:
		return "working"
	case task.StatusWaitingApproval, task.StatusWaitingInput:
		return "input-required"
	case task.StatusSucceeded:
		return "completed"
	case task.StatusFailed:
		return "failed"
	case task.StatusCanceled:
		return "canceled"
	default:
		return "working"
	}
}

func terminal(status string) bool {
	return status == task.StatusSucceeded || status == task.StatusFailed || status == task.StatusCanceled
}

func a2aError(w http.ResponseWriter, err error) {
	status := http.StatusBadRequest
	if errors.Is(err, store.ErrNotFound) {
		status = http.StatusNotFound
	} else if errors.Is(err, task.ErrConflict) {
		status = http.StatusConflict
	}
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeRawJSON(w http.ResponseWriter, status int, raw json.RawMessage) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(raw)
}
