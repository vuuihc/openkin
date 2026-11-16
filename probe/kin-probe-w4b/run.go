package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"time"
)

const (
	statusPass = "pass"
	statusSkip = "skip"
	statusFail = "fail"
)

// Config is one acceptance run. Agent is the documented CreateTaskRequest
// agent id; empty asks the daemon for its default available agent.
type Config struct {
	BaseURL      string
	MasterToken  string
	Agent        string
	ApprovalWait time.Duration
	Keep         bool
	Logf         func(format string, args ...any)
}

// Step is one line of the recorded acceptance script.
type Step struct {
	Name   string `json:"name"`
	Status string `json:"status"`
	Detail string `json:"detail,omitempty"`
}

// Metrics are the measurements the program records.
type Metrics struct {
	FirstPromptToFinalMS int64 `json:"first_prompt_to_final_ms"`
	TotalMS              int64 `json:"total_ms"`
	PeakRSSBytes         int64 `json:"peak_rss_bytes"`
	PartialChunks        int   `json:"partial_chunks"`
	StreamFrames         int   `json:"stream_frames"`
	StreamComments       int   `json:"stream_comments"`
	SnapshotSessions     int   `json:"snapshot_sessions"`
	FeedPages            int   `json:"feed_pages"`
	ApprovalsSeen        int   `json:"approvals_seen"`
}

// Outcome is the machine-readable record of a run. It deliberately contains
// no device ids, session ids, tokens, or message text.
type Outcome struct {
	Steps   []Step   `json:"steps"`
	Metrics Metrics  `json:"metrics"`
	Notes   []string `json:"notes,omitempty"`
}

func (o *Outcome) add(name, status, detail string, args ...any) {
	o.Steps = append(o.Steps, Step{Name: name, Status: status, Detail: fmt.Sprintf(detail, args...)})
}

func (o *Outcome) Failed() bool {
	for _, s := range o.Steps {
		if s.Status == statusFail {
			return true
		}
	}
	return false
}

func (o *Outcome) note(format string, args ...any) {
	o.Notes = append(o.Notes, fmt.Sprintf(format, args...))
}

func runLabel() string {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano()%1e6)
	}
	return hex.EncodeToString(b[:])
}

func peakRSSBytes() int64 {
	var ru syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &ru); err != nil {
		return 0
	}
	if runtime.GOOS == "darwin" {
		return ru.Maxrss // bytes on macOS
	}
	return ru.Maxrss * 1024 // KiB elsewhere
}

// RunAcceptance performs the six-step script against baseURL and always
// attempts cleanup unless Keep is set.
func RunAcceptance(ctx context.Context, cfg Config) *Outcome {
	logf := cfg.Logf
	if logf == nil {
		logf = func(string, ...any) {}
	}
	started := time.Now()
	out := &Outcome{}
	label := runLabel()
	pairingLabel := "probe-w4b-" + label

	var (
		master        *Client
		device        *Client
		deviceID      string
		taskID        string
		firstPromptAt time.Time
		finalAt       time.Time
	)

	defer func() {
		// Metrics exist even when a step returns early.
		if finalAt.IsZero() {
			finalAt = time.Now()
		}
		out.Metrics.TotalMS = time.Since(started).Milliseconds()
		if !firstPromptAt.IsZero() {
			out.Metrics.FirstPromptToFinalMS = finalAt.Sub(firstPromptAt).Milliseconds()
		}
		out.Metrics.PeakRSSBytes = peakRSSBytes()
	}()

	workDir, err := os.MkdirTemp("", "kin-probe-w4b-")
	if err != nil {
		out.add("setup", statusFail, "create scratch directory: %v", err)
		return out
	}
	defer os.RemoveAll(workDir)

	feed := NewFeedState()
	var live *LiveState
	var pump *Pump
	defer func() {
		// Close any stream still open on an early return. Closing is
		// intentional, so the pump must not record it as a daemon failure.
		if pump != nil {
			if live != nil {
				live.IntentionalClose()
			}
			pump.Close()
		}
	}()

	defer func() {
		// Cleanup runs even after a step failure. Detach from a cancelled
		// parent so the daemon does not keep a probe device and session.
		if cfg.Keep {
			out.add("cleanup", statusSkip, "keep requested; probe device and session left in place")
			return
		}
		cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 60*time.Second)
		defer cancel()
		cleanupStatus, cleanupDetail := cleanup(cctx, out, master, device, deviceID, taskID, pairingLabel, feed, logf)
		out.add("cleanup", cleanupStatus, "%s", cleanupDetail)
	}()

	// ---- Step 1: pair through the documented flow ----
	master = NewClient(cfg.BaseURL, cfg.MasterToken)
	session, err := master.CreatePairingSession(ctx, pairingLabel)
	if err != nil {
		out.add("1 pair", statusFail, "create pairing session: %v", err)
		return out
	}
	exchange, err := master.ExchangePairingSecret(ctx, session.Secret, pairingLabel)
	if err != nil {
		var apiErr *APIError
		// A transport failure or a 5xx may mean the device was minted and the
		// response was lost. The documented recovery header re-reads the same
		// credential within five minutes instead of consuming a second pairing.
		recoverable := !errors.As(err, &apiErr) || apiErr.Status >= 500
		if !recoverable {
			out.add("1 pair", statusFail, "exchange pairing secret: %v", err)
			return out
		}
		recovered, rerr := master.ExchangePairingSecretRecovery(ctx, session.Secret, pairingLabel)
		if rerr != nil {
			out.add("1 pair", statusFail, "exchange pairing secret: %v; recovery retry: %v", err, rerr)
			return out
		}
		exchange = recovered
		out.note("pairing exchange was retried with X-Kin-Pairing-Recovery after a transport/5xx failure")
	}
	device = master.WithToken(exchange.Token)
	deviceID = exchange.DeviceID
	if _, err := device.Cursor(ctx); err != nil {
		out.add("1 pair", statusFail, "paired device token rejected by /api/sessions/cursor: %v", err)
		return out
	}
	devices, err := master.Devices(ctx)
	if err != nil {
		out.add("1 pair", statusFail, "operator device list after pairing: %v", err)
		return out
	}
	found := false
	for _, d := range devices {
		if d.ID == deviceID {
			found = true
		}
	}
	if !found {
		out.add("1 pair", statusFail, "paired device missing from GET /api/devices")
		return out
	}
	expiresIn := time.Until(time.UnixMilli(session.ExpiresAt)).Round(time.Second)
	out.add("1 pair", statusPass, "pairing session, exchange, device token, and operator device list all agree (secret expires in %s)", expiresIn)
	logf("step 1 pair: ok")

	// ---- Step 2: list sessions and capture the cursor ----
	cursorBefore, err := device.Cursor(ctx)
	if err != nil {
		out.add("2 snapshot", statusFail, "read /api/sessions/cursor: %v", err)
		return out
	}
	// The documented order is cursor first, then a snapshot from the feed.
	// Applying the drain also advances a resume cursor; it never moves back.
	snapshot := NewFeedState()
	pages, err := DrainFeed(ctx, func(since *int64) (ChangePage, error) {
		return device.ChangePage(ctx, since, 200)
	}, nil, snapshot.Apply)
	if err != nil {
		out.add("2 snapshot", statusFail, "drain session snapshot: %v", err)
		return out
	}
	if snapshot.Cursor < cursorBefore {
		out.add("2 snapshot", statusFail, "feed end %d is behind the cursor read before it (%d)", snapshot.Cursor, cursorBefore)
		return out
	}
	feed.Cursor = snapshot.Cursor
	feed.Started = true
	out.Metrics.SnapshotSessions = len(snapshot.Tasks)
	out.Metrics.FeedPages = pages
	out.add("2 snapshot", statusPass, "cursor %d read before the snapshot; drained %d page(s) to %d with %d session(s)", cursorBefore, pages, snapshot.Cursor, len(snapshot.Tasks))
	logf("step 2 snapshot: ok (%d sessions, cursor %d)", len(snapshot.Tasks), snapshot.Cursor)

	// ---- Step 3: open the session and receive live events ----
	stream, err := OpenEventStream(ctx, cfg.BaseURL, exchange.Token)
	if err != nil {
		out.add("3 live events", statusFail, "open /api/events: %v", err)
		return out
	}
	live = NewLiveState("")
	pump = StartPump(stream, live)

	firstPromptAt = time.Now()
	task, err := device.CreateTask(ctx, CreateTaskRequest{
		Agent:          cfg.Agent,
		Cwd:            workDir,
		Prompt:         "Reply with exactly: probe-w4b-ready",
		Title:          "probe-w4b-" + label,
		PermissionMode: "default",
		WorkspaceMode:  "shared",
	})
	if err != nil {
		out.add("3 live events", statusFail, "create probe session: %v", err)
		return out
	}
	taskID = task.ID
	live.SetTaskID(taskID)
	logf("step 3 live events: session created, waiting for frames")
	snap, _, err := waitLive(ctx, 120*time.Second, live, device, taskID, func(s LiveSnapshot, t Task) (bool, string) {
		if s.HasTask && s.EventCount > 0 {
			return true, ""
		}
		if t.Status != "" && t.Terminal() && (!s.HasTask || s.EventCount == 0) {
			return true, "terminal without both task_update and event frames"
		}
		return false, "waiting for task_update and event frames"
	})
	if err != nil {
		out.add("3 live events", statusFail, "wait for live events: %v", err)
		return out
	}
	if snap.DroppedPending > 0 {
		out.add("3 live events", statusFail, "dropped %d buffered frame(s) before the session id was known", snap.DroppedPending)
		return out
	}
	if !snap.HasTask {
		out.add("3 live events", statusFail, "no task_update frame for the session reached %s", snap.Task.Status)
		return out
	}
	if snap.EventCount == 0 {
		out.add("3 live events", statusFail, "session reached %s without any event frame", snap.Task.Status)
		return out
	}
	kinds := formatCounts(snap.KindCounts)
	agent := cfg.Agent
	if agent == "" {
		agent = "daemon default"
	}
	out.add("3 live events", statusPass, "%s agent; task_update and event frames received (%d task frame(s) of %d stream-wide), %d event(s) tracked (%s), %d keep-alive comment(s), %d unrecognized/mismatched frame(s)", agent, snap.TaskFrames, snap.Frames, snap.EventCount, kinds, snap.Comments, snap.Unknown)
	out.Metrics.StreamFrames += snap.Frames
	out.Metrics.StreamComments += snap.Comments
	logf("step 3 live events: ok (%d task frames, kinds %s)", snap.TaskFrames, kinds)

	// ---- Step 4: send a prompt and see streaming text ----
	if _, err := waitTerminal(ctx, device, taskID, 180*time.Second); err != nil {
		out.add("4 streaming", statusFail, "the session's first turn did not reach a terminal state: %v", err)
		return out
	}
	partialsBefore := live.Snapshot().PartialChunks
	if _, err := device.PromptTask(ctx, taskID, "Count from 1 to 5, one number per line, then say done."); err != nil {
		out.add("4 streaming", statusFail, "send prompt: %v", err)
		return out
	}
	terminalSince := time.Time{}
	snap, _, err = waitLive(ctx, 180*time.Second, live, device, taskID, func(s LiveSnapshot, t Task) (bool, string) {
		if s.PartialChunks > partialsBefore {
			return true, ""
		}
		if t.Status != "" && t.Terminal() {
			if terminalSince.IsZero() {
				terminalSince = time.Now()
			}
			if time.Since(terminalSince) > 5*time.Second {
				return true, "terminal without partial chunks"
			}
		}
		return false, "no partial message chunks yet"
	})
	if err != nil {
		out.add("4 streaming", statusFail, "wait for streaming text: %v", err)
		return out
	}
	out.Metrics.PartialChunks = snap.PartialChunks - partialsBefore
	if snap.PartialChunks <= partialsBefore {
		durable, derr := device.TaskEvents(ctx, taskID, 0)
		detail := fmt.Sprintf("no partial message chunk arrived before the turn ended (%d final message(s)); observed event types: %s", boolInt(snap.HaveFinal), eventTypeSummary(snap))
		if derr == nil {
			detail += fmt.Sprintf("; durable event types: %s", durableTypeSummary(durable))
		}
		out.add("4 streaming", statusFail, "%s", detail)
		return out
	}
	// Let the turn finish so the final (non-partial) message is on record
	// before the next prompt is sent.
	if _, err := waitTerminal(ctx, device, taskID, 180*time.Second); err != nil {
		out.add("4 streaming", statusFail, "turn did not finish after streaming began: %v", err)
		return out
	}
	snap = live.Snapshot()
	out.Metrics.PartialChunks = snap.PartialChunks - partialsBefore
	out.add("4 streaming", statusPass, "%d partial message chunk(s) for this prompt; %d total tracked, final message seen=%t", out.Metrics.PartialChunks, snap.PartialChunks, snap.HaveFinal)
	logf("step 4 streaming: ok (%d new partial chunks)", out.Metrics.PartialChunks)

	// ---- Step 5: receive and approve a permission request ----
	approvalStatus, approvalDetail := attemptApproval(ctx, cfg, device, live, taskID, out)
	out.add("5 approval", approvalStatus, "%s", approvalDetail)
	logf("step 5 approval: %s (%s)", approvalStatus, approvalDetail)

	// ---- Step 6: disconnect, reconnect, catch up from the cursor ----
	if _, err := waitTerminal(ctx, device, taskID, 180*time.Second); err != nil {
		out.add("6 catch-up", statusFail, "turn did not reach a terminal state: %v", err)
		finalAt = time.Now()
		return out
	}
	// Bring the feed cursor up to the moment of disconnect.
	if _, err := DrainFeed(ctx, func(since *int64) (ChangePage, error) {
		return device.ChangePage(ctx, since, 200)
	}, &feed.Cursor, feed.Apply); err != nil {
		out.add("6 catch-up", statusFail, "drain feed before disconnect: %v", err)
		finalAt = time.Now()
		return out
	}
	disconnectCursor := feed.Cursor
	beforeDisconnect := live.Snapshot()

	live.IntentionalClose()
	pump.Close()
	if beforeDisconnect.StreamErr != nil {
		out.add("6 catch-up", statusFail, "event stream failed before the intentional disconnect: %v", beforeDisconnect.StreamErr)
		finalAt = time.Now()
		return out
	}

	if _, err := device.PromptTask(ctx, taskID, "Reply with exactly: probe-w4b-catchup"); err != nil {
		out.add("6 catch-up", statusFail, "send prompt while disconnected: %v", err)
		finalAt = time.Now()
		return out
	}
	if _, err := waitTerminal(ctx, device, taskID, 180*time.Second); err != nil {
		out.add("6 catch-up", statusFail, "catch-up turn did not finish: %v", err)
		finalAt = time.Now()
		return out
	}
	catchupPages, err := DrainFeed(ctx, func(since *int64) (ChangePage, error) {
		return device.ChangePage(ctx, since, 200)
	}, &disconnectCursor, feed.Apply)
	if err != nil {
		out.add("6 catch-up", statusFail, "catch up from cursor %d: %v", disconnectCursor, err)
		finalAt = time.Now()
		return out
	}
	feedTask, ok := feed.Tasks[taskID]
	if !ok {
		out.add("6 catch-up", statusFail, "session missing from the feed after catch-up")
		finalAt = time.Now()
		return out
	}
	current, err := device.GetTask(ctx, taskID)
	if err != nil {
		out.add("6 catch-up", statusFail, "fetch session after catch-up: %v", err)
		finalAt = time.Now()
		return out
	}
	if err := matchTask(feedTask, current); err != nil {
		out.add("6 catch-up", statusFail, "feed and task resource disagree after catch-up: %v", err)
		finalAt = time.Now()
		return out
	}
	durable, err := device.TaskEvents(ctx, taskID, 0)
	if err != nil {
		out.add("6 catch-up", statusFail, "read durable event log: %v", err)
		finalAt = time.Now()
		return out
	}
	if err := checkContiguous(durable); err != nil {
		out.add("6 catch-up", statusFail, "durable event log is not contiguous: %v", err)
		finalAt = time.Now()
		return out
	}
	if err := checkSubset(beforeDisconnect, durable); err != nil {
		out.add("6 catch-up", statusFail, "streamed events are not a subset of the durable log: %v", err)
		finalAt = time.Now()
		return out
	}
	out.Metrics.FeedPages += catchupPages

	// Reconnect and prove the stream carries new live frames again.
	reconnectStream, err := OpenEventStream(ctx, cfg.BaseURL, exchange.Token)
	if err != nil {
		out.add("6 catch-up", statusFail, "reconnect /api/events: %v", err)
		finalAt = time.Now()
		return out
	}
	reconnectLive := NewLiveState(taskID)
	reconnectPump := StartPump(reconnectStream, reconnectLive)
	defer reconnectPump.Close()

	durableMax := maxSeq(durable)
	durableEpoch := epochOf(durable)
	if _, err := device.PromptTask(ctx, taskID, "Reply with exactly: probe-w4b-live-again"); err != nil {
		out.add("6 catch-up", statusFail, "send prompt after reconnect: %v", err)
		finalAt = time.Now()
		return out
	}
	reSnap, _, err := waitLive(ctx, 180*time.Second, reconnectLive, device, taskID, func(s LiveSnapshot, t Task) (bool, string) {
		if s.HaveEpoch && (s.Epoch > durableEpoch || s.NextSeq-1 > durableMax) {
			return true, ""
		}
		return false, "no new event frame after reconnect"
	})
	if err != nil {
		out.add("6 catch-up", statusFail, "wait for live event after reconnect: %v", err)
		finalAt = time.Now()
		return out
	}
	out.Metrics.StreamFrames += reSnap.Frames
	if _, err := waitTerminal(ctx, device, taskID, 180*time.Second); err != nil {
		out.add("6 catch-up", statusFail, "post-reconnect turn did not finish: %v", err)
		finalAt = time.Now()
		return out
	}
	if _, err := DrainFeed(ctx, func(since *int64) (ChangePage, error) {
		return device.ChangePage(ctx, since, 200)
	}, &feed.Cursor, feed.Apply); err != nil {
		out.add("6 catch-up", statusFail, "drain feed after reconnect: %v", err)
		finalAt = time.Now()
		return out
	}
	finalTask, err := device.GetTask(ctx, taskID)
	if err != nil {
		out.add("6 catch-up", statusFail, "fetch session at the end: %v", err)
		finalAt = time.Now()
		return out
	}
	if err := matchTask(feed.Tasks[taskID], finalTask); err != nil {
		out.add("6 catch-up", statusFail, "final feed and task resource disagree: %v", err)
		finalAt = time.Now()
		return out
	}
	finalDurable, err := device.TaskEvents(ctx, taskID, 0)
	if err != nil {
		out.add("6 catch-up", statusFail, "read final durable log: %v", err)
		finalAt = time.Now()
		return out
	}
	if err := checkContiguous(finalDurable); err != nil {
		out.add("6 catch-up", statusFail, "final durable log is not contiguous: %v", err)
		finalAt = time.Now()
		return out
	}
	if err := checkSubset(reSnap, finalDurable); err != nil {
		out.add("6 catch-up", statusFail, "post-reconnect streamed events are not a subset of the durable log: %v", err)
		finalAt = time.Now()
		return out
	}
	finalAt = time.Now()
	out.add("6 catch-up", statusPass, "disconnected at cursor %d; caught up %d page(s); reconnected and saw %d new task frame(s) of %d stream-wide (%d unrecognized); feed, task resource, and %d durable event(s) match", disconnectCursor, catchupPages, reSnap.TaskFrames, reSnap.Frames, reSnap.Unknown, len(finalDurable))
	logf("step 6 catch-up: ok")
	return out
}

// attemptApproval sends a prompt that invites one benign tool call, then
// watches both the live stream and GET /api/approvals for a pending decision.
func attemptApproval(ctx context.Context, cfg Config, device *Client, live *LiveState, taskID string, out *Outcome) (string, string) {
	before, beforeErr := device.TaskEvents(ctx, taskID, 0)
	started := time.Now()
	if _, err := device.PromptTask(ctx, taskID, "Use the Bash tool to run `echo probe-w4b-ok`, then reply with its output."); err != nil {
		return statusFail, fmt.Sprintf("send tool-use prompt: %v", err)
	}
	deadline := time.Now().Add(cfg.ApprovalWait)
	var approved *Approval
	var lastListErr error
	for time.Now().Before(deadline) {
		snap := live.Snapshot()
		for _, id := range snap.ApprovalIDs {
			a := snap.Approvals[id]
			if a.Decision == "pending" {
				approved = &a
				break
			}
		}
		if approved == nil {
			pending, err := device.Approvals(ctx, "pending")
			if err != nil {
				lastListErr = err
			} else {
				out.Metrics.ApprovalsSeen = len(pending)
				for i := range pending {
					if pending[i].TaskID == taskID {
						approved = &pending[i]
						break
					}
				}
			}
		}
		if approved != nil {
			break
		}
		if _, err := waitTerminal(ctx, device, taskID, 0); err == nil {
			// Terminal already; one last list read below decides.
			break
		}
		select {
		case <-ctx.Done():
			return statusFail, ctx.Err().Error()
		case <-time.After(500 * time.Millisecond):
		}
	}
	if approved == nil {
		all, allErr := device.Approvals(ctx, "")
		pending, pendingErr := device.Approvals(ctx, "pending")
		if allErr != nil || pendingErr != nil {
			return statusFail, fmt.Sprintf("no approval was observed, and the approval list could not be read to classify the outcome (all: %v; pending: %v)", allErr, pendingErr)
		}
		finalTask, statusErr := waitTerminal(ctx, device, taskID, 0)
		durable, durableErr := device.TaskEvents(ctx, taskID, 0)
		if durableErr != nil {
			return statusFail, fmt.Sprintf("no approval was observed, and the durable log could not be read to classify the outcome: %v", durableErr)
		}
		if beforeErr != nil {
			return statusFail, fmt.Sprintf("no approval was observed, and the pre-prompt durable baseline could not be read, so the turn's tool evidence cannot be attributed: %v", beforeErr)
		}
		// Two completed turns precede this prompt, so an empty baseline means
		// the log could not be trusted for attribution; accepting it would make
		// the whole log look like this turn's output.
		if len(before) == 0 {
			return statusFail, "no approval was observed, and the pre-prompt durable baseline is empty after two completed turns, so the turn's tool evidence cannot be attributed to it"
		}
		if len(durable) < len(before) {
			return statusFail, fmt.Sprintf("the durable log shrank from %d to %d events across the tool prompt; the turn's evidence cannot be attributed (possible retry or rewrite)", len(before), len(durable))
		}
		seen := make(map[EventKey]struct{}, len(before))
		for _, ev := range before {
			key := EventKey{Epoch: ev.EventEpoch, Seq: ev.Seq}
			if _, dup := seen[key]; dup {
				return statusFail, fmt.Sprintf("the pre-prompt durable baseline repeats event identity (epoch %d, seq %d), so the turn's tool evidence cannot be attributed", ev.EventEpoch, ev.Seq)
			}
			seen[key] = struct{}{}
		}
		last := before[len(before)-1]
		if durable[len(before)-1].EventEpoch != last.EventEpoch || durable[len(before)-1].Seq != last.Seq {
			return statusFail, fmt.Sprintf("the durable log changed shape across the tool prompt at position %d; the turn's evidence cannot be attributed (possible retry or rewrite)", len(before)-1)
		}
		// Count only events this prompt produced. A tool call from an earlier
		// turn must not stand in for the invited tool, and an earlier approval
		// must not turn this turn's outcome into a failure.
		after := durable[len(before):]
		for _, ev := range after {
			if _, repeated := seen[EventKey{Epoch: ev.EventEpoch, Seq: ev.Seq}]; repeated {
				return statusFail, fmt.Sprintf("the durable log repeats a pre-prompt event identity (epoch %d, seq %d) after the tool prompt; the turn's evidence cannot be attributed", ev.EventEpoch, ev.Seq)
			}
		}
		allForTask, pendingForTask := 0, 0
		for _, a := range all {
			if a.TaskID == taskID {
				allForTask++
			}
		}
		for _, a := range pending {
			if a.TaskID == taskID {
				pendingForTask++
			}
		}
		var requested, toolUse, toolResult, embedded int
		var statuses, toolNames []string
		for _, ev := range after {
			switch ev.Type {
			case "approval_requested":
				requested++
			case "tool_use":
				toolUse++
				statuses = append(statuses, ev.Payload.Status)
				if name := toolName(ev.Payload); name != "" {
					toolNames = append(toolNames, name)
				}
			case "tool_result":
				toolResult++
			}
		}
		embedded = embeddedToolResults(after)
		evidence := fmt.Sprintf("list readable (%d total, %d for this session; %d pending, %d for this session); durable after the tool prompt: approval_requested=%d tool_use=%d tool_result=%d embedded_tool_result=%d", len(all), allForTask, len(pending), pendingForTask, requested, toolUse, toolResult, embedded)
		if len(statuses) > 0 {
			evidence += fmt.Sprintf(" (tool_use statuses: %s)", strings.Join(statuses, ","))
		}
		if len(toolNames) > 0 {
			evidence += fmt.Sprintf(" (tool names: %s)", strings.Join(toolNames, ","))
		}
		if len(after) > 0 {
			evidence += fmt.Sprintf("; events after the tool prompt: %s", durableTypeSummary(after))
		}
		if requested > 0 {
			return statusFail, fmt.Sprintf("the durable log records %d approval_requested event(s), but GET /api/approvals exposed no pending row for the session; %s", requested, evidence)
		}
		if statusErr != nil {
			return statusFail, fmt.Sprintf("inconclusive after %s: %v; %s", time.Since(started).Round(time.Second), statusErr, evidence)
		}
		evidence = fmt.Sprintf("turn reached %s after %s; %s", finalTask.Status, time.Since(started).Round(time.Second), evidence)
		if finalTask.Status != "succeeded" {
			return statusFail, fmt.Sprintf("the tool-prompt turn reached %s without an approval row; %s", finalTask.Status, evidence)
		}
		if toolUse == 0 && toolResult == 0 && embedded == 0 {
			return statusFail, "the turn succeeded without attempting the invited tool; " + evidence
		}
		if lastListErr != nil {
			evidence += fmt.Sprintf("; a mid-wait list read failed transiently: %v", lastListErr)
		}
		return statusSkip, "no pending approval appeared; " + evidence
	}

	decided, err := device.DecideApproval(ctx, approved.ID, "approved")
	if err != nil {
		return statusFail, fmt.Sprintf("approve pending request: %v", err)
	}
	if decided.Decision != "approved" {
		return statusFail, fmt.Sprintf("decision response reads %q, want approved", decided.Decision)
	}
	if _, err := waitTerminal(ctx, device, taskID, 180*time.Second); err != nil {
		return statusFail, fmt.Sprintf("turn did not finish after approval: %v", err)
	}
	via := decided.DecidedVia
	if via == "" {
		via = "unreported"
	} else if i := strings.IndexByte(via, ':'); i >= 0 {
		// The contract documents ios:<device-id>; keep the mechanism only so
		// the outcome never carries a device identifier.
		via = via[:i] + " (identifier redacted)"
	}
	return statusPass, fmt.Sprintf("pending approval received and approved (kind=%s, decided_via=%s); turn finished", approved.Kind, via)
}

// waitTerminal polls the task resource until it reaches a terminal status. A
// zero timeout performs a single read.
func waitTerminal(ctx context.Context, client *Client, taskID string, timeout time.Duration) (Task, error) {
	deadline := time.Now().Add(timeout)
	for {
		task, err := client.GetTask(ctx, taskID)
		if err != nil {
			return task, err
		}
		if task.Terminal() {
			return task, nil
		}
		if timeout == 0 || time.Now().After(deadline) {
			return task, fmt.Errorf("status %q after %s", task.Status, timeout)
		}
		select {
		case <-ctx.Done():
			return task, ctx.Err()
		case <-time.After(time.Second):
		}
	}
}

// waitLive polls the live view until cond is satisfied. The task resource is
// refreshed about once a second so a quiet stream still sees terminal states.
func waitLive(ctx context.Context, timeout time.Duration, live *LiveState, client *Client, taskID string, cond func(LiveSnapshot, Task) (bool, string)) (LiveSnapshot, Task, error) {
	deadline := time.Now().Add(timeout)
	var task Task
	var lastPoll time.Time
	lastDetail := "condition not met"
	for {
		if snap := live.Snapshot(); snap.StreamErr != nil {
			return snap, task, fmt.Errorf("event stream failed: %w", snap.StreamErr)
		}
		if time.Since(lastPoll) >= time.Second {
			if t, err := client.GetTask(ctx, taskID); err == nil {
				task = t
			}
			lastPoll = time.Now()
		}
		snap := live.Snapshot()
		if ok, detail := cond(snap, task); ok {
			return snap, task, nil
		} else if detail != "" {
			lastDetail = detail
		}
		if time.Now().After(deadline) {
			return snap, task, fmt.Errorf("timeout after %s: %s", timeout, lastDetail)
		}
		select {
		case <-ctx.Done():
			return snap, task, ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func matchTask(feed Task, resource Task) error {
	if feed.ID == "" {
		return errors.New("session absent from the feed")
	}
	if feed.ID != resource.ID {
		return fmt.Errorf("feed id %q != resource id %q", feed.ID, resource.ID)
	}
	if feed.Status != resource.Status {
		return fmt.Errorf("feed status %q != resource status %q", feed.Status, resource.Status)
	}
	if feed.EventEpoch != resource.EventEpoch {
		return fmt.Errorf("feed event_epoch %d != resource event_epoch %d", feed.EventEpoch, resource.EventEpoch)
	}
	fh, rh := int64(-1), int64(-1)
	if feed.HubSeq != nil {
		fh = *feed.HubSeq
	}
	if resource.HubSeq != nil {
		rh = *resource.HubSeq
	}
	if fh != rh {
		return fmt.Errorf("feed hub_seq %d != resource hub_seq %d", fh, rh)
	}
	return nil
}

func maxSeq(events []TaskEvent) int64 {
	var max int64
	for _, ev := range events {
		if ev.Seq > max {
			max = ev.Seq
		}
	}
	return max
}

func epochOf(events []TaskEvent) int64 {
	if len(events) == 0 {
		return 0
	}
	return events[0].EventEpoch
}

// checkContiguous verifies this probe's log shape: the run creates a fresh task
// and no retry or other tail rewrite occurred, so a single epoch with seq 1..N
// is expected. A mixed-epoch log after a tail rewrite is valid but out of scope
// for this acceptance; the tracker itself resets on a higher epoch.
func checkContiguous(events []TaskEvent) error {
	if len(events) == 0 {
		return errors.New("empty event log")
	}
	epoch := events[0].EventEpoch
	seqs := make([]int64, 0, len(events))
	seen := make(map[int64]bool, len(events))
	for _, ev := range events {
		if ev.EventEpoch != epoch {
			return fmt.Errorf("mixed event epochs %d and %d", epoch, ev.EventEpoch)
		}
		if seen[ev.Seq] {
			return fmt.Errorf("duplicate seq %d", ev.Seq)
		}
		seen[ev.Seq] = true
		seqs = append(seqs, ev.Seq)
	}
	sort.Slice(seqs, func(i, j int) bool { return seqs[i] < seqs[j] })
	for i, seq := range seqs {
		if seq != int64(i+1) {
			return fmt.Errorf("seq %d at position %d", seq, i)
		}
	}
	return nil
}

// checkSubset verifies every event the live stream saw also exists in the
// durable log with the same identity and type. The stream is an accelerant;
// the log is the truth, so the stream must never carry an event the log lacks.
func checkSubset(snap LiveSnapshot, durable []TaskEvent) error {
	byKey := make(map[EventKey]TaskEvent, len(durable))
	for _, ev := range durable {
		byKey[EventKey{Epoch: ev.EventEpoch, Seq: ev.Seq}] = ev
	}
	for _, key := range snap.Order {
		ev, ok := byKey[key]
		if !ok {
			return fmt.Errorf("streamed event (epoch %d, seq %d) absent from the durable log", key.Epoch, key.Seq)
		}
		streamed := snap.Events[key]
		if streamed.Type != ev.Type {
			return fmt.Errorf("streamed event (epoch %d, seq %d) type %q != durable type %q", key.Epoch, key.Seq, streamed.Type, ev.Type)
		}
	}
	if len(snap.Gaps) > 0 {
		return fmt.Errorf("live seq gaps: %s", strings.Join(snap.Gaps, ", "))
	}
	return nil
}

func formatCounts(counts map[string]int) string {
	if len(counts) == 0 {
		return "none"
	}
	keys := make([]string, 0, len(counts))
	for k := range counts {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%s=%d", k, counts[k]))
	}
	return strings.Join(parts, ", ")
}

// toolName reads the documented aliases for a tool-use name. Adapters may put
// it at the top level under tool_name or name, or inside the content object.
func toolName(p TaskEventPayload) string {
	if p.ToolName != "" {
		return p.ToolName
	}
	if p.Name != "" {
		return p.Name
	}
	if len(p.Content) > 0 {
		var obj struct {
			Name string `json:"name"`
		}
		if err := json.Unmarshal(p.Content, &obj); err == nil && obj.Name != "" {
			return obj.Name
		}
	}
	return ""
}

func embeddedToolResults(events []TaskEvent) int {
	count := 0
	for _, ev := range events {
		if ev.Type != "message" || len(ev.Payload.Content) == 0 {
			continue
		}
		var blocks []struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(ev.Payload.Content, &blocks); err != nil {
			continue
		}
		for _, b := range blocks {
			if b.Type == "tool_result" {
				count++
			}
		}
	}
	return count
}

func eventTypeSummary(snap LiveSnapshot) string {
	counts := make(map[string]int, len(snap.Order))
	for _, key := range snap.Order {
		counts[snap.Events[key].Type]++
	}
	return formatCounts(counts)
}

func durableTypeSummary(events []TaskEvent) string {
	types := make([]string, 0, len(events))
	for _, ev := range events {
		types = append(types, ev.Type)
	}
	if len(types) == 0 {
		return "none"
	}
	return strings.Join(types, ",")
}

func boolInt(v bool) int {
	if v {
		return 1
	}
	return 0
}

// cleanup deletes the probe session and revokes the probe device, then
// re-queries to confirm both.
func cleanup(ctx context.Context, out *Outcome, master, device *Client, deviceID, taskID, pairingLabel string, feed *FeedState, logf func(string, ...any)) (string, string) {
	var problems []string
	deviceConfirmation := "device check not run"

	// If the exchange response was lost, the device may exist without the
	// client knowing its id. The label is the documented, non-secret way to
	// find it again so cleanup does not leak a credential.
	if deviceID == "" && master != nil {
		devices, err := master.Devices(ctx)
		if err != nil {
			problems = append(problems, fmt.Sprintf("find paired device by label: %v", err))
		} else {
			for _, d := range devices {
				if d.Label == pairingLabel && d.RevokedAt == 0 {
					deviceID = d.ID
					deviceConfirmation = "device recovered by label after a lost exchange response"
					out.note("recovered the paired device by label because the exchange response was lost")
					break
				}
			}
		}
	}

	if taskID != "" && device != nil {
		if _, err := waitTerminal(ctx, device, taskID, 20*time.Second); err != nil {
			if _, cerr := device.CancelTask(ctx, taskID); cerr != nil {
				problems = append(problems, fmt.Sprintf("cancel running session: %v", cerr))
			} else if _, err := waitTerminal(ctx, device, taskID, 30*time.Second); err != nil {
				problems = append(problems, fmt.Sprintf("session did not stop after cancel: %v", err))
			}
		}
	}
	deleted := false
	if taskID != "" && master != nil {
		if err := master.DeleteTask(ctx, taskID); err != nil {
			problems = append(problems, fmt.Sprintf("delete session: %v", err))
		} else {
			deleted = true
			if _, err := master.GetTask(ctx, taskID); err == nil {
				problems = append(problems, "deleted session is still readable")
			} else if !isStatus(err, 404) {
				problems = append(problems, fmt.Sprintf("confirm deleted session: %v", err))
			}
		}
		// Deletion is part of the durable feed (ADR 0024): a tombstone must
		// appear for clients that were away. Waiting is pointless when the
		// delete itself failed.
		if deleted {
			tombstone := false
			deadline := time.Now().Add(10 * time.Second)
			for time.Now().Before(deadline) {
				if _, err := DrainFeed(ctx, func(since *int64) (ChangePage, error) {
					return master.ChangePage(ctx, since, 200)
				}, &feed.Cursor, feed.Apply); err != nil {
					problems = append(problems, fmt.Sprintf("drain feed for tombstone: %v", err))
					break
				}
				if feed.Deleted[taskID] {
					tombstone = true
					break
				}
				time.Sleep(500 * time.Millisecond)
			}
			if !tombstone {
				problems = append(problems, "deletion tombstone never appeared in the session feed")
			}
		}
	}
	if deviceID != "" && master != nil {
		if err := master.RevokeDevice(ctx, deviceID); err != nil {
			problems = append(problems, fmt.Sprintf("revoke device: %v", err))
		} else {
			devices, err := master.Devices(ctx)
			if err != nil {
				problems = append(problems, fmt.Sprintf("list devices after revoke: %v", err))
			} else {
				found := false
				for _, d := range devices {
					if d.ID == deviceID {
						found = true
						if d.RevokedAt == 0 {
							problems = append(problems, "revoked device is listed without revoked_at")
						}
					}
				}
				if !found {
					deviceConfirmation = "revoked device absent from GET /api/devices"
					out.note("revoked device is absent from GET /api/devices (acceptable confirmation)")
				} else {
					deviceConfirmation = "revoked device listed with revoked_at set"
				}
			}
			if device != nil {
				if _, err := device.Cursor(ctx); err == nil {
					problems = append(problems, "revoked device token is still accepted")
				} else if !isStatus(err, 401) {
					problems = append(problems, fmt.Sprintf("revoked device token check: %v", err))
				}
			}
		}
	}
	if len(problems) > 0 {
		sort.Strings(problems)
		return statusFail, strings.Join(problems, "; ")
	}
	logf("cleanup: session deleted and device revoked, both confirmed")
	return statusPass, "session deleted (404 on re-read) and its deletion is in the feed; device revoked and its token now gets 401; " + deviceConfirmation
}

func isStatus(err error, status int) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.Status == status
}
