package node

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/fsroot"
	"github.com/vuuihc/openkin/internal/remote/worker"
)

const (
	// DefaultOutboxLimit bounds the bytes a Node holds for its Hub while the
	// connection is gone. An agent can produce faster than a dead socket can
	// drain, so the holding area is a bound, not a queue that grows until the
	// process runs out of memory.
	DefaultOutboxLimit = 8 << 20
	// nodeWriteTimeout bounds one write. A peer that stops reading must not hold the
	// turn's goroutine forever; a write whose deadline passes leaves the socket
	// closed, which is a state the connection code already converges from.
	nodeWriteTimeout = 10 * time.Second
	// The replay bounds remember what was written just before a connection
	// died. TCP can lose the tail of a reset socket — for a chatty agent that is
	// routinely more than a handful of frames — and the Hub reads the next event
	// as a hole, so the frames are kept to be written again; the Hub drops a
	// duplicate by kind and sequence.
	//
	// maxReplayBytes is the real bound per turn. One frame is always kept even
	// when it alone is larger, so a pathological turn can hold one frame of up
	// to MaxFrameBytes; with maxReplayTurns that is the worst case (~32 MiB),
	// and it is why the outbox has a byte budget of its own.
	maxReplayBytes = 256 << 10
	maxReplayTurns = 32
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
	// AllowYOLO permits a dispatched turn to run with the agent's permission
	// system switched off. It is off by default and has to be turned on by the
	// operator of this machine: otherwise anything that can create a task on
	// the Hub can run arbitrary commands here with nobody asked, which would
	// make the roots boundary above decorative.
	AllowYOLO bool
	// Attachments brings the files a dispatch refers to onto this machine
	// before the agent starts. Nil means this machine cannot fetch them, and a
	// prompt keeps the Hub's paths — which, for a prompt that names any, is
	// the same as saying the agent cannot open them.
	Attachments *AttachmentFetcher
	// Warn receives problems that have nowhere else to go. Nil means quiet.
	Warn func(format string, args ...any)
	// OutboxLimit is how many bytes of turn traffic may wait for a connection.
	// Zero means DefaultOutboxLimit.
	OutboxLimit int

	mu      sync.Mutex
	running map[string]*execution

	// sendMu serializes every write to the Hub and guards the write path and
	// everything waiting for one. Writes are serialized because the order of a
	// turn's frames is the protocol: an event must not overtake the one before
	// it while a reconnect is draining what the last connection missed.
	sendMu    sync.Mutex
	sendFrame WriteFunc
	// outbox holds frames that could not be written, oldest first, with the
	// turn each belongs to so a reconnect can say what it still has.
	outbox    []queuedFrame
	outboxLen int
	// recent holds the last frames actually written per turn, so a connection
	// that dies mid-write can be retried rather than read as a hole.
	recent    map[string]*recentFrames
	recentSeq []string
	// aborted marks turns whose held frames were given up on. Everything they
	// send afterwards is dropped: the Hub is going to read one finish for that
	// turn, and an event after it would be a frame for a run that no longer has
	// a coherent sequence.
	aborted map[string]bool
}

// queuedFrame is one frame waiting for a connection.
type queuedFrame struct {
	turnID string
	frame  worker.Frame
}

// recentFrames is what one turn wrote most recently on the current connection.
type recentFrames struct {
	frames []worker.Frame
	bytes  int
}

type execution struct {
	turnID string
	// ctx is the turn's own lifetime, created when the dispatch was taken off
	// the read loop.
	ctx    context.Context
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
	// The turn is registered here, on the read loop, before its own goroutine
	// exists. The Hub sends a cancel right behind a dispatch when a task is
	// stopped as it starts, and both frames arrive in one read: a turn that
	// registered itself inside the goroutine below could be cancelled in the
	// microseconds before that goroutine first runs, and the cancel would be
	// dropped as one for a turn this machine never had — leaving a silent agent
	// working on a turn the Hub has already given up on.
	turnCtx, cancel := context.WithCancel(ctx)
	entry := &execution{turnID: dispatch.TurnID, ctx: turnCtx, cancel: cancel}
	if err := e.track(entry); err != nil {
		// Already running. The turn that is already going will report its own
		// finish; answering here with a finish of our own would end it out from
		// under the run that is still working.
		cancel()
		e.warn("ignoring a second dispatch for turn %s: %v", dispatch.TurnID, err)
		return nil
	}
	// The turn runs in the background: this is called from the connection's read
	// loop, and a turn outlives it by design. A dispatch that blocked here would
	// stop the machine from hearing anything else, including its own cancel.
	go e.run(ctx, entry, dispatch)
	return nil
}

func (e *Executor) run(parent context.Context, entry *execution, dispatch worker.Dispatch) {
	// The turn's own context, created when the dispatch was registered: a cancel
	// that arrived in the meantime has already fired it, and the checks below
	// still run so the Hub hears a finish either way.
	ctx := entry.ctx
	defer entry.cancel()
	defer e.untrack(dispatch.TurnID)

	// Say so before anything else: the Hub is holding a turn open on the
	// strength of this frame, and a refusal below arrives as a finish, which is a
	// better answer than the silence the Hub would otherwise have to time out.
	e.started(parent, dispatch.TurnID)
	if !e.allowedCwd(dispatch.Cwd) {
		e.report(parent, dispatch.TurnID, worker.TurnError,
			fmt.Sprintf("%s is not a directory this machine works in", dispatch.Cwd))
		return
	}
	mode := adapter.NormalizePermissionMode(dispatch.PermissionMode)
	runner, err := e.Runners.Runnable(parent, dispatch.Agent)
	if err != nil {
		e.report(parent, dispatch.TurnID, worker.TurnError, err.Error())
		return
	}
	// The permission ceiling is judged on what the agent will actually do, not on
	// the name of the mode: for an agent with no approval channel of its own,
	// accept_edits is the same bypass yolo is (adapter.AutoApprovesAll).
	if adapter.AutoApprovesAll(runner, mode) && !e.AllowYOLO {
		e.report(parent, dispatch.TurnID, worker.TurnError,
			fmt.Sprintf("this machine does not run dispatched turns with approvals bypassed "+
				"(agent %s in mode %s), start it with --allow-yolo to permit that",
				dispatch.Agent, mode))
		return
	}

	// The prompt is the Hub's until the files it names are here. Fetching
	// happens after the refusals above: a turn this machine will not run is not
	// worth downloading for.
	prompt := dispatch.Prompt
	if e.Attachments != nil {
		e.Attachments.Sweep()
	}
	if len(dispatch.Attachments) > 0 {
		if e.Attachments == nil {
			e.warn("turn %s: prompt names %d attachments this machine cannot fetch", dispatch.TurnID, len(dispatch.Attachments))
		} else {
			prompt = e.Attachments.Rewrite(ctx, dispatch.TaskID, prompt, dispatch.Attachments)
		}
	}

	// No ProviderCfg, no API keys: this machine runs with its own agent logins,
	// and nothing about them crossed the wire to get here (ADR 0022 D7).
	handle, err := runner.Start(ctx, adapter.TaskSpec{
		ID:             dispatch.TaskID,
		Agent:          dispatch.Agent,
		Cwd:            dispatch.Cwd,
		Prompt:         prompt,
		Model:          dispatch.Model,
		SessionRef:     dispatch.SessionRef,
		PermissionMode: mode,
		Execution:      adapter.ExecutionRef{ID: dispatch.TurnID, Agent: dispatch.Agent, Model: dispatch.Model},
	})
	if err != nil {
		e.report(parent, dispatch.TurnID, worker.TurnError, err.Error())
		return
	}

	// seq counts what the Hub has been told, so it only moves once a frame is on
	// its way: an event that cannot be encoded is skipped without leaving the
	// hole that a bare increment would open (the Hub ends a turn that skips a
	// number, which is exactly the wrong outcome for one bad event).
	seq := 0
	for event := range handle.Events() {
		if seq >= worker.MaxTurnSeq {
			// The Hub refuses frames past its own bound, so continuing would
			// leave it waiting for a sequence that can never arrive.
			e.report(parent, dispatch.TurnID, worker.TurnError,
				fmt.Sprintf("turn produced more than %d events", worker.MaxTurnSeq))
			return
		}
		payload, err := json.Marshal(event)
		if err != nil {
			e.warn("turn %s: encode event after %d: %v", dispatch.TurnID, seq, err)
			continue
		}
		frame, err := worker.NewFrame("turn.event", worker.TurnEvent{
			TurnID: dispatch.TurnID,
			Seq:    seq + 1,
			Event:  payload,
		})
		if err != nil {
			e.warn("turn %s: event after %d does not fit a frame: %v", dispatch.TurnID, seq, err)
			continue
		}
		if err := e.send(ctx, dispatch.TurnID, frame); err != nil {
			// Only the end of the turn fails a send now: a broken connection is
			// something send waits out. There is no reader left for the rest,
			// and holding more events for a canceled run would only fill the
			// outbox.
			e.warn("turn %s: send event %d: %v", dispatch.TurnID, seq+1, err)
			return
		}
		seq++
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
		// it asks for already holds. Anything this machine still held for it is
		// for a turn the Hub will never accept, so it goes too. No marker is
		// needed: once a turn is untracked its goroutine has already sent its
		// last frame.
		e.sendMu.Lock()
		e.forgetLocked(turnID)
		e.sendMu.Unlock()
		e.warn("cancel for unknown turn %s: %s", turnID, reason)
		return nil
	}
	// A turn that is still running is stopped, and its goroutine reports the
	// cancellation the usual way: the Hub may have closed its side already, but
	// a finish is what the run's reader is waiting for.
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

// started tells the Hub this machine has taken the dispatch.
func (e *Executor) started(ctx context.Context, turnID string) {
	frame, err := worker.NewFrame("turn.started", worker.TurnStarted{TurnID: turnID})
	if err != nil {
		e.warn("turn %s: build started: %v", turnID, err)
		return
	}
	if err := e.send(ctx, turnID, frame); err != nil {
		e.warn("turn %s: send started: %v", turnID, err)
	}
}

// report sends a turn's ending. A failure to report is only worth a warning:
// the frame is held for the next connection, and if the turn is stopped before
// one arrives the Hub has already stopped waiting for it.
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
	if err := e.send(ctx, turnID, frame); err != nil {
		e.warn("turn %s: send finish: %v", turnID, err)
	}
}

// send writes to the Hub, or holds the frame until a connection exists again.
//
// A broken connection is not the end of a turn any more: the machine keeps
// running the agent and the Hub keeps the turn open for a grace period, so the
// frame is worth keeping. Only a turn that has ended from this side fails a
// send — nobody is waiting for those frames and holding them would grow the
// outbox for a run that is already over.
func (e *Executor) send(ctx context.Context, turnID string, frame worker.Frame) error {
	e.sendMu.Lock()
	defer e.sendMu.Unlock()
	return e.sendLocked(ctx, turnID, frame)
}

func (e *Executor) sendLocked(ctx context.Context, turnID string, frame worker.Frame) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if e.aborted[turnID] {
		return nil
	}
	if e.sendFrame == nil {
		e.enqueueLocked(turnID, frame)
		return nil
	}
	writeCtx, cancel := context.WithTimeout(ctx, nodeWriteTimeout)
	err := e.sendFrame(writeCtx, frame)
	cancel()
	if err == nil {
		e.rememberLocked(turnID, frame)
		return nil
	}
	// The socket is gone even though the connection code has not cleared it
	// yet. Keep the frame and wait for the replacement; a write that timed out
	// may or may not have arrived, which is what the replay on reconnect is
	// for.
	e.enqueueLocked(turnID, frame)
	e.sendFrame = nil
	return nil
}

// SetSender installs the connection's write path. It is set once the handshake
// completes and cleared when the connection ends, so a turn that outlives its
// connection stops trying to talk to it and holds its frames instead.
func (e *Executor) SetSender(send WriteFunc) {
	e.sendMu.Lock()
	defer e.sendMu.Unlock()
	e.sendFrame = send
	if send == nil {
		return
	}
	e.flushLocked()
}

// flushLocked greets a new connection with what this machine still holds, then
// writes everything the last one could not take.
//
// The resume frame goes first and on every connection, including with an empty
// list: an empty answer is how the Hub learns that the turns it kept for this
// device are gone, so it can fail them now instead of at the end of the grace.
func (e *Executor) flushLocked() {
	ids := e.resumableLocked()
	resume, err := worker.NewFrame("turn.resume", worker.TurnResume{TurnIDs: ids})
	if err != nil {
		e.warn("node: build resume: %v", err)
		return
	}
	if !e.writeLocked(resume) {
		return
	}
	// Frames written just before the old connection died may not have arrived:
	// TCP can lose the tail of a reset socket, and the Hub reads the next event
	// as a hole. Replaying is safe because the Hub drops an event whose
	// sequence it already has, and a repeated start ack for a live turn is a
	// no-op there (a turn it has already closed answers with a cancel, which is
	// the right answer for a run it no longer wants).
	for _, id := range ids {
		entry := e.recent[id]
		if entry == nil {
			continue
		}
		for _, frame := range entry.frames {
			if !e.writeLocked(frame) {
				return
			}
		}
	}
	for len(e.outbox) > 0 {
		queued := e.outbox[0]
		if !e.writeLocked(queued.frame) {
			return
		}
		e.outbox = e.outbox[1:]
		e.outboxLen -= len(queued.frame.Data)
		if queued.frame.Kind == "turn.finish" {
			// The ending is delivered, so the marker has done its job. Anything
			// the stopped run still emits is for a turn the Hub has closed and
			// is answered as such.
			delete(e.aborted, queued.turnID)
		}
	}
}

// writeLocked writes one frame on the current connection. A failure clears the
// write path and leaves everything else where it is; the next connection
// resumes it.
func (e *Executor) writeLocked(frame worker.Frame) bool {
	ctx, cancel := context.WithTimeout(context.Background(), nodeWriteTimeout)
	defer cancel()
	if err := e.sendFrame(ctx, frame); err != nil {
		e.sendFrame = nil
		return false
	}
	return true
}

// resumableLocked is what this machine tells a new connection it still holds:
// the turns it is running, the turns with frames waiting to go out, and the
// turns whose last frames may have died with the old socket.
//
// The list is capped at the protocol's bound, running turns first: a resume the
// Hub refuses for being too long adopts nothing, so the turns that are still
// being worked on go in before the ones whose endings are only being retried.
// A node running more turns than the bound (only reachable with a concurrency
// setting the protocol does not anticipate) loses the overflow: the Hub fails
// the unlisted turns at once. Loud and bounded beats a resume nobody accepts.
func (e *Executor) resumableLocked() []string {
	seen := make(map[string]bool)
	ids := make([]string, 0, worker.MaxResumeTurns)
	add := func(id string) {
		if id == "" || seen[id] || len(ids) >= worker.MaxResumeTurns {
			return
		}
		seen[id] = true
		ids = append(ids, id)
	}
	e.mu.Lock()
	running := make([]string, 0, len(e.running))
	for id := range e.running {
		running = append(running, id)
	}
	e.mu.Unlock()
	sort.Strings(running)
	for _, id := range running {
		add(id)
	}
	for _, queued := range e.outbox {
		add(queued.turnID)
	}
	recent := make([]string, 0, len(e.recent))
	for id := range e.recent {
		recent = append(recent, id)
	}
	sort.Strings(recent)
	for _, id := range recent {
		add(id)
	}
	return ids
}

// rememberLocked keeps the last frames actually written for a turn, so a
// connection that dies mid-write can be retried instead of leaving a hole.
//
// A start ack is kept too: it is written before the first event, and a write
// that returns successfully may still die with the socket. The Hub treats a
// duplicate ack for a live turn as the no-op it is.
func (e *Executor) rememberLocked(turnID string, frame worker.Frame) {
	switch frame.Kind {
	case "turn.started", "turn.event", "turn.finish":
	default:
		return
	}
	if e.recent == nil {
		e.recent = make(map[string]*recentFrames)
	}
	entry := e.recent[turnID]
	if entry == nil {
		entry = &recentFrames{}
		e.recent[turnID] = entry
		e.recentSeq = append(e.recentSeq, turnID)
		for len(e.recentSeq) > maxReplayTurns {
			oldest := e.recentSeq[0]
			e.recentSeq = e.recentSeq[1:]
			delete(e.recent, oldest)
		}
	}
	entry.frames = append(entry.frames, frame)
	entry.bytes += len(frame.Data)
	// The byte budget is the bound; there is no frame count, because a burst of
	// small deltas is exactly what a reset socket loses and exactly what the Hub
	// would read as a hole. The newest frame is always kept even when it alone
	// is over budget: dropping it would guarantee the hole the replay exists to
	// prevent.
	for len(entry.frames) > 1 && entry.bytes > maxReplayBytes {
		entry.bytes -= len(entry.frames[0].Data)
		entry.frames = entry.frames[1:]
	}
}

// enqueueLocked holds one frame until a connection can take it.
func (e *Executor) enqueueLocked(turnID string, frame worker.Frame) {
	limit := e.OutboxLimit
	if limit <= 0 {
		limit = DefaultOutboxLimit
	}
	if len(e.outbox) > 0 && e.outboxLen+len(frame.Data) > limit {
		e.overflowLocked(limit)
		if e.aborted[turnID] {
			// The frame that would have crossed the limit belongs to a turn the
			// overflow just stopped; it is covered by that turn's finish.
			return
		}
	}
	e.outbox = append(e.outbox, queuedFrame{turnID: turnID, frame: frame})
	e.outboxLen += len(frame.Data)
}

// overflowLocked gives up on what is waiting rather than growing without a
// bound while the Hub is unreachable.
//
// The turns in the outbox cannot be resumed coherently any more: dropping some
// of their frames would leave a hole the Hub reads as a broken machine. Each one
// is stopped here and replaced by a single finish that says what happened, which
// is the outcome the Hub would reach on its own after the reconnect grace —
// just sooner, and with a reason that names the real cause.
func (e *Executor) overflowLocked(limit int) {
	reason := "the node fell behind while disconnected from the hub"
	ids := make(map[string]bool, len(e.outbox))
	for _, queued := range e.outbox {
		ids[queued.turnID] = true
	}
	e.outbox = nil
	e.outboxLen = 0
	var cancels []context.CancelFunc
	e.mu.Lock()
	for id := range ids {
		// Forget first: it drops the marker along with the frames, and the turn
		// is marked again immediately so its late events stay dropped.
		e.forgetLocked(id)
		e.abortLocked(id)
		if entry, ok := e.running[id]; ok {
			cancels = append(cancels, entry.cancel)
		}
	}
	e.mu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
	for id := range ids {
		frame, err := worker.NewFrame("turn.finish", worker.TurnFinish{
			TurnID: id, Status: worker.TurnError, Error: reason,
		})
		if err != nil {
			continue
		}
		e.outbox = append(e.outbox, queuedFrame{turnID: id, frame: frame})
		e.outboxLen += len(frame.Data)
	}
	e.warn("node: holding more than %d bytes for the hub; %d turn(s) stopped", limit, len(ids))
}

// abortLocked marks a turn whose held frames were given up on.
func (e *Executor) abortLocked(turnID string) {
	if e.aborted == nil {
		e.aborted = make(map[string]bool)
	}
	e.aborted[turnID] = true
}

// forgetLocked drops everything held for one turn, including the marker that
// keeps its late frames out: with nothing left to deliver there is no reason to
// remember that the turn was given up on.
func (e *Executor) forgetLocked(turnID string) {
	delete(e.aborted, turnID)
	if _, ok := e.recent[turnID]; ok {
		delete(e.recent, turnID)
		for i, id := range e.recentSeq {
			if id == turnID {
				e.recentSeq = append(e.recentSeq[:i], e.recentSeq[i+1:]...)
				break
			}
		}
	}
	if len(e.outbox) == 0 {
		return
	}
	kept := e.outbox[:0]
	for _, queued := range e.outbox {
		if queued.turnID == turnID {
			e.outboxLen -= len(queued.frame.Data)
			continue
		}
		kept = append(kept, queued)
	}
	e.outbox = kept
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

// Has reports whether this machine is running that turn for its Hub.
//
// It is what tells a permission question asked here apart from one this machine
// owns: an agent running a turn the Hub dispatched is asking about work somebody
// else is watching, and the answer has to travel (see ApprovalRelay).
func (e *Executor) Has(turnID string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	_, ok := e.running[turnID]
	return ok
}

// allowedCwd reports whether a dispatched working directory is one this machine
// agreed to work in.
//
// The rule itself lives in rootSet, shared with the answers this machine gives
// about its own directories: a listing that offered a directory a dispatch
// would refuse is a person being sent to a wall.
func (e *Executor) allowedCwd(cwd string) bool {
	roots := rootSet(e.Roots)
	if len(roots) == 0 {
		return false
	}
	// A dispatch with no cwd is the machine's own choice of directory, which is
	// only meaningful when it has declared one.
	if strings.TrimSpace(cwd) == "" {
		return len(roots) == 1
	}
	// The Hub speaks in paths on this machine, so it has to name one: a relative
	// path would be resolved against whatever directory the daemon was started
	// in, which is not a choice the Hub gets to make.
	if !filepath.IsAbs(cwd) {
		return false
	}
	return roots.contains(cwd)
}

// UnresolvedRoots lists declared roots this machine cannot resolve.
//
// A root that has been renamed or unmounted is skipped by the containment check,
// which fails closed — work in it is refused — but silently, and a machine that
// has quietly stopped accepting the work it was set up for is worth saying out
// loud at startup.
func (e *Executor) UnresolvedRoots() []string {
	var out []string
	for _, root := range e.Roots {
		if _, err := fsroot.Resolve(root); err != nil {
			out = append(out, strings.TrimSpace(root))
		}
	}
	return out
}
