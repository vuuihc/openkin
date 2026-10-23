package workers

import (
	"errors"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/remote/worker"
)

func validHello() worker.Hello {
	return worker.Hello{
		Version:  worker.ProtocolVersion,
		WorkerID: "device-1",
		Agents: []worker.Agent{{
			ID: "claude-code", Installed: true, Available: true,
			Version: "2.1.0", Models: []string{"sonnet"},
		}},
		WorkspaceRoots: []worker.WorkspaceRoot{{
			Path: "/Users/me/code/openkin", RemoteURL: "github.com/vuuihc/openkin", RelativePath: "internal",
		}},
		MaxConcurrent: 2,
	}
}

func TestRegistryLeaseLifecycle(t *testing.T) {
	now := time.UnixMilli(1000)
	r := NewRegistry(10*time.Second, nil)
	r.SetClock(func() time.Time { return now })

	record, err := r.Register(validHello())
	if err != nil {
		t.Fatal(err)
	}
	if record.State != StateOnline || record.Lease.ExpiresAt != 11000 {
		t.Fatalf("record = %+v", record)
	}

	now = time.UnixMilli(9000)
	renewed, err := r.Heartbeat(worker.Heartbeat{
		WorkerID: record.WorkerID, LeaseID: record.Lease.ID, At: 9000,
	})
	if err != nil {
		t.Fatal(err)
	}
	if renewed.Lease.ExpiresAt != 19000 {
		t.Fatalf("renewed lease = %+v", renewed.Lease)
	}

	now = time.UnixMilli(19000)
	offline := r.Sweep()
	if len(offline) != 1 || offline[0].State != StateOffline {
		t.Fatalf("offline = %+v", offline)
	}
	if _, err := r.Heartbeat(worker.Heartbeat{
		WorkerID: record.WorkerID, LeaseID: record.Lease.ID, At: 19001,
	}); !errors.Is(err, ErrLeaseExpired) {
		t.Fatalf("heartbeat after expiry = %v", err)
	}
	if len(r.Sweep()) != 0 {
		t.Fatal("offline hook/state repeated on second sweep")
	}
}

func TestRegistryRevokeIsIndependent(t *testing.T) {
	r := NewRegistry(time.Minute, nil)
	r.SetClock(func() time.Time { return time.UnixMilli(1000) })
	record, err := r.Register(validHello())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.Revoke(record.WorkerID, time.UnixMilli(1001)); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Heartbeat(worker.Heartbeat{
		WorkerID: record.WorkerID, LeaseID: record.Lease.ID, At: 1002,
	}); !errors.Is(err, ErrWorkerRevoked) {
		t.Fatalf("heartbeat after revoke = %v", err)
	}
}

func TestRegistryBindsLeaseToOwnerAndNotifiesOnce(t *testing.T) {
	now := time.UnixMilli(1000)
	var offline []Record
	r := NewRegistry(time.Second, func(record Record) {
		offline = append(offline, record)
	})
	r.SetClock(func() time.Time { return now })
	record, err := r.RegisterForOwner(validHello(), "device-a")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.HeartbeatForOwner(worker.Heartbeat{
		WorkerID: record.WorkerID, LeaseID: record.Lease.ID, At: 1001,
	}, "device-b"); !errors.Is(err, ErrWorkerOwner) {
		t.Fatalf("cross-device heartbeat = %v", err)
	}
	now = time.UnixMilli(2000)
	if got := r.Sweep(); len(got) != 1 || len(offline) != 1 {
		t.Fatalf("sweep = %v, offline hook = %v", got, offline)
	}
	if offline[0].OwnerDeviceID != "device-a" || offline[0].State != StateOffline {
		t.Fatalf("offline record = %+v", offline[0])
	}
	if len(r.Sweep()) != 0 || len(offline) != 1 {
		t.Fatalf("offline notification repeated: %v", offline)
	}
	if _, err := r.HeartbeatForOwner(worker.Heartbeat{
		WorkerID: record.WorkerID, LeaseID: record.Lease.ID, At: 3000,
	}, "device-a"); !errors.Is(err, ErrLeaseExpired) {
		t.Fatalf("late heartbeat = %v", err)
	}
	if len(offline) != 1 {
		t.Fatalf("late heartbeat repeated offline hook: %v", offline)
	}
	if _, err := r.Revoke(record.WorkerID, time.UnixMilli(3001)); err != nil {
		t.Fatal(err)
	}
	if _, err := r.RegisterForOwner(validHello(), "device-a"); err == nil {
		t.Fatal("revoked worker ID was re-registered")
	}
}
