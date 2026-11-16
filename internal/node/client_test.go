package node

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"nhooyr.io/websocket"

	"github.com/vuuihc/openkin/internal/remote/worker"
)

// quietHello is a hello that passes validation without touching the network.
func quietHello() worker.Hello {
	return worker.Hello{
		Version:       worker.ProtocolVersion,
		WorkerID:      "test",
		Label:         "test",
		Agents:        []worker.Agent{{ID: "claude-code", Installed: true, Available: true}},
		MaxConcurrent: 4,
	}
}

func TestRunKeepsTryingAndBacksOff(t *testing.T) {
	// A port nobody is listening on: the Hub is down, which is the state a Node
	// has to survive without spinning.
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	url := "http://" + listener.Addr().String()
	_ = listener.Close()

	var (
		mu       sync.Mutex
		attempts int
	)
	ctx, cancel := context.WithTimeout(context.Background(), 2500*time.Millisecond)
	defer cancel()
	err = Run(ctx, ClientConfig{
		HubURL: url,
		Token:  "irrelevant",
		Hello:  func() worker.Hello { return quietHello() },
		Warn: func(string, ...any) {
			mu.Lock()
			attempts++
			mu.Unlock()
		},
	})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Run returned %v, want the context error", err)
	}

	mu.Lock()
	defer mu.Unlock()
	// Backoff starts at one second, so two and a half seconds buys a couple of
	// attempts. A tight loop would buy thousands.
	if attempts < 2 || attempts > 3 {
		t.Fatalf("made %d attempts in 2.5s: retries are not spaced", attempts)
	}
}

func TestRunOnceReturnsTheHubRefusal(t *testing.T) {
	// A Hub that accepts the socket and then refuses the hello speaks the
	// protocol, and the Node has to surface what it said. Reconnecting into a
	// refusal forever would be silent.
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "")
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		frame, err := ReadFrame(ctx, conn)
		if err != nil {
			return
		}
		if _, err := Decode[worker.Hello](frame); err != nil {
			return
		}
		refusal, err := worker.NewFrame("error", map[string]string{"error": "this hub is full"})
		if err != nil {
			return
		}
		_ = WriteFrame(ctx, conn, refusal)
	}))
	defer hub.Close()

	err := RunOnce(context.Background(), ClientConfig{
		HubURL: hub.URL,
		Token:  "device-token",
		Hello:  func() worker.Hello { return quietHello() },
	})
	if err == nil {
		t.Fatal("a refused hello was reported as success")
	}
	if !strings.Contains(err.Error(), "this hub is full") {
		t.Fatalf("refusal lost its reason: %v", err)
	}
}

func TestRunOnceSendsHeartbeats(t *testing.T) {
	beats := make(chan worker.Heartbeat, 4)
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "")
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		if _, err := ReadFrame(ctx, conn); err != nil {
			return
		}
		ack, err := worker.NewFrame("hello_ack", worker.HelloAck{
			Version: worker.ProtocolVersion,
			// One second, so the test does not wait fifteen for the first beat.
			HeartbeatSeconds: 1,
			HubTime:          time.Now().UnixMilli(),
		})
		if err != nil {
			return
		}
		if err := WriteFrame(ctx, conn, ack); err != nil {
			return
		}
		for {
			frame, err := ReadFrame(ctx, conn)
			if err != nil {
				return
			}
			if frame.Kind != "heartbeat" {
				continue
			}
			beat, err := Decode[worker.Heartbeat](frame)
			if err != nil {
				return
			}
			select {
			case beats <- beat:
			default:
			}
		}
	}))
	defer hub.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		_ = RunOnce(ctx, ClientConfig{HubURL: hub.URL, Token: "t", Hello: func() worker.Hello { return quietHello() }})
	}()

	select {
	case beat := <-beats:
		if beat.WorkerID != "test" {
			t.Fatalf("heartbeat = %+v", beat)
		}
		if beat.At <= 0 {
			t.Fatalf("heartbeat has no timestamp: %+v", beat)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the node never sent a heartbeat")
	}
}

// TestRunAnnouncesAFreshHelloOnRefresh pins live propagation: the Hub builds
// the phone's agent list from the last hello, so a default changed while the
// daemon runs has to reach it without a restart.
func TestRunAnnouncesAFreshHelloOnRefresh(t *testing.T) {
	hellos := make(chan worker.Hello, 4)
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "")
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		frame, err := ReadFrame(ctx, conn)
		if err != nil {
			return
		}
		hello, err := Decode[worker.Hello](frame)
		if err != nil {
			return
		}
		select {
		case hellos <- hello:
		default:
		}
		ack, err := worker.NewFrame("hello_ack", worker.HelloAck{
			Version:          worker.ProtocolVersion,
			HeartbeatSeconds: 30,
			HubTime:          time.Now().UnixMilli(),
		})
		if err != nil {
			return
		}
		if err := WriteFrame(ctx, conn, ack); err != nil {
			return
		}
		// Hold the connection open until the node redials.
		for {
			if _, err := ReadFrame(ctx, conn); err != nil {
				return
			}
		}
	}))
	defer hub.Close()

	var current atomic.Value
	current.Store("opencode")
	refresh := make(chan struct{}, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		_ = Run(ctx, ClientConfig{
			HubURL: hub.URL,
			Token:  "t",
			Hello: func() worker.Hello {
				hello := quietHello()
				hello.Agents = []worker.Agent{{
					ID: current.Load().(string), Installed: true, Available: true, IsDefault: true,
				}}
				return hello
			},
			Refresh: refresh,
		})
	}()

	next := func() worker.Hello {
		t.Helper()
		select {
		case hello := <-hellos:
			return hello
		case <-time.After(5 * time.Second):
			t.Fatal("the node did not announce itself")
			return worker.Hello{}
		}
	}
	if got := next().Agents[0].ID; got != "opencode" {
		t.Fatalf("first hello names %q", got)
	}

	current.Store("claude-code")
	refresh <- struct{}{}

	if got := next().Agents[0].ID; got != "claude-code" {
		t.Fatalf("hello after refresh names %q, want claude-code", got)
	}
}
