package acp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/adapter/rpcstdio"
	"github.com/vuuihc/openkin/internal/approvalbridge"
)

const (
	// defaultCancelGrace is how long the agent has to honour `session/cancel`
	// before it is asked to stop with a signal. The protocol has no cancellation
	// timeout and admits that an agent may ignore the notification entirely, so
	// the deadline is Kin's own.
	defaultCancelGrace = 3 * time.Second
	// defaultKillGrace is how long after SIGTERM the process group gets SIGKILL.
	defaultKillGrace = 5 * time.Second
	// defaultEventBuffer is how far the reader may fall behind before the agent
	// blocks on its own output. The console's reader is the engine's run loop,
	// which does store writes; this is what keeps a slow disk from looking like a
	// slow agent.
	defaultEventBuffer = 128
)

// Adapter runs an ACP agent as a subprocess and speaks the Agent Client
// Protocol to it over stdin/stdout.
//
// One Adapter is one agent (one binary), configured once at registration: the
// protocol is per-process, so the "which agent" question is answered by which
// adapter is started, not by a field on the request.
type Adapter struct {
	Binary   string
	Args     []string
	LookPath func(file string) (string, error)
	// DaemonURL and Token are this machine's own daemon, where the approval
	// inbox lives. They are the same two values every other adapter bridges
	// through (internal/approvalbridge).
	DaemonURL  string
	Token      string
	TokenFunc  func() string
	HTTPClient *http.Client
	// Version is this daemon's version, reported to the agent as clientInfo.
	Version string
	// CancelGrace and KillGrace bound the two stages of stopping a turn that
	// will not stop itself. Zero means the defaults above.
	CancelGrace time.Duration
	KillGrace   time.Duration
}

// New returns an adapter for the named ACP binary.
func New(binary string) *Adapter {
	return &Adapter{Binary: binary}
}

// errCanceled is what a send returns once the turn has been stopped. Callers
// treat it as "nothing was written", which is what it means: the failure paths
// that report a write error already stay quiet for a cancelled run.
var errCanceled = errors.New("the turn was cancelled")

// AutoApprovesAll reports that a mode meaning "stop asking" cannot be honoured
// for this agent, so a Node must treat such a turn as one with approvals
// bypassed.
//
// What Kin can promise here is only half the question. Kin approves nothing on
// its own: a question the agent asks becomes a person's decision or a refusal
// (ADR 0022 D1), and no mode changes that. But the schema makes the *question*
// the agent's choice — an agent may run a tool call without asking anybody — so
// an agent started with a mode that means "stop asking" can end up executing
// every call unattended, and Kin would not be in the loop to notice. The
// ceiling exists so that the machine's operator decides whether unattended
// execution happens on their machine (see the executor's refusal), which means
// the honest answer for yolo and accept_edits is yes: Kin cannot apply them and
// cannot promise they are gated either.
//
// The default mode is a different matter: the agent is expected to ask, and
// when it does a person answers. Dispatches in default mode are not refused.
func (a *Adapter) AutoApprovesAll(mode string) bool {
	return adapter.NormalizePermissionMode(mode) != adapter.PermissionDefault
}

// Start implements adapter.Adapter.
func (a *Adapter) Start(ctx context.Context, spec adapter.TaskSpec) (adapter.RunHandle, error) {
	if spec.ProviderCfg != nil && strings.TrimSpace(spec.ProviderCfg.Kind) != "" &&
		strings.TrimSpace(spec.ProviderCfg.Kind) != "subscription" {
		return nil, errors.New("ACP agents manage their own authentication; " +
			"Kin does not route provider keys into them")
	}
	bin := strings.TrimSpace(a.Binary)
	if bin == "" {
		return nil, errors.New("no ACP agent binary configured")
	}
	look := a.LookPath
	if look == nil {
		look = exec.LookPath
	}
	path, err := look(bin)
	if err != nil {
		return nil, fmt.Errorf("ACP agent %q not found on PATH: %w", bin, err)
	}

	cmd := exec.CommandContext(ctx, path, a.Args...)
	cmd.Dir = spec.Cwd
	cmd.Env = os.Environ()
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("acp stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("acp stdout pipe: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, fmt.Errorf("acp stderr pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start %s: %w", bin, err)
	}

	runCtx, cancelRun := context.WithCancel(ctx)
	token := a.Token
	if a.TokenFunc != nil {
		if current := strings.TrimSpace(a.TokenFunc()); current != "" {
			token = current
		}
	}
	h := &handle{
		cmd:         cmd,
		stdin:       stdin,
		conn:        rpcstdio.NewConn(stdin, "kin-"),
		ch:          make(chan adapter.Event, defaultEventBuffer),
		done:        make(chan struct{}),
		cancelRun:   cancelRun,
		cancelGrace: durationOr(a.CancelGrace, defaultCancelGrace),
		killGrace:   durationOr(a.KillGrace, defaultKillGrace),
	}
	h.bridge = newApprovalBridge(&approvalbridge.Client{
		DaemonURL:  strings.TrimRight(a.DaemonURL, "/"),
		Token:      token,
		HTTPClient: a.HTTPClient,
	}, spec)

	var ioWG sync.WaitGroup
	ioWG.Add(2)
	go func() {
		defer ioWG.Done()
		h.scanStdout(runCtx, stdout, spec)
	}()
	go func() {
		defer ioWG.Done()
		h.scanStderr(stderr)
	}()
	go func() {
		ioWG.Wait()
		waitErr := cmd.Wait()
		cancelRun()
		// The read loops are done, so no new reverse request can start; the ones
		// already running are answering a question nobody is waiting for any
		// more, and the process they would answer into is gone.
		h.requestWG.Wait()
		h.stateMu.Lock()
		if cmd.ProcessState != nil {
			code := cmd.ProcessState.ExitCode()
			h.exitCode = &code
		}
		h.stateMu.Unlock()
		h.finish(waitErr)
	}()

	if _, err := h.send(ctx, methodInitialize, initializeParams{
		ProtocolVersion: protocolVersion,
		ClientInfo:      implementation{Name: clientName, Version: a.Version},
	}); err != nil {
		h.stopProcess()
		return nil, fmt.Errorf("initialize %s: %w", bin, err)
	}
	return h, nil
}

type handle struct {
	cmd         *exec.Cmd
	stdin       io.WriteCloser
	conn        *rpcstdio.Conn
	ch          chan adapter.Event
	done        chan struct{}
	cancelRun   context.CancelFunc
	cancelGrace time.Duration
	killGrace   time.Duration
	bridge      *approvalBridge

	requestWG sync.WaitGroup

	stateMu       sync.Mutex
	canceled      bool
	sawResult     bool
	reportedError bool
	// eventsClosed is set once the run is over and its channel is about to close,
	// so a late diagnostic drops itself instead of panicking on a closed channel.
	eventsClosed bool
	// replaying is set while `session/load` is in flight. The protocol requires
	// an agent to replay the entire conversation as session/update
	// notifications, which are indistinguishable from live ones; appending them
	// would write the whole history into the transcript a second time.
	replaying bool
	// replayed counts what came back during a load, so a load that replays
	// nothing is visible in the transcript rather than silently trusted.
	replayed  int
	sessionID string
	// canLoad is whether the agent advertised `session/load` in its initialize
	// response. Asking an agent that never claimed the capability is how a resume
	// becomes an error at the start of a turn instead of a fresh session.
	canLoad  bool
	exitCode *int

	cancelOnce    sync.Once
	closeOnce     sync.Once
	terminateOnce sync.Once
}

func (h *handle) Events() <-chan adapter.Event { return h.ch }

// ExitCode returns the agent's exit code once Events is closed.
func (h *handle) ExitCode() *int {
	h.stateMu.Lock()
	defer h.stateMu.Unlock()
	return h.exitCode
}

// Cancel stops the turn.
//
// The order matters and is the protocol's: the `session/cancel` notification
// goes out first, and the connection stays open afterwards, because the spec
// requires every pending `session/request_permission` to be answered with a
// `cancelled` outcome — a client that closed the pipe here would leave the
// agent waiting on a question forever. The deadline only starts once that has
// had its chance to arrive.
func (h *handle) Cancel() error {
	h.cancelOnce.Do(func() {
		h.stateMu.Lock()
		h.canceled = true
		sessionID := h.sessionID
		h.stateMu.Unlock()

		// The notification is written before the run context is released, not
		// after: releasing it is what makes a pending permission bridge answer
		// itself, and that answer would otherwise overtake the cancel — leaving an
		// agent told "cancelled" by a client that never said why.
		if sessionID != "" {
			if err := h.write(notificationEnvelope(methodSessionCancel,
				map[string]any{"sessionId": sessionID})); err != nil {
				h.warn("session/cancel: %v", err)
			}
		}
		// Releasing the turn's context is what makes the pending permission
		// bridges stop waiting and answer `cancelled` — the cascade the spec
		// demands, done by the one thing every waiter already selects on.
		h.cancelRun()
		h.scheduleTermination(h.cancelGrace)
	})
	return nil
}

// scanStdout is the protocol's read loop: every message the agent sends arrives
// here, and which of the three JSON-RPC shapes it is decides what happens next.
func (h *handle) scanStdout(ctx context.Context, r io.Reader, spec adapter.TaskSpec) {
	scanner := rpcstdio.Scanner(r)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.TrimSpace(line) == "" {
			continue
		}
		var env envelope
		if err := json.Unmarshal([]byte(line), &env); err != nil {
			h.emit(rawOutput(line))
			continue
		}
		switch {
		case env.isRequest():
			h.handleAgentRequest(ctx, env)
		case env.Method != "":
			h.handleNotification(env)
		default:
			h.handleResponse(env, spec)
		}
	}
	if err := scanner.Err(); err != nil {
		h.stopWithError("read ACP agent stdout: " + err.Error())
	}
}

func (h *handle) scanStderr(r io.Reader) {
	scanner := rpcstdio.Scanner(r)
	for scanner.Scan() {
		if line := scanner.Text(); strings.TrimSpace(line) != "" {
			h.emit(adapter.Event{
				Type:    "raw_output",
				Payload: mustMarshal(map[string]string{"line": line, "stream": "stderr"}),
			})
		}
	}
	if err := scanner.Err(); err != nil {
		h.stopWithError("read ACP agent stderr: " + err.Error())
	}
}

// handleNotification is the streaming path: `session/update` is where a turn's
// output arrives.
func (h *handle) handleNotification(env envelope) {
	if env.Method != methodSessionUpdate {
		// The protocol defines no other notification from agent to client. An
		// unknown one is recorded rather than dropped, so a newer agent's
		// additions are visible in the transcript instead of looking like a
		// stall.
		h.emit(rawOutput(string(mustMarshal(env))))
		return
	}
	var note sessionNotification
	if err := json.Unmarshal(env.Params, &note); err != nil {
		h.emit(rawOutput(string(env.Params)))
		return
	}
	h.stateMu.Lock()
	replaying := h.replaying
	if replaying {
		h.replayed++
	}
	h.stateMu.Unlock()
	if replaying {
		// A load's replay: the transcript already has this.
		return
	}
	for _, event := range mapUpdate(note.Update) {
		h.noteEvent(event)
		h.emit(event)
	}
}

// handleAgentRequest answers a request from the agent. Today that is exactly
// one method, the permission question.
func (h *handle) handleAgentRequest(ctx context.Context, env envelope) {
	h.requestWG.Add(1)
	go func() {
		defer h.requestWG.Done()
		var response envelope
		switch env.Method {
		case methodRequestPerm:
			var request permissionRequest
			if err := json.Unmarshal(env.Params, &request); err != nil {
				response = errorEnvelope(env.ID, methodInvalidParams, "unreadable permission request")
				break
			}
			outcome, recorded := h.bridge.requestPermission(ctx, request)
			if !recorded {
				// No row anywhere: nobody was asked, so this is the only record
				// that the agent asked and what it was told. A notice, not
				// `approval_requested` — the console draws that event as
				// "needs your approval" and would send the reader looking for a
				// card that was never created. When the bridge did create one,
				// the owner of that row writes the canonical event instead, and
				// a second copy here would land after the question was already
				// answered.
				h.emit(permissionNotice(request, outcome))
			}
			response = responseEnvelope(env.ID, outcome)
		default:
			// Kin advertises no fs or terminal capability, so a well-behaved
			// agent never asks. Answering "not found" is what tells a
			// misbehaving one to stop asking.
			response = errorEnvelope(env.ID, methodMethodNotFound, "method not found")
		}
		// The answer goes out even when the turn has been cancelled: a pending
		// permission request answered with anything else, or with nothing at
		// all, is what the protocol forbids.
		if err := h.write(response); err != nil {
			h.warn("%s response: %v", env.Method, err)
		}
	}()
}

// handleResponse advances the turn: every step of a session is the answer to
// the request before it.
func (h *handle) handleResponse(env envelope, spec adapter.TaskSpec) {
	// A cancelled turn stops advancing here. Without this, a cancel that arrives
	// in the window before the session exists — the one window with nothing to
	// send `session/cancel` about — would still walk the rest of the pipeline and
	// hand the agent a full prompt: work done for a turn the user already stopped,
	// and a cancel notification it never gets because there was no session yet.
	if h.isCanceled() {
		return
	}
	method := h.conn.Take(env.idString())
	if method == "" {
		// Not an answer to anything Kin asked: a duplicate, or an id the agent
		// chose for itself.
		h.emit(rawOutput(string(mustMarshal(env))))
		return
	}
	if env.Error != nil {
		h.stopWithError(fmt.Sprintf("%s failed: %s", method, env.Error.Error()))
		return
	}

	switch method {
	case methodInitialize:
		var result initializeResult
		if err := json.Unmarshal(env.Result, &result); err != nil {
			h.stopWithError("decode initialize result: " + err.Error())
			return
		}
		// The protocol refuses a version it does not speak instead of
		// negotiating down; so does Kin, and it says which side is which.
		if result.ProtocolVersion != protocolVersion {
			h.stopWithError(fmt.Sprintf(
				"the agent speaks ACP version %d and Kin speaks %d",
				result.ProtocolVersion, protocolVersion))
			return
		}
		if result.AgentCapabilities.LoadSession {
			h.stateMu.Lock()
			h.canLoad = true
			h.stateMu.Unlock()
		}
		h.startSession(spec)

	case methodSessionNew, methodSessionLoad:
		var result sessionResult
		if err := json.Unmarshal(env.Result, &result); err != nil {
			h.stopWithError("decode " + method + " result: " + err.Error())
			return
		}
		if strings.TrimSpace(result.SessionID) == "" {
			h.stopWithError(method + " returned no session id")
			return
		}
		h.stateMu.Lock()
		replayed := h.replayed
		h.stateMu.Unlock()
		h.stateMu.Lock()
		h.sessionID = result.SessionID
		h.stateMu.Unlock()

		ref := result.SessionID
		if method == methodSessionLoad {
			ref = firstNonEmpty(spec.SessionRef, result.SessionID)
			if replayed == 0 {
				// The capability was advertised and the agent replayed nothing.
				// The conversation Kin is continuing may not be the one the
				// agent just loaded, and saying so is cheaper than a turn that
				// quietly answers a question from a context nobody can see.
				h.emit(noticeEvent("session loaded without replay",
					"the agent did not replay the conversation it loaded; "+
						"the next turn may not have the earlier context"))
			}
		}
		h.emit(startedEvent(ref, spec.Model))
		h.applyModel(spec, result)

	case methodSetConfigOption:
		h.sendPrompt(spec)

	case methodSessionPrompt:
		var result promptResult
		if err := json.Unmarshal(env.Result, &result); err != nil {
			h.stopWithError("decode session/prompt result: " + err.Error())
			return
		}
		h.finishTurn(result)
	}
}

// startSession opens the session this turn runs in: the task's own session when
// there is one and the agent can load it, a new one otherwise.
func (h *handle) startSession(spec adapter.TaskSpec) {
	// A permission mode this agent cannot honour is said out loud rather than
	// ignored. The mode is not applied — and it is not enforced either: Kin
	// answers the questions the agent asks, and how many it asks is the agent's
	// choice, so someone who picked "stop asking" is about to be asked anyway.
	if mode := adapter.NormalizePermissionMode(spec.PermissionMode); mode != adapter.PermissionDefault {
		h.emit(adapter.Event{Type: "notice", Payload: mustMarshal(map[string]any{
			"severity": "info",
			"title":    "permission mode not applied",
			"message": fmt.Sprintf(
				"this agent decides for itself when to ask, so the %q mode is not applied; "+
					"every tool call it does ask about goes to the approval inbox", mode),
			"mode": mode,
		})})
	}
	if ref := strings.TrimSpace(spec.SessionRef); ref != "" {
		if h.loadsSessions() {
			h.stateMu.Lock()
			h.replaying = true
			h.replayed = 0
			h.stateMu.Unlock()
			if _, err := h.send(context.Background(), methodSessionLoad, loadSessionParams{
				SessionID:  ref,
				Cwd:        spec.Cwd,
				McpServers: []any{},
			}); err != nil {
				h.failWrite(methodSessionLoad, err)
			}
			return
		}
		// This task has a session on this agent and the agent cannot reopen it, so
		// the turn starts a fresh one. Silently swapping the session would look
		// like an agent that forgot the work it already did.
		h.emit(noticeEvent("session not reloaded",
			"this agent cannot reopen an earlier session, so the turn starts a new one "+
				"and the earlier context is not available to it"))
	}
	if _, err := h.send(context.Background(), methodSessionNew, newSessionParams{
		Cwd:        spec.Cwd,
		McpServers: []any{},
	}); err != nil {
		h.failWrite(methodSessionNew, err)
	}
}

// applyModel selects the model the task asked for, and refuses to run on a
// different one.
//
// Running on the agent's default when the user asked for something else would
// leave the transcript claiming a model that did no work — the same failure the
// workspace anchors exist to prevent, one layer down.
func (h *handle) applyModel(spec adapter.TaskSpec, session sessionResult) {
	h.stateMu.Lock()
	h.replaying = false
	h.stateMu.Unlock()

	model := strings.TrimSpace(spec.Model)
	if model == "" {
		h.sendPrompt(spec)
		return
	}
	configID := session.modelConfigID()
	switch {
	case configID == "":
		h.stopWithError(fmt.Sprintf(
			"this agent does not offer a model setting, so the turn cannot run on %q", model))
	case !session.modelOffered(model):
		h.stopWithError(fmt.Sprintf("this agent does not offer the model %q", model))
	default:
		if _, err := h.send(context.Background(), methodSetConfigOption, setConfigOptionParams{
			SessionID: session.SessionID,
			ConfigID:  configID,
			Value:     model,
		}); err != nil {
			h.failWrite(methodSetConfigOption, err)
		}
	}
}

func (h *handle) sendPrompt(spec adapter.TaskSpec) {
	h.stateMu.Lock()
	sessionID := h.sessionID
	h.stateMu.Unlock()
	if _, err := h.send(context.Background(), methodSessionPrompt, promptParams{
		SessionID: sessionID,
		Prompt:    []map[string]any{{"type": "text", "text": spec.Prompt}},
	}); err != nil {
		h.failWrite(methodSessionPrompt, err)
	}
}

// finishTurn records why the agent stopped. The response to `session/prompt` is
// the end of the turn, so this is where the result event comes from.
func (h *handle) finishTurn(result promptResult) {
	// No `source` here: the engine stamps that field with the agent id on the way
	// in, and a value set in the adapter would win over it — usage records read
	// `source` as the provider, and this adapter does not know which agent it is
	// driving.
	//
	// A refusal and a cancellation are both turns that did not happen. The other
	// stop reasons (`max_tokens`, `max_turn_requests`) leave a truncated answer,
	// which is still an answer; these two leave nothing, and a result event saying
	// `is_error: false` would finalize the stream as if the agent had finished.
	isError := result.StopReason == stopRefusal || result.StopReason == stopCancelled
	payload := map[string]any{
		"is_error":    isError,
		"stop_reason": result.StopReason,
	}
	switch result.StopReason {
	case stopRefusal:
		payload["error"] = "the agent refused to continue"
	case stopCancelled:
		payload["error"] = "the agent stopped the turn before answering"
	}
	if notice := reportedUsageNotice(result.Usage); notice != nil {
		// Reported, never billed. The schema marks this whole type UNSTABLE, and
		// its field docs contradict its use site: `PromptResponse.usage` is "token
		// usage for this turn", while `inputTokens` is "total input tokens across
		// all turns" and `totalTokens` is "sum of all token types across session".
		// Upstream has an open question about which it is (the
		// end-turn-token-usage RFD). Kin's usage records are deltas, and the
		// engine books whatever a result carries as this turn's tokens — so
		// booking a number whose scope is undefined is how a ledger starts lying.
		// The numbers are worth reading, so they are shown; they are not worth
		// trusting, so they are not recorded.
		h.emit(adapter.Event{Type: "notice", Payload: mustMarshal(notice)})
	}
	event := adapter.Event{Type: "result", Payload: mustMarshal(payload)}
	h.noteEvent(event)
	h.emit(event)

	// The turn is over; the agent has nothing left to say. Closing its input is
	// what ends a well-behaved session, and the deadline is only there for one
	// that keeps running.
	h.closeInput()
	h.scheduleTermination(h.killGrace)
}

// write sends one message to the agent.
func (h *handle) write(env envelope) error {
	data, err := json.Marshal(env)
	if err != nil {
		return err
	}
	return h.conn.Write(data)
}

// send asks the agent something and remembers what the answer will mean.
//
// A cancelled run asks nothing: the cancel may have landed after the response
// that led here was already being handled, and the pipeline's next step is a
// question — a model, a config option, the prompt itself — that a stopped turn
// has no business putting to an agent.
func (h *handle) send(_ context.Context, method string, params any) (string, error) {
	if h.isCanceled() {
		return "", errCanceled
	}
	id := h.conn.RequestID(method)
	env := requestEnvelope(id, method, params)
	data, err := json.Marshal(env)
	if err != nil {
		h.conn.Forget(id)
		return "", err
	}
	if err := h.conn.Write(data); err != nil {
		h.conn.Forget(id)
		return "", err
	}
	return id, nil
}

func (h *handle) failWrite(method string, err error) {
	if h.isCanceled() {
		return
	}
	h.stopWithError(fmt.Sprintf("send %s: %v", method, err))
}

func (h *handle) stopWithError(message string) {
	h.noteError()
	h.emit(errorEvent(message))
	if h.cancelRun != nil {
		h.cancelRun()
	}
	h.closeInput()
	h.scheduleTermination(h.cancelGrace)
}

// stopProcess ends a process whose protocol never started.
func (h *handle) stopProcess() {
	h.closeInput()
	if h.cmd != nil && h.cmd.Process != nil {
		_ = syscall.Kill(-h.cmd.Process.Pid, syscall.SIGKILL)
	}
}

func (h *handle) isCanceled() bool {
	h.stateMu.Lock()
	defer h.stateMu.Unlock()
	return h.canceled
}

func (h *handle) loadsSessions() bool {
	h.stateMu.Lock()
	defer h.stateMu.Unlock()
	return h.canLoad
}

func (h *handle) closeInput() {
	h.closeOnce.Do(func() {
		_ = h.stdin.Close()
	})
}

// scheduleTermination stops an agent that has been given its chance to stop.
//
// The protocol has no cancellation timeout, and its own documentation says an
// agent that ignores `session/cancel` leaves the prompt pending forever. Kin
// cannot wait forever: it asks politely, then signals the process group, then
// kills it. Whatever the agent managed to say is already in the transcript.
func (h *handle) scheduleTermination(grace time.Duration) {
	h.terminateOnce.Do(func() {
		go func() {
			timer := time.NewTimer(grace)
			defer timer.Stop()
			select {
			case <-h.done:
				return
			case <-timer.C:
			}
			if h.cmd != nil && h.cmd.Process != nil {
				_ = syscall.Kill(-h.cmd.Process.Pid, syscall.SIGTERM)
			}
			timer.Reset(h.killGrace)
			select {
			case <-h.done:
				return
			case <-timer.C:
			}
			if h.cmd != nil && h.cmd.Process != nil {
				_ = syscall.Kill(-h.cmd.Process.Pid, syscall.SIGKILL)
			}
		}()
	})
}

func (h *handle) noteEvent(event adapter.Event) {
	h.stateMu.Lock()
	defer h.stateMu.Unlock()
	if event.Type == "result" {
		h.sawResult = true
	}
	if event.Type == "error" {
		h.reportedError = true
	}
}

func (h *handle) noteError() {
	h.stateMu.Lock()
	h.reportedError = true
	h.stateMu.Unlock()
}

func (h *handle) emit(event adapter.Event) {
	// Three guards, because a diagnostic must never be the thing that kills the
	// daemon: a run that has finished has closed its channel, and the writers that
	// can still reach here afterwards are exactly the failure paths — a cancel
	// whose notification could not be written, a stderr line from a process that
	// is already gone. The flag covers the ordinary case, `done` covers a sender
	// that was already blocked on a full buffer when the run ended, and the
	// recover covers the instant between the two. An event with nowhere left to
	// go is dropped: nobody is reading it.
	h.stateMu.Lock()
	closed := h.eventsClosed
	h.stateMu.Unlock()
	if closed {
		return
	}
	defer func() { _ = recover() }()
	select {
	case <-h.done:
	case h.ch <- event:
	}
}

func (h *handle) warn(format string, args ...any) {
	// A warning has nowhere to go but the transcript: the adapter has no logger,
	// and a silent failure here would be a turn that stopped for no stated
	// reason.
	h.emit(noticeEvent("acp", fmt.Sprintf(format, args...)))
}

// finish closes the run. A process that exited without answering the prompt is
// an error the transcript has to carry: the engine reads the terminal event out
// of the stream, and a stream that just ends leaves the task hanging.
func (h *handle) finish(waitErr error) {
	h.stateMu.Lock()
	canceled := h.canceled
	sawResult := h.sawResult
	reportedError := h.reportedError
	h.stateMu.Unlock()

	if !canceled && !sawResult && !reportedError {
		message := "the ACP agent exited without answering the prompt"
		if waitErr != nil {
			message = "the ACP agent exited: " + waitErr.Error()
		}
		h.emit(errorEvent(message))
	}
	// Marked before the close, and after the last event this run has to say: an
	// emitter that has not looked yet must not find the channel closed under it.
	h.stateMu.Lock()
	h.eventsClosed = true
	h.stateMu.Unlock()
	close(h.done)
	close(h.ch)
}

func startedEvent(sessionRef, model string) adapter.Event {
	return adapter.Event{Type: "task_started", Payload: mustMarshal(adapter.StartedPayload{
		SessionRef: sessionRef,
		Model:      model,
	})}
}

func errorEvent(message string) adapter.Event {
	return adapter.Event{Type: "error", Payload: mustMarshal(map[string]string{"message": message})}
}

func noticeEvent(title, message string) adapter.Event {
	return adapter.Event{Type: "notice", Payload: mustMarshal(map[string]any{
		"severity": "warning",
		"title":    title,
		"message":  message,
	})}
}

// permissionNotice records a permission question that never reached an inbox:
// the agent asked, and Kin answered it out of protocol rather than out of a
// person's decision.
//
// Every path that gets here has no approval row, and therefore no card: an agent
// that offered no allow option (Kin answered with the reject it did offer), an
// agent that offered no options at all, a bridge with no Kin to ask, a create
// that failed. `approval_requested` is the console's "needs your approval"
// marker, so writing one on these paths would ask the reader to approve
// something no view can show them. What is left is the plain fact, which is also
// what the CLI adapters leave behind when a tool call is refused before it runs.
func permissionNotice(request permissionRequest, outcome permissionResponse) adapter.Event {
	var call toolCall
	_ = json.Unmarshal(request.ToolCall, &call)
	answer := outcome.Outcome.Outcome
	if option := strings.TrimSpace(outcome.Outcome.OptionID); option != "" {
		answer = option
	}
	return noticeEvent("permission", fmt.Sprintf(
		"the agent asked to use %s and was told %s", toolName(call), answer,
	))
}

func rawOutput(line string) adapter.Event {
	return adapter.Event{
		Type:    "raw_output",
		Payload: mustMarshal(map[string]string{"line": line, "stream": rawOutputStreamName}),
	}
}

func durationOr(value, fallback time.Duration) time.Duration {
	if value > 0 {
		return value
	}
	return fallback
}

var _ adapter.Adapter = (*Adapter)(nil)
