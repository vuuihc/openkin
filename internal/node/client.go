package node

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"nhooyr.io/websocket"

	"github.com/vuuihc/openkin/internal/remote/worker"
)

// Path is where a Node connects on the Hub.
const Path = "/api/node"

// FrameHandler handles a frame the Hub sent down. Returning an error only
// abandons that frame: the connection is the transport's business, and one bad
// dispatch should not cost the Node every other turn it is running.
type FrameHandler func(ctx context.Context, frame worker.Frame) error

// WriteFunc writes one frame to the Hub. A Node has exactly one peer, so
// unlike the Hub's SendFunc it takes no device.
type WriteFunc func(ctx context.Context, frame worker.Frame) error

// ClientConfig describes one Node's connection to its Hub.
type ClientConfig struct {
	// HubURL is the Hub's origin, e.g. https://kin.example.com or
	// http://192.168.1.20:7777. ws/wss is derived from it.
	HubURL string
	// Token is the device credential from pairing. It is the same credential a
	// browser or phone uses; a Node is a device like any other.
	Token string
	// Hello is what this machine reports about itself.
	Hello worker.Hello
	// OnFrame receives every frame that is not part of the handshake or the
	// heartbeat.
	OnFrame FrameHandler
	// OnReady receives this connection's write path once the handshake
	// completes, and nil when the connection ends. Turns running on this machine
	// use it to talk back; without it they can only be started and never heard.
	OnReady func(send WriteFunc)
	// Warn receives connection lifecycle problems. Nil means stay quiet.
	Warn func(format string, args ...any)
	// DialTimeout bounds one connection attempt. Defaults to 15s.
	DialTimeout time.Duration
}

func (cfg ClientConfig) warn(format string, args ...any) {
	if cfg.Warn != nil {
		cfg.Warn(format, args...)
	}
}

// RunOnce connects, serves the connection until it drops or ctx ends, and
// returns. Reconnection belongs to Run, so one dropped socket does not turn
// into a reconnect storm here.
func RunOnce(ctx context.Context, cfg ClientConfig) error {
	conn, ack, err := dial(ctx, cfg)
	if err != nil {
		return err
	}
	defer conn.Close(websocket.StatusNormalClosure, "")
	cfg.warn("node connected to %s (heartbeat %ds)", cfg.HubURL, ack.HeartbeatSeconds)

	// Cancelling the read context stops the heartbeat when this returns.
	readCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	if cfg.OnReady != nil {
		cfg.OnReady(func(ctx context.Context, frame worker.Frame) error {
			return WriteFrame(ctx, conn, frame)
		})
		// Turns still running when this connection goes away have nobody to
		// report to; they must hear that before they keep trying.
		defer cfg.OnReady(nil)
	}

	heartbeatErr := make(chan error, 1)
	go func() {
		heartbeatErr <- heartbeatLoop(readCtx, conn, cfg.Hello.WorkerID, ack.HeartbeatSeconds)
	}()

	for {
		frame, err := ReadFrame(readCtx, conn)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			// A failed heartbeat is the more specific cause: the socket is
			// broken even though the read may not have noticed yet.
			select {
			case hbErr := <-heartbeatErr:
				if hbErr != nil {
					return fmt.Errorf("heartbeat: %w", hbErr)
				}
			default:
			}
			return fmt.Errorf("read from hub: %w", err)
		}
		switch frame.Kind {
		case "ack", "lease", "hello_ack":
			// Presence bookkeeping the Node has no part in.
			continue
		case "error":
			cfg.warn("hub reported an error: %s", strings.TrimSpace(string(frame.Data)))
			continue
		}
		if cfg.OnFrame == nil {
			cfg.warn("dropping unhandled frame %q", frame.Kind)
			continue
		}
		if err := cfg.OnFrame(readCtx, frame); err != nil {
			cfg.warn("frame %q failed: %v", frame.Kind, err)
		}
	}
}

// Run keeps a Node connected for as long as ctx lives, reconnecting with a
// bounded backoff. A Node that cannot reach its Hub is not broken — the Hub may
// be restarting, the laptop may be off the network — so this returns only when
// ctx ends.
func Run(ctx context.Context, cfg ClientConfig) error {
	attempt := 0
	for ctx.Err() == nil {
		err := RunOnce(ctx, cfg)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err != nil && !errors.Is(err, context.Canceled) {
			cfg.warn("node disconnected: %v", err)
		}
		delay := time.Duration(1<<min(attempt, 4)) * time.Second
		attempt++
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(delay):
		}
	}
	return ctx.Err()
}

// dial opens the control channel and completes the hello exchange.
func dial(ctx context.Context, cfg ClientConfig) (*websocket.Conn, worker.HelloAck, error) {
	if err := cfg.Hello.Validate(); err != nil {
		return nil, worker.HelloAck{}, fmt.Errorf("node hello: %w", err)
	}
	wsURL, err := wsEndpoint(cfg.HubURL)
	if err != nil {
		return nil, worker.HelloAck{}, err
	}
	timeout := cfg.DialTimeout
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	header := http.Header{}
	header.Set("Authorization", "Bearer "+strings.TrimSpace(cfg.Token))

	dialCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	conn, _, err := websocket.Dial(dialCtx, wsURL, &websocket.DialOptions{HTTPHeader: header})
	if err != nil {
		return nil, worker.HelloAck{}, fmt.Errorf("dial hub %s: %w", wsURL, err)
	}
	conn.SetReadLimit(worker.MaxFrameBytes)

	refuse := func(err error) (*websocket.Conn, worker.HelloAck, error) {
		_ = conn.Close(websocket.StatusProtocolError, "handshake failed")
		return nil, worker.HelloAck{}, err
	}

	hello, err := worker.NewFrame("hello", cfg.Hello)
	if err != nil {
		return refuse(err)
	}
	if err := WriteFrame(dialCtx, conn, hello); err != nil {
		return refuse(fmt.Errorf("send hello: %w", err))
	}

	frame, err := ReadFrame(dialCtx, conn)
	if err != nil {
		return refuse(fmt.Errorf("await hello_ack: %w", err))
	}
	if frame.Kind == "error" {
		detail, _ := Decode[map[string]string](frame)
		return refuse(fmt.Errorf("hub refused hello: %s", detail["error"]))
	}
	if frame.Kind != "hello_ack" {
		return refuse(fmt.Errorf("expected hello_ack, got %q", frame.Kind))
	}
	ack, err := Decode[worker.HelloAck](frame)
	if err != nil {
		return refuse(err)
	}
	if err := ack.Validate(); err != nil {
		return refuse(err)
	}
	return conn, ack, nil
}

// heartbeatLoop keeps this device's presence fresh. A write failure is fatal to
// the connection: the socket is broken even if reads have not noticed.
func heartbeatLoop(ctx context.Context, ws *websocket.Conn, workerID string, seconds int) error {
	if seconds <= 0 {
		seconds = 15
	}
	ticker := time.NewTicker(time.Duration(seconds) * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			frame, err := worker.NewFrame("heartbeat", worker.Heartbeat{
				WorkerID: workerID,
				At:       time.Now().UnixMilli(),
			})
			if err != nil {
				return err
			}
			writeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err = WriteFrame(writeCtx, ws, frame)
			cancel()
			if err != nil {
				return err
			}
		}
	}
}

// wsEndpoint turns a Hub origin into the control-channel WebSocket URL.
func wsEndpoint(hubURL string) (string, error) {
	trimmed := strings.TrimSpace(hubURL)
	if trimmed == "" {
		return "", errors.New("hub url is required")
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return "", fmt.Errorf("parse hub url: %w", err)
	}
	switch parsed.Scheme {
	case "http":
		parsed.Scheme = "ws"
	case "https":
		parsed.Scheme = "wss"
	case "ws", "wss":
	default:
		return "", fmt.Errorf("hub url must be http(s), got %q", parsed.Scheme)
	}
	if parsed.Host == "" {
		return "", errors.New("hub url has no host")
	}
	parsed.Path = strings.TrimSuffix(parsed.Path, "/") + Path
	return parsed.String(), nil
}
