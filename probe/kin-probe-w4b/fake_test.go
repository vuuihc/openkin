package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	fakeMasterToken = "master-token-for-tests"
	fakeDeviceToken = "device-token-for-tests"
	fakeDeviceID    = "ios-0000000000000001"
)

type feedChange struct {
	cursor  int64
	taskID  string
	deleted bool
}

type fakeSubscriber struct {
	ch   chan SSEEvent
	done chan struct{}
}

type fakeApproval struct {
	Approval
	ch chan struct{}
}

type fakeTask struct {
	task    Task
	epoch   int64
	events  []TaskEvent
	nextSeq int64
}

// fakeDaemon is an in-process daemon implementing just the documented surface
// the probe uses. It also plays the agent: each prompt runs a scripted turn
// with streaming chunks and, when configured, one approval request.
type fakeDaemon struct {
	t *testing.T

	mu          sync.Mutex
	hubSeq      int64
	pageCap     int
	tasks       map[string]*fakeTask
	changes     []feedChange
	approvals   map[string]*fakeApproval
	subscribers map[*fakeSubscriber]struct{}
	taskSeq     int
	approvalSeq int
	revoked     bool
	decisions   []string
	deviceToken string
	approvalCut string // "pending" or "none"

	// Negative-path knobs, set before start().
	breakApprovals      bool
	corruptFeedStatus   bool
	mangleDurableType   string
	breakStream         bool
	failDelete          bool
	failRevoke          bool
	suppressTaskUpdate  bool
	requestedWithoutRow bool
	pairingUsed         bool
	pairingLabel        string
	deviceLabel         string
}

func newFakeDaemon(t *testing.T, approvalCut string) *fakeDaemon {
	t.Helper()
	f := &fakeDaemon{
		t:           t,
		pageCap:     3,
		tasks:       make(map[string]*fakeTask),
		approvals:   make(map[string]*fakeApproval),
		subscribers: make(map[*fakeSubscriber]struct{}),
		deviceToken: fakeDeviceToken,
		approvalCut: approvalCut,
		deviceLabel: "probe",
	}
	// Seed old history so the first snapshot spans more than one page.
	for i := 0; i < 4; i++ {
		f.seedTask(fmt.Sprintf("seed-%d", i))
	}
	return f
}

func (f *fakeDaemon) seedTask(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.hubSeq++
	task := Task{
		ID:         id,
		Title:      id,
		Agent:      "fake",
		Status:     "succeeded",
		EventEpoch: 0,
		HubSeq:     ptr(f.hubSeq),
		CreatedAt:  time.Now().UnixMilli(),
	}
	f.tasks[id] = &fakeTask{task: task, epoch: 0, nextSeq: 1}
	f.changes = append(f.changes, feedChange{cursor: f.hubSeq, taskID: id})
}

func ptr[T any](v T) *T { return &v }

func (f *fakeDaemon) start() *httptest.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"ok": true})
	})
	mux.HandleFunc("POST /api/pairing/sessions", func(w http.ResponseWriter, r *http.Request) {
		if !f.operator(w, r) {
			return
		}
		writeJSON(w, 201, PairingSession{Secret: "pair-secret", ExpiresAt: time.Now().Add(5 * time.Minute).UnixMilli()})
	})
	mux.HandleFunc("POST /api/pairing/exchange", func(w http.ResponseWriter, r *http.Request) {
		var req PairingExchangeRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, 400, map[string]string{"error": "invalid json"})
			return
		}
		if req.Secret != "pair-secret" {
			writeJSON(w, 401, map[string]string{"error": "expired, replayed, or invalid pairing secret"})
			return
		}
		f.mu.Lock()
		used, label := f.pairingUsed, f.pairingLabel
		f.mu.Unlock()
		if used {
			// A replayed secret is refused unless the documented recovery
			// header asks for the credential minted by the first exchange.
			if r.Header.Get("X-Kin-Pairing-Recovery") != "1" || req.Label != label {
				writeJSON(w, 401, map[string]string{"error": "expired, replayed, or invalid pairing secret"})
				return
			}
			writeJSON(w, 200, PairingExchange{DeviceID: fakeDeviceID, Token: f.deviceToken, Label: label, DesktopID: "desktop-test", DesktopName: "Test Desktop"})
			return
		}
		f.mu.Lock()
		f.pairingUsed, f.pairingLabel, f.deviceLabel = true, req.Label, req.Label
		f.mu.Unlock()
		writeJSON(w, 201, PairingExchange{DeviceID: fakeDeviceID, Token: f.deviceToken, Label: req.Label, DesktopID: "desktop-test", DesktopName: "Test Desktop"})
	})
	mux.HandleFunc("GET /api/devices", func(w http.ResponseWriter, r *http.Request) {
		if !f.operator(w, r) {
			return
		}
		f.mu.Lock()
		dev := Device{ID: fakeDeviceID, Label: f.deviceLabel, Reachability: "unknown", CreatedAt: time.Now().UnixMilli(), Agents: []json.RawMessage{}}
		if f.revoked {
			dev.RevokedAt = time.Now().UnixMilli()
		}
		f.mu.Unlock()
		writeJSON(w, 200, []Device{dev})
	})
	mux.HandleFunc("POST /api/devices/{deviceId}/revoke", func(w http.ResponseWriter, r *http.Request) {
		if !f.operator(w, r) {
			return
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		if f.failRevoke {
			writeJSON(w, 500, map[string]string{"error": "injected revoke failure"})
			return
		}
		if r.PathValue("deviceId") != fakeDeviceID || f.revoked {
			writeJSON(w, 404, map[string]string{"error": "device not found or already revoked"})
			return
		}
		f.revoked = true
		w.WriteHeader(204)
	})
	mux.HandleFunc("GET /api/sessions/cursor", func(w http.ResponseWriter, r *http.Request) {
		if !f.holder(w, r) {
			return
		}
		f.mu.Lock()
		cursor := f.hubSeq
		f.mu.Unlock()
		writeJSON(w, 200, map[string]int64{"cursor": cursor})
	})
	mux.HandleFunc("GET /api/sessions", func(w http.ResponseWriter, r *http.Request) {
		if !f.holder(w, r) {
			return
		}
		var since *int64
		if raw := r.URL.Query().Get("updated_since"); raw != "" {
			v, err := strconv.ParseInt(raw, 10, 64)
			if err != nil || v < 0 {
				writeJSON(w, 400, map[string]string{"error": "invalid cursor"})
				return
			}
			since = &v
		}
		limit := 200
		if raw := r.URL.Query().Get("limit"); raw != "" {
			v, err := strconv.Atoi(raw)
			if err != nil || v < 0 {
				writeJSON(w, 400, map[string]string{"error": "invalid limit"})
				return
			}
			limit = v
		}
		writeJSON(w, 200, f.page(since, limit))
	})
	mux.HandleFunc("GET /api/events", f.handleEvents)
	mux.HandleFunc("POST /api/tasks", f.handleCreateTask)
	mux.HandleFunc("GET /api/tasks/{taskId}", func(w http.ResponseWriter, r *http.Request) {
		if !f.holder(w, r) {
			return
		}
		f.mu.Lock()
		task, ok := f.tasks[r.PathValue("taskId")]
		var out Task
		if ok {
			out = task.task
		}
		f.mu.Unlock()
		if !ok {
			writeJSON(w, 404, map[string]string{"error": "task not found"})
			return
		}
		writeJSON(w, 200, out)
	})
	mux.HandleFunc("POST /api/tasks/{taskId}/prompt", func(w http.ResponseWriter, r *http.Request) {
		if !f.holder(w, r) {
			return
		}
		var req FollowUpRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Prompt == "" {
			writeJSON(w, 400, map[string]string{"error": "prompt is required"})
			return
		}
		f.mu.Lock()
		task, ok := f.tasks[r.PathValue("taskId")]
		if !ok {
			f.mu.Unlock()
			writeJSON(w, 404, map[string]string{"error": "task not found"})
			return
		}
		f.setStatusLocked(task, "running")
		out := task.task
		f.mu.Unlock()
		go f.runTurn(task.task.ID, req.Prompt)
		writeJSON(w, 200, out)
	})
	mux.HandleFunc("POST /api/tasks/{taskId}/cancel", func(w http.ResponseWriter, r *http.Request) {
		if !f.holder(w, r) {
			return
		}
		f.mu.Lock()
		task, ok := f.tasks[r.PathValue("taskId")]
		if !ok {
			f.mu.Unlock()
			writeJSON(w, 404, map[string]string{"error": "task not found"})
			return
		}
		f.setStatusLocked(task, "canceled")
		out := task.task
		f.mu.Unlock()
		writeJSON(w, 200, out)
	})
	mux.HandleFunc("DELETE /api/tasks/{taskId}", func(w http.ResponseWriter, r *http.Request) {
		if !f.operator(w, r) {
			return
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		if f.failDelete {
			writeJSON(w, 500, map[string]string{"error": "injected delete failure"})
			return
		}
		id := r.PathValue("taskId")
		task, ok := f.tasks[id]
		if !ok {
			writeJSON(w, 404, map[string]string{"error": "task not found"})
			return
		}
		if !task.task.Terminal() {
			writeJSON(w, 400, map[string]string{"error": "the task cannot be deleted in its current state"})
			return
		}
		delete(f.tasks, id)
		f.hubSeq++
		f.changes = append(f.changes, feedChange{cursor: f.hubSeq, taskID: id, deleted: true})
		f.emitLocked("task_deleted", map[string]string{"id": id})
		w.WriteHeader(204)
	})
	mux.HandleFunc("GET /api/tasks/{taskId}/events", func(w http.ResponseWriter, r *http.Request) {
		if !f.holder(w, r) {
			return
		}
		since, _ := strconv.ParseInt(r.URL.Query().Get("since_seq"), 10, 64)
		f.mu.Lock()
		task, ok := f.tasks[r.PathValue("taskId")]
		if !ok {
			f.mu.Unlock()
			writeJSON(w, 404, map[string]string{"error": "task not found"})
			return
		}
		out := make([]TaskEvent, 0, len(task.events))
		for _, ev := range task.events {
			if ev.Seq > since {
				if f.mangleDurableType != "" && ev.Type == f.mangleDurableType {
					ev.Type += "-mangled"
				}
				out = append(out, ev)
			}
		}
		f.mu.Unlock()
		writeJSON(w, 200, out)
	})
	mux.HandleFunc("GET /api/approvals", func(w http.ResponseWriter, r *http.Request) {
		if !f.holder(w, r) {
			return
		}
		f.mu.Lock()
		if f.breakApprovals {
			f.mu.Unlock()
			writeJSON(w, 500, map[string]string{"error": "injected approvals failure"})
			return
		}
		status := r.URL.Query().Get("status")
		out := make([]Approval, 0, len(f.approvals))
		for _, ap := range f.approvals {
			if status == "" || ap.Decision == status {
				out = append(out, ap.Approval)
			}
		}
		f.mu.Unlock()
		writeJSON(w, 200, out)
	})
	mux.HandleFunc("POST /api/approvals/{approvalId}/decision", func(w http.ResponseWriter, r *http.Request) {
		if !f.holder(w, r) {
			return
		}
		var req struct {
			Decision string `json:"decision"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, 400, map[string]string{"error": "invalid json"})
			return
		}
		f.mu.Lock()
		ap, ok := f.approvals[r.PathValue("approvalId")]
		if !ok {
			f.mu.Unlock()
			writeJSON(w, 404, map[string]string{"error": "approval not found"})
			return
		}
		if ap.Decision != "pending" {
			f.mu.Unlock()
			writeJSON(w, 400, map[string]string{"error": "approval already decided"})
			return
		}
		if req.Decision != "approved" && req.Decision != "denied" {
			f.mu.Unlock()
			writeJSON(w, 400, map[string]string{"error": "invalid decision"})
			return
		}
		now := time.Now().UnixMilli()
		ap.Decision = req.Decision
		ap.DecidedAt = &now
		ap.DecidedVia = "ios:" + fakeDeviceID
		f.emitLocked("approval_update", ap.Approval)
		f.decisions = append(f.decisions, req.Decision)
		out := ap.Approval
		close(ap.ch)
		f.mu.Unlock()
		writeJSON(w, 200, out)
	})
	return httptest.NewServer(mux)
}

type PairingExchangeRequest struct {
	Secret string `json:"secret"`
	Label  string `json:"label"`
}

type FollowUpRequest struct {
	Prompt string `json:"prompt"`
}

func (f *fakeDaemon) operator(w http.ResponseWriter, r *http.Request) bool {
	tok := bearer(r)
	switch tok {
	case fakeMasterToken:
		return true
	case f.deviceToken:
		writeJSON(w, 403, map[string]string{"error": "operator access required"})
		return false
	default:
		w.Header().Set("WWW-Authenticate", `Bearer realm="kin"`)
		writeJSON(w, 401, map[string]string{"error": "unauthorized"})
		return false
	}
}

func (f *fakeDaemon) holder(w http.ResponseWriter, r *http.Request) bool {
	tok := bearer(r)
	f.mu.Lock()
	revoked := f.revoked
	f.mu.Unlock()
	if tok == fakeMasterToken {
		return true
	}
	if tok == f.deviceToken && !revoked {
		return true
	}
	if tok == f.deviceToken && revoked {
		writeJSON(w, 401, map[string]string{"error": "device revoked"})
		return false
	}
	w.Header().Set("WWW-Authenticate", `Bearer realm="kin"`)
	writeJSON(w, 401, map[string]string{"error": "unauthorized"})
	return false
}

func bearer(r *http.Request) string {
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		return strings.TrimPrefix(h, "Bearer ")
	}
	return r.URL.Query().Get("token")
}

func (f *fakeDaemon) page(since *int64, limit int) ChangePage {
	f.mu.Lock()
	defer f.mu.Unlock()
	start := int64(0)
	if since != nil {
		start = *since
	}
	if limit <= 0 {
		limit = 200
	}
	if limit > 500 {
		limit = 500
	}
	if f.pageCap > 0 && limit > f.pageCap {
		limit = f.pageCap
	}
	selected := make([]feedChange, 0, limit)
	for _, ch := range f.changes {
		if ch.cursor > start {
			selected = append(selected, ch)
			if len(selected) >= limit {
				break
			}
		}
	}
	page := ChangePage{NextCursor: start}
	if len(selected) > 0 {
		page.NextCursor = selected[len(selected)-1].cursor
	}
	type entry struct {
		id      string
		deleted bool
		task    Task
	}
	var order []string
	byID := make(map[string]*entry)
	for _, ch := range selected {
		e, ok := byID[ch.taskID]
		if !ok {
			e = &entry{id: ch.taskID}
			byID[ch.taskID] = e
			order = append(order, ch.taskID)
		}
		if ch.deleted {
			e.deleted = true
			continue
		}
		if task, ok := f.tasks[ch.taskID]; ok {
			e.deleted = false
			e.task = task.task
			if f.corruptFeedStatus {
				e.task.Status = "queued"
			}
		}
	}
	for _, id := range order {
		e := byID[id]
		if e.deleted {
			page.Deleted = append(page.Deleted, id)
		} else if e.task.ID != "" {
			page.Sessions = append(page.Sessions, e.task)
		}
	}
	for _, ch := range f.changes {
		if ch.cursor > page.NextCursor {
			page.HasMore = true
			break
		}
	}
	return page
}

func (f *fakeDaemon) handleCreateTask(w http.ResponseWriter, r *http.Request) {
	if !f.holder(w, r) {
		return
	}
	var req CreateTaskRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, 400, map[string]string{"error": "invalid json"})
		return
	}
	if req.Cwd == "" || req.Prompt == "" {
		writeJSON(w, 400, map[string]string{"error": "cwd and prompt are required"})
		return
	}
	f.mu.Lock()
	f.taskSeq++
	id := fmt.Sprintf("task-%d", f.taskSeq)
	f.hubSeq++
	task := &fakeTask{
		task: Task{
			ID:             id,
			Title:          req.Title,
			Agent:          "fake",
			Cwd:            req.Cwd,
			Prompt:         req.Prompt,
			PermissionMode: "default",
			Status:         "running",
			EventEpoch:     0,
			HubSeq:         ptr(f.hubSeq),
			CreatedAt:      time.Now().UnixMilli(),
		},
		epoch:   0,
		nextSeq: 1,
	}
	f.tasks[id] = task
	f.changes = append(f.changes, feedChange{cursor: f.hubSeq, taskID: id})
	f.emitLocked("task_update", task.task)
	out := task.task
	f.mu.Unlock()
	go f.runTurn(id, req.Prompt)
	writeJSON(w, 201, out)
}

func (f *fakeDaemon) runTurn(taskID, prompt string) {
	f.appendEvent(taskID, "task_started", TaskEventPayload{Status: "running", Source: "host"})
	f.setStatus(taskID, "running")
	f.appendEvent(taskID, "message", TaskEventPayload{Role: "user", Speaker: "user", Source: "user", Text: prompt})

	if strings.Contains(prompt, "echo") {
		if f.approvalCut == "pending" {
			ap := f.createApproval(taskID)
			f.appendEvent(taskID, "tool_use", TaskEventPayload{ToolName: "Bash", Status: "pending", ApprovalID: ap.ID})
			select {
			case <-ap.ch:
			case <-time.After(5 * time.Second):
				f.mu.Lock()
				if ap.Decision == "pending" {
					ap.Decision = "expired"
					now := time.Now().UnixMilli()
					ap.DecidedAt = &now
					ap.DecidedVia = "timeout"
					f.emitLocked("approval_update", ap.Approval)
				}
				f.mu.Unlock()
			}
		} else {
			if f.requestedWithoutRow {
				f.appendEvent(taskID, "approval_requested", TaskEventPayload{Kind: "tool_use"})
			}
			f.appendEvent(taskID, "tool_use", TaskEventPayload{ToolName: "Bash", Status: "running"})
			// The live daemon can deliver a tool result as a message content
			// block (role user, type tool_result) rather than a tool_result
			// event; the contract treats block types as an open set.
			f.appendEvent(taskID, "message", TaskEventPayload{
				Role:    "user",
				Partial: ptr(false),
				Content: json.RawMessage(`[{"type":"tool_result","content":"probe-w4b-ok","is_error":false}]`),
			})
		}
	}

	for _, chunk := range []string{"stream-", "chunk-", "text "} {
		time.Sleep(5 * time.Millisecond)
		f.appendEvent(taskID, "message", TaskEventPayload{Role: "assistant", Partial: ptr(true), Text: chunk, Source: "claude-code"})
	}
	f.appendEvent(taskID, "message", TaskEventPayload{Role: "assistant", Partial: ptr(false), Text: "final answer for: " + prompt, Source: "claude-code"})
	f.appendEvent(taskID, "result", TaskEventPayload{Text: "done", Status: "ok"})
	f.setStatus(taskID, "succeeded")
}

func (f *fakeDaemon) appendEvent(taskID, kind string, payload TaskEventPayload) {
	f.mu.Lock()
	defer f.mu.Unlock()
	task, ok := f.tasks[taskID]
	if !ok {
		return
	}
	ev := TaskEvent{
		TaskID:     taskID,
		EventEpoch: task.epoch,
		Seq:        task.nextSeq,
		Ts:         time.Now().UnixMilli(),
		Type:       kind,
		Payload:    payload,
	}
	task.nextSeq++
	task.events = append(task.events, ev)
	f.hubSeq++
	task.task.HubSeq = ptr(f.hubSeq)
	f.changes = append(f.changes, feedChange{cursor: f.hubSeq, taskID: taskID})
	f.emitLocked("event", ev)
	f.emitLocked("task_update", task.task)
}

func (f *fakeDaemon) setStatus(taskID, status string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	task, ok := f.tasks[taskID]
	if !ok {
		return
	}
	f.setStatusLocked(task, status)
}

func (f *fakeDaemon) setStatusLocked(task *fakeTask, status string) {
	task.task.Status = status
	if status == "succeeded" || status == "failed" || status == "canceled" {
		now := time.Now().UnixMilli()
		task.task.FinishedAt = &now
	}
	f.hubSeq++
	task.task.HubSeq = ptr(f.hubSeq)
	f.changes = append(f.changes, feedChange{cursor: f.hubSeq, taskID: task.task.ID})
	f.emitLocked("task_update", task.task)
}

func (f *fakeDaemon) createApproval(taskID string) *fakeApproval {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.approvalSeq++
	ap := &fakeApproval{
		Approval: Approval{
			ID:        fmt.Sprintf("approval-%d", f.approvalSeq),
			TaskID:    taskID,
			Kind:      "tool_use",
			Decision:  "pending",
			CreatedAt: time.Now().UnixMilli(),
		},
		ch: make(chan struct{}),
	}
	f.approvals[ap.ID] = ap
	f.emitLocked("approval_update", ap.Approval)
	return ap
}

func (f *fakeDaemon) emitLocked(kind string, data any) {
	if f.suppressTaskUpdate && kind == "task_update" {
		return
	}
	raw, err := json.Marshal(data)
	if err != nil {
		f.t.Errorf("marshal %s: %v", kind, err)
		return
	}
	msg, err := json.Marshal(wsMessage{Kind: kind, Data: raw})
	if err != nil {
		f.t.Errorf("marshal envelope %s: %v", kind, err)
		return
	}
	ev := SSEEvent{Name: kind, Data: string(msg)}
	for sub := range f.subscribers {
		select {
		case sub.ch <- ev:
		case <-sub.done:
		default:
			// A slow test subscriber may drop; the durable feed still heals.
		}
	}
}

func (f *fakeDaemon) handleEvents(w http.ResponseWriter, r *http.Request) {
	if !f.holder(w, r) {
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", 500)
		return
	}
	if f.breakStream {
		// Send valid headers so OpenEventStream succeeds, then drop the
		// connection without an SSE terminator so the reader sees a real
		// transport failure rather than a clean EOF.
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(200)
		flusher.Flush()
		if hj, ok := w.(http.Hijacker); ok {
			if conn, _, err := hj.Hijack(); err == nil {
				_ = conn.Close()
			}
		}
		return
	}
	sub := &fakeSubscriber{ch: make(chan SSEEvent, 256), done: make(chan struct{})}
	f.mu.Lock()
	f.subscribers[sub] = struct{}{}
	f.mu.Unlock()
	defer func() {
		f.mu.Lock()
		if _, ok := f.subscribers[sub]; ok {
			delete(f.subscribers, sub)
			close(sub.done)
		}
		f.mu.Unlock()
	}()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(200)
	fmt.Fprint(w, "retry: 3000\n\n")
	flusher.Flush()

	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case ev := <-sub.ch:
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", ev.Name, ev.Data)
			flusher.Flush()
		case <-ticker.C:
			fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		case <-r.Context().Done():
			return
		}
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// ---- tests ----

func runFakeAcceptance(t *testing.T, approvalCut string) (*Outcome, *fakeDaemon) {
	t.Helper()
	return runFakeAcceptanceWith(t, approvalCut, nil)
}

func runFakeAcceptanceWith(t *testing.T, approvalCut string, configure func(*fakeDaemon)) (*Outcome, *fakeDaemon) {
	t.Helper()
	f := newFakeDaemon(t, approvalCut)
	if configure != nil {
		configure(f)
	}
	srv := f.start()
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	out := RunAcceptance(ctx, Config{
		BaseURL:      srv.URL,
		MasterToken:  fakeMasterToken,
		ApprovalWait: 5 * time.Second,
		Logf:         t.Logf,
	})
	return out, f
}

func stepByName(t *testing.T, out *Outcome, name string) Step {
	t.Helper()
	for _, step := range out.Steps {
		if step.Name == name {
			return step
		}
	}
	t.Fatalf("no %q step in %+v", name, out.Steps)
	return Step{}
}

func TestRunAcceptanceAgainstFake(t *testing.T) {
	out, f := runFakeAcceptance(t, "pending")
	for _, step := range out.Steps {
		if step.Status == statusFail {
			t.Fatalf("step %s failed: %s", step.Name, step.Detail)
		}
	}
	if len(out.Steps) != 7 {
		t.Fatalf("got %d steps, want 6 acceptance steps plus cleanup: %+v", len(out.Steps), out.Steps)
	}
	if out.Steps[4].Status != statusPass {
		t.Fatalf("approval step = %s (%s), want pass", out.Steps[4].Status, out.Steps[4].Detail)
	}
	if out.Metrics.PartialChunks < 1 {
		t.Fatalf("partial chunks = %d, want at least 1", out.Metrics.PartialChunks)
	}
	if out.Metrics.FirstPromptToFinalMS <= 0 {
		t.Fatalf("first-prompt-to-final elapsed = %d ms", out.Metrics.FirstPromptToFinalMS)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.decisions) != 1 || f.decisions[0] != "approved" {
		t.Fatalf("decisions = %v, want one approved", f.decisions)
	}
	if len(f.tasks) != 4 {
		t.Fatalf("tasks remaining = %d, want the 4 seeded tasks only", len(f.tasks))
	}
	if !f.revoked {
		t.Fatal("device was not revoked")
	}
}

func TestRunAcceptanceApprovalSuppressed(t *testing.T) {
	out, _ := runFakeAcceptance(t, "none")
	approvalStep := out.Steps[4]
	if approvalStep.Status != statusSkip {
		t.Fatalf("approval step = %s (%s), want skip", approvalStep.Status, approvalStep.Detail)
	}
	if !strings.Contains(approvalStep.Detail, "list readable") {
		t.Fatalf("skip detail does not record list readability: %s", approvalStep.Detail)
	}
	if !strings.Contains(approvalStep.Detail, "approval_requested=0") {
		t.Fatalf("skip detail does not record the durable approval evidence: %s", approvalStep.Detail)
	}
	if !strings.Contains(approvalStep.Detail, "embedded_tool_result=1") {
		t.Fatalf("skip detail does not record the embedded tool result: %s", approvalStep.Detail)
	}
	for _, step := range out.Steps {
		if step.Status == statusFail {
			t.Fatalf("step %s failed: %s", step.Name, step.Detail)
		}
	}
}

func TestSSEParser(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want []SSEEvent
	}{
		{
			name: "retry and comment are not events",
			in:   "retry: 3000\n\n: ping\n\nevent: task_update\ndata: {\"kind\":\"task_update\"}\n\n",
			want: []SSEEvent{{Name: "task_update", Data: `{"kind":"task_update"}`}},
		},
		{
			name: "multi-line data joins with newline",
			in:   "event: event\ndata: line1\ndata: line2\n\n",
			want: []SSEEvent{{Name: "event", Data: "line1\nline2"}},
		},
		{
			name: "crlf and default name",
			in:   "data: hello\r\n\r\n",
			want: []SSEEvent{{Name: "message", Data: "hello"}},
		},
		{
			name: "final frame without trailing blank line",
			in:   "event: x\ndata: y",
			want: []SSEEvent{{Name: "x", Data: "y"}},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			stream := &EventStream{resp: &http.Response{Body: ioNopCloser{strings.NewReader(tc.in)}}}
			var got []SSEEvent
			err := stream.Read(func(ev SSEEvent) error {
				got = append(got, ev)
				return nil
			})
			if err != nil && !errors.Is(err, io.EOF) {
				t.Fatalf("read: %v", err)
			}
			if len(got) != len(tc.want) {
				t.Fatalf("got %d events %+v, want %d", len(got), got, len(tc.want))
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("event %d = %+v, want %+v", i, got[i], tc.want[i])
				}
			}
		})
	}
}

type ioNopCloser struct{ *strings.Reader }

func (ioNopCloser) Close() error { return nil }

func TestMessageAccumulator(t *testing.T) {
	var m MessageAccumulator
	yes, no := true, false
	m.Apply(TaskEvent{Type: "message", Payload: TaskEventPayload{Partial: &yes, Text: "a"}})
	m.Apply(TaskEvent{Type: "message", Payload: TaskEventPayload{Partial: &yes, Text: "b"}})
	if m.PartialChunks != 2 || m.PartialText != "ab" {
		t.Fatalf("partials = %d %q", m.PartialChunks, m.PartialText)
	}
	m.Apply(TaskEvent{Type: "message", Payload: TaskEventPayload{Partial: &no, Text: "final"}})
	if m.FinalText != "final" || m.PartialText != "" || !m.HaveFinal {
		t.Fatalf("final = %q partial = %q have=%t", m.FinalText, m.PartialText, m.HaveFinal)
	}
}

func TestTaskTrackerEpochReset(t *testing.T) {
	tr := NewTaskTracker()
	for seq := int64(1); seq <= 4; seq++ {
		tr.ApplyEvent(TaskEvent{EventEpoch: 0, Seq: seq, Type: "message", Payload: TaskEventPayload{Partial: ptr(true), Text: "old"}})
	}
	if len(tr.Events) != 4 || tr.NextSeq != 5 {
		t.Fatalf("events=%d next=%d", len(tr.Events), tr.NextSeq)
	}
	// A tail rewrite deletes events from the rewrite point and appends with a
	// higher epoch; the appended seq values reuse those from that point, so the
	// new epoch may start at a seq above 1.
	if !tr.ApplyEvent(TaskEvent{EventEpoch: 1, Seq: 3, Type: "message"}) {
		t.Fatal("epoch bump did not report a reset")
	}
	if len(tr.Events) != 1 || tr.Epoch != 1 || tr.NextSeq != 4 || tr.Messages.PartialText != "" {
		t.Fatalf("after reset events=%d epoch=%d next=%d partial=%q", len(tr.Events), tr.Epoch, tr.NextSeq, tr.Messages.PartialText)
	}
}

func TestDrainFeedPaginationAndGuard(t *testing.T) {
	pages := []ChangePage{
		{Sessions: []Task{{ID: "a"}}, NextCursor: 1, HasMore: true},
		{Sessions: []Task{{ID: "b"}}, Deleted: []string{"a"}, NextCursor: 2, HasMore: false},
	}
	i := 0
	state := NewFeedState()
	n, err := DrainFeed(context.Background(), func(since *int64) (ChangePage, error) {
		p := pages[i]
		i++
		return p, nil
	}, nil, state.Apply)
	if err != nil {
		t.Fatalf("drain: %v", err)
	}
	if n != 2 || state.Cursor != 2 || state.Deleted["a"] != true || len(state.Tasks) != 1 {
		t.Fatalf("pages=%d cursor=%d deleted=%v tasks=%v", n, state.Cursor, state.Deleted, state.Tasks)
	}

	stuck := func(since *int64) (ChangePage, error) {
		return ChangePage{NextCursor: 5, HasMore: true}, nil
	}
	since := int64(5)
	if _, err := DrainFeed(context.Background(), stuck, &since, NewFeedState().Apply); err == nil {
		t.Fatal("unchanged cursor with has_more was not refused")
	}

	backwards := func(since *int64) (ChangePage, error) {
		return ChangePage{NextCursor: 1, HasMore: false}, nil
	}
	s := int64(5)
	state2 := NewFeedState()
	state2.Cursor = 5
	state2.Started = true
	if _, err := DrainFeed(context.Background(), backwards, &s, state2.Apply); err == nil {
		t.Fatal("backwards cursor was not refused")
	}
}

func TestRevokedDeviceGets401(t *testing.T) {
	f := newFakeDaemon(t, "none")
	srv := f.start()
	defer srv.Close()
	client := NewClient(srv.URL, fakeDeviceToken)
	if _, err := client.Cursor(context.Background()); err != nil {
		t.Fatalf("active device: %v", err)
	}
	master := NewClient(srv.URL, fakeMasterToken)
	if err := master.RevokeDevice(context.Background(), fakeDeviceID); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if _, err := client.Cursor(context.Background()); !isStatus(err, 401) {
		t.Fatalf("revoked device cursor error = %v, want 401", err)
	}
}

func frame(kind string, data any) SSEEvent {
	raw, err := json.Marshal(data)
	if err != nil {
		panic(err)
	}
	msg, err := json.Marshal(wsMessage{Kind: kind, Data: raw})
	if err != nil {
		panic(err)
	}
	return SSEEvent{Name: kind, Data: string(msg)}
}

func TestSetTaskIDReplaysBufferedFrames(t *testing.T) {
	s := NewLiveState("")
	s.ApplyFrame(frame("task_update", Task{ID: "t1", Status: "running"}))
	s.ApplyFrame(frame("event", TaskEvent{TaskID: "t1", EventEpoch: 0, Seq: 1, Type: "message"}))
	s.ApplyFrame(frame("event", TaskEvent{TaskID: "t1", EventEpoch: 0, Seq: 2, Type: "message"}))
	if snap := s.Snapshot(); snap.HasTask || snap.EventCount != 0 {
		t.Fatalf("buffered frames leaked into the task view before naming it: %+v", snap)
	}
	s.SetTaskID("t1")
	snap := s.Snapshot()
	if !snap.HasTask || snap.EventCount != 2 {
		t.Fatalf("replay lost frames: hasTask=%t events=%d", snap.HasTask, snap.EventCount)
	}
	if len(snap.Gaps) != 0 || snap.TaskFrames != 3 {
		t.Fatalf("replay gaps=%v taskFrames=%d", snap.Gaps, snap.TaskFrames)
	}
}

func TestLiveStateApprovalFrame(t *testing.T) {
	s := NewLiveState("t1")
	s.ApplyFrame(frame("approval_update", Approval{ID: "a1", TaskID: "t1", Decision: "pending"}))
	s.ApplyFrame(frame("approval_update", Approval{ID: "other", TaskID: "t2", Decision: "pending"}))
	snap := s.Snapshot()
	if len(snap.ApprovalIDs) != 1 || snap.ApprovalIDs[0] != "a1" {
		t.Fatalf("approval ids = %v, want only a1", snap.ApprovalIDs)
	}
	if snap.Approvals["a1"].Decision != "pending" || snap.TaskFrames != 1 {
		t.Fatalf("approval = %+v taskFrames=%d", snap.Approvals["a1"], snap.TaskFrames)
	}
}

func TestMatchTask(t *testing.T) {
	base := Task{ID: "t1", Status: "succeeded", EventEpoch: 1, HubSeq: ptr(int64(9))}
	with := func(change func(*Task)) Task {
		out := base
		change(&out)
		return out
	}
	cases := []struct {
		name     string
		feed     Task
		resource Task
		wantErr  bool
	}{
		{name: "equal", feed: base, resource: base},
		{name: "absent from feed", feed: Task{}, resource: base, wantErr: true},
		{name: "id mismatch", feed: with(func(t *Task) { t.ID = "t2" }), resource: base, wantErr: true},
		{name: "status mismatch", feed: with(func(t *Task) { t.Status = "queued" }), resource: base, wantErr: true},
		{name: "epoch mismatch", feed: with(func(t *Task) { t.EventEpoch = 2 }), resource: base, wantErr: true},
		{name: "hub_seq mismatch", feed: with(func(t *Task) { t.HubSeq = ptr(int64(10)) }), resource: base, wantErr: true},
		{name: "both hub_seq absent", feed: with(func(t *Task) { t.HubSeq = nil }), resource: with(func(t *Task) { t.HubSeq = nil })},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := matchTask(tc.feed, tc.resource)
			if (err != nil) != tc.wantErr {
				t.Fatalf("matchTask() error = %v, wantErr %t", err, tc.wantErr)
			}
		})
	}
}

func TestCheckContiguous(t *testing.T) {
	events := func(pairs ...int64) []TaskEvent {
		out := make([]TaskEvent, 0, len(pairs)/2)
		for i := 0; i < len(pairs); i += 2 {
			out = append(out, TaskEvent{EventEpoch: pairs[i], Seq: pairs[i+1]})
		}
		return out
	}
	cases := []struct {
		name    string
		events  []TaskEvent
		wantErr bool
	}{
		{name: "contiguous", events: events(0, 1, 0, 2, 0, 3)},
		{name: "gap", events: events(0, 1, 0, 3), wantErr: true},
		{name: "duplicate", events: events(0, 1, 0, 1), wantErr: true},
		{name: "starts above one", events: events(0, 2, 0, 3), wantErr: true},
		{name: "mixed epochs", events: events(0, 1, 1, 2), wantErr: true},
		{name: "empty", events: nil, wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := checkContiguous(tc.events)
			if (err != nil) != tc.wantErr {
				t.Fatalf("checkContiguous() error = %v, wantErr %t", err, tc.wantErr)
			}
		})
	}
}

func TestCheckSubset(t *testing.T) {
	durable := []TaskEvent{
		{EventEpoch: 0, Seq: 1, Type: "message"},
		{EventEpoch: 0, Seq: 2, Type: "result"},
	}
	key := EventKey{Epoch: 0, Seq: 1}
	good := LiveSnapshot{
		Order:  []EventKey{key},
		Events: map[EventKey]TaskEvent{key: {EventEpoch: 0, Seq: 1, Type: "message"}},
	}
	if err := checkSubset(good, durable); err != nil {
		t.Fatalf("matching subset: %v", err)
	}

	missing := good
	missing.Order = append(append([]EventKey(nil), good.Order...), EventKey{Epoch: 0, Seq: 3})
	missing.Events = map[EventKey]TaskEvent{key: {EventEpoch: 0, Seq: 1, Type: "message"}, {Epoch: 0, Seq: 3}: {EventEpoch: 0, Seq: 3, Type: "message"}}
	if err := checkSubset(missing, durable); err == nil {
		t.Fatal("streamed event absent from durable was accepted")
	}

	wrongType := good
	wrongType.Events = map[EventKey]TaskEvent{key: {EventEpoch: 0, Seq: 1, Type: "result"}}
	if err := checkSubset(wrongType, durable); err == nil {
		t.Fatal("streamed event type mismatch was accepted")
	}

	gapped := good
	gapped.Gaps = []string{"seq 3..4 missing"}
	if err := checkSubset(gapped, durable); err == nil {
		t.Fatal("live seq gap was accepted")
	}
}

func TestCancelTask(t *testing.T) {
	f := newFakeDaemon(t, "pending")
	srv := f.start()
	defer srv.Close()
	ctx := context.Background()
	client := NewClient(srv.URL, fakeDeviceToken)
	task, err := client.CreateTask(ctx, CreateTaskRequest{Cwd: "/tmp", Prompt: "Use echo now"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	got, err := client.CancelTask(ctx, task.ID)
	if err != nil {
		t.Fatalf("cancel: %v", err)
	}
	if got.Status != "canceled" {
		t.Fatalf("cancel status = %q, want canceled", got.Status)
	}
}

func TestPairingRecovery(t *testing.T) {
	f := newFakeDaemon(t, "none")
	srv := f.start()
	defer srv.Close()
	ctx := context.Background()
	master := NewClient(srv.URL, fakeMasterToken)
	session, err := master.CreatePairingSession(ctx, "probe-w4b-recovery")
	if err != nil {
		t.Fatalf("create pairing session: %v", err)
	}
	first, err := master.ExchangePairingSecret(ctx, session.Secret, "probe-w4b-recovery")
	if err != nil {
		t.Fatalf("first exchange: %v", err)
	}
	if _, err := master.ExchangePairingSecret(ctx, session.Secret, "probe-w4b-recovery"); !isStatus(err, 401) {
		t.Fatalf("replayed exchange error = %v, want 401", err)
	}
	recovered, err := master.ExchangePairingSecretRecovery(ctx, session.Secret, "probe-w4b-recovery")
	if err != nil {
		t.Fatalf("recovery exchange: %v", err)
	}
	if recovered.DeviceID != first.DeviceID || recovered.Token != first.Token {
		t.Fatalf("recovery returned a different credential: %+v vs %+v", recovered, first)
	}
}

func TestCleanupRecoversDeviceByLabel(t *testing.T) {
	f := newFakeDaemon(t, "none")
	srv := f.start()
	defer srv.Close()
	ctx := context.Background()
	master := NewClient(srv.URL, fakeMasterToken)
	session, err := master.CreatePairingSession(ctx, "probe-w4b-labelled")
	if err != nil {
		t.Fatalf("create pairing session: %v", err)
	}
	if _, err := master.ExchangePairingSecret(ctx, session.Secret, "probe-w4b-labelled"); err != nil {
		t.Fatalf("exchange: %v", err)
	}
	out := &Outcome{}
	status, detail := cleanup(ctx, out, master, nil, "", "", "probe-w4b-labelled", NewFeedState(), t.Logf)
	if status != statusPass {
		t.Fatalf("cleanup = %s (%s)", status, detail)
	}
	f.mu.Lock()
	revoked := f.revoked
	f.mu.Unlock()
	if !revoked {
		t.Fatal("device recovered by label was not revoked")
	}
}

func TestRunAcceptanceFailsWhenApprovalListUnreadable(t *testing.T) {
	out, _ := runFakeAcceptanceWith(t, "none", func(f *fakeDaemon) { f.breakApprovals = true })
	step := stepByName(t, out, "5 approval")
	if step.Status != statusFail {
		t.Fatalf("approval step = %s (%s), want fail", step.Status, step.Detail)
	}
	if !strings.Contains(step.Detail, "could not be read") {
		t.Fatalf("failure does not name the unreadable list: %s", step.Detail)
	}
}

func TestRunAcceptanceFailsOnFeedDrift(t *testing.T) {
	out, _ := runFakeAcceptanceWith(t, "pending", func(f *fakeDaemon) { f.corruptFeedStatus = true })
	step := stepByName(t, out, "6 catch-up")
	if step.Status != statusFail {
		t.Fatalf("catch-up step = %s (%s), want fail", step.Status, step.Detail)
	}
	if !strings.Contains(step.Detail, "disagree") {
		t.Fatalf("failure does not name the disagreement: %s", step.Detail)
	}
}

func TestRunAcceptanceFailsOnDurableTypeDrift(t *testing.T) {
	out, _ := runFakeAcceptanceWith(t, "pending", func(f *fakeDaemon) { f.mangleDurableType = "result" })
	step := stepByName(t, out, "6 catch-up")
	if step.Status != statusFail {
		t.Fatalf("catch-up step = %s (%s), want fail", step.Status, step.Detail)
	}
	if !strings.Contains(step.Detail, "subset") {
		t.Fatalf("failure does not name the stream/log mismatch: %s", step.Detail)
	}
}

func TestRunAcceptanceFailsOnStreamError(t *testing.T) {
	out, _ := runFakeAcceptanceWith(t, "pending", func(f *fakeDaemon) { f.breakStream = true })
	step := stepByName(t, out, "3 live events")
	if step.Status != statusFail {
		t.Fatalf("live-events step = %s (%s), want fail", step.Status, step.Detail)
	}
}

func TestRunAcceptanceFailsWithoutTaskUpdate(t *testing.T) {
	out, _ := runFakeAcceptanceWith(t, "pending", func(f *fakeDaemon) { f.suppressTaskUpdate = true })
	step := stepByName(t, out, "3 live events")
	if step.Status != statusFail {
		t.Fatalf("live-events step = %s (%s), want fail", step.Status, step.Detail)
	}
	if !strings.Contains(step.Detail, "task_update") {
		t.Fatalf("failure does not name the missing frame: %s", step.Detail)
	}
}

func TestRunAcceptanceFailsWhenApprovalRequestedButNoRow(t *testing.T) {
	out, _ := runFakeAcceptanceWith(t, "none", func(f *fakeDaemon) { f.requestedWithoutRow = true })
	step := stepByName(t, out, "5 approval")
	if step.Status != statusFail {
		t.Fatalf("approval step = %s (%s), want fail", step.Status, step.Detail)
	}
	if !strings.Contains(step.Detail, "approval_requested") {
		t.Fatalf("failure does not name the durable evidence: %s", step.Detail)
	}
}

func TestRunAcceptanceCleanupFailsOnDeleteError(t *testing.T) {
	out, _ := runFakeAcceptanceWith(t, "pending", func(f *fakeDaemon) { f.failDelete = true })
	step := stepByName(t, out, "cleanup")
	if step.Status != statusFail {
		t.Fatalf("cleanup = %s (%s), want fail", step.Status, step.Detail)
	}
	if !strings.Contains(step.Detail, "delete session") {
		t.Fatalf("cleanup failure does not name the delete: %s", step.Detail)
	}
}

func TestRunAcceptanceCleanupFailsOnRevokeError(t *testing.T) {
	out, _ := runFakeAcceptanceWith(t, "pending", func(f *fakeDaemon) { f.failRevoke = true })
	step := stepByName(t, out, "cleanup")
	if step.Status != statusFail {
		t.Fatalf("cleanup = %s (%s), want fail", step.Status, step.Detail)
	}
	if !strings.Contains(step.Detail, "revoke device") {
		t.Fatalf("cleanup failure does not name the revoke: %s", step.Detail)
	}
}
