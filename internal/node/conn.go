package node

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"

	"nhooyr.io/websocket"

	"github.com/vuuihc/openkin/internal/remote/worker"
)

// Sender is the Hub's write end of one live Node connection.
type Sender interface {
	DeviceID() string
	Send(ctx context.Context, frame worker.Frame) error
	// Close ends the connection. Used when a newer connection replaces this one.
	Close(status websocket.StatusCode, reason string)
}

// conn is the Hub's handle on one live Node connection.
//
// Writes are serialized because a WebSocket permits one writer at a time and
// this connection has several: heartbeats, dispatches, cancellations, approval
// decisions. Reads happen on the handler's goroutine only.
type conn struct {
	deviceID string
	ws       *websocket.Conn

	mu sync.Mutex
}

// NewSender wraps an accepted WebSocket as the Hub's side of one device.
func NewSender(deviceID string, ws *websocket.Conn) Sender {
	return &conn{deviceID: deviceID, ws: ws}
}

func (c *conn) DeviceID() string { return c.deviceID }

func (c *conn) Send(ctx context.Context, frame worker.Frame) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return WriteFrame(ctx, c.ws, frame)
}

func (c *conn) Close(status websocket.StatusCode, reason string) {
	_ = c.ws.Close(status, reason)
}

// ReadFrame reads one frame and validates its envelope, so callers only ever
// see frames that speak the protocol.
func ReadFrame(ctx context.Context, ws *websocket.Conn) (worker.Frame, error) {
	_, data, err := ws.Read(ctx)
	if err != nil {
		return worker.Frame{}, err
	}
	return ParseFrame(data)
}

// ParseFrame decodes and validates a frame envelope.
func ParseFrame(data []byte) (worker.Frame, error) {
	var frame worker.Frame
	if err := json.Unmarshal(data, &frame); err != nil {
		return worker.Frame{}, fmt.Errorf("decode frame: %w", err)
	}
	if err := frame.Validate(); err != nil {
		return worker.Frame{}, err
	}
	return frame, nil
}

// WriteFrame sends a frame on a connection.
func WriteFrame(ctx context.Context, ws *websocket.Conn, frame worker.Frame) error {
	data, err := json.Marshal(frame)
	if err != nil {
		return fmt.Errorf("encode frame: %w", err)
	}
	return ws.Write(ctx, websocket.MessageText, data)
}

// Decode unmarshals a frame's payload into T.
func Decode[T any](frame worker.Frame) (T, error) {
	var out T
	if len(frame.Data) == 0 {
		return out, fmt.Errorf("frame %q has no payload", frame.Kind)
	}
	if err := json.Unmarshal(frame.Data, &out); err != nil {
		return out, fmt.Errorf("decode %s frame: %w", frame.Kind, err)
	}
	return out, nil
}

// Capabilities is the half of a hello that is not the agent inventory: where
// this machine keeps its work, and how much of it the Hub may use at once.
//
// It is stored as JSON in devices.capabilities. Nothing here is secret — it is
// the same short list of paths the machine would show a user who asked.
type Capabilities struct {
	WorkspaceRoots []string `json:"workspace_roots,omitempty"`
	MaxConcurrent  int      `json:"max_concurrent,omitempty"`
}

// EncodeCapabilities renders the non-agent half of a hello for storage.
func EncodeCapabilities(hello worker.Hello) (string, error) {
	data, err := json.Marshal(Capabilities{
		WorkspaceRoots: hello.WorkspaceRoots,
		MaxConcurrent:  hello.MaxConcurrent,
	})
	if err != nil {
		return "", fmt.Errorf("encode device capabilities: %w", err)
	}
	return string(data), nil
}

// DecodeCapabilities reads back what EncodeCapabilities wrote. An unreadable or
// absent value is not an error: that is simply a device which has never
// reported, the normal state for one that was paired but never connected.
func DecodeCapabilities(raw string) Capabilities {
	if raw == "" {
		return Capabilities{}
	}
	var caps Capabilities
	if err := json.Unmarshal([]byte(raw), &caps); err != nil {
		return Capabilities{}
	}
	return caps
}
