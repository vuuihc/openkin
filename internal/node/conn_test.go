package node

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/remote/worker"
)

// A peer that stops reading must not be able to hold a connection's write turn
// forever, because the frame reader writes too: it answers a turn this Hub is
// not running with a cancel. A reader parked on an un-interruptible lock stops
// reading, a connection that stops being read is never detached, and a
// connection that is never detached never fails the turns it was carrying — so
// those tasks sit in running for good.
func TestASendDoesNotWaitForeverForTheWriteTurn(t *testing.T) {
	sender := wedgedConnection(t)

	// The caller that has a deadline of its own gets it.
	short, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()
	start := time.Now()
	if err := sender.Send(short, smallFrame(t)); err == nil {
		t.Fatal("the frame was written to a peer that is not reading")
	}
	if waited := time.Since(start); waited > 2*time.Second {
		t.Fatalf("a send with a 250ms deadline waited %s for the write turn", waited)
	}

	// And the caller that has none still gets one: both of the paths that
	// dispatch and cancel a turn pass a context that never ends.
	saved := sendTimeout
	sendTimeout = 200 * time.Millisecond
	defer func() { sendTimeout = saved }()
	start = time.Now()
	if err := sender.Send(context.Background(), smallFrame(t)); err == nil {
		t.Fatal("the frame was written to a peer that is not reading")
	}
	if waited := time.Since(start); waited > 2*time.Second {
		t.Fatalf("a send with no deadline of its own waited %s", waited)
	}
}

// wedgedConnection returns a sender whose write turn is held: the state a
// write to a peer that stopped reading leaves behind.
//
// The turn is held directly rather than by writing a frame "larger than any
// socket buffer". A 4 MiB frame fits in Linux's autotuned send buffer, so the
// write completed and released the turn before the test took it; the test then
// failed only on CI, while passing on a Mac with a smaller buffer. The property
// under test is the interruptible wait for the turn, not the kernel's buffer
// size.
func wedgedConnection(t *testing.T) Sender {
	t.Helper()
	sender := &conn{deviceID: "device-1", write: make(chan struct{}, 1)}
	sender.write <- struct{}{}
	t.Cleanup(func() { <-sender.write })
	return sender
}

func smallFrame(t *testing.T) worker.Frame {
	t.Helper()
	return frameOfSize(t, 0)
}

// frameOfSize builds one frame directly rather than through worker.NewFrame:
// the point here is a payload no socket buffer will hold, and the protocol's
// own frame bound is not what this test is about.
func frameOfSize(t *testing.T, payload int) worker.Frame {
	t.Helper()
	data, err := json.Marshal(worker.TurnEvent{
		TurnID: "turn-1", Seq: 1,
		Event: json.RawMessage(`"` + strings.Repeat("x", payload) + `"`),
	})
	if err != nil {
		t.Fatal(err)
	}
	return worker.Frame{Version: worker.ProtocolVersion, Kind: "turn.event", Data: data}
}
