package api

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"nhooyr.io/websocket"

	"github.com/vuuihc/openkin/internal/node"
	"github.com/vuuihc/openkin/internal/remote"
	"github.com/vuuihc/openkin/internal/remote/worker"
	"github.com/vuuihc/openkin/internal/store"
)

// How long a Node has to say hello, and how often it is asked to check in.
const (
	nodeHelloTimeout     = 20 * time.Second
	nodeHeartbeatSeconds = 15
)

// nodeRevokeCheck is how often an open control channel re-reads whether its
// credential is still valid. It is a variable so a test can shorten it.
var nodeRevokeCheck = 5 * time.Second

// handleNodeConnect is the control channel: one WebSocket per Node, opened by
// the Node, carrying everything the Hub and that machine need to say to each
// other.
//
// The handshake is strict and comes first. Everything after it is routed by
// device, so a connection that has not identified itself is useless — and a Hub
// that trusted the frame's own worker_id over the credential that carried it
// would let any paired device claim to be any other.
func (s *Server) handleNodeConnect(w http.ResponseWriter, r *http.Request) {
	if s.Nodes == nil || s.Store == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "node connections are disabled"})
		return
	}
	principal, ok := remote.PrincipalFromContext(r.Context())
	if !ok || principal.Kind != remote.PrincipalDevice || strings.TrimSpace(principal.DeviceID) == "" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "paired device token required"})
		return
	}
	deviceID := principal.DeviceID

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// A Node is a native client with no origin, and the credential above is
		// what authorizes the connection.
		InsecureSkipVerify: true,
	})
	if err != nil {
		return
	}
	conn.SetReadLimit(worker.MaxFrameBytes)
	defer conn.Close(websocket.StatusNormalClosure, "")

	ctx := r.Context()
	hello, err := readNodeHello(ctx, conn)
	if err != nil {
		refuseNode(ctx, conn, err)
		return
	}
	if err := s.recordNodeHello(ctx, deviceID, hello, time.Now().UnixMilli()); err != nil {
		refuseNode(ctx, conn, fmt.Errorf("record hello: %w", err))
		return
	}

	ack, err := worker.NewFrame("hello_ack", worker.HelloAck{
		Version:          worker.ProtocolVersion,
		HeartbeatSeconds: nodeHeartbeatSeconds,
		HubTime:          time.Now().UnixMilli(),
	})
	if err != nil {
		refuseNode(ctx, conn, err)
		return
	}
	sender := node.NewSender(deviceID, conn)
	if err := sender.Send(ctx, ack); err != nil {
		return
	}

	// From here the device is reachable. A reconnect replaces the old
	// connection rather than being refused: a laptop that slept must be able to
	// come back without waiting for the Hub to notice it left.
	if previous := s.Nodes.Attach(sender); previous != nil {
		previous.Close(websocket.StatusPolicyViolation, "replaced by a newer connection")
	}
	defer s.Nodes.Detach(sender)

	// Revocation has to reach a socket that is already open, or a machine the
	// operator has cut off keeps taking work.
	go s.watchNodeRevocation(ctx, deviceID, conn)

	// Presence is not worth dropping a working connection over: the device is
	// here either way, and the heartbeat below will try again.
	_ = s.Store.SetDeviceReachability(ctx, deviceID, store.ReachabilityOnline)
	defer func() {
		// The process holding the socket is the only thing that can tell
		// "offline" from "the Hub restarted", so presence is written here, on
		// the way out, and nowhere else. WithoutCancel: the request context is
		// already done by the time this runs.
		_ = s.Store.SetDeviceReachability(context.WithoutCancel(ctx), deviceID, store.ReachabilityOffline)
	}()

	s.serveNode(ctx, deviceID, conn)
}

// watchNodeRevocation closes the control channel once the device's credential is
// no longer valid.
//
// The handshake checked it once, and a socket can outlive that: revoking a
// machine has to end what it can do, not just its next connection attempt. This
// channel matters more than the console's streams, which do the same check —
// this is the socket that carries commands.
func (s *Server) watchNodeRevocation(ctx context.Context, deviceID string, conn *websocket.Conn) {
	ticker := time.NewTicker(nodeRevokeCheck)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			// An unreadable answer is treated as "not valid": the only reason
			// this query fails is that the Hub cannot speak for the device
			// registry, and a machine that keeps executing through that is worse
			// than one that reconnects when the Hub recovers.
			active, err := s.Store.DeviceActive(ctx, deviceID)
			if err != nil || !active {
				_ = conn.Close(websocket.StatusPolicyViolation, "device credential revoked")
				return
			}
		}
	}
}

// readNodeHello reads the opening frame. Anything else — a heartbeat, a stray
// frame, an older protocol — is a client that does not speak this channel.
func readNodeHello(ctx context.Context, conn *websocket.Conn) (worker.Hello, error) {
	readCtx, cancel := context.WithTimeout(ctx, nodeHelloTimeout)
	defer cancel()

	frame, err := node.ReadFrame(readCtx, conn)
	if err != nil {
		return worker.Hello{}, fmt.Errorf("read hello: %w", err)
	}
	if frame.Kind != "hello" {
		return worker.Hello{}, fmt.Errorf("expected hello, got %q", frame.Kind)
	}
	hello, err := node.Decode[worker.Hello](frame)
	if err != nil {
		return worker.Hello{}, err
	}
	if err := hello.Validate(); err != nil {
		return worker.Hello{}, err
	}
	return hello, nil
}

// recordNodeHello writes the device row and its agent inventory.
//
// The frame's worker_id is never used as an identity: the device is the one the
// credential authenticated as. One daemon runs one Node per machine, and
// letting the payload rename the device would make the registry forgeable by
// any paired credential.
func (s *Server) recordNodeHello(ctx context.Context, deviceID string, hello worker.Hello, now int64) error {
	agents := make([]store.DeviceAgent, 0, len(hello.Agents))
	for _, agent := range hello.Agents {
		agents = append(agents, store.DeviceAgent{
			DeviceID:     deviceID,
			AgentID:      agent.ID,
			Installed:    agent.Installed,
			Available:    agent.Available,
			Version:      agent.Version,
			Reason:       agent.Reason,
			DefaultModel: agent.DefaultModel,
			Models:       agent.Models,
			IsDefault:    agent.IsDefault,
		})
	}
	capabilities, err := node.EncodeCapabilities(hello)
	if err != nil {
		return err
	}
	return s.Store.RecordDeviceHello(ctx, deviceID, store.Device{
		Label:        hello.Label,
		Platform:     hello.Platform,
		Arch:         hello.Arch,
		KinVersion:   hello.KinVersion,
		Capabilities: capabilities,
	}, agents, now)
}

// serveNode routes frames until the connection ends.
func (s *Server) serveNode(ctx context.Context, deviceID string, ws *websocket.Conn) {
	for {
		frame, err := node.ReadFrame(ctx, ws)
		if err != nil {
			return
		}
		switch frame.Kind {
		case "heartbeat":
			if _, err := node.Decode[worker.Heartbeat](frame); err != nil {
				continue
			}
			_ = s.Store.TouchDevice(ctx, deviceID, time.Now().UnixMilli())
		default:
			// Until turns are dispatched nothing consumes these. Saying so is
			// better than dropping them silently: a Node that sends a frame the
			// Hub does not understand should hear about it.
			_ = s.routeNodeFrame(ctx, deviceID, frame)
		}
	}
}

// routeNodeFrame hands a frame to whoever asked for it.
func (s *Server) routeNodeFrame(ctx context.Context, deviceID string, frame worker.Frame) error {
	if s.NodeFrames != nil {
		return s.NodeFrames(ctx, deviceID, frame)
	}
	return fmt.Errorf("unhandled frame kind %q", frame.Kind)
}

// refuseNode tells the Node why it is being turned away before closing. A Node
// logging "connection closed" with no reason is a support ticket.
func refuseNode(ctx context.Context, conn *websocket.Conn, cause error) {
	frame, err := worker.NewFrame("error", map[string]string{"error": cause.Error()})
	if err != nil {
		_ = conn.Close(websocket.StatusInternalError, "handshake failed")
		return
	}
	writeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	_ = node.WriteFrame(writeCtx, conn, frame)
	_ = conn.Close(websocket.StatusPolicyViolation, "handshake failed")
}
