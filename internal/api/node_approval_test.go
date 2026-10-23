package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"nhooyr.io/websocket"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/approvalbridge"
	"github.com/vuuihc/openkin/internal/node"
	"github.com/vuuihc/openkin/internal/remote"
	"github.com/vuuihc/openkin/internal/remote/worker"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/task"
)

// This is the cross-device approval (M2.5) over real wiring: a turn dispatched to
// another machine, an agent there asking its own daemon for permission, and the
// question arriving in the inbox of the Hub that owns the session. Nothing in
// this file talks to a Hub from the agent's side — the agent only knows the
// daemon that launched it, which is the whole point of the mechanism.

// nodeFramesWithApprovals is the Hub's frame router with the approval half
// attached, the way routeNodeFrame builds it in server.go.
func nodeFramesWithApprovals(turns *node.Turns, approvals *node.Approvals) func(context.Context, node.Sender, worker.Frame) error {
	return func(ctx context.Context, sender node.Sender, frame worker.Frame) error {
		if frame.Kind == "approval.request" {
			return approvals.Route(ctx, sender, frame)
		}
		return turns.RouteFrame(ctx, sender, frame)
	}
}

// localDaemon is the API of the machine running the turn: the daemon the agent
// was launched by, which is where its permission hook points.
func localDaemon(t *testing.T, relay *node.ApprovalRelay) (*httptest.Server, string) {
	t.Helper()
	const token = "00112233445566778899aabbccddeeff00112233445566778899aabbccddee"
	srv := httptest.NewServer((&Server{
		Auth: remote.NewAuth(token), ApprovalRelay: relay, Version: "test",
	}).Handler())
	t.Cleanup(srv.Close)
	return srv, token
}

// startRelayExecutor dials the Hub for real and routes frames the way runNode
// does: the approval half first, the executor for everything else. The returned
// function stops the machine, which is how a test makes it go away.
func startRelayExecutor(
	t *testing.T, hubURL, deviceToken string, roots []string, agent adapter.Adapter, relay *node.ApprovalRelay,
) (*node.Executor, context.CancelFunc) {
	t.Helper()
	executor := &node.Executor{Runners: e2eRunners{agent: agent}, Roots: roots}
	relay.Executor = executor
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go func() {
		_ = node.Run(ctx, node.ClientConfig{
			HubURL: hubURL,
			Token:  deviceToken,
			Hello:  nodeHello(roots...),
			OnFrame: func(ctx context.Context, frame worker.Frame) error {
				switch frame.Kind {
				case "approval.status", "approval.decision":
					return relay.Handle(ctx, frame)
				default:
					return executor.Handle(ctx, frame)
				}
			},
			OnReady: func(send node.WriteFunc) {
				executor.SetSender(send)
				relay.SetSender(send)
			},
			Warn: func(format string, args ...any) { t.Logf("node: "+format, args...) },
		})
	}()
	return executor, cancel
}

// askingAgent is the agent installed on the other machine. It asks the daemon
// that launched it, exactly as a real agent's permission hook does, and reports
// what it heard as the turn's result.
type askingAgent struct {
	client *approvalbridge.Client
	// asked is the approval id it was given, and heard is the decision, so the
	// test can tell "the agent was blocked" from "the agent was told".
	asked chan string
	heard chan string
}

func newAskingAgent(client *approvalbridge.Client) *askingAgent {
	return &askingAgent{client: client, asked: make(chan string, 1), heard: make(chan string, 1)}
}

func (a *askingAgent) Start(ctx context.Context, spec adapter.TaskSpec) (adapter.RunHandle, error) {
	ch := make(chan adapter.Event, 2)
	go func() {
		defer close(ch)
		id, err := a.client.CreateApproval(ctx, spec.ID, "tool_use",
			json.RawMessage(`{"tool_name":"Bash","input":{"command":"ls"}}`),
			approvalbridge.Execution{ID: spec.Execution.ID, Agent: spec.Execution.Agent})
		if err != nil {
			ch <- failed("create approval: " + err.Error())
			return
		}
		a.asked <- id
		decision, err := a.client.WaitApproval(ctx, id)
		if err != nil {
			ch <- failed("wait for approval: " + err.Error())
			return
		}
		a.heard <- decision
		if decision != store.DecisionApproved {
			ch <- failed("permission was " + decision)
			return
		}
		ch <- adapter.Event{Type: "result", Payload: json.RawMessage(`{"is_error":false}`)}
	}()
	return &e2eHandle{ch: ch}, nil
}

// failed is one turn-ending event carrying a message.
func failed(message string) adapter.Event {
	payload, _ := json.Marshal(map[string]string{"message": message})
	return adapter.Event{Type: "error", Payload: payload}
}

// awaitAsks waits for the agent on the other machine to have asked, and returns
// the id its own daemon gave it.
func awaitAsks(t *testing.T, agent *askingAgent) string {
	t.Helper()
	select {
	case id := <-agent.asked:
		return id
	case <-time.After(10 * time.Second):
		t.Fatal("the agent never asked for permission")
		return ""
	}
}

// awaitApproval waits for the Hub's inbox to hold a pending approval for a task.
func awaitApproval(t *testing.T, s *Server, taskID string) store.Approval {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		list, err := s.Engine.ListApprovals(context.Background(), store.ListApprovalsOpts{Status: store.DecisionPending, Scope: store.Unscoped()})
		if err == nil {
			for _, approval := range list {
				if approval.TaskID == taskID {
					return approval
				}
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no approval for task %s reached the hub's inbox", taskID)
	return store.Approval{}
}

// TestAnAgentOnAMachineAsksTheHubsInbox is the M2.5 path end to end: the turn
// runs elsewhere, the row lands in the one inbox a person watches, and the
// answer travels back to the tool call that was blocked on it.
func TestAnAgentOnAMachineAsksTheHubsInbox(t *testing.T) {
	s, master, conns, turns := remoteHub(t)
	approvals := &node.Approvals{Turns: turns, Engine: s.Engine, Poll: 20 * time.Millisecond}
	s.NodeFrames = nodeFramesWithApprovals(turns, approvals)
	hub := httptest.NewServer(s.Handler())
	defer hub.Close()

	deviceToken, deviceID := pairDevice(t, s.Handler(), master)

	relay := &node.ApprovalRelay{}
	local, localToken := localDaemon(t, relay)
	agent := newAskingAgent(&approvalbridge.Client{DaemonURL: local.URL, Token: localToken})

	work := t.TempDir()
	startRelayExecutor(t, hub.URL, deviceToken, []string{work}, agent, relay)
	awaitOnline(t, conns, deviceID)

	created := createTask(t, s.Handler(), master, map[string]any{
		"agent": "claude-code", "cwd": work, "prompt": "ask before you touch anything",
		"executing_device_id": deviceID,
	})

	// The agent's own daemon gave it an id, and the row behind that id is in the
	// Hub's inbox, against the Hub's task rather than anything the device said.
	id := awaitAsks(t, agent)
	approval := awaitApproval(t, s, created.ID)
	if approval.ID != id {
		t.Fatalf("the agent is waiting on %s, the hub is showing %s", id, approval.ID)
	}
	if approval.Kind != "tool_use" || len(approval.Payload) == 0 {
		t.Fatalf("the question lost its content on the way: %+v", approval)
	}
	// Attribution survives the trip: the row says which turn asked and through
	// which agent. The console shows the agent today; naming the machine on the
	// card needs a device label on this row, which is a UI follow-up rather than
	// something this path drops (the task it belongs to carries the device).
	if approval.ExecutionID == nil || *approval.ExecutionID == "" {
		t.Fatalf("the approval does not say which turn asked: %+v", approval)
	}
	if approval.ExecutionAgent == nil || *approval.ExecutionAgent != "claude-code" {
		t.Fatalf("execution agent = %v", approval.ExecutionAgent)
	}

	// A person answers in the console.
	rec := postJSON(t, s.Handler(), "/api/approvals/"+approval.ID+"/decision", master,
		map[string]string{"decision": store.DecisionApproved})
	if rec.Code != http.StatusOK {
		t.Fatalf("decide: %d %s", rec.Code, rec.Body.String())
	}

	select {
	case decision := <-agent.heard:
		if decision != store.DecisionApproved {
			t.Fatalf("the agent heard %q", decision)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the decision never reached the agent that asked")
	}
	awaitTaskStatus(t, s, created.ID, task.StatusSucceeded)
	if pending := approvals.Pending(); len(pending) != 0 {
		t.Fatalf("answered questions left on the hub: %v", pending)
	}
	if running := turns.Running(""); len(running) != 0 {
		t.Fatalf("turns still open on the hub: %v", running)
	}
}

// TestAQuestionAboutATurnTheHubIsNotRunningIsAnswered pins the third path a
// device's question can take: the Hub has no record of the turn, so there is no
// inbox to put it in. The machine is blocked until it hears about the request
// itself — a turn.cancel stops the turn, but only an approval.status ends that
// wait — so both go back.
func TestAQuestionAboutATurnTheHubIsNotRunningIsAnswered(t *testing.T) {
	s, _, _ := nodeTestServer(t)
	s.NodeFrames = func(context.Context, node.Sender, worker.Frame) error {
		return node.ErrTurnUnknown
	}
	sender := &recordingSender{deviceID: "device-1"}
	frame, err := worker.NewFrame("approval.request", worker.ApprovalRequest{
		RequestID: "req-1", TurnID: "turn-gone", Kind: "tool_use", Agent: "claude-code",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.routeNodeFrame(context.Background(), sender, frame); !errors.Is(err, node.ErrTurnUnknown) {
		t.Fatalf("routeNodeFrame err = %v, want the unknown turn", err)
	}

	statuses := sender.ofKind("approval.status")
	if len(statuses) != 1 {
		t.Fatalf("the machine heard %d answers to its question; frames = %+v", len(statuses), sender.sent())
	}
	status, err := node.Decode[worker.ApprovalStatus](statuses[0])
	if err != nil {
		t.Fatal(err)
	}
	if status.RequestID != "req-1" || status.Error == "" || status.ApprovalID != "" {
		t.Fatalf("status = %+v, want a refusal it can match to its request", status)
	}
	cancels := sender.ofKind("turn.cancel")
	if len(cancels) != 1 {
		t.Fatalf("the agent was not told to stop: %+v", sender.sent())
	}
	cancel, err := node.Decode[worker.TurnCancel](cancels[0])
	if err != nil {
		t.Fatal(err)
	}
	if cancel.TurnID != "turn-gone" {
		t.Fatalf("turn.cancel = %+v", cancel)
	}
}

// recordingSender is one device connection that keeps what the Hub pushed to it.
type recordingSender struct {
	deviceID string

	mu     sync.Mutex
	frames []worker.Frame
}

func (s *recordingSender) DeviceID() string                   { return s.deviceID }
func (s *recordingSender) Generation() uint64                 { return 1 }
func (s *recordingSender) Close(websocket.StatusCode, string) {}

func (s *recordingSender) Send(_ context.Context, frame worker.Frame) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.frames = append(s.frames, frame)
	return nil
}

func (s *recordingSender) sent() []worker.Frame {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]worker.Frame(nil), s.frames...)
}

func (s *recordingSender) ofKind(kind string) []worker.Frame {
	var out []worker.Frame
	for _, frame := range s.sent() {
		if frame.Kind == kind {
			out = append(out, frame)
		}
	}
	return out
}

// TestAPendingApprovalDiesWithTheMachineThatAsked is the convergence rule on the
// Hub's side of the wire: the answer can no longer reach the machine, and the
// work it was blocked on is being failed at the same moment, so the row is
// settled rather than left for a person to answer into the void.
func TestAPendingApprovalDiesWithTheMachineThatAsked(t *testing.T) {
	// The Hub settles a machine's questions before it abandons that machine's
	// turns, which is the order server.go wires and the reason the callback comes
	// first here: settling a question pushes the task out of waiting_approval and
	// back into running, so failing the turn afterwards has the last word.
	var approvals *node.Approvals
	s, master, conns, turns := remoteHub(t, func(_ *node.Turns, sender node.Sender) {
		if approvals != nil {
			approvals.Abandon(sender)
		}
	})
	approvals = &node.Approvals{Turns: turns, Engine: s.Engine, Poll: 20 * time.Millisecond}
	s.NodeFrames = nodeFramesWithApprovals(turns, approvals)
	hub := httptest.NewServer(s.Handler())
	defer hub.Close()

	deviceToken, deviceID := pairDevice(t, s.Handler(), master)

	relay := &node.ApprovalRelay{}
	local, localToken := localDaemon(t, relay)
	agent := newAskingAgent(&approvalbridge.Client{DaemonURL: local.URL, Token: localToken})

	work := t.TempDir()
	_, stop := startRelayExecutor(t, hub.URL, deviceToken, []string{work}, agent, relay)
	awaitOnline(t, conns, deviceID)

	created := createTask(t, s.Handler(), master, map[string]any{
		"agent": "claude-code", "cwd": work, "prompt": "ask before you touch anything",
		"executing_device_id": deviceID,
	})
	awaitAsks(t, agent)
	approval := awaitApproval(t, s, created.ID)

	// The machine goes away while the question is open: its daemon stops, or the
	// laptop shuts, or the network does.
	stop()

	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		stored, err := s.Store.GetApproval(context.Background(), approval.ID)
		if err == nil && stored.Decision != store.DecisionPending {
			if stored.Decision != store.DecisionExpired {
				t.Fatalf("decision = %q, want an expiry nobody chose", stored.Decision)
			}
			if stored.DecidedVia == nil || *stored.DecidedVia != "device_disconnected" {
				t.Fatalf("decided_via = %v, want the disconnect recorded", stored.DecidedVia)
			}
			awaitTaskStatus(t, s, created.ID, task.StatusFailed)
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("the question outlived the machine that asked it")
}
