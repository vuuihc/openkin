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

const (
	w4Marker = "probe-w4-ok"
	// w4PromptIntro marks text the daemon echoed back from the probe's own
	// prompt. The prompt contains the marker, so an echoed prompt must never
	// count as assistant output.
	w4PromptIntro = "This is an automated client-contract probe."
)

var errStepSkipped = errors.New("step skipped")

// w4Prompt is the first prompt exactly as sent, so the echo filter can remove
// it from the accumulated stream text.
func w4Prompt() string {
	return w4PromptIntro + " Run the shell command `printf probe-w4-tool` once, then reply with exactly: " + w4Marker + ". If you cannot use tools, reply with exactly: " + w4Marker + "."
}

// Config is one acceptance run.
type Config struct {
	BaseURL          string
	MasterToken      string
	Label            string
	Cwd              string
	Agent            string
	Keep             bool
	TurnTimeout      time.Duration
	ReconnectTimeout time.Duration // default 10s
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
	streamDone   chan struct{}
	frames       <-chan SSEEvent

	liveEvents        map[eventKey]TaskEvent
	eventTypes        map[string]int // WSMessage kinds
	taskEventTypes    map[string]int // TaskEvent.type vocabulary
	textEventTypes    map[string]int // types that carried response text
	markerLiveTypes   map[string]bool
	taskStatuses      map[string]bool
	approvalRows      map[string]bool
	eventSamples      []string
	firstTextAt       time.Time
	lastTextAt        time.Time
	textFrames        int
	textBuilder       strings.Builder
	terminalAt        time.Time
	terminalPoll      Task
	approvalSeen      string
	approvalFrameSeen bool
	approvalDone      bool
	approvalListOK    bool
}

// eventKey identifies one durable event. seq restarts per task, and the
// contract carries event_epoch alongside it, so both are part of the identity.
type eventKey struct {
	Epoch int64
	Seq   int64
}

// Run executes the six-step acceptance script.
func Run(ctx context.Context, cfg Config, log *Logger) *Summary {
	p := &probe{
		cfg:             cfg,
		log:             log,
		sum:             &Summary{StartedAt: time.Now(), Observations: map[string]any{}},
		liveEvents:      map[eventKey]TaskEvent{},
		eventTypes:      map[string]int{},
		taskEventTypes:  map[string]int{},
		textEventTypes:  map[string]int{},
		markerLiveTypes: map[string]bool{},
		taskStatuses:    map[string]bool{},
		approvalRows:    map[string]bool{},
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

// stepSnapshot subscribes first, then captures the current end cursor and
// walks the full history, which is the documented way to build a first
// snapshot. Opening the stream before the walk means a change landing during
// the walk is delivered twice at worst, never neither (ADR 0024).
func (p *probe) stepSnapshot(ctx context.Context) (string, error) {
	if _, err := p.startStream(ctx); err != nil {
		return "", fmt.Errorf("events stream: %w", err)
	}
	var cur CursorResponse
	if err := p.client.GetJSON(ctx, "/api/sessions/cursor", &cur); err != nil {
		return "", fmt.Errorf("cursor: %w", err)
	}
	p.observe("cursor_before_turn", cur.Cursor)

	seen := map[string]struct{}{}
	pages := 0
	since := int64(0)
	more := false
	for pages < 100 {
		var page SessionChangePage
		path := fmt.Sprintf("/api/sessions?updated_since=%d&limit=500", since)
		if err := p.client.GetJSON(ctx, path, &page); err != nil {
			return "", fmt.Errorf("feed page %d: %w", pages+1, err)
		}
		more = page.HasMore
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
	if pages == 100 && more {
		p.findingf("snapshot stopped at the probe's 100-page cap while the feed still reported has_more=true; workaround: keep paging, the walk is incomplete")
	}
	return fmt.Sprintf("snapshot of %d sessions in %d page(s); cursor %d; SSE opened before the first feed page", len(seen), pages, cur.Cursor), nil
}

// stepOpenStream confirms the subscription. The snapshot step opens it before
// the first feed page, because ADR 0024 prescribes open-then-drain.
func (p *probe) stepOpenStream(ctx context.Context) (string, error) {
	if p.stream == nil {
		if _, err := p.startStream(ctx); err != nil {
			return "", fmt.Errorf("events stream: %w", err)
		}
	}
	p.log.Logf("SSE stream open")
	return "SSE subscription open and buffering; it was established before the snapshot drain", nil
}

// startStream subscribes and starts a reader whose lifetime ends with the
// stream: when closeStream closes the done channel, a reader blocked on a full
// frame buffer can exit instead of leaking.
func (p *probe) startStream(ctx context.Context) (<-chan SSEEvent, error) {
	if p.stream != nil {
		p.closeStream()
	}
	streamCtx, cancel := context.WithCancel(ctx)
	stream, err := p.client.OpenSSE(streamCtx, "/api/events")
	if err != nil {
		cancel()
		return nil, err
	}
	done := make(chan struct{})
	p.streamCancel = cancel
	p.stream = stream
	p.streamDone = done
	frames := make(chan SSEEvent, 256)
	p.frames = frames
	go func() {
		defer close(frames)
		for {
			ev, err := stream.Next()
			if err != nil {
				return
			}
			select {
			case frames <- ev:
			case <-done:
				return
			}
		}
	}()
	return frames, nil
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
		Agent: agentID,
		Cwd:   p.cwd,
		// The benign command gives a permission-enforcing daemon a chance to
		// raise an approval, so step 5 is attempted rather than assumed.
		Prompt: w4Prompt(),
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
	p.observe("create_permission_mode", task.PermissionMode)

	// Consume the subscription opened in step 3; subscribing again would leave
	// the first connection open with no reader.
	frames := p.frames
	if frames == nil {
		return "", errors.New("no open events subscription")
	}
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
	p.observe("text_event_types", p.textEventTypes)
	p.observe("terminal_permission_mode", p.terminalPoll.PermissionMode)
	p.observe("text_first_delay_ms", msSince(promptAt, p.firstTextAt))
	p.observe("text_last_delay_ms", msSince(promptAt, p.lastTextAt))
	if p.terminalAt.IsZero() {
		p.observe("terminal_delay_ms", nil)
	} else {
		p.observe("terminal_delay_ms", msSince(promptAt, p.terminalAt))
	}

	text := echoFreeText(p.textBuilder.String())
	markerLive := strings.Contains(text, w4Marker)
	p.observe("marker_in_live_text", markerLive)
	p.observe("marker_live_types", sortedKeys(p.markerLiveTypes))
	streamedBeforeTerminal := !p.firstTextAt.IsZero() && p.firstTextAt.Before(p.terminalAt)
	p.observe("text_before_terminal", streamedBeforeTerminal)

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
	markerDurable = strings.Contains(echoFreeText(durableText.String()), w4Marker)
	p.observe("durable_events_after_turn", len(durable))
	p.observe("marker_in_durable_events", markerDurable)

	if p.terminalAt.IsZero() {
		return "", errors.New("turn did not finish")
	}
	if p.textFrames == 0 {
		return "", errors.New("no assistant text was observed on the live stream")
	}
	if !markerLive {
		if markerDurable {
			return "", fmt.Errorf("the requested marker %q appears only in the durable log, not in live text", w4Marker)
		}
		return "", fmt.Errorf("assistant text was observed but never contained the requested marker %q", w4Marker)
	}
	return fmt.Sprintf("task reached %s; %d live frames, %d text fragment(s), first text %d ms after prompt, terminal %d ms",
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
		p.liveEvents[eventKeyOf(te)] = te
		p.taskEventTypes[te.Type]++
		if len(p.eventSamples) < 3 {
			sample := string(msg.Data)
			if len(sample) > 240 {
				sample = sample[:240] + "…"
			}
			p.eventSamples = append(p.eventSamples, sample)
		}
		for _, fragment := range textFragments(te.Payload) {
			// Accumulate raw text first: the daemon may echo the prompt across
			// any fragment boundaries, so the echo is subtracted from the joined
			// text rather than filtered fragment by fragment.
			hadMarker := strings.Contains(echoFreeText(p.textBuilder.String()), w4Marker)
			p.textBuilder.WriteString(fragment)
			if strings.Contains(fragment, w4PromptIntro) {
				continue // prompt echo; it carries no assistant text
			}
			p.textFrames++
			p.textEventTypes[te.Type]++
			if p.firstTextAt.IsZero() {
				p.firstTextAt = time.Now()
				p.log.Logf("first assistant text %d ms after prompt", msSince(promptAt, p.firstTextAt))
			}
			p.lastTextAt = time.Now()
			// The marker may be split across fragments, so attribute it to the
			// event type whose fragment completes it.
			if !hadMarker && strings.Contains(echoFreeText(p.textBuilder.String()), w4Marker) {
				p.markerLiveTypes[te.Type] = true
			}
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
		if approval.TaskID != p.taskID {
			return
		}
		p.approvalFrameSeen = true
		if approval.Decision == "" {
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
	p.approvalListOK = true
	for _, approval := range approvals {
		if approval.TaskID == p.taskID {
			p.approvalRows[approval.ID] = true
		}
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
		// The response is the authoritative record; a daemon that ignores the
		// decision must not count as a completed approval.
		if updated.Decision != "approved" {
			p.log.Logf("approve %s: daemon returned decision %q", shortID(approval.ID), updated.Decision)
			continue
		}
		p.approvalDone = true
		p.log.Logf("approved %s (decision=%q)", shortID(approval.ID), updated.Decision)
		return
	}
}

// stepApproval reports whether a permission request was available to approve.
func (p *probe) stepApproval(ctx context.Context) (string, error) {
	// A short turn may end before the first poll tick; take one snapshot here so
	// "no approval appeared" is backed by a readable list, not by a missed poll.
	if !p.approvalListOK {
		p.pollApprovals(ctx)
	}
	p.observe("approval_frame_seen", p.approvalFrameSeen)
	p.observe("approval_list_ok", p.approvalListOK)
	p.observe("approval_rows_for_task", len(p.approvalRows))
	if p.approvalSeen == "" {
		if !p.approvalListOK {
			return "", errors.New("no approval was seen, and GET /api/approvals was never readable, so its absence cannot be asserted")
		}
		reason := "the probe asked for one benign shell command (`printf probe-w4-tool`); no permission request appeared for the task. The live daemon runs with --allow-yolo (operator brief) and/or the agent declined to use a tool; the README documents no CLI switch to start an isolated daemon with its own data directory, so no approval-enforcing run was attempted. The approval client path is covered by tests against a stub daemon."
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
	if p.stream != nil {
		p.closeStream()
		p.log.Logf("SSE stream closed; catching up from cursor %d", cursorStart(p.sum))
	}
	time.Sleep(500 * time.Millisecond)

	// ADR 0024: reopen before draining, so a change landing between the last
	// feed page and the new subscription is delivered at least once.
	frames, err := p.startStream(ctx)
	if err != nil {
		return "", fmt.Errorf("reconnect: %w", err)
	}

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
	var tail CursorResponse
	if err := p.client.GetJSON(ctx, "/api/sessions/cursor", &tail); err != nil {
		return "", fmt.Errorf("cursor after catch-up: %w", err)
	}
	if tail.Cursor > last {
		p.findingf("catch-up stopped after 5 rounds at cursor %d while the feed end was %d; workaround: keep draining, the reconstruction is incomplete", last, tail.Cursor)
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
	durableByKey := durableIndex(durable)
	missing := 0
	mismatched := 0
	for key, live := range p.liveEvents {
		got, ok := durableByKey[key]
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
	unseen := []string{}
	for key, ev := range durableByKey {
		if _, ok := p.liveEvents[key]; !ok {
			unseen = append(unseen, fmt.Sprintf("%d:%d:%s", key.Epoch, key.Seq, ev.Type))
		}
	}
	sort.Strings(unseen)
	p.observe("durable_events_unseen_live", unseen)
	p.observe("live_events_missing_durably", missing)
	p.observe("live_events_type_mismatch", mismatched)
	if missing > 0 || mismatched > 0 {
		return "", fmt.Errorf("live events do not match the durable log: %d missing, %d type mismatches", missing, mismatched)
	}

	// Force a change after the subscription and require its frame on the
	// reopened stream. A stream that opens but never delivers is not a working
	// subscription.
	var archived Task
	if err := p.client.PostJSON(ctx, "/api/tasks/"+p.taskID+"/archive", nil, &archived); err != nil {
		return "", fmt.Errorf("reconnect proof: archiving the probe task: %w", err)
	}
	archivedAt := time.Now()
	defer func() {
		var restored Task
		if err := p.client.PostJSON(ctx, "/api/tasks/"+p.taskID+"/unarchive", nil, &restored); err != nil {
			p.findingf("could not unarchive the probe task after the reconnect check: %v", err)
		}
	}()

	timeout := p.cfg.ReconnectTimeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	deadline := time.After(timeout)
	for {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-deadline:
			p.observe("reconnect_frame_seen", false)
			return "", fmt.Errorf("the reopened SSE stream delivered no task_update for a change made after resubscribing within %s", timeout)
		case ev, ok := <-frames:
			if !ok {
				p.observe("reconnect_frame_seen", false)
				return "", errors.New("the reopened SSE stream closed before delivering a frame")
			}
			var msg WSMessage
			if json.Unmarshal(ev.Data, &msg) != nil || msg.Kind != "task_update" {
				continue
			}
			var task Task
			if json.Unmarshal(msg.Data, &task) != nil || task.ID != p.taskID || task.ArchivedAt == 0 {
				continue
			}
			delay := msSince(archivedAt, time.Now())
			p.observe("reconnect_frame_seen", true)
			p.observe("reconnect_frame_delay_ms", delay)
			return fmt.Sprintf("caught up %d change(s) in %d page(s) from cursor %d; feed row matches GET /api/tasks on %d field(s); %d live event(s) match the durable log; the reopened stream delivered a task_update %d ms after the archive response",
				len(rebuilt), pages, start, comparedFields(), len(p.liveEvents), delay), nil
		}
	}
}

func (p *probe) closeStream() {
	p.frames = nil
	if p.streamDone != nil {
		close(p.streamDone)
		p.streamDone = nil
	}
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
	more := false
	for pages < 1000 {
		var page SessionChangePage
		path := fmt.Sprintf("/api/sessions?updated_since=%d&limit=500", since)
		if err := p.client.GetJSON(ctx, path, &page); err != nil {
			return nil, nil, pages, last, fmt.Errorf("feed page: %w", err)
		}
		more = page.HasMore
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
	if pages == 1000 && more {
		p.findingf("catch-up stopped at the probe's 1000-page cap while the feed still reported has_more=true; workaround: keep draining, the reconstruction is incomplete")
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
	deleted := false
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
			deleted = true
			p.log.Logf("cleanup: deleted probe task %s", shortID(p.taskID))
		}
	}
	p.observe("cleanup_task_deleted", deleted)
	revoked := false
	if p.deviceID != "" && p.master != nil {
		if err := p.master.PostJSON(ctx, "/api/devices/"+p.deviceID+"/revoke", nil, nil); err != nil {
			p.log.Logf("cleanup: revoke probe device: %v", err)
		} else {
			revoked = true
			p.log.Logf("cleanup: revoked probe device %s", shortID(p.deviceID))
		}
	}
	p.observe("cleanup_device_revoked", revoked)
	if p.tempCwd && p.cwd != "" {
		if err := os.RemoveAll(p.cwd); err != nil {
			p.log.Logf("cleanup: remove temp cwd: %v", err)
		}
	}
}

// eventKeyOf is the shared identity for live frames and durable rows. seq
// restarts per task epoch, so both fields form the key.
func eventKeyOf(ev TaskEvent) eventKey {
	return eventKey{Epoch: ev.EventEpoch, Seq: ev.Seq}
}

// durableIndex keys the durable log the same way as the live map, so the two
// can be compared without collapsing rows that share a seq across epochs.
func durableIndex(events []TaskEvent) map[eventKey]TaskEvent {
	out := make(map[eventKey]TaskEvent, len(events))
	for _, ev := range events {
		out[eventKeyOf(ev)] = ev
	}
	return out
}

// echoFreeText removes the probe's own prompt from the joined transcript. It
// must run after joining because the daemon may split the echo across any
// fragment boundaries; a per-fragment filter would let the marker through.
func echoFreeText(text string) string {
	return strings.ReplaceAll(text, w4Prompt(), "")
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
