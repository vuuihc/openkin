package api

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"nhooyr.io/websocket"

	"github.com/vuuihc/openkin/internal/node"
	"github.com/vuuihc/openkin/internal/remote"
	"github.com/vuuihc/openkin/internal/remote/worker"
	"github.com/vuuihc/openkin/internal/store"
)

// nodeTestServer is newTestServer plus the node control channel. The Nodes
// registry is nil by default there, and the handler refuses to open a channel
// it cannot route on.
func nodeTestServer(t *testing.T) (*Server, string, *node.Connections) {
	t.Helper()
	s, master := newTestServer(t)
	conns := node.NewConnections(nil)
	s.Nodes = conns
	return s, master, conns
}

func testHello() worker.Hello {
	return worker.Hello{
		Version:    worker.ProtocolVersion,
		WorkerID:   "studio",
		Label:      "studio",
		Platform:   "darwin",
		Arch:       "arm64",
		KinVersion: "test",
		Agents: []worker.Agent{
			{ID: "claude-code", Installed: true, Available: true, IsDefault: true},
			{ID: "codex", Installed: true, Available: false, Reason: "not signed in"},
		},
		WorkspaceRoots: []worker.WorkspaceRoot{{Path: "/code/kin"}},
		MaxConcurrent:  4,
	}
}

// startNode dials the Hub the way `kin node` does, in the background, and
// returns a cancel that ends the connection.
func startNode(t *testing.T, hubURL, token string) (*node.ClientConfig, context.CancelFunc, chan worker.Frame) {
	t.Helper()
	frames := make(chan worker.Frame, 8)
	cfg := &node.ClientConfig{
		HubURL: hubURL,
		Token:  token,
		Hello:  testHello(),
		OnFrame: func(_ context.Context, frame worker.Frame) error {
			frames <- frame
			return nil
		},
		Warn: func(format string, args ...any) { t.Logf("node: "+format, args...) },
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() { _ = node.Run(ctx, *cfg) }()
	t.Cleanup(cancel)
	return cfg, cancel, frames
}

// awaitDevice polls until the Hub has a registry row for the device, because
// the handshake is asynchronous with respect to this test.
func awaitDevice(t *testing.T, s *Server, deviceID string, want func(store.Device) bool) store.Device {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		device, err := s.Store.GetDevice(context.Background(), deviceID)
		if err == nil && want(device) {
			return device
		}
		time.Sleep(10 * time.Millisecond)
	}
	device, err := s.Store.GetDevice(context.Background(), deviceID)
	t.Fatalf("device %s never reached the expected state (last: %+v, err %v)", deviceID, device, err)
	return store.Device{}
}

func TestNodeChannelRecordsDeviceAndAgents(t *testing.T) {
	s, master, conns := nodeTestServer(t)
	hub := httptest.NewServer(s.Handler())
	defer hub.Close()

	deviceToken, deviceID := pairDevice(t, s.Handler(), master)
	startNode(t, hub.URL, deviceToken)

	device := awaitDevice(t, s, deviceID, func(d store.Device) bool {
		return d.Reachability == store.ReachabilityOnline && d.Label == "studio"
	})
	if device.Platform != "darwin" || device.Arch != "arm64" || device.KinVersion != "test" {
		t.Fatalf("device = %+v", device)
	}
	if device.Role != "node" {
		t.Fatalf("role = %q, want node", device.Role)
	}
	caps := node.DecodeCapabilities(device.Capabilities)
	if len(caps.WorkspaceRoots) != 1 || caps.WorkspaceRoots[0].Path != "/code/kin" || caps.MaxConcurrent != 4 {
		t.Fatalf("capabilities = %+v", caps)
	}

	agents, err := s.Store.ListDeviceAgents(context.Background(), deviceID)
	if err != nil {
		t.Fatal(err)
	}
	if len(agents) != 2 {
		t.Fatalf("agents = %+v", agents)
	}
	byID := map[string]store.DeviceAgent{}
	for _, agent := range agents {
		byID[agent.AgentID] = agent
	}
	if !byID["claude-code"].Available || !byID["claude-code"].IsDefault {
		t.Fatalf("claude-code = %+v", byID["claude-code"])
	}
	if byID["codex"].Available || byID["codex"].Reason != "not signed in" {
		t.Fatalf("codex = %+v", byID["codex"])
	}

	// The Hub can now reach this machine, which is the whole point of the
	// channel: presence is not just a row in a table.
	if !conns.Connected(deviceID) {
		t.Fatal("the Hub has no live connection for a device that just said hello")
	}
}

func TestNodeChannelMarksDeviceOfflineOnDisconnect(t *testing.T) {
	s, master, conns := nodeTestServer(t)
	hub := httptest.NewServer(s.Handler())
	defer hub.Close()

	deviceToken, deviceID := pairDevice(t, s.Handler(), master)
	_, stop, _ := startNode(t, hub.URL, deviceToken)
	awaitDevice(t, s, deviceID, func(d store.Device) bool {
		return d.Reachability == store.ReachabilityOnline
	})

	stop()
	awaitDevice(t, s, deviceID, func(d store.Device) bool {
		return d.Reachability == store.ReachabilityOffline
	})
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && conns.Connected(deviceID) {
		time.Sleep(10 * time.Millisecond)
	}
	if conns.Connected(deviceID) {
		t.Fatal("the connection outlived the Node")
	}
}

// TestNodeChannelDropsARevokedDevice: the handshake checked the credential once,
// and a socket outlives that check. Revoking a machine has to end what it can
// do — this is the channel that carries commands, so a revoked machine that
// keeps its socket is still a machine that runs work.
func TestNodeChannelDropsARevokedDevice(t *testing.T) {
	restore := nodeRevokeCheck
	nodeRevokeCheck = 25 * time.Millisecond
	defer func() { nodeRevokeCheck = restore }()

	s, master, conns := nodeTestServer(t)
	hub := httptest.NewServer(s.Handler())
	defer hub.Close()

	deviceToken, deviceID := pairDevice(t, s.Handler(), master)
	startNode(t, hub.URL, deviceToken)
	awaitDevice(t, s, deviceID, func(d store.Device) bool {
		return d.Reachability == store.ReachabilityOnline
	})

	if err := s.Store.RevokeDeviceCredential(context.Background(), deviceID, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	awaitDevice(t, s, deviceID, func(d store.Device) bool {
		return d.Reachability == store.ReachabilityOffline
	})
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && conns.Connected(deviceID) {
		time.Sleep(10 * time.Millisecond)
	}
	if conns.Connected(deviceID) {
		t.Fatal("a revoked device kept its control channel")
	}
	// And it cannot get another one: revocation is checked at the handshake too.
	if _, err := s.Store.AuthenticateDevice(context.Background(), remote.HashToken(deviceToken), time.Now().UnixMilli()); err == nil {
		t.Fatal("a revoked device token still authenticates")
	}
}

// TestNodeChannelKeepsAValidDevice: the revocation check runs on a timer against
// every open channel, so a machine in good standing has to come through it
// untouched. A watchdog that dropped healthy connections would be worse than the
// hole it closes.
func TestNodeChannelKeepsAValidDevice(t *testing.T) {
	restore := nodeRevokeCheck
	nodeRevokeCheck = 10 * time.Millisecond
	defer func() { nodeRevokeCheck = restore }()

	s, master, conns := nodeTestServer(t)
	hub := httptest.NewServer(s.Handler())
	defer hub.Close()

	deviceToken, deviceID := pairDevice(t, s.Handler(), master)
	startNode(t, hub.URL, deviceToken)
	awaitDevice(t, s, deviceID, func(d store.Device) bool {
		return d.Reachability == store.ReachabilityOnline
	})

	// Several checks' worth of time, and the channel is still there.
	time.Sleep(150 * time.Millisecond)
	if !conns.Connected(deviceID) {
		t.Fatal("a device in good standing lost its control channel")
	}
	device, err := s.Store.GetDevice(context.Background(), deviceID)
	if err != nil {
		t.Fatal(err)
	}
	if device.Reachability != store.ReachabilityOnline {
		t.Fatalf("reachability = %q, want online", device.Reachability)
	}
}

func TestNodeChannelRequiresAPairedDevice(t *testing.T) {
	s, master, _ := nodeTestServer(t)
	hub := httptest.NewServer(s.Handler())
	defer hub.Close()

	wsURL := "ws" + hub.URL[len("http"):] + node.Path
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// The master token is not a device: it is the operator's own credential and
	// must not be able to claim a machine's identity.
	conn, resp, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": []string{"Bearer " + master}},
	})
	if err == nil {
		conn.Close(websocket.StatusNormalClosure, "")
		t.Fatal("the master token opened a node channel")
	}
	if resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %v, want 403", resp)
	}

	// No credential at all is a 401 from the auth middleware, not a handshake.
	if _, resp, err := websocket.Dial(ctx, wsURL, nil); err == nil {
		t.Fatal("an unauthenticated dial opened a node channel")
	} else if resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %v, want 401", resp)
	}
}

func TestNodeChannelRefusesBadHello(t *testing.T) {
	s, master, _ := nodeTestServer(t)
	hub := httptest.NewServer(s.Handler())
	defer hub.Close()

	deviceToken, deviceID := pairDevice(t, s.Handler(), master)
	wsURL := "ws" + hub.URL[len("http"):] + node.Path

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": []string{"Bearer " + deviceToken}},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	// A protocol version this Hub does not speak: it has to be told, not dropped.
	hello := testHello()
	hello.Version = worker.ProtocolVersion + 1
	frame, err := worker.NewFrame("hello", hello)
	if err != nil {
		t.Fatal(err)
	}
	if err := node.WriteFrame(ctx, conn, frame); err != nil {
		t.Fatal(err)
	}
	reply, err := node.ReadFrame(ctx, conn)
	if err != nil {
		t.Fatal(err)
	}
	if reply.Kind != "error" {
		t.Fatalf("reply kind = %q, want error", reply.Kind)
	}
	if _, err := node.Decode[map[string]string](reply); err != nil {
		t.Fatalf("error frame payload: %v", err)
	}
	// Pairing already registered the device, so the row exists. What a refused
	// hello must not do is teach the Hub anything about this machine: no label,
	// no inventory, and still "never seen".
	device, err := s.Store.GetDevice(ctx, deviceID)
	if err != nil {
		t.Fatal(err)
	}
	if device.Label == "studio" || device.Reachability != store.ReachabilityUnknown {
		t.Fatalf("a refused hello updated the registry: %+v", device)
	}
	agents, err := s.Store.ListDeviceAgents(ctx, deviceID)
	if err != nil {
		t.Fatal(err)
	}
	if len(agents) != 0 {
		t.Fatalf("a refused hello wrote agents: %+v", agents)
	}
}

// TestNodeChannelIgnoresClaimedWorkerID pins the identity rule: the credential
// decides which device this is, and the hello payload cannot rename it.
func TestNodeChannelIgnoresClaimedWorkerID(t *testing.T) {
	s, master, _ := nodeTestServer(t)
	hub := httptest.NewServer(s.Handler())
	defer hub.Close()

	deviceToken, deviceID := pairDevice(t, s.Handler(), master)
	frames := make(chan worker.Frame, 4)
	cfg := node.ClientConfig{
		HubURL: hub.URL,
		Token:  deviceToken,
		Hello:  testHello(),
		OnFrame: func(_ context.Context, frame worker.Frame) error {
			frames <- frame
			return nil
		},
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = node.Run(ctx, cfg) }()

	awaitDevice(t, s, deviceID, func(d store.Device) bool {
		return d.Label == "studio"
	})
	// The hello said worker_id "studio"; the device is the paired one, and no
	// device was invented under the claimed name.
	if _, err := s.Store.GetDevice(context.Background(), "studio"); !errors.Is(err, store.ErrDeviceNotFound) {
		t.Fatalf("the hello's worker_id became a device identity: %v", err)
	}
	devices, err := s.Store.ListDevices(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(devices) != 1 || devices[0].ID != deviceID {
		t.Fatalf("devices = %+v", devices)
	}
}

func TestNodeChannelRoutesFrames(t *testing.T) {
	s, master, conns := nodeTestServer(t)
	routed := make(chan worker.Frame, 4)
	s.NodeFrames = func(_ context.Context, sender node.Sender, frame worker.Frame) error {
		if sender == nil || sender.DeviceID() == "" {
			t.Error("frame routed without a device")
		}
		routed <- frame
		return nil
	}
	hub := httptest.NewServer(s.Handler())
	defer hub.Close()

	deviceToken, deviceID := pairDevice(t, s.Handler(), master)
	// One raw connection, both directions. A second client would displace this
	// one, since a device has exactly one control channel.
	wsURL := "ws" + hub.URL[len("http"):] + node.Path
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": []string{"Bearer " + deviceToken}},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close(websocket.StatusNormalClosure, "")
	hello, err := worker.NewFrame("hello", testHello())
	if err != nil {
		t.Fatal(err)
	}
	if err := node.WriteFrame(ctx, ws, hello); err != nil {
		t.Fatal(err)
	}
	ack, err := node.ReadFrame(ctx, ws)
	if err != nil {
		t.Fatal(err)
	}
	if ack.Kind != "hello_ack" {
		t.Fatalf("handshake reply = %q", ack.Kind)
	}
	// What is under test is that a real frame on a real socket reaches the
	// router, and that the Hub can push one back down the same channel; what
	// the router then does with a turn is internal/node's business.
	up, err := worker.NewFrame("turn.finish", worker.TurnFinish{TurnID: "t1", Status: worker.TurnOK})
	if err != nil {
		t.Fatal(err)
	}
	if err := node.WriteFrame(ctx, ws, up); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-routed:
		if got.Kind != "turn.finish" {
			t.Fatalf("routed frame = %q", got.Kind)
		}
		payload, err := node.Decode[worker.TurnFinish](got)
		if err != nil {
			t.Fatal(err)
		}
		if payload.TurnID != "t1" || payload.Status != worker.TurnOK {
			t.Fatalf("routed payload = %+v", payload)
		}
	case <-ctx.Done():
		t.Fatal("the Hub never routed the frame the Node sent")
	}

	// And the Hub's own writes go out over the same connection.
	if !conns.Connected(deviceID) {
		t.Fatal("the handshake did not attach the connection")
	}
	down, err := worker.NewFrame("turn.cancel", worker.TurnCancel{TurnID: "t1"})
	if err != nil {
		t.Fatal(err)
	}
	if err := conns.Send(ctx, deviceID, down); err != nil {
		t.Fatal(err)
	}
	read, err := node.ReadFrame(ctx, ws)
	if err != nil {
		t.Fatal(err)
	}
	if read.Kind != "turn.cancel" {
		t.Fatalf("frame pushed down = %q", read.Kind)
	}
}
