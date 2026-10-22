package worker

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/store"
)

func validHello() Hello {
	return Hello{
		Version:  ProtocolVersion,
		WorkerID: "device-1",
		Agents: []Agent{{
			ID: "claude-code", Installed: true, Available: true,
			Version: "2.1.0", Models: []string{"sonnet"},
		}},
		WorkspaceRoots: []WorkspaceRoot{{
			Path: "/Users/me/code/openkin", RemoteURL: "github.com/vuuihc/openkin", RelativePath: "internal",
		}},
		MaxConcurrent: 2,
	}
}

func TestHelloValidationRejectsDuplicateAgents(t *testing.T) {
	h := validHello()
	h.Agents = append(h.Agents, h.Agents[0])
	if err := h.Validate(); err == nil {
		t.Fatal("duplicate agent was accepted")
	}
}

func TestHelloValidationRejectsAgentWithoutID(t *testing.T) {
	h := validHello()
	h.Agents[0].ID = "  "
	if err := h.Validate(); err == nil {
		t.Fatal("agent without an id was accepted")
	}
}

func TestFrameRoundTripAndBounds(t *testing.T) {
	frame, err := NewFrame("hello", validHello())
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(frame)
	if err != nil {
		t.Fatal(err)
	}
	var got Frame
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if err := got.Validate(); err != nil {
		t.Fatal(err)
	}
	if _, err := NewFrame("unknown", nil); err == nil {
		t.Fatal("unknown frame kind was accepted")
	}
}

// frameSamples is one buildable payload per frame kind: the register of
// everything this protocol can actually put on the wire.
//
// A kind missing from here is a kind nobody can prove is sendable. That is not
// hypothetical: `turn.started` was constructed but never registered in
// allowedFrameKinds, so NewFrame refused it, the sender could only warn, and
// every remote turn would have died on the Hub's start deadline — with a green
// test suite, because no test built the frame the executor sends.
var frameSamples = map[string]any{
	"hello":         validHello(),
	"hello_ack":     HelloAck{Version: ProtocolVersion, HeartbeatSeconds: 15, HubTime: 1},
	"heartbeat":     Heartbeat{LeaseID: "lease-1", WorkerID: "device-1", At: 1},
	"error":         map[string]string{"error": "boom"},
	"turn.dispatch": validDispatch(),
	"turn.event": TurnEvent{
		TurnID: "turn-1", Seq: 2, Event: json.RawMessage(`{"type":"result"}`),
	},
	"turn.started": TurnStarted{TurnID: "turn-1"},
	"turn.finish":  TurnFinish{TurnID: "turn-1", Status: TurnError, Error: "boom"},
	"turn.cancel":  TurnCancel{TurnID: "turn-1", Reason: "user stopped it"},
	"approval.request": ApprovalRequest{
		RequestID: "req-1", TurnID: "turn-1", Kind: "tool_use",
		Payload: json.RawMessage(`{"tool":"Bash"}`), Agent: "claude-code",
	},
	"approval.status":   ApprovalStatus{RequestID: "req-1", ApprovalID: "apr-1"},
	"approval.decision": ApprovalDecision{RequestID: "req-1", Decision: ApprovalApproved},
}

// TestEveryFrameKindRoundTrips holds the registry of kinds and the samples
// together, in both directions: every kind can be built and survives the
// envelope, and every kind this package accepts has a sample proving it.
func TestEveryFrameKindRoundTrips(t *testing.T) {
	for kind, payload := range frameSamples {
		frame, err := NewFrame(kind, payload)
		if err != nil {
			t.Fatalf("%s: %v", kind, err)
		}
		if err := frame.Validate(); err != nil {
			t.Fatalf("%s: %v", kind, err)
		}
		var decoded map[string]any
		if err := json.Unmarshal(frame.Data, &decoded); err != nil {
			t.Fatalf("%s: %v", kind, err)
		}
		if len(decoded) == 0 {
			t.Fatalf("%s encoded to nothing", kind)
		}
	}
	for kind := range allowedFrameKinds {
		if _, ok := frameSamples[kind]; !ok {
			t.Errorf("frame kind %q is registered but nothing proves it can be built; "+
				"add a sample to frameSamples or delete the kind", kind)
		}
	}

	// The kinds that nothing ever sent are gone, so a stale Node cannot look
	// like it is speaking the protocol.
	for _, kind := range []string{"assignment", "event", "cancel", "task_event", "lease", "ack"} {
		if _, err := NewFrame(kind, map[string]string{}); err == nil {
			t.Errorf("frame kind %q is still accepted", kind)
		}
	}
}

// TestApprovalDecisionsMatchTheStore keeps the wire vocabulary and the recorded
// one the same three words. The Hub sends what the store decided, and the device
// only understands these; a drift would fail closed for every approval at once,
// which is the kind of outage a constant is supposed to prevent.
func TestApprovalDecisionsMatchTheStore(t *testing.T) {
	for _, tc := range []struct{ wire, stored string }{
		{ApprovalApproved, store.DecisionApproved},
		{ApprovalDenied, store.DecisionDenied},
		{ApprovalExpired, store.DecisionExpired},
	} {
		if tc.wire != tc.stored {
			t.Errorf("the wire says %q where the store says %q", tc.wire, tc.stored)
		}
	}
}

func TestHelloAckRejectsImpossibleHeartbeat(t *testing.T) {
	ack := HelloAck{Version: ProtocolVersion, HeartbeatSeconds: 0}
	if err := ack.Validate(); err == nil {
		t.Fatal("zero heartbeat interval was accepted")
	}
}

// A root's path is what the console shows, so it has to be the directory a user
// would recognize on the machine that reported it — including on a machine
// whose separator is not this one's.
func TestWorkspaceRootPath(t *testing.T) {
	for _, tc := range []struct {
		name string
		root WorkspaceRoot
		want string
	}{
		{"checkout", WorkspaceRoot{Path: "/code/openkin"}, "/code/openkin"},
		{"checkout with trailing slash", WorkspaceRoot{Path: "/code/openkin/"}, "/code/openkin"},
		{"inside the checkout", WorkspaceRoot{Path: "/code/openkin", RelativePath: "internal/task"}, "/code/openkin/internal/task"},
		{"repository root", WorkspaceRoot{Path: "/code/openkin", RelativePath: "."}, "/code/openkin"},
		{"windows checkout", WorkspaceRoot{Path: `C:\code\openkin`}, `C:\code\openkin`},
		{"windows checkout, inner path", WorkspaceRoot{Path: `C:\code\openkin`, RelativePath: "internal/task"}, `C:\code\openkin\internal\task`},
		{"unc share", WorkspaceRoot{Path: `\\nas\code\openkin`, RelativePath: "internal"}, `\\nas\code\openkin\internal`},
	} {
		if got := tc.root.RootPath(); got != tc.want {
			t.Fatalf("%s: RootPath() = %q want %q", tc.name, got, tc.want)
		}
		if err := tc.root.Validate(); err != nil {
			t.Fatalf("%s: a root that was reported is not valid: %v", tc.name, err)
		}
	}
}

// Roots come from another machine, so they are checked at the boundary: an
// absolute path, a relative path that stays inside the checkout, and a remote
// that is already canonical and credential-free (ADR 0022 D7).
func TestWorkspaceRootValidation(t *testing.T) {
	ok := WorkspaceRoot{Path: "/code/openkin", RemoteURL: "github.com/vuuihc/openkin", RelativePath: "internal"}
	if err := ok.Validate(); err != nil {
		t.Fatalf("valid root rejected: %v", err)
	}
	for name, root := range map[string]WorkspaceRoot{
		"no path":            {Path: "  "},
		"relative path":      {Path: "code/openkin"},
		"escaping relative":  {Path: "/code/openkin", RelativePath: "../../etc"},
		"absolute relative":  {Path: "/code/openkin", RelativePath: "/etc"},
		"nested escape":      {Path: "/code/openkin", RelativePath: "sub/../../etc"},
		"remote with a user": {Path: "/code/openkin", RemoteURL: "ssh://git@github.com/vuuihc/openkin"},
		"remote with a token": {Path: "/code/openkin",
			RemoteURL: "x-access-token:ghp_secret@github.com/vuuihc/openkin"},
		"remote with a scheme": {Path: "/code/openkin", RemoteURL: "https://github.com/vuuihc/openkin"},
		"scp remote":           {Path: "/code/openkin", RemoteURL: "git@github.com:vuuihc/openkin.git"},
		"remote with a query":  {Path: "/code/openkin", RemoteURL: "github.com/vuuihc/openkin?token=x"},
		"remote with a fragment": {Path: "/code/openkin",
			RemoteURL: "github.com/vuuihc/openkin#main"},
		// Every way of writing "out of the checkout" that is not a plain "/../":
		// the Hub stores this and resolves it on machines it cannot look at.
		"leading dotdot":        {Path: "/code/openkin", RelativePath: ".."},
		"backslash escape":      {Path: "/code/openkin", RelativePath: `..\etc`},
		"backslash nested":      {Path: "/code/openkin", RelativePath: `sub\..\..\etc`},
		"dotdot then slash":     {Path: "/code/openkin", RelativePath: "sub/.."},
		"trailing backslash up": {Path: "/code/openkin", RelativePath: `sub/..\..`},
	} {
		if err := root.Validate(); err == nil {
			t.Fatalf("%s: accepted %+v", name, root)
		}
	}
	// A machine that is not this one: the Hub may run on Linux while the Node is
	// a Windows box, so absoluteness cannot be filepath.IsAbs.
	if err := (WorkspaceRoot{Path: `C:\code`}).Validate(); err != nil {
		t.Fatalf("windows path rejected: %v", err)
	}
	if err := (WorkspaceRoot{Path: `C:\code\openkin`, RemoteURL: "github.com/vuuihc/openkin",
		RelativePath: `internal\task`}).Validate(); err != nil {
		t.Fatalf("windows relative path rejected: %v", err)
	}
	if err := (Hello{
		Version: ProtocolVersion, WorkerID: "device-1",
		Agents:         []Agent{{ID: "claude-code"}},
		WorkspaceRoots: []WorkspaceRoot{{Path: "/code", RelativePath: "../.."}},
		MaxConcurrent:  1,
	}).Validate(); err == nil {
		t.Fatal("a hello carrying an escaping root was accepted")
	}
}

func TestRegistryLeaseLifecycle(t *testing.T) {
	now := time.UnixMilli(1000)
	r := NewRegistry(10*time.Second, nil)
	r.SetClock(func() time.Time { return now })

	record, err := r.Register(validHello())
	if err != nil {
		t.Fatal(err)
	}
	if record.State != StateOnline || record.Lease.ExpiresAt != 11000 {
		t.Fatalf("record = %+v", record)
	}

	now = time.UnixMilli(9000)
	renewed, err := r.Heartbeat(Heartbeat{
		WorkerID: record.WorkerID, LeaseID: record.Lease.ID, At: 9000,
	})
	if err != nil {
		t.Fatal(err)
	}
	if renewed.Lease.ExpiresAt != 19000 {
		t.Fatalf("renewed lease = %+v", renewed.Lease)
	}

	now = time.UnixMilli(19000)
	offline := r.Sweep()
	if len(offline) != 1 || offline[0].State != StateOffline {
		t.Fatalf("offline = %+v", offline)
	}
	if _, err := r.Heartbeat(Heartbeat{
		WorkerID: record.WorkerID, LeaseID: record.Lease.ID, At: 19001,
	}); !errors.Is(err, ErrLeaseExpired) {
		t.Fatalf("heartbeat after expiry = %v", err)
	}
	if len(r.Sweep()) != 0 {
		t.Fatal("offline hook/state repeated on second sweep")
	}
}

func TestRegistryRevokeIsIndependent(t *testing.T) {
	r := NewRegistry(time.Minute, nil)
	r.SetClock(func() time.Time { return time.UnixMilli(1000) })
	record, err := r.Register(validHello())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.Revoke(record.WorkerID, time.UnixMilli(1001)); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Heartbeat(Heartbeat{
		WorkerID: record.WorkerID, LeaseID: record.Lease.ID, At: 1002,
	}); !errors.Is(err, ErrWorkerRevoked) {
		t.Fatalf("heartbeat after revoke = %v", err)
	}
}

func TestRegistryBindsLeaseToOwnerAndNotifiesOnce(t *testing.T) {
	now := time.UnixMilli(1000)
	var offline []Record
	r := NewRegistry(time.Second, func(record Record) {
		offline = append(offline, record)
	})
	r.SetClock(func() time.Time { return now })
	record, err := r.RegisterForOwner(validHello(), "device-a")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.HeartbeatForOwner(Heartbeat{
		WorkerID: record.WorkerID, LeaseID: record.Lease.ID, At: 1001,
	}, "device-b"); !errors.Is(err, ErrWorkerOwner) {
		t.Fatalf("cross-device heartbeat = %v", err)
	}
	now = time.UnixMilli(2000)
	if got := r.Sweep(); len(got) != 1 || len(offline) != 1 {
		t.Fatalf("sweep = %v, offline hook = %v", got, offline)
	}
	if offline[0].OwnerDeviceID != "device-a" || offline[0].State != StateOffline {
		t.Fatalf("offline record = %+v", offline[0])
	}
	if len(r.Sweep()) != 0 || len(offline) != 1 {
		t.Fatalf("offline notification repeated: %v", offline)
	}
	if _, err := r.HeartbeatForOwner(Heartbeat{
		WorkerID: record.WorkerID, LeaseID: record.Lease.ID, At: 3000,
	}, "device-a"); !errors.Is(err, ErrLeaseExpired) {
		t.Fatalf("late heartbeat = %v", err)
	}
	if len(offline) != 1 {
		t.Fatalf("late heartbeat repeated offline hook: %v", offline)
	}
	if _, err := r.Revoke(record.WorkerID, time.UnixMilli(3001)); err != nil {
		t.Fatal(err)
	}
	if _, err := r.RegisterForOwner(validHello(), "device-a"); err == nil {
		t.Fatal("revoked worker ID was re-registered")
	}
}
