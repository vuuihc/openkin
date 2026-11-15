package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	statusPass    = "pass"
	statusFail    = "fail"
	statusSkipped = "skipped"
)

type stepResult struct {
	Name       string         `json:"name"`
	Status     string         `json:"status"`
	Detail     string         `json:"detail"`
	DurationMS int64          `json:"duration_ms"`
	Observed   map[string]any `json:"observed,omitempty"`
	Errors     []string       `json:"errors,omitempty"`
}

type evidence struct {
	Tool       string         `json:"tool"`
	BaseURL    string         `json:"base_url"`
	StartedAt  string         `json:"started_at"`
	FinishedAt string         `json:"finished_at"`
	Steps      []*stepResult  `json:"steps"`
	Findings   []string       `json:"undocumented_behaviors"`
	Cleanup    []string       `json:"cleanup"`
	RSSBytes   int64          `json:"client_rss_bytes"`
	Extra      map[string]any `json:"extra,omitempty"`
}

type runConfig struct {
	baseURL       string
	statePath     string
	masterFile    string
	evidencePath  string
	scratchDir    string
	agent         string
	turnTimeout   time.Duration
	approvalWait  time.Duration
	noCleanup     bool
	taskTitlePref string
}

type observedEvent struct {
	Ev TaskEvent
	At time.Time
}

type runner struct {
	ctx       context.Context
	cfg       runConfig
	client    *Client
	master    string
	masterErr error
	ev        *evidence
	deviceID  string   // this run's paired device, for cleanup
	runErrors []string // failures that belong to no single step

	mu sync.Mutex
	// liveEvents is keyed by task id, then by that task's own event seq. Seq
	// restarts at 1 per task (ADR 0024) and /api/events is global, so a flat
	// seq-keyed map would let one session's frame overwrite another's.
	liveEvents   map[string]map[int64]observedEvent
	liveApproval map[string]Approval
	frameCounts  map[string]int
	// taskFrames is keyed by task id, then by SSE message kind. The stream is
	// global, so frameCounts alone cannot prove this run's own session produced
	// a frame.
	taskFrames   map[string]map[string]int
	taskEpoch    map[string]int64
	epochChanges []string
	unknownKinds map[string]int
	decodeErrors []string
	streamErrors []string

	streamCancel context.CancelFunc
	streamDone   chan struct{}
	streamReady  chan struct{}
	streamErr    error

	turn2SeqBefore int64
}

func cmdRun(parent context.Context, args []string) int {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	base := stringFlag(fs, "base", "http://127.0.0.1:7777", "daemon base URL")
	statePath := stringFlag(fs, "state", defaultStatePath, "state file")
	masterFile := stringFlag(fs, "master-token-file", defaultMasterTokenFile(), "file holding the master token (undocumented bootstrap)")
	evidencePath := stringFlag(fs, "evidence", "kin-probe-evidence.json", "evidence JSON output path")
	scratch := stringFlag(fs, "scratch", ".kin-probe-cwd", "working directory for the probe task")
	agent := stringFlag(fs, "agent", "claude-code", "agent id for the probe task")
	turnTimeout := fs.Duration("turn-timeout", 5*time.Minute, "max time for one agent turn")
	approvalWait := fs.Duration("approval-wait", 2*time.Minute, "max time to wait for a permission request")
	noCleanup := fs.Bool("no-cleanup", false, "keep the probe task and device")
	fs.Parse(args)

	cfg := runConfig{
		baseURL: *base, statePath: *statePath, masterFile: *masterFile,
		evidencePath: *evidencePath, scratchDir: *scratch, agent: *agent,
		turnTimeout: *turnTimeout, approvalWait: *approvalWait,
		noCleanup: *noCleanup, taskTitlePref: "probe-w2-acceptance",
	}
	if err := os.MkdirAll(cfg.scratchDir, 0o755); err != nil {
		fatalf("create scratch dir: %v", err)
	}

	ctx, cancel := context.WithTimeout(parent, 25*time.Minute)
	defer cancel()

	r := &runner{
		ctx: ctx, cfg: cfg,
		ev: &evidence{
			Tool:      "kin-probe",
			BaseURL:   cfg.baseURL,
			StartedAt: time.Now().UTC().Format(time.RFC3339),
			Steps:     []*stepResult{},
		},
		liveEvents:   map[string]map[int64]observedEvent{},
		liveApproval: map[string]Approval{},
		frameCounts:  map[string]int{},
		taskFrames:   map[string]map[string]int{},
		taskEpoch:    map[string]int64{},
		unknownKinds: map[string]int{},
	}
	r.master, r.masterErr = readMasterToken(cfg.masterFile, !flagWasSet(fs, "master-token-file"))
	defer r.stopStream()

	ok := r.run()
	// Stop the SSE reader before marshalling evidence and printing the summary:
	// observeFrame writes under r.mu, and the slices read below must be stable.
	r.stopStream()
	r.ev.FinishedAt = time.Now().UTC().Format(time.RFC3339)
	r.ev.RSSBytes = rssBytes()
	// A stream or decode failure belongs to no single step, but it invalidates
	// what the run claims just the same. An epoch bump restarts every seq, so
	// the seq-based catch-up evidence is no longer comparable either.
	r.collectRunErrors()
	r.ev.Extra = map[string]any{
		"stream_errors": r.streamErrorsSnapshot(),
		"decode_errors": r.decodeErrorsSnapshot(),
		"task_frames":   r.taskFramesSnapshot(),
		"epoch_changes": r.epochChangesSnapshot(),
	}
	failed, skipped := r.printSummary()
	code := runExitCode(ok, failed, skipped)
	if err := writeEvidence(cfg.evidencePath, r.ev); err != nil {
		fmt.Fprintf(os.Stderr, "kin-probe: write evidence: %v\n", err)
		// Evidence is the deliverable; a run whose evidence was not written must
		// not exit as a pass.
		code = 1
	}
	return code
}

// runExitCode separates "passed", "passed but a step was skipped", and
// "failed"; a caller scripting the probe must not read a skip as full coverage.
func runExitCode(ok bool, failed, skipped int) int {
	switch {
	case !ok || failed > 0:
		return 1
	case skipped > 0:
		return 3
	}
	return 0
}

func (r *runner) run() bool {
	var taskID string
	base := &taskContext{r: r}

	// Step 1 — pairing through the documented flow.
	base.step("pair", func(s *stepResult) bool {
		if r.masterErr != nil {
			s.Errors = append(s.Errors, r.masterErr.Error())
			return false
		}
		anon := NewClient(r.cfg.baseURL, "")
		sess, err := anon.CreatePairingSession(r.ctx, r.master, "kin-probe-w2")
		if err != nil {
			s.Errors = append(s.Errors, fmt.Sprintf("POST /api/pairing/sessions: %v", err))
			return false
		}
		exch, err := anon.ExchangePairing(r.ctx, sess.Secret, "kin-probe-w2")
		if err != nil {
			s.Errors = append(s.Errors, fmt.Sprintf("POST /api/pairing/exchange: %v", err))
			return false
		}
		r.client = NewClient(r.cfg.baseURL, exch.Token)
		r.deviceID = exch.DeviceID
		if err := saveState(r.cfg.statePath, &State{
			BaseURL: r.cfg.baseURL, DeviceID: exch.DeviceID, Token: exch.Token,
		}); err != nil {
			s.Errors = append(s.Errors, fmt.Sprintf("save state: %v", err))
			return false
		}
		s.Observed = map[string]any{
			"device_id":       exch.DeviceID,
			"desktop_name":    exch.DesktopName,
			"secret_expires":  sess.ExpiresAt,
			"token_present":   exch.Token != "",
			"bootstrap":       "master token from " + r.cfg.masterFile + " (not in the public contract)",
			"device_id_shape": "ios-<hex> even though the client is not iOS",
		}
		r.finding("the contract documents no way for a new client to obtain its first credential: /api/pairing/sessions itself requires a bearer token that only the daemon host holds")
		r.finding("paired device ids are minted with an `ios-` prefix regardless of the client, and the exchange request has no documented client-kind field")
		return true
	})

	// Step 2 — cursor first, then the snapshot.
	var cursorBefore int64
	base.step("snapshot", func(s *stepResult) bool {
		var err error
		cursorBefore, err = r.client.Cursor(r.ctx)
		if err != nil {
			s.Errors = append(s.Errors, fmt.Sprintf("GET /api/sessions/cursor: %v", err))
			return false
		}
		start := time.Now()
		sessions, deleted, final, pages, err := r.client.DrainFeed(r.ctx, 0, 500, 0)
		if err != nil {
			s.Errors = append(s.Errors, fmt.Sprintf("GET /api/sessions: %v", err))
			return false
		}
		if err := r.writeState(func(st *State) { st.Cursor = cursorBefore }); err != nil {
			s.Errors = append(s.Errors, err.Error())
			return false
		}
		s.Observed = map[string]any{
			"cursor_before_snapshot": cursorBefore,
			"snapshot_sessions":      len(sessions),
			"snapshot_deleted":       len(deleted),
			"pages":                  pages,
			"final_cursor_of_walk":   final,
			"snapshot_ms":            time.Since(start).Milliseconds(),
		}
		if cursorBefore <= 0 {
			s.Errors = append(s.Errors, "cursor is zero; cannot tell an empty feed from a broken one")
			return false
		}
		return true
	})

	// Step 3 — open the stream, create the probe session, watch live frames.
	base.step("open-session-live-events", func(s *stepResult) bool {
		r.startStream()
		// Do not create the session until the stream is actually attached; a
		// fast first turn must not finish before the SSE handshake completes.
		if err := r.waitStreamReady(5 * time.Second); err != nil {
			s.Errors = append(s.Errors, "the SSE stream did not become ready: "+err.Error())
			return false
		}
		title := fmt.Sprintf("%s-%d", r.cfg.taskTitlePref, time.Now().Unix())
		task, err := r.client.CreateTask(r.ctx, map[string]any{
			"title":           title,
			"prompt":          "Reply with exactly: PROBE-READY. Do not use tools.",
			"agent":           r.cfg.agent,
			"cwd":             absPath(r.cfg.scratchDir),
			"permission_mode": "default",
			"workspace_mode":  "shared",
		})
		if err != nil {
			s.Errors = append(s.Errors, fmt.Sprintf("POST /api/tasks: %v", err))
			return false
		}
		taskID = task.ID
		if err := r.writeState(func(st *State) { st.LastTaskID = task.ID }); err != nil {
			s.Errors = append(s.Errors, err.Error())
			return false
		}
		done, err := r.waitTurn(task.ID, taskSnapshot{TokensIn: task.TokensIn, TokensOut: task.TokensOut, FinishedAt: task.FinishedAt, HubSeq: task.HubSeq, Status: task.Status}, r.cfg.turnTimeout)
		if err != nil {
			s.Errors = append(s.Errors, err.Error())
			return false
		}
		// The daemon may report terminal state over GET before the SSE frame for
		// it arrives; give the stream a short grace period before judging it.
		for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); {
			tf := r.taskFrameStats(task.ID)
			if tf["event"] > 0 || tf["task_update"] > 0 {
				break
			}
			if err := sleepCtx(r.ctx, 100*time.Millisecond); err != nil {
				break
			}
		}
		streamFrames := r.frameStats()
		taskFrames := r.taskFrameStats(task.ID)
		streamErr := r.streamError()
		s.Observed = map[string]any{
			"task_id":               task.ID,
			"title":                 task.Title,
			"final_status":          done.Status,
			"stream_frames_by_kind": streamFrames,
			"task_frames_by_kind":   taskFrames,
			"stream_error":          streamErr,
			"task_events_seen":      r.liveEventCount(task.ID),
		}
		if streamErr != "" {
			s.Errors = append(s.Errors, "the SSE stream failed while the first turn ran: "+streamErr)
			return false
		}
		if taskFrames["event"] == 0 && taskFrames["task_update"] == 0 {
			s.Errors = append(s.Errors, "no live frame belonged to the new session; only other sessions' frames arrived")
			return false
		}
		if done.Status != "succeeded" {
			s.Errors = append(s.Errors, fmt.Sprintf("first turn ended %q, want %q", done.Status, "succeeded"))
			if msg := r.lastErrorMessage(task.ID); msg != "" {
				s.Errors = append(s.Errors, "task error: "+truncate(msg, 240))
			}
			return false
		}
		return true
	})

	// Step 4 — send a prompt and observe streaming text. This step deliberately
	// does not wait for the turn to finish: the turn is expected to pause on the
	// permission request that step 5 answers, and the final message only exists
	// after that decision.
	base.step("prompt-streaming-text", func(s *stepResult) bool {
		seqBefore := r.maxLiveSeq(taskID)
		r.turn2SeqBefore = seqBefore
		promptAt := time.Now()
		if _, err := r.client.FollowUp(r.ctx, taskID,
			"Use the Bash tool to run exactly `echo probe-ok`. Then reply with exactly: PROBE-DONE"); err != nil {
			s.Errors = append(s.Errors, fmt.Sprintf("POST /api/tasks/{id}/prompt: %v", err))
			return false
		}
		// Watch the live stream while the turn runs. Stop when the final
		// assistant message is visible, or when the turn pauses on a permission
		// request (step 5 answers that), or after a short grace once text has
		// streamed. The final message follows the last delta closely when the
		// turn finishes on its own, but judging it before it arrives would race
		// the SSE frame.
		deadline := time.Now().Add(90 * time.Second)
		sawRunning := false
		var streamedAt time.Time
		for time.Now().Before(deadline) {
			stats := r.assistantStats(taskID, seqBefore)
			if stats.partials >= 2 {
				if streamedAt.IsZero() {
					streamedAt = time.Now()
				}
				if stats.finals > 0 {
					break
				}
				if a, _ := r.pendingApproval(taskID); a != nil || time.Since(streamedAt) > 5*time.Second {
					break
				}
			}
			if t, err := r.client.Task(r.ctx, taskID); err == nil {
				if !isTerminal(t.Status) {
					sawRunning = true
				} else if sawRunning && streamedAt.IsZero() {
					break // the turn ended without ever streaming text
				}
			}
			if err := sleepCtx(r.ctx, 250*time.Millisecond); err != nil {
				break
			}
		}
		stats := r.assistantStats(taskID, seqBefore)
		done, err := r.client.Task(r.ctx, taskID)
		if err != nil {
			s.Errors = append(s.Errors, fmt.Sprintf("GET /api/tasks/{id}: %v", err))
			return false
		}
		observed := map[string]any{
			"final_status":       done.Status,
			"partial_events":     stats.partials,
			"partial_bytes":      stats.partialBytes,
			"final_messages":     stats.finals,
			"final_text_chars":   stats.finalChars,
			"streamed_preview":   truncate(stats.partialText, 160),
			"final_text_preview": truncate(stats.finalText, 160),
		}
		if stats.partials > 0 {
			observed["first_partial_ms"] = stats.firstAt.Sub(promptAt).Milliseconds()
			observed["last_partial_ms"] = stats.lastAt.Sub(promptAt).Milliseconds()
		}
		s.Observed = observed
		if streamErr := r.streamError(); streamErr != "" {
			// Partials may already be counted; a stream that died mid-turn must
			// still fail the run rather than pass on the frames it managed to send.
			s.Errors = append(s.Errors, "the SSE stream failed while the turn ran: "+streamErr)
			return false
		}
		if stats.partials == 0 {
			s.Detail = "no streaming text; task ended " + done.Status
			if msg := r.lastErrorMessage(taskID); msg != "" {
				s.Detail += ": " + truncate(msg, 240)
			}
			s.Errors = append(s.Errors, "no partial assistant message events observed; streaming text is not visible on the wire this client uses")
			return false
		}
		if stats.finals > 0 && stats.finalChars == 0 {
			s.Errors = append(s.Errors, "a final assistant message event carried no text")
			return false
		}
		if stats.finals == 0 && isFinal(done.Status) {
			s.Errors = append(s.Errors, fmt.Sprintf("the turn ended %q with no final assistant message event", done.Status))
			return false
		}
		return true
	})

	// Step 5 — receive and approve a permission request.
	var approvalID string
	base.step("permission-request", func(s *stepResult) bool {
		deadline := time.Now().Add(r.cfg.approvalWait)
		var pendingErr error
		var lastStatus string
		for time.Now().Before(deadline) {
			// The evidence should describe the last poll, not any failed one, so a
			// later success clears an earlier query error.
			a, err := r.pendingApproval(taskID)
			pendingErr = err
			if a != nil {
				approvalID = a.ID
				break
			}
			if t, err := r.client.Task(r.ctx, taskID); err == nil {
				lastStatus = t.Status
				if isTerminal(t.Status) {
					break
				}
				// keep waiting; the turn is paused on the request
			}
			if err := sleepCtx(r.ctx, time.Second); err != nil {
				break
			}
		}
		all, allErr := r.client.Approvals(r.ctx, "")
		history := make([]map[string]any, 0, len(all))
		pendingRows := 0
		for _, a := range all {
			if a.TaskID != taskID {
				continue
			}
			via := ""
			if a.DecidedVia != nil {
				via = *a.DecidedVia
			}
			pending := a.Decision == ""
			if pending {
				pendingRows++
			}
			history = append(history, map[string]any{
				"id": a.ID, "kind": a.Kind, "decision": a.Decision,
				"decided_via": via, "pending": pending,
			})
		}
		// The status-filtered query can miss a row the unfiltered sweep returns,
		// and an undecided row is actionable either way.
		if approvalID == "" && allErr == nil {
			for _, a := range all {
				if a.TaskID == taskID && a.Decision == "" {
					approvalID = a.ID
					break
				}
			}
		}
		// A live frame can be missing (seq 1 is a known hole), so the durable
		// transcript is the authority for the skip reason.
		durable, durableErr := r.client.TaskEvents(r.ctx, taskID, r.turn2SeqBefore)
		durableBySeq := eventsBySeq(durable)
		approvalEvents := countEventTypes(r.liveEventMap(taskID), r.turn2SeqBefore, "approval_requested", "approval_decided") +
			countEventTypes(durableBySeq, 0, "approval_requested", "approval_decided")
		toolUse := r.sawToolUse(taskID, r.turn2SeqBefore) ||
			countEventTypes(durableBySeq, 0, "tool_use") > 0
		s.Observed = map[string]any{
			"approvals_for_task":     history,
			"pending_rows":           pendingRows,
			"pending_query_error":    errText(pendingErr),
			"sweep_error":            errText(allErr),
			"durable_events_checked": len(durable),
			"durable_events_error":   errText(durableErr),
			"approval_events_seen":   approvalEvents,
		}
		if approvalID == "" {
			errMsg := r.lastErrorMessage(taskID)
			verdict := decidePermissionGate(permissionGate{
				historyRows:    len(history),
				sweepErr:       allErr,
				durableErr:     durableErr,
				approvalEvents: approvalEvents,
				toolUse:        toolUse,
				errMsg:         errMsg,
				lastStatus:     lastStatus,
			})
			s.Observed["last_error"] = errMsg
			s.Observed["tool_use_seen"] = toolUse
			for _, e := range verdict.errs {
				s.Errors = append(s.Errors, e)
			}
			if len(verdict.errs) > 0 {
				return false
			}
			s.Status = statusSkipped
			s.Detail = verdict.detail
			if verdict.bypass {
				r.finding("a turn that used the Bash tool completed with no approval_requested or approval_decided event in the live or durable transcript and no approval row; the gate appears bypassed (the daemon's argv includes --allow-yolo, though the probe did not isolate which flag causes it)")
			}
			return false // skipped, not failed — the step is reported as skipped
		}
		decided, err := r.client.Decide(r.ctx, approvalID, "approved")
		if err != nil {
			s.Errors = append(s.Errors, fmt.Sprintf("POST /api/approvals/{id}/decision: %v", err))
			return false
		}
		done, err := r.waitTurn(taskID, taskSnapshot{}, r.cfg.turnTimeout)
		if err != nil {
			s.Errors = append(s.Errors, err.Error())
			return false
		}
		via := ""
		if decided.DecidedVia != nil {
			via = *decided.DecidedVia
		}
		s.Observed["approval_id"] = approvalID
		s.Observed["decision"] = decided.Decision
		s.Observed["decided_via"] = via
		s.Observed["final_status"] = done.Status
		if decided.Decision != "approved" {
			s.Errors = append(s.Errors, "approval decision did not come back approved")
			return false
		}
		return true
	})

	// Step 6 — disconnect, reconnect, catch up from the cursor, match state.
	base.step("reconnect-catchup", func(s *stepResult) bool {
		// The only cursor a client may advance is the one a feed page returned
		// (ADR 0024), so resume from the page consumed in step 2, not from the
		// feed head read now.
		st, err := loadState(r.cfg.statePath)
		if err != nil {
			s.Errors = append(s.Errors, fmt.Sprintf("load state: %v", err))
			return false
		}
		resumeCursor := st.Cursor
		cursorAtDisconnect, err := r.client.Cursor(r.ctx)
		if err != nil {
			s.Errors = append(s.Errors, fmt.Sprintf("GET /api/sessions/cursor: %v", err))
			return false
		}
		// Step 5 may have skipped while its turn was still running (for example,
		// when an approval never came). Do not start the offline turn on top of
		// one that is still in flight.
		prev, err := r.client.Task(r.ctx, taskID)
		if err != nil {
			s.Errors = append(s.Errors, fmt.Sprintf("GET /api/tasks/{id} before disconnect: %v", err))
			return false
		}
		if !isTerminal(prev.Status) {
			if _, err := r.waitTurn(taskID, taskSnapshot{TokensIn: prev.TokensIn, TokensOut: prev.TokensOut, FinishedAt: prev.FinishedAt, HubSeq: prev.HubSeq, Status: prev.Status}, 2*time.Minute); err != nil {
				s.Errors = append(s.Errors, "the previous turn was still running when the disconnect step began: "+err.Error())
				return false
			}
		}
		lastLiveSeq := r.maxLiveSeq(taskID)
		liveGaps := r.liveGaps(taskID)
		r.stopStream()
		// The stream is closed. Make a change while no accelerator is attached.
		queued, err := r.client.FollowUp(r.ctx, taskID, "Reply with exactly: PROBE-OFFLINE. Do not use tools.")
		if err != nil {
			s.Errors = append(s.Errors, fmt.Sprintf("offline POST /api/tasks/{id}/prompt: %v", err))
			return false
		}
		// Use the prompt response as the baseline, not the pre-prompt read: the
		// prompt itself bumps hub_seq, and a baseline that predates it would let
		// waitTurn mistake the old terminal state for the finished new turn.
		if _, err := r.waitTurn(taskID, taskSnapshot{TokensIn: queued.TokensIn, TokensOut: queued.TokensOut, FinishedAt: queued.FinishedAt, HubSeq: queued.HubSeq, Status: queued.Status}, r.cfg.turnTimeout); err != nil {
			s.Errors = append(s.Errors, err.Error())
			return false
		}
		fresh, err := r.client.Task(r.ctx, taskID)
		if err != nil {
			s.Errors = append(s.Errors, fmt.Sprintf("GET /api/tasks/{id}: %v", err))
			return false
		}
		// Documented order: open the stream, then drain the feed.
		r.startStream()
		if err := r.waitStreamReady(5 * time.Second); err != nil {
			s.Errors = append(s.Errors, "the resumed SSE stream is not healthy: "+err.Error())
			return false
		}
		sessions, deleted, feedCursor, pages, err := r.client.DrainFeed(r.ctx, resumeCursor, 500, 0)
		if err != nil {
			s.Errors = append(s.Errors, fmt.Sprintf("catch-up GET /api/sessions: %v", err))
			return false
		}
		if err := r.writeState(func(st *State) { st.Cursor = feedCursor }); err != nil {
			s.Errors = append(s.Errors, err.Error())
			return false
		}
		var feedTask *Task
		for i := range sessions {
			if sessions[i].ID == taskID {
				feedTask = &sessions[i]
			}
		}
		// Read the full transcript before catch-up. Its highest seq is the
		// independent horizon: catch-up, requested afterwards, owes every durable
		// event the full read already saw after lastLiveSeq. Events appended
		// between the two reads (seq above the horizon) are late appends this
		// client could not expect; using catch-up's own highest seq as the horizon
		// would let a truncated response satisfy its own check.
		full, err := r.client.TaskEvents(r.ctx, taskID, 0)
		if err != nil {
			s.Errors = append(s.Errors, fmt.Sprintf("full GET /api/tasks/{id}/events: %v", err))
			return false
		}
		catchup, err := r.client.TaskEvents(r.ctx, taskID, lastLiveSeq)
		if err != nil {
			s.Errors = append(s.Errors, fmt.Sprintf("catch-up GET /api/tasks/{id}/events: %v", err))
			return false
		}
		if streamErr := r.streamError(); streamErr != "" {
			// waitStreamReady only proves the stream opened; it must still be
			// alive after the catch-up work for the reconnect claim to hold.
			s.Errors = append(s.Errors, "the resumed SSE stream failed during catch-up: "+streamErr)
		}
		diff := diffCatchup(full, catchup, lastLiveSeq)
		catchupHorizon := diff.horizon
		expectedCatchup := diff.expected
		catchupMissing := diff.missing
		catchupExtra := diff.extra
		catchupLate := diff.late
		catchupBySeq := eventsBySeq(catchup)
		fullBySeq := eventsBySeq(full)

		// Rebuild state from live + catch-up before repairing anything, so a
		// refetch cannot turn a failed catch-up into a pass. Compare against the
		// full read, so catch-up events above its horizon (appended after it) are
		// not counted either way.
		live := r.liveEventMap(taskID)
		union := map[int64]TaskEvent{}
		for seq, ev := range live {
			union[seq] = ev
		}
		for seq, ev := range catchupBySeq {
			if seq > lastLiveSeq && seq <= catchupHorizon {
				union[seq] = ev
			}
		}
		missingBeforeRepair := missingSeqs(fullBySeq, union)
		textBeforeRepair := slices.Equal(finalAssistantText(union), finalAssistantText(fullBySeq))

		// A dropped SSE frame leaves a gap no contract field reports. A client
		// can only notice it by comparing seq continuity, then refetch from the
		// first hole; record that, repair, and re-check.
		repaired := false
		if len(missingBeforeRepair) > 0 {
			since := missingBeforeRepair[0] - 1
			if since < 0 {
				since = 0
			}
			r.finding("the SSE stream left event seq gap(s) %v; no frame or field signals a drop, so a client must compare seq continuity and refetch from the first hole", missingBeforeRepair)
			repair, err := r.client.TaskEvents(r.ctx, taskID, since)
			if err == nil {
				for _, ev := range repair {
					if ev.Seq <= catchupHorizon {
						union[ev.Seq] = ev
					}
				}
				repaired = true
			}
		}
		missing := missingSeqs(fullBySeq, union)
		unionFinals := finalAssistantText(union)
		fullFinals := finalAssistantText(fullBySeq)
		stateMatch := feedTask != nil &&
			feedTask.Status == fresh.Status &&
			feedTask.TokensIn == fresh.TokensIn &&
			feedTask.TokensOut == fresh.TokensOut &&
			equalInt64Ptr(feedTask.FinishedAt, fresh.FinishedAt)
		s.Observed = map[string]any{
			"resume_cursor_from_feed_page": resumeCursor,
			"cursor_at_disconnect":         cursorAtDisconnect,
			"last_live_seq":                lastLiveSeq,
			"live_seq_gaps_before_close":   liveGaps,
			"feed_pages":                   pages,
			"feed_sessions":                len(sessions),
			"feed_deleted":                 len(deleted),
			"feed_next_cursor":             feedCursor,
			"feed_included_task":           feedTask != nil,
			"catchup_events":               len(catchup),
			"catchup_horizon_seq":          catchupHorizon,
			"catchup_expected_seqs":        len(expectedCatchup),
			"catchup_missing_seqs":         catchupMissing,
			"catchup_extra_seqs":           catchupExtra,
			"catchup_late_append_seqs":     catchupLate,
			"full_events":                  len(full),
			"live_missing_before_repair":   missingBeforeRepair,
			"text_matched_before_repair":   textBeforeRepair,
			"gap_repaired":                 repaired,
			"missing_seqs_after_repair":    missing,
			"feed_state_matches_fresh":     stateMatch,
			"final_text_matches":           slices.Equal(unionFinals, fullFinals),
			"final_text_chars":             len(strings.Join(fullFinals, "\n")),
			"fresh_status":                 fresh.Status,
			"fresh_tokens_in":              fresh.TokensIn,
			"fresh_tokens_out":             fresh.TokensOut,
			"max_event_seq":                maxSeq(full),
			// These describe the stream opened after the reconnect only: the
			// offline turn finished while disconnected, so a healthy resumed
			// stream may legitimately have no task-scoped frames yet.
			"stream_frames_after_resume":    r.frameStatsTotal(),
			"resumed_stream_frames_by_kind": r.frameStats(),
			"resumed_task_frames_by_kind":   r.taskFrameStats(taskID),
			"resumed_stream_error":          r.streamError(),
		}
		if feedTask == nil {
			s.Errors = append(s.Errors, "the change feed from the recorded cursor did not include the probe session")
		}
		for _, problem := range diff.problems(lastLiveSeq) {
			s.Errors = append(s.Errors, problem)
		}
		if !textBeforeRepair {
			r.finding("live+catch-up state differed from the full transcript until the missing seq(s) %v were refetched; a client that trusts the stream and skips the gap check shows the wrong text", missingBeforeRepair)
		}
		if len(missing) > 0 {
			s.Errors = append(s.Errors, fmt.Sprintf("events missing after live+catch-up and repair: %v", missing))
		}
		if !stateMatch {
			s.Errors = append(s.Errors, "feed task state does not match a fresh task read")
		}
		if !slices.Equal(unionFinals, fullFinals) {
			s.Errors = append(s.Errors, "assistant text after repair differs from the full transcript")
		}
		if fresh.Status != "succeeded" {
			s.Errors = append(s.Errors, fmt.Sprintf("offline turn ended %q, want %q", fresh.Status, "succeeded"))
		}
		return len(s.Errors) == 0
	})

	// Cleanup — only ever touches the probe's own task and device. Detach the
	// stream first so cleanup evidence and the final state are stable.
	r.stopStream()
	r.cleanup(taskID)
	return !r.anyFailed()
}

// ---- step bookkeeping ----

type taskContext struct{ r *runner }

func (t *taskContext) step(name string, fn func(*stepResult) bool) {
	r := t.r
	s := &stepResult{Name: name, Status: statusPass}
	start := time.Now()
	fmt.Printf("\n== step: %s\n", name)
	var ok bool
	if r.client == nil && name != "pair" {
		s.Errors = append(s.Errors, "not attempted: pairing did not produce a device client")
	} else {
		ok = fn(s)
	}
	s.DurationMS = time.Since(start).Milliseconds()
	if s.Status == statusSkipped {
		// fn reports a skip by returning false with status set.
	} else if ok {
		s.Status = statusPass
		if s.Detail == "" {
			s.Detail = "ok"
		}
	} else {
		s.Status = statusFail
		if s.Detail == "" {
			s.Detail = "failed"
		}
	}
	fmt.Printf("   %s (%dms) %s\n", strings.ToUpper(s.Status), s.DurationMS, s.Detail)
	for _, e := range s.Errors {
		fmt.Printf("   error: %s\n", e)
	}
	r.ev.Steps = append(r.ev.Steps, s)
}

func (r *runner) anyFailed() bool {
	for _, s := range r.ev.Steps {
		if s.Status == statusFail {
			return true
		}
	}
	return false
}

func (r *runner) finding(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, existing := range r.ev.Findings {
		if existing == msg {
			return
		}
	}
	r.ev.Findings = append(r.ev.Findings, msg)
}

func (r *runner) writeState(mutate func(*State)) error {
	st, err := loadState(r.cfg.statePath)
	if err != nil {
		st = &State{BaseURL: r.cfg.baseURL}
	}
	mutate(st)
	return saveState(r.cfg.statePath, st)
}

// ---- streaming observation ----

func (r *runner) startStream() {
	// Never leave a previous reader attached; stopStream is idempotent.
	r.stopStream()
	ctx, cancel := context.WithCancel(r.ctx)
	ready := make(chan struct{})
	var once sync.Once
	markReady := func() { once.Do(func() { close(ready) }) }
	r.mu.Lock()
	// Frame counters describe the stream that is open now; step 3 and the
	// post-resume check each report their own stream.
	r.frameCounts = map[string]int{}
	r.taskFrames = map[string]map[string]int{}
	r.streamReady = ready
	r.streamErr = nil
	r.streamCancel = cancel
	r.streamDone = make(chan struct{})
	done := r.streamDone
	r.mu.Unlock()
	go func() {
		defer close(done)
		sawFrame := false
		err := r.client.StreamEvents(ctx, func(f SSEFrame) error {
			sawFrame = true
			markReady()
			r.observeFrame(f)
			return nil
		})
		// StreamEvents reports a clean EOF as nil. On a long-lived SSE endpoint
		// that is a closed stream, not success: a 200-then-EOF response must not
		// read as "ready and healthy". An intentional stop cancels ctx and is not
		// an error.
		if err == nil && ctx.Err() == nil {
			if sawFrame {
				err = errors.New("SSE stream closed by the server")
			} else {
				err = errors.New("SSE stream closed before sending any frame")
			}
		}
		// Publish the stream's fate before signalling readiness: a waiter that
		// wakes because the stream died must see the error, not a stale nil.
		r.mu.Lock()
		r.streamErr = err
		if err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
			r.streamErrors = append(r.streamErrors, err.Error())
		}
		r.mu.Unlock()
		markReady()
	}()
}

func (r *runner) stopStream() {
	r.mu.Lock()
	cancel, done := r.streamCancel, r.streamDone
	r.streamCancel, r.streamDone = nil, nil
	r.mu.Unlock()
	if cancel == nil {
		return
	}
	cancel()
	<-done
}

// waitStreamReady blocks until the open stream has produced its first frame
// (the daemon's retry preamble counts) or failed. Without this, a caller can
// create work before the subscription exists and then miss its events.
func (r *runner) waitStreamReady(timeout time.Duration) error {
	r.mu.Lock()
	ready := r.streamReady
	r.mu.Unlock()
	if ready == nil {
		return errors.New("no stream is open")
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-ready:
	case <-timer.C:
		return fmt.Errorf("the SSE stream produced no frame within %s", timeout)
	case <-r.ctx.Done():
		return r.ctx.Err()
	}
	if err := r.streamError(); err != "" {
		return errors.New(err)
	}
	return nil
}

func (r *runner) streamError() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.streamErr == nil {
		return ""
	}
	return r.streamErr.Error()
}

func (r *runner) observeFrame(f SSEFrame) {
	kind := lineKind(f)
	r.mu.Lock()
	r.frameCounts[kind]++
	r.mu.Unlock()

	if f.Event == "" {
		if f.Comment != "" && f.Comment != "ping" {
			r.finding("SSE comment %q is neither documented nor a `: ping` heartbeat", f.Comment)
		}
		return
	}
	msg, err := DecodeWSMessage(f.Data)
	if err != nil {
		r.recordDecodeError("event=%s: %v", f.Event, err)
		return
	}
	if msg.Kind != f.Event {
		r.finding("SSE frame event name %q does not match WSMessage.kind %q", f.Event, msg.Kind)
	}
	switch msg.Kind {
	case "event":
		var ev TaskEvent
		if err := json.Unmarshal(msg.Data, &ev); err != nil {
			r.recordDecodeError("event payload: %v", err)
			return
		}
		if ev.Type == "message" {
			// Validate the payload once on arrival; assistantStats decodes it
			// repeatedly and must stay a pure helper.
			if _, ok := decodeMessage(ev); !ok {
				r.recordDecodeError("message event seq %d: malformed payload", ev.Seq)
			}
		}
		r.mu.Lock()
		var prevEpoch int64
		epochChanged := false
		if prev, seen := r.taskEpoch[ev.TaskID]; seen && prev != ev.EventEpoch {
			// Seq restarts at 1 under a new epoch, so the old live seqs are not
			// comparable with the new ones; keeping them would fake continuity.
			prevEpoch, epochChanged = prev, true
			delete(r.liveEvents, ev.TaskID)
			r.epochChanges = append(r.epochChanges, fmt.Sprintf("%s: %d -> %d", ev.TaskID, prev, ev.EventEpoch))
		}
		r.taskEpoch[ev.TaskID] = ev.EventEpoch
		m := r.liveEvents[ev.TaskID]
		if m == nil {
			m = map[int64]observedEvent{}
			r.liveEvents[ev.TaskID] = m
		}
		m[ev.Seq] = observedEvent{Ev: ev, At: f.At}
		r.incTaskFrameLocked(ev.TaskID, msg.Kind)
		r.mu.Unlock()
		if epochChanged {
			r.finding("task %s changed event_epoch from %d to %d; event seq restarts, so a client must reset its per-task seq state", ev.TaskID, prevEpoch, ev.EventEpoch)
		}
	case "task_update":
		var t Task
		if err := json.Unmarshal(msg.Data, &t); err != nil {
			r.recordDecodeError("task_update payload: %v", err)
			return
		}
		r.mu.Lock()
		r.incTaskFrameLocked(t.ID, msg.Kind)
		r.mu.Unlock()
	case "approval_update":
		var a Approval
		if err := json.Unmarshal(msg.Data, &a); err != nil {
			r.recordDecodeError("approval_update payload: %v", err)
			return
		}
		r.mu.Lock()
		r.liveApproval[a.ID] = a
		r.incTaskFrameLocked(a.TaskID, msg.Kind)
		r.mu.Unlock()
	case "user_question_update", "task_deleted":
		// Parsed by watch; not needed by this acceptance run.
	default:
		r.mu.Lock()
		r.unknownKinds[msg.Kind]++
		r.mu.Unlock()
		r.finding("SSE delivered undocumented message kind %q", msg.Kind)
	}
}

// incTaskFrameLocked counts one frame against the task it belongs to. The
// caller must hold r.mu.
func (r *runner) incTaskFrameLocked(taskID, kind string) {
	m := r.taskFrames[taskID]
	if m == nil {
		m = map[string]int{}
		r.taskFrames[taskID] = m
	}
	m[kind]++
}

func (r *runner) frameStats() map[string]int {
	r.mu.Lock()
	defer r.mu.Unlock()
	frames := map[string]int{}
	for k, v := range r.frameCounts {
		frames[k] = v
	}
	return frames
}

func (r *runner) taskFrameStats(taskID string) map[string]int {
	r.mu.Lock()
	defer r.mu.Unlock()
	frames := map[string]int{}
	for k, v := range r.taskFrames[taskID] {
		frames[k] = v
	}
	return frames
}

func (r *runner) taskFramesSnapshot() map[string]map[string]int {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make(map[string]map[string]int, len(r.taskFrames))
	for task, frames := range r.taskFrames {
		cp := make(map[string]int, len(frames))
		for k, v := range frames {
			cp[k] = v
		}
		out[task] = cp
	}
	return out
}

func (r *runner) recordDecodeError(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	r.mu.Lock()
	defer r.mu.Unlock()
	r.decodeErrors = append(r.decodeErrors, msg)
}

func (r *runner) streamErrorsSnapshot() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.streamErrors...)
}

func (r *runner) decodeErrorsSnapshot() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.decodeErrors...)
}

func (r *runner) epochChangesSnapshot() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.epochChanges...)
}

func (r *runner) frameStatsTotal() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	total := 0
	for _, v := range r.frameCounts {
		total += v
	}
	return total
}

func (r *runner) liveEventCount(taskID string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.liveEvents[taskID])
}

func (r *runner) liveEventMap(taskID string) map[int64]TaskEvent {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := map[int64]TaskEvent{}
	for seq, ob := range r.liveEvents[taskID] {
		out[seq] = ob.Ev
	}
	return out
}

func (r *runner) maxLiveSeq(taskID string) int64 {
	var max int64
	for _, ev := range r.liveEventMap(taskID) {
		if ev.Seq > max {
			max = ev.Seq
		}
	}
	return max
}

func (r *runner) pendingApproval(taskID string) (*Approval, error) {
	var queryErr error
	if list, err := r.client.Approvals(r.ctx, "pending"); err != nil {
		queryErr = err
	} else {
		for i := range list {
			// Trust the decision field, not the query name: a server that ignores
			// ?status=pending must not hand the client an already-decided row.
			if list[i].TaskID == taskID && list[i].Decision == "" {
				return &list[i], nil
			}
		}
	}
	// The live approval_update frame is a fallback when the list is empty or
	// unreadable; the caller still receives the query error so it can tell a
	// genuinely absent approval from an unverified one.
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, a := range r.liveApproval {
		if a.TaskID == taskID && a.Decision == "" {
			cp := a
			return &cp, queryErr
		}
	}
	return nil, queryErr
}

type assistantStats struct {
	partials     int
	partialBytes int
	partialText  string
	finals       int
	finalChars   int
	finalText    string
	firstAt      time.Time
	lastAt       time.Time
}

func (r *runner) assistantStats(taskID string, sinceSeq int64) assistantStats {
	r.mu.Lock()
	events := map[int64]TaskEvent{}
	arrival := map[int64]time.Time{}
	for seq, ob := range r.liveEvents[taskID] {
		if seq > sinceSeq {
			events[seq] = ob.Ev
			arrival[seq] = ob.At
		}
	}
	r.mu.Unlock()
	seqs := make([]int64, 0, len(events))
	for seq := range events {
		seqs = append(seqs, seq)
	}
	sort.Slice(seqs, func(i, j int) bool { return seqs[i] < seqs[j] })
	var st assistantStats
	var partial strings.Builder
	var finals []string
	for _, seq := range seqs {
		msg, ok := decodeMessage(events[seq])
		if !ok || msg.Role != "assistant" {
			continue
		}
		text := textOf(msg)
		if msg.Partial {
			if text == "" {
				continue
			}
			st.partials++
			st.partialBytes += len(text)
			partial.WriteString(text)
			at := arrival[seq]
			if st.firstAt.IsZero() {
				st.firstAt = at
			}
			st.lastAt = at
			continue
		}
		if text != "" {
			st.finals++
			finals = append(finals, text)
		}
	}
	st.partialText = partial.String()
	st.finalText = strings.Join(finals, "\n")
	st.finalChars = len(st.finalText)
	return st
}

func decodeMessage(ev TaskEvent) (MessagePayload, bool) {
	if ev.Type != "message" {
		return MessagePayload{}, false
	}
	var p MessagePayload
	if err := json.Unmarshal(ev.Payload, &p); err != nil {
		return MessagePayload{}, false
	}
	return p, true
}

func textOf(p MessagePayload) string {
	var b strings.Builder
	for _, c := range p.Content {
		if c.Type == "text" {
			b.WriteString(c.Text)
		}
	}
	return b.String()
}

func finalAssistantText(events map[int64]TaskEvent) []string {
	seqs := make([]int64, 0, len(events))
	for seq := range events {
		seqs = append(seqs, seq)
	}
	sort.Slice(seqs, func(i, j int) bool { return seqs[i] < seqs[j] })
	var out []string
	for _, seq := range seqs {
		msg, ok := decodeMessage(events[seq])
		if !ok || msg.Role != "assistant" || msg.Partial {
			continue
		}
		if text := textOf(msg); text != "" {
			out = append(out, text)
		}
	}
	return out
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

// missingSeqs lists the seqs present in full but absent from union, ascending.
func missingSeqs(full, union map[int64]TaskEvent) []int64 {
	var missing []int64
	for seq := range full {
		if _, ok := union[seq]; !ok {
			missing = append(missing, seq)
		}
	}
	sort.Slice(missing, func(i, j int) bool { return missing[i] < missing[j] })
	return missing
}

// catchupDiff compares a catch-up response with the durable transcript read
// just before it. expected is what catch-up owed the client: every event the
// full read already contained after lastLiveSeq. Events above the horizon were
// appended after that read and cannot be required of catch-up; an event inside
// the horizon that the full read lacks means the two endpoints disagree.
type catchupDiff struct {
	horizon  int64
	expected map[int64]TaskEvent
	missing  []int64
	extra    []int64
	late     []int64
}

func diffCatchup(full, catchup []TaskEvent, lastLiveSeq int64) catchupDiff {
	catchupBySeq := eventsBySeq(catchup)
	d := catchupDiff{horizon: maxSeq(full), expected: map[int64]TaskEvent{}}
	for seq, ev := range eventsBySeq(full) {
		if seq > lastLiveSeq {
			d.expected[seq] = ev
		}
	}
	d.missing = missingSeqs(d.expected, catchupBySeq)
	for seq := range catchupBySeq {
		if _, ok := d.expected[seq]; ok {
			continue
		}
		if seq > d.horizon {
			d.late = append(d.late, seq)
			continue
		}
		d.extra = append(d.extra, seq)
	}
	sort.Slice(d.extra, func(i, j int) bool { return d.extra[i] < d.extra[j] })
	sort.Slice(d.late, func(i, j int) bool { return d.late[i] < d.late[j] })
	return d
}

// problems lists the reasons a catch-up response failed its check. The horizon
// comes from the full transcript, so a truncated catch-up cannot define its own
// passing expectation.
func (d catchupDiff) problems(lastLiveSeq int64) []string {
	var out []string
	if len(d.missing) > 0 {
		out = append(out, fmt.Sprintf("catch-up missed events after seq %d: %v", lastLiveSeq, d.missing))
	}
	if len(d.extra) > 0 {
		out = append(out, fmt.Sprintf("catch-up returned events the full transcript (max seq %d) does not contain: %v", d.horizon, d.extra))
	}
	if len(d.expected) == 0 {
		out = append(out, fmt.Sprintf("catch-up from seq %d had no events to verify (full transcript ends at %d); the reconnect check had nothing to prove", lastLiveSeq, d.horizon))
	}
	return out
}

// lastErrorMessage returns the message of the highest-seq `error` event for a
// task, using the live stream first and the durable endpoint as fallback.
func (r *runner) lastErrorMessage(taskID string) string {
	var bestSeq int64
	var msg string
	for seq, ev := range r.liveEventMap(taskID) {
		if ev.Type != "error" || seq < bestSeq {
			continue
		}
		if m := errorMessage(ev); m != "" {
			bestSeq, msg = seq, m
		}
	}
	if msg != "" {
		return msg
	}
	events, err := r.client.TaskEvents(r.ctx, taskID, 0)
	if err != nil {
		return ""
	}
	for _, ev := range events {
		if ev.Type == "error" {
			if m := errorMessage(ev); m != "" {
				msg = m
			}
		}
	}
	return msg
}

// permissionGate is what step 5 knows when no approval row was found.
type permissionGate struct {
	historyRows    int
	sweepErr       error  // the unfiltered approvals query
	durableErr     error  // reading the durable transcript
	approvalEvents int    // approval_* events seen live or durable
	toolUse        bool   // a tool_use event seen live or durable
	errMsg         string // the turn's error event, if any
	lastStatus     string // the last status read of the task
}

// permissionVerdict is the step's conclusion: fail (errs), skip (detail), and
// whether the undocumented-behavior finding is supported.
type permissionVerdict struct {
	skip   bool
	detail string
	errs   []string
	bypass bool
}

// decidePermissionGate decides why no approval was available. The durable
// transcript is the authority for the bypass claim, so a failed durable read
// must fail the step even when the live stream happened to show a tool: the
// live stream has known holes, and an approval event could be in the part it
// missed. Only a successful durable read can support "no approval was asked".
func decidePermissionGate(g permissionGate) permissionVerdict {
	switch {
	case g.sweepErr != nil:
		// Without the sweep, "no approval exists" is unverified; do not turn a
		// broken route into an undocumented-behavior finding.
		return permissionVerdict{errs: []string{"could not read approvals, so the skip reason is unverified: " + g.sweepErr.Error()}}
	case g.historyRows > 0:
		return permissionVerdict{skip: true, detail: "no pending request; the approval rows for this task are already decided"}
	case g.errMsg != "":
		return permissionVerdict{skip: true, detail: "no permission request: the turn failed first: " + truncate(g.errMsg, 240)}
	case g.approvalEvents > 0:
		return permissionVerdict{errs: []string{fmt.Sprintf("the transcript has %d approval event(s) but no approval row could be read", g.approvalEvents)}}
	case g.durableErr != nil:
		return permissionVerdict{errs: []string{"could not read the durable transcript to determine whether an approval was requested: " + g.durableErr.Error()}}
	case g.toolUse:
		return permissionVerdict{skip: true, bypass: true, detail: "the turn used a tool but no approval was requested; the permission gate appears bypassed"}
	case g.lastStatus != "" && !isTerminal(g.lastStatus):
		return permissionVerdict{skip: true, detail: "no permission request appeared while the turn was still running; no tool was used"}
	default:
		return permissionVerdict{skip: true, detail: "the turn ended without using a tool, so no approval could be requested"}
	}
}

func errorMessage(ev TaskEvent) string {
	var p struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal(ev.Payload, &p); err != nil {
		return ""
	}
	return p.Message
}

// sawToolUse reports whether any tool_use event arrived after seq.
func (r *runner) sawToolUse(taskID string, sinceSeq int64) bool {
	return countEventTypes(r.liveEventMap(taskID), sinceSeq, "tool_use") > 0
}

func countEventTypes(events map[int64]TaskEvent, sinceSeq int64, types ...string) int {
	want := make(map[string]bool, len(types))
	for _, t := range types {
		want[t] = true
	}
	n := 0
	for seq, ev := range events {
		if seq > sinceSeq && want[ev.Type] {
			n++
		}
	}
	return n
}

func eventsBySeq(events []TaskEvent) map[int64]TaskEvent {
	out := make(map[int64]TaskEvent, len(events))
	for _, ev := range events {
		out[ev.Seq] = ev
	}
	return out
}

func errText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// liveGaps reports holes in the seq range the live stream delivered, which is
// the only way a client can notice a dropped SSE frame.
func (r *runner) liveGaps(taskID string) []int64 {
	live := r.liveEventMap(taskID)
	var gaps []int64
	var max int64
	for seq := range live {
		if seq > max {
			max = seq
		}
	}
	for seq := int64(1); seq <= max; seq++ {
		if _, ok := live[seq]; !ok {
			gaps = append(gaps, seq)
		}
	}
	return gaps
}

// ---- turn handling ----

type taskSnapshot struct {
	TokensIn   int64
	TokensOut  int64
	FinishedAt *int64
	HubSeq     *int64
	Status     string
}

func (r *runner) waitTurn(taskID string, base taskSnapshot, timeout time.Duration) (Task, error) {
	deadline := time.Now().Add(timeout)
	sawRunning := false
	var last Task
	started := time.Now()
	for time.Now().Before(deadline) {
		t, err := r.client.Task(r.ctx, taskID)
		if err != nil {
			if r.ctx.Err() != nil {
				return last, r.ctx.Err()
			}
			if err := sleepCtx(r.ctx, time.Second); err != nil {
				return last, err
			}
			continue
		}
		last = *t
		if !isTerminal(t.Status) {
			sawRunning = true
		}
		tokensChanged := t.TokensIn != base.TokensIn || t.TokensOut != base.TokensOut
		finishedChanged := !equalInt64Ptr(t.FinishedAt, base.FinishedAt)
		hubChanged := !equalInt64Ptr(t.HubSeq, base.HubSeq)
		if isTerminal(t.Status) && (sawRunning || tokensChanged || finishedChanged || hubChanged) && time.Since(started) > time.Second {
			return *t, nil
		}
		if err := sleepCtx(r.ctx, 750*time.Millisecond); err != nil {
			return last, err
		}
	}
	return last, fmt.Errorf("turn on task %s did not reach a terminal state within %s (last status %q)", taskID, timeout, last.Status)
}

// isTerminal reports whether a Task.status value ends a turn. The contract
// publishes no enum for status, so this list is inferred from the wire; an
// unknown value is treated as terminal so a new state cannot hang the probe.
func isTerminal(status string) bool {
	switch status {
	case "queued", "running", "starting", "pending", "waiting", "":
		return false
	}
	return true
}

// isFinal reports a status that means the turn is over. isTerminal is the
// inverse allowlist used for polling and deliberately treats an unknown status
// as terminal; that would misread a paused-on-approval status as finished.
func isFinal(status string) bool {
	switch status {
	case "succeeded", "failed", "cancelled", "canceled", "error":
		return true
	}
	return false
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

func equalInt64Ptr(a, b *int64) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// ---- cleanup, evidence, summary ----

func (r *runner) cleanup(taskID string) {
	if r.cfg.noCleanup {
		r.ev.Cleanup = append(r.ev.Cleanup, "skipped: -no-cleanup")
		return
	}
	if r.client == nil {
		r.ev.Cleanup = append(r.ev.Cleanup, "nothing to clean up: pairing never produced a client")
		return
	}
	// Cleanup must survive Ctrl-C and an expired run context: deleting the probe
	// task and revoking its device are exactly what a cancelled run owes.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.ctx), 20*time.Second)
	defer cancel()
	if taskID != "" {
		var apiErr *APIError
		devErr := r.client.DeleteTask(ctx, taskID)
		deleted := false
		switch {
		case devErr == nil:
			r.ev.Cleanup = append(r.ev.Cleanup, "DELETE /api/tasks/{id} succeeded with the device token (undocumented route)")
			deleted = true
		case errors.As(devErr, &apiErr):
			r.ev.Cleanup = append(r.ev.Cleanup, fmt.Sprintf("DELETE /api/tasks/{id} with the device token -> %d", apiErr.Status))
		default:
			r.ev.Cleanup = append(r.ev.Cleanup, "device delete failed: "+devErr.Error())
		}
		if !deleted && r.master != "" {
			if err := r.client.DeleteTaskAs(ctx, taskID, r.master); err == nil {
				r.ev.Cleanup = append(r.ev.Cleanup, "DELETE /api/tasks/{id} succeeded with the master token (undocumented; a device token is refused)")
				if apiErr != nil {
					// Derive the status from the observed response rather than
					// hard-coding 403; a different refusal is a different fact.
					r.finding("DELETE /api/tasks/{id} exists and needs the master credential (device token -> %d), so a paired client can never delete its own session even though the contract documents no delete path at all", apiErr.Status)
				}
				deleted = true
			} else {
				r.ev.Cleanup = append(r.ev.Cleanup, "master delete failed: "+err.Error())
			}
		}
		if !deleted {
			if err := r.client.ArchiveTask(ctx, taskID); err != nil {
				r.ev.Cleanup = append(r.ev.Cleanup, "archive failed: "+err.Error())
			} else {
				r.ev.Cleanup = append(r.ev.Cleanup, "POST /api/tasks/{id}/archive succeeded")
			}
		}
	}
	// Only the device this run paired; never a device id left in the state file
	// by an earlier run. r.client exists only after a successful exchange, which
	// also sets r.deviceID.
	deviceID := r.deviceID
	if deviceID == "" {
		r.ev.Cleanup = append(r.ev.Cleanup, "device not revoked: this run has no paired device id")
		return
	}
	if r.master == "" {
		r.ev.Cleanup = append(r.ev.Cleanup, "device not revoked: no master token")
		return
	}
	if err := r.client.RevokeDevice(ctx, deviceID, r.master); err != nil {
		r.ev.Cleanup = append(r.ev.Cleanup, "revoke probe device failed: "+err.Error())
		return
	}
	r.ev.Cleanup = append(r.ev.Cleanup, "POST /api/devices/{id}/revoke succeeded for "+deviceID)
	_ = r.writeState(func(s *State) { clearStateForDevice(s, deviceID) })
}

// clearStateForDevice drops the saved credential only when the state file still
// belongs to the device this run revoked. Another probe run may have paired and
// saved a new token while this one was cleaning up; blanking that would break it.
func clearStateForDevice(st *State, deviceID string) {
	if deviceID == "" || st.DeviceID != deviceID {
		return
	}
	st.Token = ""
	st.DeviceID = ""
}

func writeEvidence(path string, ev *evidence) error {
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	data, err := json.MarshalIndent(ev, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}

// collectRunErrors turns failures that do not belong to one step into
// run-level errors, so a stream that dies mid-run cannot still exit as a pass.
func (r *runner) collectRunErrors() {
	for _, e := range r.streamErrorsSnapshot() {
		r.runErrors = append(r.runErrors, "stream: "+e)
	}
	for _, e := range r.decodeErrorsSnapshot() {
		r.runErrors = append(r.runErrors, "decode: "+e)
	}
	if changes := r.epochChangesSnapshot(); len(changes) > 0 {
		r.runErrors = append(r.runErrors, "event_epoch changed during the run ("+strings.Join(changes, "; ")+"); seq baselines are not comparable across epochs")
	}
}

func (r *runner) printSummary() (failed, skipped int) {
	fmt.Printf("\n===== acceptance summary =====\n")
	for i, s := range r.ev.Steps {
		fmt.Printf("%d. %-28s %-7s %6dms  %s\n", i+1, s.Name, s.Status, s.DurationMS, s.Detail)
		switch s.Status {
		case statusFail:
			failed++
		case statusSkipped:
			skipped++
		}
	}
	fmt.Printf("undocumented behaviors: %d\n", len(r.ev.Findings))
	for i, f := range r.ev.Findings {
		fmt.Printf("  %d. %s\n", i+1, f)
	}
	if len(r.ev.Cleanup) > 0 {
		fmt.Printf("cleanup:\n")
		for _, c := range r.ev.Cleanup {
			fmt.Printf("  - %s\n", c)
		}
	}
	if len(r.runErrors) > 0 {
		fmt.Printf("run errors:\n")
		for _, e := range r.runErrors {
			fmt.Printf("  - %s\n", e)
		}
	}
	fmt.Printf("client peak RSS: %.1f MiB\n", float64(r.ev.RSSBytes)/(1024*1024))
	if len(r.runErrors) > 0 {
		fmt.Printf("RESULT: FAIL (%d run error(s), %d failed step(s), %d skipped)\n", len(r.runErrors), failed, skipped)
		return failed + len(r.runErrors), skipped
	}
	switch {
	case failed > 0:
		fmt.Printf("RESULT: FAIL (%d failed step(s), %d skipped)\n", failed, skipped)
	case skipped > 0:
		fmt.Printf("RESULT: PASS WITH SKIPS (%d step(s) could not be exercised)\n", skipped)
	default:
		fmt.Printf("RESULT: PASS\n")
	}
	return failed, skipped
}

func rssBytes() int64 {
	var ru syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &ru); err != nil {
		return 0
	}
	// Darwin reports ru_maxrss in bytes; Linux in KiB (verified against ps on
	// darwin: a 3.9 MiB process reported 4,030,464).
	if runtime.GOOS == "darwin" {
		return ru.Maxrss
	}
	return ru.Maxrss * 1024
}

func absPath(p string) string {
	a, err := filepath.Abs(p)
	if err != nil {
		return p
	}
	return a
}
