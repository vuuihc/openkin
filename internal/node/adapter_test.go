package node

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/remote/worker"
)

// TestDispatchCarriesNoSecrets is the serialized form of ADR 0022 D7. Checking
// the struct field is not enough: what matters is the bytes, because a field
// added to the dispatch later would travel without anybody deciding it should.
func TestDispatchCarriesNoSecrets(t *testing.T) {
	// A connection table the adapter can really send through, recording what it
	// puts on the wire.
	sender := newTestConn("device-1")
	conns := NewConnections(nil)
	turns := NewTurns()
	conns.Attach(sender)
	ad := &Adapter{Conns: conns, Turns: turns, DeviceID: "device-1"}
	handle, err := ad.Start(context.Background(), adapter.TaskSpec{
		ID:             "task-1",
		Agent:          "claude-code",
		Cwd:            "/code/kin",
		Prompt:         "fix the failing test",
		PermissionMode: adapter.PermissionDefault,
		Execution:      adapter.ExecutionRef{ID: "turn-1", Agent: "claude-code"},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = handle.Cancel() }()

	frames := sender.sent()
	if len(frames) != 1 || frames[0].Kind != "turn.dispatch" {
		t.Fatalf("frames = %+v", frames)
	}
	raw, err := json.Marshal(frames[0])
	if err != nil {
		t.Fatal(err)
	}
	wire := strings.ToLower(string(raw))
	for _, forbidden := range []string{
		"provider", "api_key", "apikey", "token", "secret", "base_url", "credential", "auth",
	} {
		if strings.Contains(wire, forbidden) {
			t.Fatalf("the dispatch carried %q over the wire: %s", forbidden, raw)
		}
	}
	// And what it must carry, it does.
	dispatch, err := Decode[worker.Dispatch](frames[0])
	if err != nil {
		t.Fatal(err)
	}
	if dispatch.TurnID != "turn-1" || dispatch.TaskID != "task-1" || dispatch.Cwd != "/code/kin" {
		t.Fatalf("dispatch = %+v", dispatch)
	}
}

// TestAdapterRefusesToDispatchWithoutAConnection keeps the Hub from opening a
// turn nobody can feed.
func TestAdapterRefusesToDispatchWithoutAConnection(t *testing.T) {
	turns := NewTurns()
	ad := &Adapter{Conns: NewConnections(nil), Turns: turns, DeviceID: "device-1"}
	_, err := ad.Start(context.Background(), adapter.TaskSpec{
		ID:        "task-1",
		Agent:     "claude-code",
		Cwd:       "/code/kin",
		Prompt:    "run this",
		Execution: adapter.ExecutionRef{ID: "turn-1", Agent: "claude-code"},
	})
	if err == nil {
		t.Fatal("a turn was dispatched to a device with no connection")
	}
	if running := turns.Running(""); len(running) != 0 {
		t.Fatalf("the failed dispatch left a turn open: %v", running)
	}
}

// TestAdapterCancelReachesTheDevice keeps the Hub's stop button wired to the
// machine that is doing the work.
func TestAdapterCancelReachesTheDevice(t *testing.T) {
	sender := newTestConn("device-1")
	conns := NewConnections(nil)
	conns.Attach(sender)
	turns := NewTurns()
	ad := &Adapter{Conns: conns, Turns: turns, DeviceID: "device-1"}
	handle, err := ad.Start(context.Background(), adapter.TaskSpec{
		ID: "task-1", Agent: "claude-code", Cwd: "/code/kin", Prompt: "run this",
		Execution: adapter.ExecutionRef{ID: "turn-1", Agent: "claude-code"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := handle.Cancel(); err != nil {
		t.Fatal(err)
	}
	frames := sender.sent()
	if len(frames) != 2 || frames[1].Kind != "turn.cancel" {
		t.Fatalf("frames = %+v", frames)
	}
	cancel, err := Decode[worker.TurnCancel](frames[1])
	if err != nil {
		t.Fatal(err)
	}
	if cancel.TurnID != "turn-1" {
		t.Fatalf("cancel = %+v", cancel)
	}
	// The turn is over on this side too, so the engine's slot comes back.
	select {
	case _, open := <-handle.Events():
		if open {
			t.Fatal("cancel left the event channel open")
		}
	case <-time.After(time.Second):
		t.Fatal("cancel did not close the event channel")
	}
}
