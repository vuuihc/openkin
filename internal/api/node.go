package api

import (
	"context"
	"errors"
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

	s.serveNode(ctx, sender, conn)
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
	if err := s.Store.RecordDeviceHello(ctx, deviceID, store.Device{
		Label:        hello.Label,
		Platform:     hello.Platform,
		Arch:         hello.Arch,
		KinVersion:   hello.KinVersion,
		Capabilities: capabilities,
	}, agents, now); err != nil {
		return err
	}
	// The roots become anchors here, at the only moment the Hub learns where
	// this machine keeps its checkouts. They are what lets a turn be handed an
	// address that means something on the machine that will run it, and what
	// lets "this device cannot resolve that workspace" be an answer instead of a
	// guess (ADR 0022 D3).
	roots := make([]store.ReportedRoot, 0, len(hello.WorkspaceRoots))
	for _, root := range hello.WorkspaceRoots {
		roots = append(roots, store.ReportedRoot{
			Path:         root.Path,
			RemoteURL:    root.RemoteURL,
			RelativePath: root.RelativePath,
		})
	}
	return s.Store.RecordDeviceWorkspaceRoots(ctx, deviceID, roots, now)
}

// serveNode routes frames until the connection ends.
func (s *Server) serveNode(ctx context.Context, sender node.Sender, ws *websocket.Conn) {
	deviceID := sender.DeviceID()
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
			// Saying so is better than dropping a frame silently: a Node that
			// sends something the Hub does not understand is answered — with a
			// turn.cancel for a turn this Hub is not running (see
			// routeNodeFrame), or with nothing at all if the frame was not about
			// a turn. There is no error frame in this protocol: a Node has no
			// reader for one, so inventing it here would be a message nobody
			// receives.
			_ = s.routeNodeFrame(ctx, sender, frame)
		}
	}
}

// routeNodeFrame hands a frame to whoever asked for it.
func (s *Server) routeNodeFrame(ctx context.Context, sender node.Sender, frame worker.Frame) error {
	if s.NodeFrames == nil {
		return fmt.Errorf("unhandled frame kind %q", frame.Kind)
	}
	err := s.NodeFrames(ctx, sender, frame)
	if errors.Is(err, node.ErrTurnUnknown) {
		// The device is working on a turn this Hub is not running: it was
		// dispatched before a restart, or its connection was replaced. Dropping
		// the frame would leave the agent running on that machine with nobody
		// collecting the result, so the Hub says the one thing that stops it.
		s.cancelUnknownTurn(ctx, sender, frame)
	}
	return err
}

// cancelUnknownTurn tells a device to stop a turn the Hub has no record of.
//
// The turn id comes from the frame, which is the only place it exists on this
// side: the whole point is that there is no turn object to look it up in. A
// frame that is a question rather than a report of the turn gets its own answer
// first — a cancelled turn does not, on its own, end a permission wait.
func (s *Server) cancelUnknownTurn(ctx context.Context, sender node.Sender, frame worker.Frame) {
	turnID := ""
	switch frame.Kind {
	case "turn.event":
		event, err := node.Decode[worker.TurnEvent](frame)
		if err != nil {
			return
		}
		turnID = event.TurnID
	case "turn.started":
		// The device took a dispatch whose turn is already gone — the deadline
		// gave up on it, or the Hub restarted while the frame was in flight.
		// Answering this one matters more than the others: the ack is the first
		// thing a Node sends, so it is the earliest chance to stop an agent that
		// has not produced anything yet.
		started, err := node.Decode[worker.TurnStarted](frame)
		if err != nil {
			return
		}
		turnID = started.TurnID
	case "turn.finish":
		finish, err := node.Decode[worker.TurnFinish](frame)
		if err != nil {
			return
		}
		turnID = finish.TurnID
	case "approval.request":
		// A permission question about a turn this Hub is not running: there is no
		// inbox to put it in. The turn.cancel below is what stops the agent that
		// asked, but it is this refusal that ends the wait the machine is blocked
		// on — without it the agent's tool call sits there until its own client
		// gives up, and blames a timeout for a question the Hub never had.
		request, err := node.Decode[worker.ApprovalRequest](frame)
		if err != nil || strings.TrimSpace(request.RequestID) == "" {
			return
		}
		status, err := worker.NewFrame("approval.status", worker.ApprovalStatus{
			RequestID: request.RequestID,
			Error:     "the hub is no longer running this turn",
		})
		if err != nil {
			return
		}
		writeCtx, cancelWrite := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancelWrite()
		_ = sender.Send(writeCtx, status)
		turnID = request.TurnID
	default:
		return
	}
	if strings.TrimSpace(turnID) == "" {
		return
	}
	cancel, err := worker.NewFrame("turn.cancel", worker.TurnCancel{
		TurnID: turnID,
		Reason: "the hub is no longer running this turn",
	})
	if err != nil {
		return
	}
	writeCtx, cancelCtx := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancelCtx()
	_ = sender.Send(writeCtx, cancel)
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
