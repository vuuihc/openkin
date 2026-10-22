package store

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
)

func openTestStore(t *testing.T) *Store {
	t.Helper()
	st, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

func helloAgent(id string) DeviceAgent {
	return DeviceAgent{DeviceID: "device-1", AgentID: id, Installed: true, Available: true}
}

func TestRecordDeviceHelloUpsertsDeviceAndReplacesAgents(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()

	if err := st.RecordDeviceHello(ctx, "device-1", Device{
		Label: "studio", Platform: "darwin", Arch: "arm64",
		KinVersion: "1.2.3", Capabilities: `{"workspace_roots":["/code"],"max_concurrent":4}`,
	}, []DeviceAgent{helloAgent("claude-code"), helloAgent("codex")}, 1000); err != nil {
		t.Fatal(err)
	}

	device, err := st.GetDevice(ctx, "device-1")
	if err != nil {
		t.Fatal(err)
	}
	if device.Label != "studio" || device.Platform != "darwin" || device.Arch != "arm64" {
		t.Fatalf("device = %+v", device)
	}
	if device.Role != "node" {
		t.Fatalf("role = %q, want node", device.Role)
	}
	if device.Reachability != ReachabilityOnline {
		t.Fatalf("reachability = %q, want online", device.Reachability)
	}
	if device.LastSeenAt == nil || *device.LastSeenAt != 1000 {
		t.Fatalf("last_seen_at = %v", device.LastSeenAt)
	}

	// A second hello is a snapshot: the agent that is no longer reported must be
	// gone, not merged into an ever-growing list.
	if err := st.RecordDeviceHello(ctx, "device-1", Device{
		Label: "studio", Platform: "darwin", Arch: "arm64",
	}, []DeviceAgent{helloAgent("codex")}, 2000); err != nil {
		t.Fatal(err)
	}
	agents, err := st.ListDeviceAgents(ctx, "device-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(agents) != 1 || agents[0].AgentID != "codex" {
		t.Fatalf("agents after second hello = %+v", agents)
	}
	device, err = st.GetDevice(ctx, "device-1")
	if err != nil {
		t.Fatal(err)
	}
	if device.LastSeenAt == nil || *device.LastSeenAt != 2000 {
		t.Fatalf("last_seen_at after second hello = %v", device.LastSeenAt)
	}
}

func TestRecordDeviceHelloKeepsAgentDetail(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()

	agent := DeviceAgent{
		DeviceID: "device-1", AgentID: "claude-code",
		Installed: true, Available: false, Version: "2.0.1",
		Reason: "not signed in", DefaultModel: "opus", IsDefault: true,
		Models: []string{"opus", "sonnet"},
	}
	if err := st.RecordDeviceHello(ctx, "device-1", Device{Label: "laptop"},
		[]DeviceAgent{agent}, 1000); err != nil {
		t.Fatal(err)
	}

	agents, err := st.ListDeviceAgents(ctx, "device-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(agents) != 1 {
		t.Fatalf("agents = %+v", agents)
	}
	got := agents[0]
	if !got.Installed || got.Available {
		t.Fatalf("installed/available = %v/%v, want true/false", got.Installed, got.Available)
	}
	if got.Version != "2.0.1" || got.Reason != "not signed in" || got.DefaultModel != "opus" || !got.IsDefault {
		t.Fatalf("agent = %+v", got)
	}
	if len(got.Models) != 2 || got.Models[0] != "opus" || got.Models[1] != "sonnet" {
		t.Fatalf("models = %v", got.Models)
	}
}

func TestRecordDeviceHelloRejectsBadInput(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()

	if err := st.RecordDeviceHello(ctx, "  ", Device{}, nil, 1000); err == nil {
		t.Fatal("empty device id was accepted")
	}

	// An agent with no id aborts the whole hello: a half-written inventory would
	// be worse than none, because the Hub cannot tell it is incomplete.
	err := st.RecordDeviceHello(ctx, "device-1", Device{Label: "studio"},
		[]DeviceAgent{helloAgent("claude-code"), {AgentID: "  "}}, 1000)
	if err == nil {
		t.Fatal("agent without an id was accepted")
	}
	if _, err := st.GetDevice(ctx, "device-1"); !errors.Is(err, ErrDeviceNotFound) {
		t.Fatalf("failed hello left a device row: %v", err)
	}
	agents, err := st.ListDeviceAgents(ctx, "device-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(agents) != 0 {
		t.Fatalf("failed hello left agents: %+v", agents)
	}
}

func TestTouchAndReachability(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()

	if err := st.RecordDeviceHello(ctx, "device-1", Device{Label: "studio"},
		[]DeviceAgent{helloAgent("codex")}, 1000); err != nil {
		t.Fatal(err)
	}
	if err := st.SetDeviceReachability(ctx, "device-1", ReachabilityOffline); err != nil {
		t.Fatal(err)
	}
	// A heartbeat is presence, not an inventory update: the agents must survive.
	if err := st.TouchDevice(ctx, "device-1", 5000); err != nil {
		t.Fatal(err)
	}
	device, err := st.GetDevice(ctx, "device-1")
	if err != nil {
		t.Fatal(err)
	}
	if device.Reachability != ReachabilityOnline {
		t.Fatalf("reachability after touch = %q", device.Reachability)
	}
	if device.LastSeenAt == nil || *device.LastSeenAt != 5000 {
		t.Fatalf("last_seen_at after touch = %v", device.LastSeenAt)
	}
	agents, err := st.ListDeviceAgents(ctx, "device-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(agents) != 1 || agents[0].AgentID != "codex" {
		t.Fatalf("touch rewrote the inventory: %+v", agents)
	}

	// Presence for a device that does not exist is not an error: it may have been
	// revoked while it held a connection open.
	if err := st.SetDeviceReachability(ctx, "gone", ReachabilityOffline); err != nil {
		t.Fatalf("reachability for an unknown device: %v", err)
	}
	if err := st.TouchDevice(ctx, "gone", 6000); err != nil {
		t.Fatalf("touch of an unknown device: %v", err)
	}
}

func TestListDevicesIncludesPairedButNeverSeen(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()

	// Pairing writes both rows; the device is "known" from that moment, long
	// before it ever connects.
	if err := st.InsertDeviceCredential(ctx, DeviceCredential{
		ID: "device-paired", TokenHash: "hash-1", Label: "phone", CreatedAt: 1000,
	}); err != nil {
		t.Fatal(err)
	}
	// A device that connected and reported a better label than its pairing one.
	if err := st.InsertDeviceCredential(ctx, DeviceCredential{
		ID: "device-node", TokenHash: "hash-2", Label: "spare", CreatedAt: 2000,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.RecordDeviceHello(ctx, "device-node", Device{
		Label: "studio", Platform: "linux", Arch: "amd64",
	}, []DeviceAgent{helloAgent("codex")}, 3000); err != nil {
		t.Fatal(err)
	}

	devices, err := st.ListDevices(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(devices) != 2 {
		t.Fatalf("devices = %+v", devices)
	}
	// Newest pairing first.
	if devices[0].ID != "device-node" || devices[1].ID != "device-paired" {
		t.Fatalf("order = %s, %s", devices[0].ID, devices[1].ID)
	}
	if devices[0].Label != "studio" || devices[0].Role != "node" || devices[0].Platform != "linux" {
		t.Fatalf("reported device = %+v", devices[0])
	}
	// The pairing label is the fallback, and "unknown" is the honest answer for a
	// device the Hub has never heard from.
	if devices[1].Label != "phone" || devices[1].Reachability != ReachabilityUnknown {
		t.Fatalf("paired-only device = %+v", devices[1])
	}
	// Paired is not seen. A device that has never authenticated has no last-used
	// time, and reporting the pairing time as one would claim contact that never
	// happened.
	if devices[1].LastSeenAt != nil {
		t.Fatalf("paired-only device claims to have been seen at %d", *devices[1].LastSeenAt)
	}
}

func TestListDevicesPrefersRegistryLabel(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()

	// Pairing happened before the machine had a name for itself, then the
	// registry row was written by a hello with an empty label. The pairing label
	// has to win over an empty one, not over a real one.
	if err := st.InsertDeviceCredential(ctx, DeviceCredential{
		ID: "device-1", TokenHash: "hash-1", Label: "spare", CreatedAt: 1000,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.RecordDeviceHello(ctx, "device-1", Device{Label: "studio"}, nil, 2000); err != nil {
		t.Fatal(err)
	}
	devices, err := st.ListDevices(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(devices) != 1 || devices[0].Label != "studio" {
		t.Fatalf("devices = %+v", devices)
	}

	if err := st.RecordDeviceHello(ctx, "device-1", Device{Label: ""}, nil, 3000); err != nil {
		t.Fatal(err)
	}
	devices, err = st.ListDevices(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(devices) != 1 || devices[0].Label != "spare" {
		t.Fatalf("empty reported label did not fall back to the pairing label: %+v", devices)
	}
}

func TestRevokeDeviceMarksTheRegistryRow(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()

	if err := st.InsertDeviceCredential(ctx, DeviceCredential{
		ID: "device-1", TokenHash: "hash-1", Label: "studio", CreatedAt: 1000,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.RecordDeviceHello(ctx, "device-1", Device{Label: "studio"}, nil, 2000); err != nil {
		t.Fatal(err)
	}
	if err := st.RevokeDeviceCredential(ctx, "device-1", 3000); err != nil {
		t.Fatal(err)
	}

	device, err := st.GetDevice(ctx, "device-1")
	if err != nil {
		t.Fatal(err)
	}
	if device.RevokedAt == nil || *device.RevokedAt != 3000 {
		t.Fatalf("revoked_at = %v", device.RevokedAt)
	}
	// Revoked is not the same as offline, but it is certainly not online.
	if device.Reachability == ReachabilityOnline {
		t.Fatalf("revoked device still reads online: %+v", device)
	}
	if _, err := st.AuthenticateDevice(ctx, "hash-1", 4000); !errors.Is(err, ErrNotFound) {
		t.Fatalf("revoked credential authenticated: %v", err)
	}
}
