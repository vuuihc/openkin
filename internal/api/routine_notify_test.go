package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"nhooyr.io/websocket"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/apns"
	"github.com/vuuihc/openkin/internal/node"
	"github.com/vuuihc/openkin/internal/notify"
	"github.com/vuuihc/openkin/internal/remote/worker"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/task"
)

// routineTestDevices is a notify.DeviceStore whose answer is fixed. It proves
// the Hub's fan-out reached a phone without touching a real Apple endpoint.
type routineTestDevices struct {
	mu    sync.Mutex
	devs  []store.PushDevice
	calls []string
}

func (d *routineTestDevices) ListPushDevices(context.Context) ([]store.PushDevice, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]store.PushDevice(nil), d.devs...), nil
}

func (d *routineTestDevices) ListPushDevicesForOwner(ctx context.Context, owner string) ([]store.PushDevice, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.calls = append(d.calls, owner)
	return append([]store.PushDevice(nil), d.devs...), nil
}

func (d *routineTestDevices) MarkPushDeviceResult(context.Context, string, int64, string) error {
	return nil
}

func (d *routineTestDevices) DeletePushDeviceByToken(context.Context, string) error { return nil }

func (d *routineTestDevices) owners() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.calls...)
}

// routineTestAPNs is a notify.APNsSender that records what the Hub would have
// sent. No real push message leaves a test.
type routineTestAPNs struct {
	mu          sync.Mutex
	configured  bool
	notifs      []apns.Notification
	tokens      []string
	sendStarted chan struct{}
}

func newRoutineTestAPNs(configured bool) *routineTestAPNs {
	return &routineTestAPNs{configured: configured, sendStarted: make(chan struct{}, 8)}
}

func (a *routineTestAPNs) Configured() bool { return a.configured }

func (a *routineTestAPNs) Send(_ context.Context, token string, _ apns.Environment, n apns.Notification) apns.Result {
	a.mu.Lock()
	a.notifs = append(a.notifs, n)
	a.tokens = append(a.tokens, token)
	a.mu.Unlock()
	a.sendStarted <- struct{}{}
	return apns.Result{OK: true}
}

func (a *routineTestAPNs) notifications() []apns.Notification {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]apns.Notification(nil), a.notifs...)
}

func (a *routineTestAPNs) wait(t *testing.T, n int) []apns.Notification {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if got := a.notifications(); len(got) >= n {
			return got
		}
		if time.Now().After(deadline) {
			t.Fatalf("expected %d apns notifications, got %d", n, len(a.notifications()))
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// nodeWire is a live Node connection plus the channels a test reads its
// handshake and frames from.
type nodeWire struct {
	send   chan node.WriteFunc
	acks   chan worker.HelloAck
	frames chan worker.Frame
	cancel context.CancelFunc
}

func startRoutineNode(t *testing.T, hubURL, token string) *nodeWire {
	t.Helper()
	w := &nodeWire{
		send:   make(chan node.WriteFunc, 1),
		acks:   make(chan worker.HelloAck, 1),
		frames: make(chan worker.Frame, 8),
	}
	ctx, cancel := context.WithCancel(context.Background())
	w.cancel = cancel
	t.Cleanup(cancel)
	go func() {
		_ = node.Run(ctx, node.ClientConfig{
			HubURL: hubURL,
			Token:  token,
			Hello:  helloFunc(testHello()),
			OnReady: func(send node.WriteFunc) {
				if send != nil {
					w.send <- send
				}
			},
			OnHelloAck: func(ack worker.HelloAck) { w.acks <- ack },
			OnFrame: func(_ context.Context, frame worker.Frame) error {
				w.frames <- frame
				return nil
			},
			Warn: func(format string, args ...any) { t.Logf("node: "+format, args...) },
		})
	}()
	return w
}

func (w *nodeWire) writeFunc(t *testing.T) node.WriteFunc {
	t.Helper()
	select {
	case send := <-w.send:
		return send
	case <-time.After(5 * time.Second):
		t.Fatal("node never became ready")
		return nil
	}
}

func (w *nodeWire) helloAck(t *testing.T) worker.HelloAck {
	t.Helper()
	select {
	case ack := <-w.acks:
		return ack
	case <-time.After(5 * time.Second):
		t.Fatal("no hello ack")
		return worker.HelloAck{}
	}
}

func (w *nodeWire) nextFrame(t *testing.T) worker.Frame {
	t.Helper()
	select {
	case frame := <-w.frames:
		return frame
	case <-time.After(5 * time.Second):
		t.Fatal("no frame arrived")
		return worker.Frame{}
	}
}

// TestRoutineNotifyEndToEnd proves the whole path: a Node reports a routine
// completion over the control channel, the Hub acknowledges it and fans it out
// through its notifier to the phones it registered, with a link that names the
// source device. The APNs sender is a mock; nothing leaves the process.
func TestRoutineNotifyEndToEnd(t *testing.T) {
	s, master := newTestServer(t)
	s.Nodes = node.NewConnections(nil)
	apnsFake := newRoutineTestAPNs(true)
	devices := &routineTestDevices{devs: []store.PushDevice{
		{ID: "phone-1", Token: "tok-1", Environment: string(apns.Sandbox)},
	}}
	s.Notify = &notify.Sender{
		Store:        s.Store,
		Devices:      devices,
		APNs:         apnsFake,
		OwnerAccount: func(context.Context) (string, error) { return "operator-1", nil },
	}

	hub := httptest.NewServer(s.Handler())
	defer hub.Close()
	deviceToken, deviceID := pairDevice(t, s.Handler(), master)

	wire := startRoutineNode(t, hub.URL, deviceToken)
	if ack := wire.helloAck(t); !ack.RoutineNotify {
		t.Fatal("the hub did not advertise routine.notify")
	}
	send := wire.writeFunc(t)

	report, err := worker.NewFrame("routine.notify", worker.RoutineNotify{
		Event: worker.RoutineEventReport, EventID: "task-1", TaskID: "task-1",
		Title: "Routine report", Body: "A routine has something for you",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := send(context.Background(), report); err != nil {
		t.Fatal(err)
	}
	if ack := wire.nextFrame(t); ack.Kind != "routine.notify.ack" {
		t.Fatalf("expected routine.notify.ack, got %q", ack.Kind)
	}

	sent := apnsFake.wait(t, 1)
	wantURL := "/machines/" + deviceID + "/tasks/task-1"
	if sent[0].URL != wantURL {
		t.Fatalf("apns url = %q, want %q", sent[0].URL, wantURL)
	}
	if sent[0].Kind != "routine" || sent[0].ID != "task-1" {
		t.Fatalf("apns notification = %+v", sent[0])
	}
	// The device has no owner, so the Hub resolves it to the operator.
	if owners := devices.owners(); len(owners) != 1 || owners[0] != "operator-1" {
		t.Fatalf("fan-out owners = %v, want [operator-1]", owners)
	}
}

// TestRoutineNotifyDedupesReplays: a reconnect replays a frame with the same
// event id, and the Hub rings the phones once while still acknowledging each
// replay so the Node can drop what it holds.
func TestRoutineNotifyDedupesReplays(t *testing.T) {
	s, master := newTestServer(t)
	s.Nodes = node.NewConnections(nil)
	apnsFake := newRoutineTestAPNs(true)
	s.Notify = &notify.Sender{
		Store:   s.Store,
		Devices: &routineTestDevices{devs: []store.PushDevice{{ID: "phone-1", Token: "tok-1", Environment: string(apns.Sandbox)}}},
		APNs:    apnsFake,
	}

	hub := httptest.NewServer(s.Handler())
	defer hub.Close()
	deviceToken, _ := pairDevice(t, s.Handler(), master)
	wire := startRoutineNode(t, hub.URL, deviceToken)
	wire.helloAck(t)
	send := wire.writeFunc(t)

	report, err := worker.NewFrame("routine.notify", worker.RoutineNotify{
		Event: worker.RoutineEventReport, EventID: "task-1", TaskID: "task-1", Title: "Routine report",
	})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := send(context.Background(), report); err != nil {
			t.Fatal(err)
		}
		if ack := wire.nextFrame(t); ack.Kind != "routine.notify.ack" {
			t.Fatalf("frame %d: expected ack, got %q", i, ack.Kind)
		}
	}
	// Give a duplicate fan-out a moment to happen, then assert it did not.
	time.Sleep(100 * time.Millisecond)
	if got := apnsFake.notifications(); len(got) != 1 {
		t.Fatalf("expected exactly one apns send, got %d", len(got))
	}
}

// TestRoutineNotifyRejectsMalformedInput: a frame the Node should never send is
// dropped without ringing a phone and without an ack.
func TestRoutineNotifyRejectsMalformedInput(t *testing.T) {
	s, master := newTestServer(t)
	s.Nodes = node.NewConnections(nil)
	apnsFake := newRoutineTestAPNs(true)
	s.Notify = &notify.Sender{
		Store:   s.Store,
		Devices: &routineTestDevices{devs: []store.PushDevice{{ID: "phone-1", Token: "tok-1", Environment: string(apns.Sandbox)}}},
		APNs:    apnsFake,
	}

	hub := httptest.NewServer(s.Handler())
	defer hub.Close()
	deviceToken, _ := pairDevice(t, s.Handler(), master)
	wire := startRoutineNode(t, hub.URL, deviceToken)
	wire.helloAck(t)
	send := wire.writeFunc(t)

	// Unknown event kind: a report without a task id also fails; this one has
	// neither, so the frame is refused before it reaches the notifier.
	bad, err := worker.NewFrame("routine.notify", worker.RoutineNotify{
		Event: "banner", EventID: "x",
	})
	if err != nil {
		t.Fatal(err)
	}
	// worker.NewFrame only checks the envelope, not the payload, so this
	// frame is sendable; the Hub must refuse its payload.
	if err := send(context.Background(), bad); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	if got := apnsFake.notifications(); len(got) != 0 {
		t.Fatalf("a malformed frame rang %d phones", len(got))
	}
	// No ack for a frame the Hub refused.
	select {
	case frame := <-wire.frames:
		t.Fatalf("unexpected frame %q for a malformed routine.notify", frame.Kind)
	case <-time.After(100 * time.Millisecond):
	}
}

// TestRoutineNotifyDisabledAlertLinksToTheMachine: a disabled alert lands on
// the routines page preselecting the machine that owns the routine.
func TestRoutineNotifyDisabledAlertLinksToTheMachine(t *testing.T) {
	s, master := newTestServer(t)
	s.Nodes = node.NewConnections(nil)
	apnsFake := newRoutineTestAPNs(true)
	s.Notify = &notify.Sender{
		Store:   s.Store,
		Devices: &routineTestDevices{devs: []store.PushDevice{{ID: "phone-1", Token: "tok-1", Environment: string(apns.Sandbox)}}},
		APNs:    apnsFake,
	}

	hub := httptest.NewServer(s.Handler())
	defer hub.Close()
	deviceToken, deviceID := pairDevice(t, s.Handler(), master)
	wire := startRoutineNode(t, hub.URL, deviceToken)
	wire.helloAck(t)
	send := wire.writeFunc(t)

	alert, err := worker.NewFrame("routine.notify", worker.RoutineNotify{
		Event: worker.RoutineEventDisabled, EventID: "rt-1", RoutineID: "rt-1",
		Title: "Routine disabled", Body: "auto-disabled after repeated failures",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := send(context.Background(), alert); err != nil {
		t.Fatal(err)
	}
	wire.nextFrame(t)
	sent := apnsFake.wait(t, 1)
	wantURL := "/routines?device=" + deviceID
	if sent[0].URL != wantURL {
		t.Fatalf("disabled alert url = %q, want %q", sent[0].URL, wantURL)
	}
}

// TestRoutineNotifyDeniesARevokedDevice: a device revoked after the handshake
// must not ring any phone.
func TestRoutineNotifyDeniesARevokedDevice(t *testing.T) {
	s, master := newTestServer(t)
	s.Nodes = node.NewConnections(nil)
	apnsFake := newRoutineTestAPNs(true)
	s.Notify = &notify.Sender{
		Store:   s.Store,
		Devices: &routineTestDevices{devs: []store.PushDevice{{ID: "phone-1", Token: "tok-1", Environment: string(apns.Sandbox)}}},
		APNs:    apnsFake,
	}

	hub := httptest.NewServer(s.Handler())
	defer hub.Close()
	deviceToken, deviceID := pairDevice(t, s.Handler(), master)
	wire := startRoutineNode(t, hub.URL, deviceToken)
	wire.helloAck(t)
	send := wire.writeFunc(t)

	if err := s.Store.RevokeDeviceCredential(context.Background(), deviceID, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}

	report, err := worker.NewFrame("routine.notify", worker.RoutineNotify{
		Event: worker.RoutineEventReport, EventID: "task-1", TaskID: "task-1", Title: "Routine report",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := send(context.Background(), report); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	if got := apnsFake.notifications(); len(got) != 0 {
		t.Fatalf("a revoked device rang %d phones", len(got))
	}
}

// routineTestSender is one authenticated device connection with a controllable
// generation, for handleRoutineNotify's connection-identity checks.
type routineTestSender struct {
	deviceID string
	gen      uint64

	mu     sync.Mutex
	frames []worker.Frame
}

func (s *routineTestSender) DeviceID() string                   { return s.deviceID }
func (s *routineTestSender) Generation() uint64                 { return s.gen }
func (s *routineTestSender) Close(websocket.StatusCode, string) {}

func (s *routineTestSender) Send(_ context.Context, frame worker.Frame) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.frames = append(s.frames, frame)
	return nil
}

func (s *routineTestSender) sent() []worker.Frame {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]worker.Frame(nil), s.frames...)
}

func routineNotifyTestSender(deviceID string, gen uint64) *routineTestSender {
	return &routineTestSender{deviceID: deviceID, gen: gen}
}

func setupRoutineNotifyServer(t *testing.T) (*Server, string, *routineTestAPNs) {
	t.Helper()
	s, master := newTestServer(t)
	s.Nodes = node.NewConnections(nil)
	apnsFake := newRoutineTestAPNs(true)
	s.Notify = &notify.Sender{
		Store:   s.Store,
		Devices: &routineTestDevices{devs: []store.PushDevice{{ID: "phone-1", Token: "tok-1", Environment: string(apns.Sandbox)}}},
		APNs:    apnsFake,
	}
	_, deviceID := pairDevice(t, s.Handler(), master)
	return s, deviceID, apnsFake
}

func routineNotifyFrame(t *testing.T) worker.Frame {
	t.Helper()
	frame, err := worker.NewFrame("routine.notify", worker.RoutineNotify{
		Event: worker.RoutineEventReport, EventID: "task-1", TaskID: "task-1", Title: "Routine report",
	})
	if err != nil {
		t.Fatal(err)
	}
	return frame
}

// TestRoutineNotifyRequiresCurrentConnection: a frame from a connection that
// another, newer connection replaced is refused without an ack or a fan-out.
func TestRoutineNotifyRequiresCurrentConnection(t *testing.T) {
	s, deviceID, apnsFake := setupRoutineNotifyServer(t)
	// The device row must exist so the only failing guard is the connection
	// generation, not the registry read that follows it.
	if err := s.Store.RecordDeviceHello(context.Background(), deviceID, store.Device{Label: "node"}, nil, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}

	current := routineNotifyTestSender(deviceID, 42)
	s.Nodes.Attach(current)
	stale := routineNotifyTestSender(deviceID, 41)

	if err := s.handleRoutineNotify(context.Background(), stale, routineNotifyFrame(t)); err == nil {
		t.Fatal("a replaced connection was accepted")
	}
	if len(stale.sent()) != 0 || len(current.sent()) != 0 {
		t.Fatalf("a replaced connection was acknowledged")
	}
	time.Sleep(20 * time.Millisecond)
	if got := apnsFake.notifications(); len(got) != 0 {
		t.Fatalf("a replaced connection rang %d phones", len(got))
	}
}

// TestRoutineNotifyCurrentConnectionFansOut: the current connection is accepted.
func TestRoutineNotifyCurrentConnectionFansOut(t *testing.T) {
	s, deviceID, apnsFake := setupRoutineNotifyServer(t)
	if err := s.Store.RecordDeviceHello(context.Background(), deviceID, store.Device{Label: "node"}, nil, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	current := routineNotifyTestSender(deviceID, 42)
	s.Nodes.Attach(current)

	if err := s.handleRoutineNotify(context.Background(), current, routineNotifyFrame(t)); err != nil {
		t.Fatalf("current connection was refused: %v", err)
	}
	if got := current.sent(); len(got) != 1 || got[0].Kind != "routine.notify.ack" {
		t.Fatalf("current connection was not acknowledged: %v", current.sent())
	}
	if sent := apnsFake.wait(t, 1); len(sent) != 1 {
		t.Fatalf("fan-out = %d, want 1", len(sent))
	}
}

// TestRoutineNotifyFailsClosedOnDeviceLookupError: a registry read error must
// drop the alert (and not fan it out to the operator) instead of being silently
// mapped to an ownerless operator-send.
func TestRoutineNotifyFailsClosedOnDeviceLookupError(t *testing.T) {
	s, deviceID, apnsFake := setupRoutineNotifyServer(t)
	if err := s.Store.RecordDeviceHello(context.Background(), deviceID, store.Device{Label: "node"}, nil, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	current := routineNotifyTestSender(deviceID, 1)
	s.Nodes.Attach(current)

	_ = s.Store.Close() // every later registry read fails

	if err := s.handleRoutineNotify(context.Background(), current, routineNotifyFrame(t)); err != nil {
		t.Fatalf("a device lookup error returned an unexpected error: %v", err)
	}
	if len(current.sent()) != 0 {
		t.Fatalf("a device lookup error was acknowledged: %v", current.sent())
	}
	time.Sleep(20 * time.Millisecond)
	if got := apnsFake.notifications(); len(got) != 0 {
		t.Fatalf("a device lookup error rang %d phones", len(got))
	}
}

// TestRoutineNotifyRevokedDeviceFailsClosed: a credential revoked after the
// handshake is refused without an ack.
func TestRoutineNotifyRevokedDeviceFailsClosed(t *testing.T) {
	s, deviceID, apnsFake := setupRoutineNotifyServer(t)
	if err := s.Store.RecordDeviceHello(context.Background(), deviceID, store.Device{Label: "node"}, nil, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	current := routineNotifyTestSender(deviceID, 1)
	s.Nodes.Attach(current)
	if err := s.Store.RevokeDeviceCredential(context.Background(), deviceID, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}

	if err := s.handleRoutineNotify(context.Background(), current, routineNotifyFrame(t)); err != nil {
		t.Fatalf("a revoked device returned an unexpected error: %v", err)
	}
	if len(current.sent()) != 0 {
		t.Fatalf("a revoked device was acknowledged: %v", current.sent())
	}
	time.Sleep(20 * time.Millisecond)
	if got := apnsFake.notifications(); len(got) != 0 {
		t.Fatalf("a revoked device rang %d phones", len(got))
	}
}

// TestRoutineNotifyDispatchSaturation: when every fan-out slot is taken, a new
// event is refused (no ack, no dedupe claim) rather than acknowledged and
// dropped.
func TestRoutineNotifyDispatchSaturation(t *testing.T) {
	s, deviceID, _ := setupRoutineNotifyServer(t)
	if err := s.Store.RecordDeviceHello(context.Background(), deviceID, store.Device{Label: "node"}, nil, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	current := routineNotifyTestSender(deviceID, 1)
	s.Nodes.Attach(current)

	// Shrink the slot pool to one for the test.
	s.routineNotifyDispatchOnce.Do(func() { s.routineNotifyDispatch = make(chan struct{}, 1) })
	if !s.reserveRoutineDispatch() {
		t.Fatal("first slot did not reserve")
	}
	if s.reserveRoutineDispatch() {
		t.Fatal("second slot reserved on a one-slot pool")
	}
	// Release returns the slot.
	s.releaseRoutineDispatch()
	if !s.reserveRoutineDispatch() {
		t.Fatal("slot did not come back after release")
	}
	s.releaseRoutineDispatch()

	// Saturated fan-out: the handler refuses and does not ack.
	if !s.reserveRoutineDispatch() {
		t.Fatal("setup: slot did not reserve")
	}
	err := s.handleRoutineNotify(context.Background(), current, routineNotifyFrame(t))
	if err == nil {
		t.Fatal("a saturated fan-out was accepted")
	}
	if len(current.sent()) != 0 {
		t.Fatalf("a saturated fan-out was acknowledged: %v", current.sent())
	}
	// No claim was made, so a retry with capacity is treated as new.
	s.releaseRoutineDispatch()
	if !s.routineNotifyDedupeState().claim(deviceID, "task-1") {
		t.Fatal("a saturated fan-out consumed the dedupe claim without dispatch")
	}
}

func TestRoutineNotifyDoesNotAcknowledgeWithoutNotifier(t *testing.T) {
	s, deviceID, _ := setupRoutineNotifyServer(t)
	current := routineNotifyTestSender(deviceID, 1)
	s.Nodes.Attach(current)
	s.Notify = nil
	if err := s.handleRoutineNotify(context.Background(), current, routineNotifyFrame(t)); err == nil {
		t.Fatal("missing notifier accepted the report")
	}
	if len(current.sent()) != 0 {
		t.Fatal("missing notifier acknowledged the report")
	}
}

// A duplicate still gets an ack and no second fan-out.
func TestRoutineNotifyDedupeStillAcksReplays(t *testing.T) {
	s, deviceID, apnsFake := setupRoutineNotifyServer(t)
	if err := s.Store.RecordDeviceHello(context.Background(), deviceID, store.Device{Label: "node"}, nil, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	current := routineNotifyTestSender(deviceID, 1)
	s.Nodes.Attach(current)

	frame := routineNotifyFrame(t)
	if err := s.handleRoutineNotify(context.Background(), current, frame); err != nil {
		t.Fatal(err)
	}
	if err := s.handleRoutineNotify(context.Background(), current, frame); err != nil {
		t.Fatal(err)
	}
	apnsFake.wait(t, 1)
	time.Sleep(20 * time.Millisecond)
	if got := apnsFake.notifications(); len(got) != 1 {
		t.Fatalf("replay fanned out %d times", len(got))
	}
	acks := current.sent()
	if len(acks) != 2 || acks[0].Kind != "routine.notify.ack" || acks[1].Kind != "routine.notify.ack" {
		t.Fatalf("replays were not each acknowledged: %v", acks)
	}
}

var _ = errors.New

// routineNotifyAdapter and its handle drive the task.Engine end of the end-to-end
// test: one terminal result whose text carries the report signal the same way a
// real agent result does.
type routineNotifyAdapter struct {
	text    string
	isError bool
}

func (a routineNotifyAdapter) Start(context.Context, adapter.TaskSpec) (adapter.RunHandle, error) {
	return &routineNotifyHandle{text: a.text, isError: a.isError}, nil
}

type routineNotifyHandle struct {
	text    string
	isError bool
}

func (h *routineNotifyHandle) Events() <-chan adapter.Event {
	ch := make(chan adapter.Event, 1)
	payload, _ := json.Marshal(map[string]any{"text": h.text, "is_error": h.isError})
	ch <- adapter.Event{Type: "result", Payload: payload}
	close(ch)
	return ch
}

func (h *routineNotifyHandle) Cancel() error { return nil }

// startRoutineNotifyNode runs the live Node half of the integration: the
// RoutineNotifyForwarder is wired exactly as runNode wires it, and readiness is
// signalled once the connection's write path and capability are installed.
func startRoutineNotifyNode(t *testing.T, ctx context.Context, hubURL, token string, forwarder *node.RoutineNotifyForwarder) <-chan struct{} {
	t.Helper()
	ready := make(chan struct{}, 1)
	go func() {
		_ = node.Run(ctx, node.ClientConfig{
			HubURL: hubURL,
			Token:  token,
			Hello:  helloFunc(testHello()),
			OnHelloAck: func(ack worker.HelloAck) {
				forwarder.SetSupported(ack.RoutineNotify)
			},
			OnReady: func(send node.WriteFunc) {
				forwarder.SetSender(send)
				select {
				case ready <- struct{}{}:
				default:
				}
			},
			OnFrame: func(_ context.Context, frame worker.Frame) error {
				if frame.Kind == "routine.notify.ack" {
					forwarder.HandleAck(frame)
				}
				return nil
			},
			Warn: func(format string, args ...any) { t.Logf("node: "+format, args...) },
		})
	}()
	return ready
}

func TestRoutineNotifyRetriesAfterHubSaturationWithoutReconnect(t *testing.T) {
	hubS, master := newTestServer(t)
	hubS.Nodes = node.NewConnections(nil)
	apnsFake := newRoutineTestAPNs(true)
	hubS.Notify = &notify.Sender{
		Store: hubS.Store, APNs: apnsFake,
		Devices: &routineTestDevices{devs: []store.PushDevice{{ID: "phone", Token: "token", Environment: string(apns.Sandbox)}}},
	}
	hubS.routineNotifyDispatchOnce.Do(func() { hubS.routineNotifyDispatch = make(chan struct{}, 1) })
	if !hubS.reserveRoutineDispatch() {
		t.Fatal("could not saturate hub")
	}
	hub := httptest.NewServer(hubS.Handler())
	defer hub.Close()
	token, deviceID := pairDevice(t, hubS.Handler(), master)
	forwarder := node.NewRoutineNotifyForwarder(nil)
	defer forwarder.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ready := startRoutineNotifyNode(t, ctx, hub.URL, token, forwarder)
	select {
	case <-ready:
	case <-time.After(5 * time.Second):
		t.Fatal("node did not connect")
	}
	if err := forwarder.Send(ctx, notify.RoutineEvent{Event: "report", TaskID: "task-1"}); err != nil {
		t.Fatal(err)
	}
	// Wait until the first attempt has reached the full hub; no delivery is
	// possible while its only slot remains reserved.
	time.Sleep(200 * time.Millisecond)
	if len(apnsFake.notifications()) != 0 {
		t.Fatal("delivered while saturated")
	}
	current, err := hubS.Nodes.Get(deviceID)
	if err != nil {
		t.Fatal(err)
	}
	hubS.releaseRoutineDispatch()
	select {
	case <-apnsFake.sendStarted:
	case <-time.After(8 * time.Second):
		t.Fatal("no retry after hub recovered")
	}
	after, err := hubS.Nodes.Get(deviceID)
	if err != nil || after.Generation() != current.Generation() {
		t.Fatal("delivery required a reconnect")
	}
	if got := apnsFake.notifications(); len(got) != 1 {
		t.Fatalf("got %d notifications", len(got))
	}
}

// TestRoutineNotifyEngineToHubToAPNs proves the production-shaped path from a
// real task terminal event: Engine -> NotifyRoutine -> RoutineForward -> Node
// control frame -> authenticated Hub -> APNs mock, with a link that names the
// source device. No real push message leaves the process.
func TestRoutineNotifyEngineToHubToAPNs(t *testing.T) {
	hubS, master := newTestServer(t)
	hubS.Nodes = node.NewConnections(nil)
	apnsFake := newRoutineTestAPNs(true)
	hubS.Notify = &notify.Sender{
		Store:   hubS.Store,
		Devices: &routineTestDevices{devs: []store.PushDevice{{ID: "phone-1", Token: "tok-1", Environment: string(apns.Sandbox)}}},
		APNs:    apnsFake,
	}
	hub := httptest.NewServer(hubS.Handler())
	defer hub.Close()
	deviceToken, deviceID := pairDevice(t, hubS.Handler(), master)

	nodeStore, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = nodeStore.Close() })
	now := time.Now().UnixMilli()
	if err := nodeStore.InsertRoutine(context.Background(), store.Routine{
		ID: "r1", Cwd: t.TempDir(), Agent: "claude-code", Prompt: "check",
		IntervalSecs: 60, Enabled: true, NextDueAt: now, CreatedAt: now, Title: "PRs",
	}); err != nil {
		t.Fatal(err)
	}

	forwarder := node.NewRoutineNotifyForwarder(nil)
	defer forwarder.Close()
	nodeNotifier := &notify.Sender{
		RoutineForward: func(ctx context.Context, event notify.RoutineEvent) {
			_ = forwarder.Send(ctx, event)
		},
	}
	eng := task.NewEngineFromAdapters(nodeStore, map[string]adapter.Adapter{
		"claude-code": routineNotifyAdapter{text: "done\nTLDR: auth middleware touched\nnoteworthy: true\n"},
	}, task.NewBus(), 4)
	defer eng.Close()
	eng.SetNotifier(nodeNotifier)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ready := startRoutineNotifyNode(t, ctx, hub.URL, deviceToken, forwarder)
	select {
	case <-ready:
	case <-time.After(5 * time.Second):
		t.Fatal("node forwarder never became ready")
	}

	created, err := eng.Create(ctx, task.CreateRequest{
		Agent: "claude-code", Cwd: t.TempDir(), Prompt: "p", RoutineID: "r1",
	})
	if err != nil {
		t.Fatal(err)
	}

	sent := apnsFake.wait(t, 1)
	wantURL := "/machines/" + deviceID + "/tasks/" + created.ID
	if sent[0].URL != wantURL {
		t.Fatalf("apns url = %q, want %q", sent[0].URL, wantURL)
	}
	if sent[0].Kind != "routine" || sent[0].ID != created.ID {
		t.Fatalf("apns notification = %+v", sent[0])
	}
}

// TestRoutineNotifyEngineSilentRunStaysLocal: a quiet report must not produce a
// forwarded frame or a Hub fan-out.
func TestRoutineNotifyEngineSilentRunStaysLocal(t *testing.T) {
	hubS, master := newTestServer(t)
	hubS.Nodes = node.NewConnections(nil)
	apnsFake := newRoutineTestAPNs(true)
	hubS.Notify = &notify.Sender{
		Store:   hubS.Store,
		Devices: &routineTestDevices{devs: []store.PushDevice{{ID: "phone-1", Token: "tok-1", Environment: string(apns.Sandbox)}}},
		APNs:    apnsFake,
	}
	hub := httptest.NewServer(hubS.Handler())
	defer hub.Close()
	deviceToken, _ := pairDevice(t, hubS.Handler(), master)

	nodeStore, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = nodeStore.Close() })
	now := time.Now().UnixMilli()
	if err := nodeStore.InsertRoutine(context.Background(), store.Routine{
		ID: "r1", Cwd: t.TempDir(), Agent: "claude-code", Prompt: "check",
		IntervalSecs: 60, Enabled: true, NextDueAt: now, CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	forwarder := node.NewRoutineNotifyForwarder(nil)
	defer forwarder.Close()
	eng := task.NewEngineFromAdapters(nodeStore, map[string]adapter.Adapter{
		"claude-code": routineNotifyAdapter{text: "TLDR: 0 new PRs\nnoteworthy: false\n"},
	}, task.NewBus(), 4)
	defer eng.Close()
	eng.SetNotifier(&notify.Sender{
		RoutineForward: func(ctx context.Context, event notify.RoutineEvent) {
			_ = forwarder.Send(ctx, event)
		},
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ready := startRoutineNotifyNode(t, ctx, hub.URL, deviceToken, forwarder)
	select {
	case <-ready:
	case <-time.After(5 * time.Second):
		t.Fatal("node forwarder never became ready")
	}

	created, err := eng.Create(ctx, task.CreateRequest{
		Agent: "claude-code", Cwd: t.TempDir(), Prompt: "p", RoutineID: "r1",
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = created

	// Wait for the run to reach its terminal state, then assert nothing was
	// forwarded to the Hub.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if got, err := nodeStore.GetTask(ctx, created.ID); err == nil && got.Status == task.StatusSucceeded {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(100 * time.Millisecond)
	if got := apnsFake.notifications(); len(got) != 0 {
		t.Fatalf("a silent run rang %d phones", len(got))
	}
}

// TestRoutineNotifyEngineCircuitBreaker: three consecutive failed runs trip the
// circuit breaker and produce a disabled alert over the same production path.
func TestRoutineNotifyEngineCircuitBreaker(t *testing.T) {
	hubS, master := newTestServer(t)
	hubS.Nodes = node.NewConnections(nil)
	apnsFake := newRoutineTestAPNs(true)
	hubS.Notify = &notify.Sender{
		Store:   hubS.Store,
		Devices: &routineTestDevices{devs: []store.PushDevice{{ID: "phone-1", Token: "tok-1", Environment: string(apns.Sandbox)}}},
		APNs:    apnsFake,
	}
	hub := httptest.NewServer(hubS.Handler())
	defer hub.Close()
	deviceToken, deviceID := pairDevice(t, hubS.Handler(), master)

	nodeStore, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = nodeStore.Close() })
	now := time.Now().UnixMilli()
	if err := nodeStore.InsertRoutine(context.Background(), store.Routine{
		ID: "r1", Cwd: t.TempDir(), Agent: "claude-code", Prompt: "check",
		IntervalSecs: 60, Enabled: true, NextDueAt: now, CreatedAt: now, Title: "PRs",
		ConsecFailures: store.RoutineMaxConsecFailures - 1,
	}); err != nil {
		t.Fatal(err)
	}

	forwarder := node.NewRoutineNotifyForwarder(nil)
	defer forwarder.Close()
	eng := task.NewEngineFromAdapters(nodeStore, map[string]adapter.Adapter{
		"claude-code": routineNotifyAdapter{text: "boom", isError: true},
	}, task.NewBus(), 4)
	defer eng.Close()
	eng.SetNotifier(&notify.Sender{
		RoutineForward: func(ctx context.Context, event notify.RoutineEvent) {
			_ = forwarder.Send(ctx, event)
		},
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ready := startRoutineNotifyNode(t, ctx, hub.URL, deviceToken, forwarder)
	select {
	case <-ready:
	case <-time.After(5 * time.Second):
		t.Fatal("node forwarder never became ready")
	}

	if _, err := eng.Create(ctx, task.CreateRequest{
		Agent: "claude-code", Cwd: t.TempDir(), Prompt: "p", RoutineID: "r1",
	}); err != nil {
		t.Fatal(err)
	}

	sent := apnsFake.wait(t, 1)
	wantURL := "/routines?device=" + deviceID
	if sent[0].URL != wantURL {
		t.Fatalf("disabled alert url = %q, want %q", sent[0].URL, wantURL)
	}
	if sent[0].Kind != "routine" || sent[0].ID != "r1" {
		t.Fatalf("disabled alert = %+v", sent[0])
	}
}
