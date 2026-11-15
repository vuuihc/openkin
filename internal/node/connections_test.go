package node

import (
	"context"
	"errors"
	"testing"

	"github.com/vuuihc/openkin/internal/remote/worker"
)

func TestConnectionsAttachReplacesAndReportsTheOldConnectionEnded(t *testing.T) {
	var ended []Sender
	conns := NewConnections(func(sender Sender) { ended = append(ended, sender) })

	first := newTestConn("device-1")
	if previous := conns.Attach(first); previous != nil {
		t.Fatalf("first attach displaced %v", previous)
	}
	second := newTestConn("device-1")
	if previous := conns.Attach(second); previous != first {
		t.Fatalf("reconnect displaced %v, want the first connection", previous)
	}
	// The replaced connection is over, and its turns went with it: the Node ties
	// a turn's lifetime to the socket that dispatched it, so closing this one
	// stopped the work on that machine. Reporting it here is the only chance to
	// settle those turns — its own Detach no longer speaks for the device.
	if len(ended) != 1 || ended[0] != Sender(first) {
		t.Fatalf("ended = %v, want one report for the replaced connection", ended)
	}

	// The replaced connection must not remove its successor on the way out, nor
	// report a second ending.
	conns.Detach(first)
	if !conns.Connected("device-1") {
		t.Fatal("detaching the replaced connection removed the live one")
	}
	if len(ended) != 1 {
		t.Fatalf("the replaced connection reported twice: %v", ended)
	}
	conns.Detach(second)
	if conns.Connected("device-1") {
		t.Fatal("detaching the live connection left it connected")
	}
	if len(ended) != 2 || ended[1] != Sender(second) {
		t.Fatalf("ended = %v, want one report per connection", ended)
	}
}

func TestConnectionsSendToOfflineDevice(t *testing.T) {
	conns := NewConnections(nil)
	if err := conns.Send(context.Background(), "missing", worker.Frame{}); !errors.Is(err, ErrOffline) {
		t.Fatalf("send to an offline device: %v, want ErrOffline", err)
	}

	sender := newTestConn("device-1")
	conns.Attach(sender)
	frame, err := worker.NewFrame("turn.cancel", worker.TurnCancel{TurnID: "t1"})
	if err != nil {
		t.Fatal(err)
	}
	if err := conns.Send(context.Background(), "device-1", frame); err != nil {
		t.Fatal(err)
	}
	if frames := sender.sent(); len(frames) != 1 || frames[0].Kind != "turn.cancel" {
		t.Fatalf("frames = %v", frames)
	}
}

func TestConnectionsOnline(t *testing.T) {
	conns := NewConnections(nil)
	conns.Attach(newTestConn("a"))
	conns.Attach(newTestConn("b"))
	online := conns.Online()
	if len(online) != 2 {
		t.Fatalf("online = %v", online)
	}
}

func TestWSEndpoint(t *testing.T) {
	cases := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{in: "https://kin.example.com", want: "wss://kin.example.com/api/node"},
		{in: "http://192.168.1.20:7777", want: "ws://192.168.1.20:7777/api/node"},
		{in: "https://kin.example.com/", want: "wss://kin.example.com/api/node"},
		{in: "wss://kin.example.com", want: "wss://kin.example.com/api/node"},
		{in: "", wantErr: true},
		{in: "kin.example.com", wantErr: true},
		{in: "ftp://kin.example.com", wantErr: true},
	}
	for _, tc := range cases {
		got, err := wsEndpoint(tc.in)
		if tc.wantErr {
			if err == nil {
				t.Errorf("wsEndpoint(%q) = %q, want an error", tc.in, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("wsEndpoint(%q): %v", tc.in, err)
			continue
		}
		if got != tc.want {
			t.Errorf("wsEndpoint(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestDecodeCapabilitiesIgnoresJunk(t *testing.T) {
	if got := DecodeCapabilities(""); len(got.WorkspaceRoots) != 0 {
		t.Fatalf("empty input decoded to %v", got)
	}
	if got := DecodeCapabilities("{not json"); len(got.WorkspaceRoots) != 0 {
		t.Fatalf("junk input decoded to %v", got)
	}
	encoded, err := EncodeCapabilities(worker.Hello{
		WorkspaceRoots: []worker.WorkspaceRoot{{Path: "/code/a"}},
		MaxConcurrent:  3,
	})
	if err != nil {
		t.Fatal(err)
	}
	got := DecodeCapabilities(encoded)
	if len(got.WorkspaceRoots) != 1 || got.WorkspaceRoots[0].Path != "/code/a" || got.MaxConcurrent != 3 {
		t.Fatalf("round trip = %+v", got)
	}
}
