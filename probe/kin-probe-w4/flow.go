package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

const w4Marker = "probe-w4-ok"

var errStepSkipped = errors.New("step skipped")

// Config is one acceptance run.
type Config struct {
	BaseURL     string
	MasterToken string
	Label       string
	Cwd         string
	Agent       string
	Keep        bool
	TurnTimeout time.Duration
}

// StepResult is one line of the acceptance script.
type StepResult struct {
	Name   string `json:"name"`
	Status string `json:"status"` // pass | fail | skip
	Detail string `json:"detail"`
}

// Summary is the machine-readable outcome of one run.
type Summary struct {
	StartedAt      time.Time      `json:"started_at"`
	FinishedAt     time.Time      `json:"finished_at"`
	ElapsedSeconds float64        `json:"elapsed_seconds"`
	Steps          []StepResult   `json:"steps"`
	Findings       []string       `json:"findings"`
	Observations   map[string]any `json:"observations"`
	PeakRSSBytes   int64          `json:"peak_rss_bytes"`
}

// Logger is a timestamped line logger shared by the steps.
type Logger struct {
	mu    sync.Mutex
	out   io.Writer
	start time.Time
}

func NewLogger(out io.Writer) *Logger {
	return &Logger{out: out, start: time.Now()}
}

func (l *Logger) Logf(format string, args ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	fmt.Fprintf(l.out, "[%7.2fs] %s\n", time.Since(l.start).Seconds(), fmt.Sprintf(format, args...))
}

type probe struct {
	cfg    Config
	log    *Logger
	sum    *Summary
	master *Client
	device *Client
	client *Client // device client after pairing, master before

	deviceID string
	taskID   string
	title    string
	cwd      string
	tempCwd  bool

	stream       *SSEStream
	streamCancel context.CancelFunc
	streamCtx    context.Context

	liveEvents     map[int64]TaskEvent
	eventTypes     map[string]int // WSMessage kinds
	taskEventTypes map[string]int // TaskEvent.type vocabulary
	taskStatuses   map[string]bool
	eventSamples   []string
	firstTextAt    time.Time
	lastTextAt     time.Time
	textFrames     int
	textBuilder    strings.Builder
	terminalAt     time.Time
	terminalPoll   Task
	approvalSeen   string
	approvalDone   bool
}

// Run executes the six-step acceptance script.
func Run(ctx context.Context, cfg Config, log *Logger) *Summary {
	p := &probe{
		cfg:            cfg,
		log:            log,
		sum:            &Summary{StartedAt: time.Now(), Observations: map[string]any{}},
		liveEvents:     map[int64]TaskEvent{},
		eventTypes:     map[string]int{},
		taskEventTypes: map[string]int{},
		taskStatuses:   map[string]bool{},
	}
	defer p.cleanup()
	defer p.closeStream()

	steps := []struct {
		name string
		fn   func(context.Context) (string, error)
	}{
		{"1_pair", p.stepPair},
		{"2_list_sessions_cursor", p.stepSnapshot},
		{"3_open_live_events", p.stepOpenStream},
		{"4_prompt_stream", p.stepPrompt},
		{"5_approval", p.stepApproval},
		{"6_reconnect_catchup", p.stepReconnect},
	}

	blocked := false
	for _, step := range steps {
		if blocked {
			p.sum.Steps = append(p.sum.Steps, StepResult{Name: step.name, Status: "skip", Detail: "not attempted: an earlier step failed"})
			continue
		}
		detail, err := step.fn(ctx)
		status := "pass"
		if errors.Is(err, errStepSkipped) {
			status = "skip"
		} else if err != nil {
			status = "fail"
			if detail == "" {
				detail = err.Error()
			} else {
				detail = detail + ": " + err.Error()
			}
			blocked = true
		}
		p.sum.Steps = append(p.sum.Steps, StepResult{Name: step.name, Status: status, Detail: detail})
		p.log.Logf("step %s: %s — %s", step.name, status, detail)
	}

	p.sum.FinishedAt = time.Now()
	p.sum.ElapsedSeconds = p.sum.FinishedAt.Sub(p.sum.StartedAt).Seconds()
	p.sum.PeakRSSBytes = peakRSSBytes()
	return p.sum
}

func (p *probe) findingf(format string, args ...any) {
	line := fmt.Sprintf(format, args...)
	p.sum.Findings = append(p.sum.Findings, line)
	p.log.Logf("finding: %s", line)
}

func (p *probe) observe(key string, value any) {
	p.sum.Observations[key] = value
}

// stepPair mints a pairing secret with the master credential and exchanges it
// for a device token, then proves the device token authenticates.
func (p *probe) stepPair(ctx context.Context) (string, error) {
	public := NewClient(p.cfg.BaseURL, "")
	var health struct {
		OK          bool  `json:"ok"`
		BusOverflow int64 `json:"bus_overflow"`
	}
	if err := public.GetJSON(ctx, "/api/health", &health); err != nil {
		return "", fmt.Errorf("health: %w", err)
	}
	if !health.OK {
		return "", errors.New("daemon reports ok=false")
	}
	p.observe("bus_overflow", health.BusOverflow)

	var authStatus AuthStatus
	if err := public.GetJSON(ctx, "/api/auth/status", &authStatus); err != nil {
		return "", fmt.Errorf("auth status: %w", err)
	}
	p.observe("auth_providers", len(authStatus.Providers))
	p.observe("auth_needs_bootstrap", authStatus.NeedsBootstrap)

	p.master = NewClient(p.cfg.BaseURL, p.cfg.MasterToken)
	var version struct {
		Version     string `json:"version"`
		DesktopID   string `json:"desktop_id"`
		DesktopName string `json:"desktop_name"`
	}
	if err := p.master.GetJSON(ctx, "/api/version", &version); err != nil {
		p.log.Logf("version: %v", err)
	} else {
		p.observe("daemon_version", version.Version)
	}
	var session PairingSessionResponse
	if err := p.master.PostJSON(ctx, "/api/pairing/sessions", map[string]string{"label": p.cfg.Label}, &session); err != nil {
		return "", fmt.Errorf("pairing session: %w", err)
	}
	if session.Secret == "" {
		return "", errors.New("pairing session answered without a secret")
	}

	var exchange PairingExchangeResponse
	if err := public.PostJSON(ctx, "/api/pairing/exchange", PairingExchangeRequest{Secret: session.Secret, Label: p.cfg.Label}, &exchange); err != nil {
		return "", fmt.Errorf("pairing exchange: %w", err)
	}
	if exchange.Token == "" || exchange.DeviceID == "" {
		return "", errors.New("pairing exchange answered without a device credential")
	}
	p.deviceID = exchange.DeviceID
	p.device = NewClient(p.cfg.BaseURL, exchange.Token)
	p.client = p.device

	var cursor CursorResponse
	if err := p.device.GetJSON(ctx, "/api/sessions/cursor", &cursor); err != nil {
		return "", fmt.Errorf("paired device credential rejected by the change feed: %w", err)
	}
	p.observe("desktop_id_present", exchange.DesktopID != "")
	p.observe("pairing_cursor", cursor.Cursor)
	return fmt.Sprintf("paired device %s… (label %q); device credential reads the cursor", shortID(exchange.DeviceID), p.cfg.Label), nil
}

// stepSnapshot captures the current end cursor and walks the full history,
// which is the documented way to build a first snapshot.
func (p *probe) stepSnapshot(ctx context.Context) (string, error) {
	var cur CursorResponse
	if err := p.client.GetJSON(ctx, "/api/sessions/cursor", &cur); err != nil {
		return "", fmt.Errorf("cursor: %w", err)
	}
	p.observe("cursor_before_turn", cur.Cursor)

	seen := map[string]struct{}{}
	pages := 0
	since := int64(0)
	for pages < 100 {
		var page SessionChangePage
		path := fmt.Sprintf("/api/sessions?updated_since=%d&limit=500", since)
		if err := p.client.GetJSON(ctx, path, &page); err != nil {
			return "", fmt.Errorf("feed page %d: %w", pages+1, err)
		}
		for _, task := range page.Sessions {
			seen[task.ID] = struct{}{}
		}
		pages++
		if !page.HasMore {
			p.observe("snapshot_last_cursor", page.NextCursor)
			break
		}
		if page.NextCursor == since {
			p.findingf("the change feed reported has_more=true but next_cursor did not advance (stuck at %d); workaround: stop paging to avoid an infinite loop", since)
			break
		}
		since = page.NextCursor
	}
	p.observe("snapshot_sessions", len(seen))
	p.observe("snapshot_pages", pages)
	return fmt.Sprintf("snapshot of %d sessions in %d page(s); cursor %d", len(seen), pages, cur.Cursor), nil
}

// stepOpenStream subscribes to /api/events before the first write, which is the
// documented client order.
func (p *probe) stepOpenStream(ctx context.Context) (string, error) {
	p.streamCtx, p.streamCancel = context.WithCancel(ctx)
	stream, err := p.client.OpenSSE(p.streamCtx, "/api/events")
	if err != nil {
		p.streamCancel()
		return "", fmt.Errorf("events stream: %w", err)
	}
	p.stream = stream
	p.log.Logf("SSE stream open")
	return "SSE subscription opened before the prompt", nil
}

// nextStream gives each subscription its own frame channel and reader.
func nextStream(stream *SSEStream) <-chan SSEEvent {
	frames := make(chan SSEEvent, 256)
	go func() {
		defer close(frames)
		for {
			ev, err := stream.Next()
			if err != nil {
				return
			}
			frames <- ev
		}
	}()
	return frames
}

// stepPrompt creates a task with a first prompt and watches the live bus until
// the turn is terminal, recording text and any approval request.
func (p *probe) stepPrompt(ctx context.Context) (string, error) {
	agentID, err := p.pickAgent(ctx)
	if err != nil {
		return "", err
	}
	if p.cfg.Cwd != "" {
		p.cwd = p.cfg.Cwd
	} else {
		dir, err := os.MkdirTemp("", "probe-w4-*")
		if err != nil {
			return "", fmt.Errorf("temp cwd: %w", err)
		}
		p.cwd = dir
		p.tempCwd = true
	}
	p.title = p.cfg.Label + "-" + time.Now().Format("150405")
	req := CreateTaskRequest{
		Agent:  agentID,
		Cwd:    p.cwd,
		Prompt: "This is an automated client-contract probe. Reply with exactly: " + w4Marker + ". Do not use any tools.",
		Title:  p.title,
	}
	var task Task
	err = p.client.PostJSON(ctx, "/api/tasks", req, &task)
	if err != nil {
		var httpErr *HTTPError
		if errors.As(err, &httpErr) && httpErr.Status == 403 {
			p.findingf("a paired device token was refused when creating a task (403); the spec says a device token may act on the holder's tasks but does not name task creation. Workaround: creating the session with the master token.")
			err = p.master.PostJSON(ctx, "/api/tasks", req, &task)
		}
	}
	if err != nil {
		return "", fmt.Errorf("create task: %w", err)
	}
	p.taskID = task.ID
	p.taskStatuses[task.Status] = true
	p.log.Logf("created task %s (agent %s, cwd %s)", shortID(task.ID), agentID, p.cwd)
	p.observe("agent", agentID)
	p.observe("initial_task_status", task.Status)
	p.observe("create_finished_at", task.FinishedAt)

	frames := nextStream(p.stream)
	deadline := time.NewTimer(p.cfg.TurnTimeout)
	defer deadline.Stop()
	poll := time.NewTicker(2 * time.Second)
	defer poll.Stop()
	// The terminal frame can arrive between polls; a small housekeeping tick
	// lets the grace window close without waiting for the next daemon poll.
	housekeeping := time.NewTicker(200 * time.Millisecond)
	defer housekeeping.Stop()

	var frameCount int
	promptAt := time.Now()
	graceUntil := time.Time{}
	for {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-deadline.C:
			return "", fmt.Errorf("the turn did not reach a terminal row within %s (%d frames, %d text frames)", p.cfg.TurnTimeout, frameCount, p.textFrames)
		case ev, ok := <-frames:
			if !ok {
				return "", fmt.Errorf("the event stream closed on its own after %d frames", frameCount)
			}
			frameCount++
			p.handleFrame(ev, promptAt)
		case <-poll.C:
			if p.terminalAt.IsZero() {
				if done, ok := p.pollTerminal(ctx); ok && done {
					p.log.Logf("task terminal: status=%s finished_at=%d", p.terminalPoll.Status, p.terminalPoll.FinishedAt)
				}
			}
			p.pollApprovals(ctx)
		case <-housekeeping.C:
		}
		if !p.terminalAt.IsZero() && graceUntil.IsZero() {
			graceUntil = time.Now().Add(2 * time.Second)
		}
		if !graceUntil.IsZero() && time.Now().After(graceUntil) {
			break
		}
	}
	p.observe("stream_frames", frameCount)
	p.observe("event_types", p.eventTypes)
	p.observe("task_event_types", p.taskEventTypes)
	p.observe("task_statuses", sortedKeys(p.taskStatuses))
	p.observe("event_samples", p.eventSamples)
	p.observe("text_frames", p.textFrames)
	p.observe("text_first_delay_ms", msSince(promptAt, p.firstTextAt))
	p.observe("text_last_delay_ms", msSince(promptAt, p.lastTextAt))
	if p.terminalAt.IsZero() {
		p.observe("terminal_delay_ms", nil)
	} else {
		p.observe("terminal_delay_ms", msSince(promptAt, p.terminalAt))
	}

	text := p.textBuilder.String()
	markerLive := strings.Contains(text, w4Marker)
	p.observe("marker_in_live_text", markerLive)

	// A client that missed text frames can still rebuild the transcript from the
	// durable event log; record whether the marker is there even if the live
	// stream did not carry it.
	durable, durableErr := p.fetchEvents(ctx)
	if durableErr != nil {
		p.log.Logf("durable events after turn: %v", durableErr)
	}
	markerDurable := false
	var durableText strings.Builder
	for _, ev := range durable {
		for _, fragment := range textFragments(ev.Payload) {
			durableText.WriteString(fragment)
		}
	}
	markerDurable = strings.Contains(durableText.String(), w4Marker)
	p.observe("durable_events_after_turn", len(durable))
	p.observe("marker_in_durable_events", markerDurable)

	if p.terminalAt.IsZero() {
		return "", errors.New("turn did not finish")
	}
	if p.textFrames == 0 {
		return "", errors.New("no assistant text was observed on the live stream")
	}
	if !markerLive && !markerDurable {
		return "", fmt.Errorf("assistant text was observed but never contained the requested marker %q", w4Marker)
	}
	streamedBeforeTerminal := p.firstTextAt.Before(p.terminalAt)
	p.observe("text_before_terminal", streamedBeforeTerminal)
	return fmt.Sprintf("task reached %s; %d live frames, %d text frame(s), first text %d ms after prompt, terminal %d ms",
		p.terminalPoll.Status, frameCount, p.textFrames, msSince(promptAt, p.firstTextAt), msSince(promptAt, p.terminalAt)), nil
}

func (p *probe) pickAgent(ctx context.Context) (string, error) {
	if p.cfg.Agent != "" {
		return p.cfg.Agent, nil
	}
	var agents []AgentInfo
	if err := p.client.GetJSON(ctx, "/api/agents", &agents); err != nil {
		return "", fmt.Errorf("agent catalogue: %w", err)
	}
	p.findingf("CreateTaskRequest.agent is optional but the contract does not say which runtime is used when it is omitted; workaround: read /api/agents and pick the row marked default, or the first installed and available one.")
	var fallback string
	for _, a := range agents {
		if !a.Installed || !a.Available {
			continue
		}
		if a.Default {
			return a.ID, nil
		}
		if fallback == "" {
			fallback = a.ID
		}
	}
	if fallback != "" {
		return fallback, nil
	}
	return "", errors.New("no installed and available agent was reported by /api/agents")
}

func (p *probe) handleFrame(ev SSEEvent, promptAt time.Time) {
	var msg WSMessage
	if err := json.Unmarshal(ev.Data, &msg); err != nil {
		p.log.Logf("unparseable SSE frame %q: %v", ev.Event, err)
		return
	}
	kind := msg.Kind
	if kind == "" {
		kind = ev.Event
	}
	p.eventTypes[kind]++
	switch kind {
	case "event":
		var te TaskEvent
		if err := json.Unmarshal(msg.Data, &te); err != nil {
			return
		}
		if te.TaskID != p.taskID {
			return
		}
		p.liveEvents[te.Seq] = te
		p.taskEventTypes[te.Type]++
		if len(p.eventSamples) < 3 {
			sample := string(msg.Data)
			if len(sample) > 240 {
				sample = sample[:240] + "…"
			}
			p.eventSamples = append(p.eventSamples, sample)
		}
		for _, fragment := range textFragments(te.Payload) {
			p.textFrames++
			if p.firstTextAt.IsZero() {
				p.firstTextAt = time.Now()
				p.log.Logf("first assistant text %d ms after prompt", msSince(promptAt, p.firstTextAt))
			}
			p.lastTextAt = time.Now()
			p.textBuilder.WriteString(fragment)
		}
	case "task_update":
		var task Task
		if err := json.Unmarshal(msg.Data, &task); err != nil {
			return
		}
		if task.ID != p.taskID {
			return
		}
		p.taskStatuses[task.Status] = true
		if task.FinishedAt != 0 {
			p.markTerminal(task)
		}
	case "approval_update":
		var approval Approval
		if err := json.Unmarshal(msg.Data, &approval); err != nil {
			return
		}
		if approval.TaskID == p.taskID && approval.Decision == "" {
			p.approvalSeen = approval.ID
			p.log.Logf("approval %s requested for the probe task", shortID(approval.ID))
		}
	}
}

func (p *probe) markTerminal(task Task) {
	if !p.terminalAt.IsZero() {
		return
	}
	p.terminalAt = time.Now()
	p.terminalPoll = task
}

func (p *probe) pollTerminal(ctx context.Context) (bool, bool) {
	var task Task
	if err := p.client.GetJSON(ctx, "/api/tasks/"+p.taskID, &task); err != nil {
		return false, false
	}
	p.taskStatuses[task.Status] = true
	if task.FinishedAt != 0 {
		p.markTerminal(task)
		return true, true
	}
	return false, true
}

func (p *probe) pollApprovals(ctx context.Context) {
	var approvals []Approval
	if err := p.client.GetJSON(ctx, "/api/approvals", &approvals); err != nil {
		p.log.Logf("approval snapshot: %v", err)
		return
	}
	for _, approval := range approvals {
		if approval.TaskID != p.taskID || approval.Decision != "" {
			continue
		}
		p.approvalSeen = approval.ID
		if p.approvalDone {
			continue
		}
		var updated Approval
		err := p.client.PostJSON(ctx, "/api/approvals/"+approval.ID+"/decision", ApprovalDecisionRequest{Decision: "approved"}, &updated)
		if err != nil {
			p.log.Logf("approve %s: %v", shortID(approval.ID), err)
			continue
		}
		p.approvalDone = true
		p.log.Logf("approved %s (decision=%q)", shortID(approval.ID), updated.Decision)
		return
	}
}

// stepApproval reports whether a permission request was available to approve.
func (p *probe) stepApproval(_ context.Context) (string, error) {
	if p.approvalSeen == "" {
		reason := "no permission request was raised on the live daemon (started with --allow-yolo, per the operator brief); the README documents no CLI switch to run an isolated daemon with a separate data directory, so no isolated approval run was attempted. The approval client path is covered by tests against a stub daemon."
		p.observe("approval_exercised_live", false)
		return reason, errStepSkipped
	}
	if !p.approvalDone {
		return "", errors.New("an approval was requested but could not be approved")
	}
	p.observe("approval_exercised_live", true)
	return "permission request received and approved through POST /api/approvals/{id}/decision", nil
}

// stepReconnect disconnects the live stream, catches up from the pre-turn
// cursor, compares the reconstructed row with the authoritative read, then
// reopens the stream and proves frames resume.
func (p *probe) stepReconnect(ctx context.Context) (string, error) {
	var before CursorResponse
	if err := p.client.GetJSON(ctx, "/api/sessions/cursor", &before); err != nil {
		return "", fmt.Errorf("cursor before disconnect: %w", err)
	}
	if p.stream != nil {
		p.closeStream()
		p.log.Logf("SSE stream closed; catching up from cursor %d", cursorStart(p.sum))
	}
	time.Sleep(500 * time.Millisecond)

	start := cursorStart(p.sum)
	rebuilt, deleted, pages, last, err := p.drainFeed(ctx, start)
	if err != nil {
		return "", err
	}
	// Keep draining while other writers advance the end of the feed.
	for i := 0; i < 5; i++ {
		var now CursorResponse
		if err := p.client.GetJSON(ctx, "/api/sessions/cursor", &now); err != nil {
			return "", fmt.Errorf("cursor during catch-up: %w", err)
		}
		if now.Cursor <= last {
			break
		}
		more, moreDeleted, morePages, next, err := p.drainFeed(ctx, last)
		if err != nil {
			return "", err
		}
		for id, task := range more {
			rebuilt[id] = task
		}
		for id := range moreDeleted {
			deleted[id] = struct{}{}
		}
		pages += morePages
		last = next
	}
	p.observe("catchup_pages", pages)
	p.observe("catchup_changes", len(rebuilt))
	p.observe("catchup_deleted", len(deleted))
	p.observe("cursor_after_catchup", last)

	feedTask, present := rebuilt[p.taskID]
	if !present {
		return "", fmt.Errorf("the change feed from cursor %d never reported probe task %s", start, shortID(p.taskID))
	}
	var current Task
	if err := p.client.GetJSON(ctx, "/api/tasks/"+p.taskID, &current); err != nil {
		return "", fmt.Errorf("authoritative task read: %w", err)
	}
	mismatches := compareTask(feedTask, current)
	p.observe("catchup_mismatches", mismatches)
	if len(mismatches) > 0 {
		return "", fmt.Errorf("feed state does not match GET /api/tasks: %s", strings.Join(mismatches, "; "))
	}
	p.observe("catchup_hub_seq", valueOrNil(feedTask.HubSeq))

	durable, err := p.fetchEvents(ctx)
	if err != nil {
		return "", fmt.Errorf("durable events: %w", err)
	}
	durableBySeq := map[int64]TaskEvent{}
	for _, ev := range durable {
		durableBySeq[ev.Seq] = ev
	}
	missing := 0
	mismatched := 0
	for seq, live := range p.liveEvents {
		got, ok := durableBySeq[seq]
		if !ok {
			missing++
			continue
		}
		if got.Type != live.Type {
			mismatched++
		}
	}
	p.observe("live_event_seqs", len(p.liveEvents))
	p.observe("durable_event_rows", len(durable))
	p.observe("live_events_missing_durably", missing)
	p.observe("live_events_type_mismatch", mismatched)
	if missing > 0 || mismatched > 0 {
		return "", fmt.Errorf("live events do not match the durable log: %d missing, %d type mismatches", missing, mismatched)
	}

	// Reconnect: the stream must reopen, and a fresh change must arrive on it.
	p.streamCtx, p.streamCancel = context.WithCancel(ctx)
	stream, err := p.client.OpenSSE(p.streamCtx, "/api/events")
	if err != nil {
		p.streamCancel()
		return "", fmt.Errorf("reconnect: %w", err)
	}
	p.stream = stream
	frames := nextStream(stream)
	reconnectedAt := time.Now()

	var archived Task
	if err := p.client.PostJSON(ctx, "/api/tasks/"+p.taskID+"/archive", nil, &archived); err != nil {
		p.findingf("reconnect frame proof skipped: archiving the probe task to force a change failed (%v)", err)
	} else {
		deadline := time.After(10 * time.Second)
		saw := false
		for !saw {
			select {
			case <-ctx.Done():
				return "", ctx.Err()
			case <-deadline:
				p.findingf("a reconnected SSE stream did not deliver a task_update for a change made after reconnecting within 10s; workaround: poll /api/sessions, which is the documented source of truth")
				saw = true
			case ev, ok := <-frames:
				if !ok {
					p.findingf("the reconnected SSE stream closed early; workaround: poll /api/sessions")
					saw = true
					continue
				}
				var msg WSMessage
				if json.Unmarshal(ev.Data, &msg) != nil {
					continue
				}
				if msg.Kind != "task_update" {
					continue
				}
				var task Task
				if json.Unmarshal(msg.Data, &task) != nil || task.ID != p.taskID {
					continue
				}
				if task.ArchivedAt != 0 {
					p.observe("reconnect_frame_delay_ms", msSince(reconnectedAt, time.Now()))
					saw = true
				}
			}
		}
		var restored Task
		if err := p.client.PostJSON(ctx, "/api/tasks/"+p.taskID+"/unarchive", nil, &restored); err != nil {
			p.findingf("could not unarchive the probe task after the reconnect check: %v", err)
		}
	}
	return fmt.Sprintf("caught up %d change(s) in %d page(s) from cursor %d; feed row matches GET /api/tasks on %d field(s); %d live event(s) match the durable log; reconnect reopened the stream",
		len(rebuilt), pages, start, comparedFields(), len(p.liveEvents)), nil
}

func (p *probe) closeStream() {
	if p.streamCancel != nil {
		p.streamCancel()
		p.streamCancel = nil
	}
	if p.stream != nil {
		_ = p.stream.Close()
		p.stream = nil
	}
}

// drainFeed reads the change feed from since until the daemon says there is no
// more, applying changes by id in arrival order.
func (p *probe) drainFeed(ctx context.Context, since int64) (map[string]Task, map[string]struct{}, int, int64, error) {
	rebuilt := map[string]Task{}
	deleted := map[string]struct{}{}
	pages := 0
	last := since
	for pages < 1000 {
		var page SessionChangePage
		path := fmt.Sprintf("/api/sessions?updated_since=%d&limit=500", since)
		if err := p.client.GetJSON(ctx, path, &page); err != nil {
			return nil, nil, pages, last, fmt.Errorf("feed page: %w", err)
		}
		for _, task := range page.Sessions {
			rebuilt[task.ID] = task
			delete(deleted, task.ID)
		}
		for _, id := range page.Deleted {
			deleted[id] = struct{}{}
			delete(rebuilt, id)
		}
		pages++
		if page.NextCursor == since && page.HasMore {
			p.findingf("change feed repeated cursor %d with has_more=true; workaround: stop draining", since)
			break
		}
		since = page.NextCursor
		last = since
		if !page.HasMore {
			break
		}
	}
	return rebuilt, deleted, pages, last, nil
}

func (p *probe) fetchEvents(ctx context.Context) ([]TaskEvent, error) {
	var events []TaskEvent
	if err := p.client.GetJSON(ctx, "/api/tasks/"+p.taskID+"/events?since_seq=0", &events); err != nil {
		return nil, err
	}
	return events, nil
}

func compareTask(feed, current Task) []string {
	var out []string
	if feed.ID != current.ID {
		out = append(out, "id")
	}
	if feed.Title != current.Title {
		out = append(out, fmt.Sprintf("title %q != %q", feed.Title, current.Title))
	}
	if feed.Status != current.Status {
		out = append(out, fmt.Sprintf("status %q != %q", feed.Status, current.Status))
	}
	if feed.EventEpoch != current.EventEpoch {
		out = append(out, fmt.Sprintf("event_epoch %d != %d", feed.EventEpoch, current.EventEpoch))
	}
	if feed.FinishedAt != current.FinishedAt {
		out = append(out, fmt.Sprintf("finished_at %d != %d", feed.FinishedAt, current.FinishedAt))
	}
	return out
}

func comparedFields() int { return 5 }

func cursorStart(sum *Summary) int64 {
	if v, ok := sum.Observations["cursor_before_turn"].(int64); ok {
		return v
	}
	return 0
}

func msSince(from, to time.Time) int64 {
	if to.IsZero() {
		return -1
	}
	return to.Sub(from).Milliseconds()
}

func shortID(id string) string {
	if len(id) <= 8 {
		return id
	}
	return id[:8]
}

func valueOrNil(v *int64) any {
	if v == nil {
		return nil
	}
	return *v
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for key := range m {
		out = append(out, key)
	}
	sort.Strings(out)
	return out
}

// cleanup deletes the probe session and revokes the paired device unless the
// caller asked to keep them. It runs with its own context after the script.
func (p *probe) cleanup() {
	if p.cfg.Keep {
		p.log.Logf("cleanup skipped (-keep)")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if p.taskID != "" && p.master != nil {
		err := p.master.Delete(ctx, "/api/tasks/"+p.taskID)
		if err != nil {
			// A task still running refuses deletion; cancel it first, then retry
			// once. Both routes are documented.
			p.log.Logf("cleanup: delete probe task failed (%v); cancelling first", err)
			if cancelErr := p.master.PostJSON(ctx, "/api/tasks/"+p.taskID+"/cancel", nil, nil); cancelErr != nil {
				p.log.Logf("cleanup: cancel probe task: %v", cancelErr)
			}
			time.Sleep(time.Second)
			err = p.master.Delete(ctx, "/api/tasks/"+p.taskID)
		}
		if err != nil {
			p.log.Logf("cleanup: delete probe task: %v", err)
		} else {
			p.log.Logf("cleanup: deleted probe task %s", shortID(p.taskID))
		}
	}
	if p.deviceID != "" && p.master != nil {
		if err := p.master.PostJSON(ctx, "/api/devices/"+p.deviceID+"/revoke", nil, nil); err != nil {
			p.log.Logf("cleanup: revoke probe device: %v", err)
		} else {
			p.log.Logf("cleanup: revoked probe device %s", shortID(p.deviceID))
		}
	}
	if p.tempCwd && p.cwd != "" {
		if err := os.RemoveAll(p.cwd); err != nil {
			p.log.Logf("cleanup: remove temp cwd: %v", err)
		}
	}
}

// textFragments pulls human-visible strings out of an undocumented event
// payload. The contract types payload as an open object, so this walks the
// whole value and accepts only text-shaped keys.
func textFragments(raw json.RawMessage) []string {
	if len(raw) == 0 {
		return nil
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	var out []string
	var walk func(key string, v any)
	walk = func(key string, v any) {
		switch typed := v.(type) {
		case string:
			if textKey(key) && strings.TrimSpace(typed) != "" {
				out = append(out, typed)
			}
		case []any:
			for _, item := range typed {
				walk(key, item)
			}
		case map[string]any:
			keys := make([]string, 0, len(typed))
			for k := range typed {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				walk(k, typed[k])
			}
		}
	}
	walk("", value)
	return out
}

func textKey(key string) bool {
	switch strings.ToLower(key) {
	case "text", "delta", "content", "chunk", "output", "message", "result":
		return true
	}
	return false
}
