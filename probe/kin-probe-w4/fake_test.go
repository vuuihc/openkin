package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	testMasterToken = "master-token"
	testDeviceToken = "device-token"
	testDeviceID    = "device-1"
)

// fakeDaemon implements the documented P0 surface just far enough to drive the
// probe end to end. It is deliberately a stub: the acceptance run is what talks
// to the real daemon.
type fakeDaemon struct {
	t            *testing.T
	withApproval bool
	pageSize     int

	// Failure modes used by the negative tests.
	stuckCursor            bool // feed reports has_more with a non-advancing cursor
	suppressReconnectFrame bool // archive changes the row but emits no frame
	userEchoOnly           bool // the turn only echoes the prompt, with no assistant text
	splitEcho              bool // the prompt echo is split across two text fragments
	markerDurableOnly      bool // the marker is durable but never sent live
	echoDurableOnly        bool // the prompt echo is durable but never sent live
	ignoreDecision         bool // the decision endpoint returns the row unchanged
	approvalListFails      bool // GET /api/approvals always fails
	deleteFailures         int  // DELETE /api/tasks/{id} fails this many times

	mu          sync.Mutex
	cursor      int64
	tasks       map[string]*Task
	order       []string
	events      map[string][]TaskEvent
	approvals   map[string]*Approval
	tombstones  map[string]int64
	subs        map[chan SSEEvent]struct{}
	approvalCh  chan struct{}
	approveOnce sync.Once
	limits      []int
	prompts     []string
	requests    []string
	cancelCalls int
	deletes     int
	revokes     int

	server *httptest.Server
}

type feedEntry struct {
	pos     int64
	id      string
	deleted bool
}

func newFakeDaemon(t *testing.T, withApproval bool) *fakeDaemon {
	f := &fakeDaemon{
		t:            t,
		withApproval: withApproval,
		pageSize:     2,
		tasks:        map[string]*Task{},
		events:       map[string][]TaskEvent{},
		approvals:    map[string]*Approval{},
		tombstones:   map[string]int64{},
		subs:         map[chan SSEEvent]struct{}{},
		approvalCh:   make(chan struct{}),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "bus_overflow": 0})
	})
	mux.HandleFunc("GET /api/auth/status", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, AuthStatus{})
	})
	mux.HandleFunc("POST /api/pairing/sessions", func(w http.ResponseWriter, r *http.Request) {
		if !f.authorized(r, testMasterToken) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "master required"})
			return
		}
		writeJSON(w, http.StatusCreated, PairingSessionResponse{Secret: "pair-secret", ExpiresAt: time.Now().Add(5 * time.Minute).UnixMilli()})
	})
	mux.HandleFunc("POST /api/pairing/exchange", func(w http.ResponseWriter, r *http.Request) {
		var req PairingExchangeRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Secret != "pair-secret" {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "bad secret"})
			return
		}
		writeJSON(w, http.StatusCreated, PairingExchangeResponse{DeviceID: testDeviceID, Token: testDeviceToken, Label: req.Label, DesktopID: "desktop-1", DesktopName: "Test Desktop"})
	})
	mux.HandleFunc("GET /api/sessions/cursor", func(w http.ResponseWriter, r *http.Request) {
		if !f.authorized(r, testDeviceToken) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		f.mu.Lock()
		cursor := f.cursor
		f.mu.Unlock()
		writeJSON(w, http.StatusOK, CursorResponse{Cursor: cursor})
	})
	mux.HandleFunc("GET /api/sessions", func(w http.ResponseWriter, r *http.Request) {
		if !f.authorized(r, testDeviceToken) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		since := int64(0)
		if v := r.URL.Query().Get("updated_since"); v != "" {
			fmt.Sscanf(v, "%d", &since)
		}
		limit := 0
		if v := r.URL.Query().Get("limit"); v != "" {
			fmt.Sscanf(v, "%d", &limit)
		}
		f.mu.Lock()
		f.limits = append(f.limits, limit)
		f.requests = append(f.requests, "feed")
		f.mu.Unlock()
		page := f.feedPage(since)
		writeJSON(w, http.StatusOK, page)
	})
	mux.HandleFunc("GET /api/agents", func(w http.ResponseWriter, r *http.Request) {
		if !f.authorized(r, testDeviceToken) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		writeJSON(w, http.StatusOK, []AgentInfo{{ID: "fake-agent", Name: "Fake", Installed: true, Available: true, Default: true}})
	})
	mux.HandleFunc("POST /api/tasks", func(w http.ResponseWriter, r *http.Request) {
		if !f.authorized(r, testDeviceToken) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		var req CreateTaskRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
			return
		}
		task := f.createTask(req)
		writeJSON(w, http.StatusCreated, task)
		go f.runTurn(task.ID)
	})
	mux.HandleFunc("GET /api/tasks/{taskId}", func(w http.ResponseWriter, r *http.Request) {
		if !f.authorized(r, testDeviceToken) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		f.mu.Lock()
		task, ok := f.tasks[r.PathValue("taskId")]
		var snapshot Task
		if ok {
			snapshot = *task
		}
		f.mu.Unlock()
		if !ok {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
			return
		}
		writeJSON(w, http.StatusOK, snapshot)
	})
	mux.HandleFunc("GET /api/tasks/{taskId}/events", func(w http.ResponseWriter, r *http.Request) {
		if !f.authorized(r, testDeviceToken) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		since := int64(0)
		if v := r.URL.Query().Get("since_seq"); v != "" {
			fmt.Sscanf(v, "%d", &since)
		}
		f.mu.Lock()
		out := []TaskEvent{}
		for _, ev := range f.events[r.PathValue("taskId")] {
			if ev.Seq > since {
				out = append(out, ev)
			}
		}
		f.mu.Unlock()
		writeJSON(w, http.StatusOK, out)
	})
	mux.HandleFunc("POST /api/tasks/{taskId}/archive", func(w http.ResponseWriter, r *http.Request) {
		f.setArchived(w, r, true)
	})
	mux.HandleFunc("POST /api/tasks/{taskId}/unarchive", func(w http.ResponseWriter, r *http.Request) {
		f.setArchived(w, r, false)
	})
	mux.HandleFunc("POST /api/tasks/{taskId}/cancel", func(w http.ResponseWriter, r *http.Request) {
		if !f.authorized(r, testMasterToken) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "operator only"})
			return
		}
		f.mu.Lock()
		f.cancelCalls++
		if task, ok := f.tasks[r.PathValue("taskId")]; ok {
			task.Status = "cancelled"
			task.FinishedAt = time.Now().UnixMilli()
			f.bumpLocked(task)
		}
		f.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("DELETE /api/tasks/{taskId}", func(w http.ResponseWriter, r *http.Request) {
		if !f.authorized(r, testMasterToken) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "operator only"})
			return
		}
		f.mu.Lock()
		f.deletes++
		if f.deleteFailures > 0 {
			f.deleteFailures--
			f.mu.Unlock()
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "still running"})
			return
		}
		id := r.PathValue("taskId")
		if _, ok := f.tasks[id]; ok {
			delete(f.tasks, id)
			f.cursor++
			f.tombstones[id] = f.cursor
		}
		f.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("POST /api/devices/{deviceId}/revoke", func(w http.ResponseWriter, r *http.Request) {
		if !f.authorized(r, testMasterToken) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "operator only"})
			return
		}
		f.mu.Lock()
		f.revokes++
		f.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("GET /api/approvals", func(w http.ResponseWriter, r *http.Request) {
		if !f.authorized(r, testDeviceToken) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		if f.approvalListFails {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "approval store unavailable"})
			return
		}
		f.mu.Lock()
		out := []Approval{}
		for _, approval := range f.approvals {
			out = append(out, *approval)
		}
		f.mu.Unlock()
		writeJSON(w, http.StatusOK, out)
	})
	mux.HandleFunc("POST /api/approvals/{approvalId}/decision", func(w http.ResponseWriter, r *http.Request) {
		if !f.authorized(r, testDeviceToken) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		var req ApprovalDecisionRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
			return
		}
		f.mu.Lock()
		approval, ok := f.approvals[r.PathValue("approvalId")]
		if ok && !f.ignoreDecision {
			approval.Decision = req.Decision
			approval.DecidedAt = time.Now().UnixMilli()
		}
		var snapshot Approval
		if ok {
			snapshot = *approval
		}
		f.mu.Unlock()
		if !ok {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
			return
		}
		f.emit("approval_update", snapshot)
		f.approveOnce.Do(func() { close(f.approvalCh) })
		writeJSON(w, http.StatusOK, snapshot)
	})
	mux.HandleFunc("GET /api/events", f.handleSSE)

	f.server = httptest.NewServer(mux)
	t.Cleanup(f.server.Close)
	return f
}

func (f *fakeDaemon) seed(n int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := 0; i < n; i++ {
		id := fmt.Sprintf("seed-%d", i+1)
		task := &Task{
			ID:         id,
			Title:      id,
			Agent:      "fake-agent",
			Cwd:        "/tmp",
			Prompt:     "seed",
			Status:     "completed",
			EventEpoch: 1,
			CreatedAt:  time.Now().UnixMilli(),
			FinishedAt: time.Now().UnixMilli(),
		}
		f.tasks[id] = task
		f.order = append(f.order, id)
		f.bumpLocked(task)
	}
}

func (f *fakeDaemon) authorized(r *http.Request, want string) bool {
	if r.URL.Query().Get("token") == want {
		return true
	}
	return r.Header.Get("Authorization") == "Bearer "+want
}

func (f *fakeDaemon) handleSSE(w http.ResponseWriter, r *http.Request) {
	if !f.authorized(r, testDeviceToken) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "no flusher", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(http.StatusOK)
	ch := make(chan SSEEvent, 256)
	f.mu.Lock()
	f.subs[ch] = struct{}{}
	f.requests = append(f.requests, "sse")
	f.mu.Unlock()
	defer func() {
		f.mu.Lock()
		delete(f.subs, ch)
		f.requests = append(f.requests, "sse_close")
		f.mu.Unlock()
	}()
	fmt.Fprint(w, ": ping\n\n")
	flusher.Flush()
	for {
		select {
		case <-r.Context().Done():
			return
		case ev := <-ch:
			// Split the frame across writes to exercise the client parser.
			fmt.Fprintf(w, "event: %s\n", ev.Event)
			flusher.Flush()
			fmt.Fprintf(w, "data: %s\n\n", ev.Data)
			flusher.Flush()
		}
	}
}

func (f *fakeDaemon) emit(kind string, data any) {
	raw, err := json.Marshal(data)
	if err != nil {
		f.t.Errorf("emit %s: %v", kind, err)
		return
	}
	msg, err := json.Marshal(WSMessage{Kind: kind, Data: raw})
	if err != nil {
		f.t.Errorf("emit envelope %s: %v", kind, err)
		return
	}
	ev := SSEEvent{Event: kind, Data: msg, At: time.Now()}
	f.mu.Lock()
	defer f.mu.Unlock()
	for ch := range f.subs {
		select {
		case ch <- ev:
		default:
		}
	}
}

func (f *fakeDaemon) createTask(req CreateTaskRequest) Task {
	f.mu.Lock()
	defer f.mu.Unlock()
	id := fmt.Sprintf("task-%d", len(f.order)+1)
	task := &Task{
		ID:             id,
		Title:          req.Title,
		Agent:          req.Agent,
		Cwd:            req.Cwd,
		Prompt:         req.Prompt,
		Status:         "queued",
		EventEpoch:     1,
		PermissionMode: "default",
		CreatedAt:      time.Now().UnixMilli(),
	}
	f.tasks[id] = task
	f.order = append(f.order, id)
	f.prompts = append(f.prompts, req.Prompt)
	f.bumpLocked(task)
	return *task
}

func (f *fakeDaemon) bumpLocked(task *Task) {
	f.cursor++
	seq := f.cursor
	task.HubSeq = &seq
}

func (f *fakeDaemon) addEvent(taskID, typ string, payload map[string]string) {
	f.addEventLive(taskID, typ, payload, true)
}

// addEventLive writes the durable row always and emits it on the bus only when
// live is true, which models a stream that lost a row.
func (f *fakeDaemon) addEventLive(taskID, typ string, payload map[string]string, live bool) {
	f.mu.Lock()
	task, ok := f.tasks[taskID]
	if !ok {
		f.mu.Unlock()
		return
	}
	raw, _ := json.Marshal(payload)
	ev := TaskEvent{
		TaskID:     taskID,
		EventEpoch: task.EventEpoch,
		Seq:        int64(len(f.events[taskID]) + 1),
		Ts:         time.Now().UnixMilli(),
		Type:       typ,
		Payload:    raw,
	}
	f.events[taskID] = append(f.events[taskID], ev)
	f.bumpLocked(task)
	f.mu.Unlock()
	if live {
		f.emit("event", ev)
	}
}

func (f *fakeDaemon) runTurn(taskID string) {
	time.Sleep(20 * time.Millisecond)
	f.mu.Lock()
	task, ok := f.tasks[taskID]
	if !ok {
		f.mu.Unlock()
		return
	}
	task.Status = "running"
	task.StartedAt = time.Now().UnixMilli()
	f.bumpLocked(task)
	prompt := task.Prompt
	snapshot := *task
	f.mu.Unlock()
	f.emit("task_update", snapshot)

	// The daemon writes the prompt back as a user event. It contains the reply
	// marker, so it must never satisfy the assistant-text check.
	if f.splitEcho {
		split := strings.Index(prompt, w4Marker)
		if split <= 0 {
			split = len(prompt) / 2
		}
		f.addEventLive(taskID, "user_message", map[string]string{"delta": prompt[:split]}, true)
		f.addEventLive(taskID, "user_message", map[string]string{"delta": prompt[split:]}, true)
	} else {
		f.addEventLive(taskID, "user_message", map[string]string{"content": prompt}, !f.echoDurableOnly)
	}

	if f.markerDurableOnly {
		f.addEventLive(taskID, "assistant_delta", map[string]string{"delta": "partial "}, true)
		f.addEventLive(taskID, "assistant_delta", map[string]string{"delta": w4Marker}, false)
	} else if !f.userEchoOnly && !f.splitEcho {
		f.addEvent(taskID, "assistant_delta", map[string]string{"delta": "probe-w4-"})
		time.Sleep(20 * time.Millisecond)
		f.addEvent(taskID, "assistant_delta", map[string]string{"delta": "ok"})
	}

	if f.withApproval {
		approval := &Approval{ID: "approval-1", TaskID: taskID, Kind: "permission", Payload: json.RawMessage(`{"tool":"Bash"}`), CreatedAt: time.Now().UnixMilli()}
		f.mu.Lock()
		f.approvals[approval.ID] = approval
		f.mu.Unlock()
		f.emit("approval_update", *approval)
		select {
		case <-f.approvalCh:
		case <-time.After(3 * time.Second):
		}
		time.Sleep(20 * time.Millisecond)
	}

	f.mu.Lock()
	task, ok = f.tasks[taskID]
	if !ok {
		f.mu.Unlock()
		return
	}
	task.Status = "completed"
	task.FinishedAt = time.Now().UnixMilli()
	f.bumpLocked(task)
	snapshot = *task
	f.mu.Unlock()
	f.emit("task_update", snapshot)
}

func (f *fakeDaemon) setArchived(w http.ResponseWriter, r *http.Request, archived bool) {
	if !f.authorized(r, testDeviceToken) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	f.mu.Lock()
	task, ok := f.tasks[r.PathValue("taskId")]
	if ok {
		if archived {
			task.ArchivedAt = time.Now().UnixMilli()
		} else {
			task.ArchivedAt = 0
		}
		f.bumpLocked(task)
	}
	var snapshot Task
	if ok {
		snapshot = *task
	}
	suppress := f.suppressReconnectFrame && archived
	f.mu.Unlock()
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if !suppress {
		f.emit("task_update", snapshot)
	}
	writeJSON(w, http.StatusOK, snapshot)
}

// feedPage returns the distinct tasks whose latest row change is after since,
// ordered by that change, plus tombstones, cut to pageSize.
func (f *fakeDaemon) feedPage(since int64) SessionChangePage {
	f.mu.Lock()
	defer f.mu.Unlock()
	entries := []feedEntry{}
	for id, task := range f.tasks {
		if task.HubSeq != nil && *task.HubSeq > since {
			entries = append(entries, feedEntry{pos: *task.HubSeq, id: id})
		}
	}
	for id, pos := range f.tombstones {
		if pos > since {
			entries = append(entries, feedEntry{pos: pos, id: id, deleted: true})
		}
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].pos == entries[j].pos {
			return entries[i].id < entries[j].id
		}
		return entries[i].pos < entries[j].pos
	})
	page := SessionChangePage{Sessions: []Task{}, Deleted: []string{}, NextCursor: since}
	if len(entries) == 0 {
		return page
	}
	limit := f.pageSize
	if limit <= 0 {
		limit = len(entries)
	}
	if limit > len(entries) {
		limit = len(entries)
	}
	for _, entry := range entries[:limit] {
		if entry.deleted {
			page.Deleted = append(page.Deleted, entry.id)
		} else {
			page.Sessions = append(page.Sessions, *f.tasks[entry.id])
		}
		page.NextCursor = entry.pos
	}
	page.HasMore = len(entries) > limit
	if f.stuckCursor {
		// A broken feed: there is more, but the cursor never advances.
		page.NextCursor = since
		page.HasMore = true
	}
	return page
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func (f *fakeDaemon) requestLog() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.requests...)
}
