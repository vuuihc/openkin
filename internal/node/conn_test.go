package node

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"nhooyr.io/websocket"

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

// wedgedConnection returns a sender whose peer never reads a byte, with a write
// already in flight that holds the connection's write turn.
func wedgedConnection(t *testing.T) Sender {
	t.Helper()
	accepted := make(chan struct{})
	done := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close(websocket.StatusNormalClosure, "")
		close(accepted)
		// The peer that never reads: the socket's buffer fills, and every write
		// from here on is a write nobody is draining.
		<-done
	}))
	t.Cleanup(server.Close)
	// Closing the peer is what unblocks the write below, so it has to happen
	// before the server waits for its handler to return.
	t.Cleanup(func() { close(done) })

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-accepted:
	case <-time.After(5 * time.Second):
		t.Fatal("the peer never accepted the connection")
	}

	sender := NewSender("device-1", ws)
	// Larger than any socket buffer, so it is still in flight when the sends
	// below try to take the write turn.
	big := frameOfSize(t, 4<<20)
	go func() {
		writeCtx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		_ = sender.Send(writeCtx, big)
	}()
	deadline := time.Now().Add(5 * time.Second)
	for len(sender.(*conn).write) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("the first write never took the connection's write turn")
		}
		time.Sleep(time.Millisecond)
	}
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
