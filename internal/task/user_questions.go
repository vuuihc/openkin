package task

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/vuuihc/kin/internal/store"
)

// CreateUserQuestionRequest is the body for POST /internal/user-questions.
type CreateUserQuestionRequest struct {
	TaskID  string          `json:"task_id"`
	Payload json.RawMessage `json:"payload"` // optional raw; preferred fields below
	// Structured fields (preferred over raw payload).
	Question    string               `json:"question"`
	Header      string               `json:"header,omitempty"`
	Options     []UserQuestionOption `json:"options"`
	MultiSelect bool                 `json:"multi_select,omitempty"`
	// Optional execution attribution.
	ExecutionID    string `json:"execution_id,omitempty"`
	ExecutionAgent string `json:"execution_agent,omitempty"`
	ExecutionStep  int    `json:"execution_step,omitempty"`
	ExecutionModel string `json:"execution_model,omitempty"`
}

// UserQuestionOption is one selectable choice.
type UserQuestionOption struct {
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

// AnswerUserQuestionRequest is the body for POST /api/user-questions/{id}/answer.
type AnswerUserQuestionRequest struct {
	Selected  []string `json:"selected"`
	OtherText string   `json:"other_text,omitempty"`
}

// userQuestionPayload is the stored payload shape.
type userQuestionPayload struct {
	Question    string               `json:"question"`
	Header      string               `json:"header,omitempty"`
	Options     []UserQuestionOption `json:"options"`
	MultiSelect bool                 `json:"multi_select,omitempty"`
}

// userQuestionResponse is the stored/returned answer shape.
type userQuestionResponse struct {
	Selected  []string `json:"selected"`
	OtherText string   `json:"other_text,omitempty"`
}

func buildUserQuestionPayload(req CreateUserQuestionRequest) (json.RawMessage, error) {
	if len(req.Payload) > 0 && req.Question == "" && len(req.Options) == 0 {
		// Allow raw payload passthrough when structured fields absent.
		var p userQuestionPayload
		if err := json.Unmarshal(req.Payload, &p); err != nil {
			return nil, fmt.Errorf("invalid payload: %w", err)
		}
		if p.Question == "" {
			return nil, fmt.Errorf("question is required")
		}
		if len(p.Options) < 2 {
			return nil, fmt.Errorf("at least 2 options are required")
		}
		for i, o := range p.Options {
			if o.Label == "" {
				return nil, fmt.Errorf("options[%d].label is required", i)
			}
		}
		if len(p.Options) > 6 {
			return nil, fmt.Errorf("at most 6 options are allowed")
		}
		return json.Marshal(p)
	}
	if req.Question == "" {
		return nil, fmt.Errorf("question is required")
	}
	if len(req.Options) < 2 {
		return nil, fmt.Errorf("at least 2 options are required")
	}
	if len(req.Options) > 6 {
		return nil, fmt.Errorf("at most 6 options are allowed")
	}
	for i, o := range req.Options {
		if o.Label == "" {
			return nil, fmt.Errorf("options[%d].label is required", i)
		}
	}
	p := userQuestionPayload{
		Question:    req.Question,
		Header:      req.Header,
		Options:     req.Options,
		MultiSelect: req.MultiSelect,
	}
	return json.Marshal(p)
}

// RequestUserQuestion inserts a pending user question, sets task waiting_input,
// appends user_question_requested, and broadcasts.
func (e *Engine) RequestUserQuestion(ctx context.Context, req CreateUserQuestionRequest) (store.UserQuestion, error) {
	if req.TaskID == "" {
		return store.UserQuestion{}, fmt.Errorf("task_id is required")
	}
	payload, err := buildUserQuestionPayload(req)
	if err != nil {
		return store.UserQuestion{}, err
	}
	execID, execAgent, execStep, execModel, err := normalizeExecutionAttribution(
		req.ExecutionID, req.ExecutionAgent, req.ExecutionStep, req.ExecutionModel,
	)
	if err != nil {
		return store.UserQuestion{}, err
	}

	t, err := e.store.GetTask(ctx, req.TaskID)
	if err != nil {
		return store.UserQuestion{}, err
	}
	switch t.Status {
	case StatusRunning, StatusWaitingApproval, StatusWaitingInput:
		// ok — questions are independent of permission mode / approval waits
	default:
		return store.UserQuestion{}, fmt.Errorf("%w: task status %s cannot request user question", ErrConflict, t.Status)
	}

	id, err := e.newID()
	if err != nil {
		return store.UserQuestion{}, err
	}
	now := e.nowMilli()
	q := store.UserQuestion{
		ID:        id,
		TaskID:    req.TaskID,
		Payload:   payload,
		Status:    store.UQStatusPending,
		CreatedAt: now,
	}
	if execID != "" {
		q.ExecutionID = &execID
		q.ExecutionAgent = &execAgent
		if execStep > 0 {
			step := execStep
			q.ExecutionStep = &step
		}
		if execModel != "" {
			q.ExecutionModel = &execModel
		}
	}
	if err := e.store.InsertUserQuestion(ctx, q); err != nil {
		return store.UserQuestion{}, err
	}

	// Task → waiting_input (distinct from waiting_approval).
	status := StatusWaitingInput
	if err := e.store.UpdateTask(ctx, req.TaskID, store.TaskPatch{Status: &status}); err != nil {
		return store.UserQuestion{}, err
	}
	t, _ = e.store.GetTask(ctx, req.TaskID)
	e.bus.PublishTask(t)

	evMap := map[string]any{
		"question_id": id,
		"payload":     json.RawMessage(payload),
	}
	if q.ExecutionID != nil {
		evMap["execution_id"] = *q.ExecutionID
	}
	if q.ExecutionAgent != nil {
		evMap["execution_agent"] = *q.ExecutionAgent
		evMap["agent"] = *q.ExecutionAgent
		evMap["speaker"] = *q.ExecutionAgent
	}
	if q.ExecutionStep != nil {
		evMap["execution_step"] = *q.ExecutionStep
	}
	if q.ExecutionModel != nil {
		evMap["execution_model"] = *q.ExecutionModel
		evMap["model"] = *q.ExecutionModel
	}
	evPayload, _ := json.Marshal(evMap)
	if _, err := e.appendEventLocked(ctx, req.TaskID, "user_question_requested", evPayload); err != nil {
		return store.UserQuestion{}, fmt.Errorf("persist user_question_requested: %w", err)
	}
	e.bus.PublishUserQuestion(q)
	return q, nil
}

// AnswerUserQuestion records the user's answer (or an interrupt/timeout resolution).
// via is typically "web", "timeout", or "interrupt".
func (e *Engine) AnswerUserQuestion(ctx context.Context, id string, req AnswerUserQuestionRequest, via string) (store.UserQuestion, error) {
	if via == "" {
		via = "web"
	}
	if req.Selected == nil {
		req.Selected = []string{}
	}
	respObj := userQuestionResponse{Selected: req.Selected, OtherText: req.OtherText}
	respRaw, err := json.Marshal(respObj)
	if err != nil {
		return store.UserQuestion{}, err
	}

	now := e.nowMilli()
	var q store.UserQuestion
	if via == "timeout" || via == "interrupt" {
		// Interrupt/timeout: mark expired (or answered with empty selection) so
		// long-pollers unblock. Use expire for timeout; for interrupt store answered
		// with empty selected so the MCP tool can fail-open with a note.
		if via == "timeout" {
			q, err = e.store.ExpireUserQuestion(ctx, id, via, now)
		} else {
			// interrupt → answered with empty selected (fail-open for the model)
			q, err = e.store.AnswerUserQuestion(ctx, id, respRaw, via, now)
		}
	} else {
		q, err = e.store.AnswerUserQuestion(ctx, id, respRaw, via, now)
	}
	if err != nil {
		if errors.Is(err, store.ErrAlreadyAnswered) {
			return store.UserQuestion{}, ErrAlreadyAnswered
		}
		return store.UserQuestion{}, err
	}

	e.notifyUserQuestionWaiters(id, q)

	evPayload, _ := json.Marshal(map[string]any{
		"question_id":  id,
		"status":       q.Status,
		"response":     json.RawMessage(respRaw),
		"answered_via": via,
	})
	if _, err := e.appendEventLocked(ctx, q.TaskID, "user_question_answered", evPayload); err != nil {
		e.bus.PublishUserQuestion(q)
		return q, fmt.Errorf("persist user_question_answered: %w", err)
	}

	// Resume task to running if no other pending approvals or questions.
	t, err := e.store.GetTask(ctx, q.TaskID)
	if err == nil && (t.Status == StatusWaitingInput || t.Status == StatusWaitingApproval) {
		pendingA, _ := e.store.ListPendingForTask(ctx, q.TaskID)
		pendingQ, _ := e.store.ListPendingUserQuestionsForTask(ctx, q.TaskID)
		if len(pendingA) == 0 && len(pendingQ) == 0 {
			status := StatusRunning
			_ = e.store.UpdateTask(ctx, q.TaskID, store.TaskPatch{Status: &status})
			if t2, err := e.store.GetTask(ctx, q.TaskID); err == nil {
				e.bus.PublishTask(t2)
			}
		}
	}

	e.bus.PublishUserQuestion(q)
	return q, nil
}

// GetUserQuestion returns one user question.
func (e *Engine) GetUserQuestion(ctx context.Context, id string) (store.UserQuestion, error) {
	return e.store.GetUserQuestion(ctx, id)
}

// ListUserQuestions lists user questions with optional status filter.
func (e *Engine) ListUserQuestions(ctx context.Context, opts store.ListUserQuestionsOpts) ([]store.UserQuestion, error) {
	return e.store.ListUserQuestions(ctx, opts)
}

// WaitUserQuestion long-polls until the question is answered/expired or timeout elapses.
func (e *Engine) WaitUserQuestion(ctx context.Context, id string, timeout time.Duration) (store.UserQuestion, error) {
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	if timeout > 30*time.Second {
		timeout = 30 * time.Second
	}

	q, err := e.store.GetUserQuestion(ctx, id)
	if err != nil {
		return store.UserQuestion{}, err
	}
	q, err = e.maybeExpireUserQuestion(ctx, q)
	if err != nil {
		return store.UserQuestion{}, err
	}
	if q.Status != store.UQStatusPending {
		return q, nil
	}

	ch := e.registerUserQuestionWaiter(id)
	defer e.unregisterUserQuestionWaiter(id, ch)

	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return store.UserQuestion{}, ctx.Err()
	case got := <-ch:
		return got, nil
	case <-timer.C:
	}

	q, err = e.store.GetUserQuestion(ctx, id)
	if err != nil {
		return store.UserQuestion{}, err
	}
	return e.maybeExpireUserQuestion(ctx, q)
}

func (e *Engine) maybeExpireUserQuestion(ctx context.Context, q store.UserQuestion) (store.UserQuestion, error) {
	if q.Status != store.UQStatusPending {
		return q, nil
	}
	ttl := store.DefaultUserQuestionTTL
	if e.now().Sub(time.UnixMilli(q.CreatedAt)) < ttl {
		return q, nil
	}
	return e.AnswerUserQuestion(ctx, q.ID, AnswerUserQuestionRequest{}, "timeout")
}

// ExpireStaleUserQuestions flips pending questions older than TTL to expired.
func (e *Engine) ExpireStaleUserQuestions(ctx context.Context) (int, error) {
	cutoff := e.nowMilli() - store.DefaultUserQuestionTTL.Milliseconds()
	pending, err := e.store.ListPendingUserQuestionsOlderThan(ctx, cutoff)
	if err != nil {
		return 0, err
	}
	n := 0
	for _, q := range pending {
		if _, err := e.AnswerUserQuestion(ctx, q.ID, AnswerUserQuestionRequest{}, "timeout"); err == nil {
			n++
		}
	}
	return n, nil
}

func (e *Engine) registerUserQuestionWaiter(id string) chan store.UserQuestion {
	ch := make(chan store.UserQuestion, 1)
	e.mu.Lock()
	e.userQuestionWaiters[id] = append(e.userQuestionWaiters[id], ch)
	e.mu.Unlock()
	return ch
}

func (e *Engine) unregisterUserQuestionWaiter(id string, ch chan store.UserQuestion) {
	e.mu.Lock()
	defer e.mu.Unlock()
	list := e.userQuestionWaiters[id]
	for i, c := range list {
		if c == ch {
			e.userQuestionWaiters[id] = append(list[:i], list[i+1:]...)
			break
		}
	}
	if len(e.userQuestionWaiters[id]) == 0 {
		delete(e.userQuestionWaiters, id)
	}
}

func (e *Engine) notifyUserQuestionWaiters(id string, q store.UserQuestion) {
	e.mu.Lock()
	list := e.userQuestionWaiters[id]
	delete(e.userQuestionWaiters, id)
	e.mu.Unlock()
	for _, ch := range list {
		select {
		case ch <- q:
		default:
		}
	}
}
