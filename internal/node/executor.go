package node

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/remote/worker"
)

// Runners resolves an agent id to something that can run a turn on this
// machine. It is the Node's whole view of the agent layer: whether an agent is
// installed, and how to start it.
type Runners interface {
	// Runnable returns the adapter for agentID, or an error saying why this
	// machine cannot run it — a reason the Hub can show the user.
	Runnable(ctx context.Context, agentID string) (adapter.Adapter, error)
}

// Executor runs the turns a Hub dispatches to this machine.
//
// It is the mirror image of the Hub's Adapter: the Hub sees a turn as a local
// agent run, and this sees a local agent run as a turn. Between them the agent
// protocol, the event shapes and the transcript are the same objects, which is
// why a remote turn shows up in the console with no remote-specific code.
type Executor struct {
	Runners Runners
	// Roots are the directories this machine agreed to work in. A dispatch
	// naming a path outside them is refused here, on the machine that owns the
	// filesystem: the Hub is another party and cannot be trusted to bound
	// itself.
	Roots []string
	// Warn receives problems that have nowhere else to go. Nil means quiet.
	Warn func(format string, args ...any)

	mu        sync.Mutex
	running   map[string]*execution
	sendFrame WriteFunc
}

type execution struct {
	turnID string
	cancel context.CancelFunc
}

func (e *Executor) warn(format string, args ...any) {
	if e.Warn != nil {
		e.Warn(format, args...)
	}
}

// Handle is the FrameHandler for a Node's control channel.
func (e *Executor) Handle(ctx context.Context, frame worker.Frame) error {
	switch frame.Kind {
	case "turn.dispatch":
		return e.dispatch(ctx, frame)
	case "turn.cancel":
		cancel, err := Decode[worker.TurnCancel](frame)
		if err != nil {
			return err
		}
		if err := cancel.Validate(); err != nil {
			return err
		}
		return e.cancel(cancel.TurnID, cancel.Reason)
	default:
		return fmt.Errorf("node does not handle frame kind %q", frame.Kind)
	}
}

func (e *Executor) dispatch(ctx context.Context, frame worker.Frame) error {
	dispatch, err := Decode[worker.Dispatch](frame)
	if err != nil {
		return err
	}
	if err := dispatch.Validate(); err != nil {
		return err
	}
	// The turn runs in the background: this is called from the connection's read
	// loop, and a turn outlives it by design. A dispatch that blocked here would
	// stop the machine from hearing anything else, including its own cancel.
	go e.run(ctx, dispatch)
	return nil
}

func (e *Executor) run(parent context.Context, dispatch worker.Dispatch) {
	if !e.allowedCwd(dispatch.Cwd) {
		e.report(parent, dispatch.TurnID, worker.TurnError,
			fmt.Sprintf("%s is not a directory this machine works in", dispatch.Cwd))
		return
	}
	runner, err := e.Runners.Runnable(parent, dispatch.Agent)
	if err != nil {
		e.report(parent, dispatch.TurnID, worker.TurnError, err.Error())
		return
	}

	// The turn's lifetime is its own: it must outlive the frame that started it
	// and end when it is canceled or the connection goes away.
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	entry := &execution{turnID: dispatch.TurnID, cancel: cancel}
	if err := e.track(entry); err != nil {
		// Already running: two turns with one id would interleave into one
		// transcript.
		e.report(parent, dispatch.TurnID, worker.TurnError, err.Error())
		return
	}
	defer e.untrack(dispatch.TurnID)

	// No ProviderCfg, no API keys: this machine runs with its own agent logins,
	// and nothing about them crossed the wire to get here (ADR 0022 D7).
	handle, err := runner.Start(ctx, adapter.TaskSpec{
		ID:             dispatch.TaskID,
		Agent:          dispatch.Agent,
		Cwd:            dispatch.Cwd,
		Prompt:         dispatch.Prompt,
		Model:          dispatch.Model,
		SessionRef:     dispatch.SessionRef,
		PermissionMode: adapter.NormalizePermissionMode(dispatch.PermissionMode),
		Execution:      adapter.ExecutionRef{ID: dispatch.TurnID, Agent: dispatch.Agent, Model: dispatch.Model},
	})
	if err != nil {
		e.report(parent, dispatch.TurnID, worker.TurnError, err.Error())
		return
	}

	seq := 0
	for event := range handle.Events() {
		seq++
		payload, err := json.Marshal(event)
		if err != nil {
			e.warn("turn %s: encode event %d: %v", dispatch.TurnID, seq, err)
			continue
		}
		frame, err := worker.NewFrame("turn.event", worker.TurnEvent{
			TurnID: dispatch.TurnID,
			Seq:    seq,
			Event:  payload,
		})
		if err != nil {
			// One oversized event must not take the turn down with it: the Hub
			// would see a gap and end the turn, which is worse than a note.
			e.warn("turn %s: event %d does not fit a frame: %v", dispatch.TurnID, seq, err)
			seq--
			continue
		}
		if err := e.send(ctx, frame); err != nil {
			e.warn("turn %s: send event %d: %v", dispatch.TurnID, seq, err)
			return
		}
	}

	status := worker.TurnOK
	if errors.Is(ctx.Err(), context.Canceled) {
		status = worker.TurnCanceled
	}
	e.report(parent, dispatch.TurnID, status, "")
}

// cancel stops a turn this machine is running.
func (e *Executor) cancel(turnID, reason string) error {
	e.mu.Lock()
	entry, ok := e.running[turnID]
	e.mu.Unlock()
	if !ok {
		// The turn already ended, or never started. Saying so is not an error
		// worth failing the channel over: a cancel is a request, and the state
		// it asks for already holds.
		e.warn("cancel for unknown turn %s: %s", turnID, reason)
		return nil
	}
	entry.cancel()
	return nil
}

// Stop ends every turn, for shutdown.
func (e *Executor) Stop() {
	e.mu.Lock()
	entries := make([]*execution, 0, len(e.running))
	for _, entry := range e.running {
		entries = append(entries, entry)
	}
	e.mu.Unlock()
	for _, entry := range entries {
		entry.cancel()
	}
}

// report sends a turn's ending. A failure to report is only worth a warning:
// the Hub will conclude the turn when the connection drops.
func (e *Executor) report(ctx context.Context, turnID, status, message string) {
	frame, err := worker.NewFrame("turn.finish", worker.TurnFinish{
		TurnID: turnID,
		Status: status,
		Error:  message,
	})
	if err != nil {
		e.warn("turn %s: build finish: %v", turnID, err)
		return
	}
	if err := e.send(ctx, frame); err != nil {
		e.warn("turn %s: send finish: %v", turnID, err)
	}
}

// send writes to the Hub. The sender is installed by the connection.
func (e *Executor) send(ctx context.Context, frame worker.Frame) error {
	e.mu.Lock()
	send := e.sendFrame
	e.mu.Unlock()
	if send == nil {
		return errors.New("node is not connected")
	}
	return send(ctx, frame)
}

// SetSender installs the connection's write path. It is set once the handshake
// completes and cleared when the connection ends, so a turn that outlives its
// connection stops trying to talk to it.
func (e *Executor) SetSender(send WriteFunc) {
	e.mu.Lock()
	e.sendFrame = send
	e.mu.Unlock()
}

func (e *Executor) track(entry *execution) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.running == nil {
		e.running = make(map[string]*execution)
	}
	if _, exists := e.running[entry.turnID]; exists {
		return fmt.Errorf("turn %s is already running here", entry.turnID)
	}
	e.running[entry.turnID] = entry
	return nil
}

func (e *Executor) untrack(turnID string) {
	e.mu.Lock()
	delete(e.running, turnID)
	e.mu.Unlock()
}

// Running lists the turns this machine is executing.
func (e *Executor) Running() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make([]string, 0, len(e.running))
	for id := range e.running {
		out = append(out, id)
	}
	return out
}

// allowedCwd reports whether a dispatched working directory is one this machine
// agreed to work in.
//
// The check is containment, not equality: a turn runs in a checkout *inside* a
// root, and a root is what the operator declared. With no roots declared the
// machine runs nothing — an empty declaration must not read as "anywhere".
func (e *Executor) allowedCwd(cwd string) bool {
	if len(e.Roots) == 0 {
		return false
	}
	// A dispatch with no cwd is the machine's own choice of directory, which is
	// only meaningful when it has declared one.
	if strings.TrimSpace(cwd) == "" {
		return len(e.Roots) == 1
	}
	target, err := filepath.Abs(cwd)
	if err != nil {
		return false
	}
	target = filepath.Clean(target)
	for _, root := range e.Roots {
		absRoot, err := filepath.Abs(strings.TrimSpace(root))
		if err != nil {
			continue
		}
		absRoot = filepath.Clean(absRoot)
		if target == absRoot || strings.HasPrefix(target, absRoot+string(filepath.Separator)) {
			return true
		}
	}
	return false
}
