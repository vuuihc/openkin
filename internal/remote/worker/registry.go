package worker

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

const DefaultLeaseTTL = 30 * time.Second

var (
	ErrWorkerNotFound = errors.New("worker not found")
	ErrLeaseExpired   = errors.New("worker lease expired")
	ErrWorkerRevoked  = errors.New("worker revoked")
	ErrLeaseMismatch  = errors.New("worker lease mismatch")
	ErrWorkerOwner    = errors.New("worker owner mismatch")
	ErrWorkerExists   = errors.New("worker already registered")
)

type State string

const (
	StateOnline  State = "online"
	StateOffline State = "offline"
	StateRevoked State = "revoked"
)

type Record struct {
	Hello
	OwnerDeviceID string `json:"owner_device_id,omitempty"`
	Lease         Lease  `json:"lease"`
	State         State  `json:"state"`
	LastSeen      int64  `json:"last_seen_at"`
	RevokedAt     int64  `json:"revoked_at,omitempty"`
}

// OfflineHook is called once when a live lease crosses its expiry.
type OfflineHook func(Record)

type Registry struct {
	mu        sync.Mutex
	clock     func() time.Time
	leaseTTL  time.Duration
	onOffline OfflineHook
	workers   map[string]Record
}

func NewRegistry(leaseTTL time.Duration, onOffline OfflineHook) *Registry {
	if leaseTTL <= 0 {
		leaseTTL = DefaultLeaseTTL
	}
	return &Registry{
		clock: time.Now, leaseTTL: leaseTTL, onOffline: onOffline,
		workers: make(map[string]Record),
	}
}

func (r *Registry) Register(h Hello) (Record, error) {
	return r.RegisterForOwner(h, "")
}

// RegisterForOwner registers a worker and binds its lease to a device
// credential. An empty owner is reserved for tests and local composition.
func (r *Registry) RegisterForOwner(h Hello, ownerDeviceID string) (Record, error) {
	if err := h.Validate(); err != nil {
		return Record{}, err
	}
	id := strings.TrimSpace(h.WorkerID)
	if id == "" {
		var err error
		id, err = newID()
		if err != nil {
			return Record{}, err
		}
		h.WorkerID = id
	} else {
		h.WorkerID = id
	}
	now := r.nowMillis()
	leaseID, err := newID()
	if err != nil {
		return Record{}, err
	}
	record := Record{
		Hello: h, OwnerDeviceID: strings.TrimSpace(ownerDeviceID),
		State: StateOnline, LastSeen: now,
		Lease: Lease{
			ID: leaseID, WorkerID: id, IssuedAt: now,
			ExpiresAt: now + r.leaseTTL.Milliseconds(),
		},
	}
	r.mu.Lock()
	if previous, exists := r.workers[id]; exists {
		owner := strings.TrimSpace(ownerDeviceID)
		if previous.State == StateRevoked {
			r.mu.Unlock()
			return Record{}, ErrWorkerRevoked
		}
		if owner == "" || previous.OwnerDeviceID != owner || previous.State == StateOnline {
			r.mu.Unlock()
			return Record{}, ErrWorkerExists
		}
	}
	r.workers[id] = record
	r.mu.Unlock()
	return record, nil
}

func (r *Registry) Heartbeat(h Heartbeat) (Record, error) {
	return r.HeartbeatForOwner(h, "")
}

// HeartbeatForOwner renews a lease only when it belongs to ownerDeviceID.
// Empty owner preserves the local/test registry API.
func (r *Registry) HeartbeatForOwner(h Heartbeat, ownerDeviceID string) (Record, error) {
	if err := h.Validate(); err != nil {
		return Record{}, err
	}
	now := r.nowMillis()
	r.mu.Lock()
	record, ok := r.workers[h.WorkerID]
	if !ok {
		r.mu.Unlock()
		return Record{}, ErrWorkerNotFound
	}
	if owner := strings.TrimSpace(ownerDeviceID); owner != "" && record.OwnerDeviceID != owner {
		r.mu.Unlock()
		return Record{}, ErrWorkerOwner
	}
	if record.State == StateRevoked {
		r.mu.Unlock()
		return Record{}, ErrWorkerRevoked
	}
	if record.Lease.ID != h.LeaseID {
		r.mu.Unlock()
		return Record{}, ErrLeaseMismatch
	}
	if record.State == StateOffline {
		r.mu.Unlock()
		return Record{}, ErrLeaseExpired
	}
	if record.Lease.ExpiresAt <= now {
		record.State = StateOffline
		r.workers[h.WorkerID] = record
		hook := r.onOffline
		r.mu.Unlock()
		if hook != nil {
			hook(record)
		}
		return Record{}, ErrLeaseExpired
	}
	record.State = StateOnline
	record.LastSeen = now
	record.Lease.ExpiresAt = now + r.leaseTTL.Milliseconds()
	r.workers[h.WorkerID] = record
	r.mu.Unlock()
	return record, nil
}

func (r *Registry) Revoke(workerID string, now time.Time) (Record, error) {
	workerID = strings.TrimSpace(workerID)
	r.mu.Lock()
	defer r.mu.Unlock()
	record, ok := r.workers[workerID]
	if !ok {
		return Record{}, ErrWorkerNotFound
	}
	record.State = StateRevoked
	record.RevokedAt = now.UnixMilli()
	record.Lease.ExpiresAt = record.RevokedAt
	r.workers[workerID] = record
	return record, nil
}

// RevokeOwner revokes every active lease created by ownerDeviceID. It is used
// when a device credential is revoked so unrelated devices remain connected.
func (r *Registry) RevokeOwner(ownerDeviceID string, now time.Time) []Record {
	ownerDeviceID = strings.TrimSpace(ownerDeviceID)
	if ownerDeviceID == "" {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	var revoked []Record
	for id, record := range r.workers {
		if record.OwnerDeviceID != ownerDeviceID || record.State == StateRevoked {
			continue
		}
		record.State = StateRevoked
		record.RevokedAt = now.UnixMilli()
		record.Lease.ExpiresAt = record.RevokedAt
		r.workers[id] = record
		revoked = append(revoked, record)
	}
	return revoked
}

func (r *Registry) Get(workerID string) (Record, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	record, ok := r.workers[strings.TrimSpace(workerID)]
	if !ok {
		return Record{}, ErrWorkerNotFound
	}
	return record, nil
}

func (r *Registry) List() []Record {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]Record, 0, len(r.workers))
	for _, record := range r.workers {
		out = append(out, record)
	}
	return out
}

// Sweep marks expired online leases offline and invokes the hook outside the
// lock. Calling Sweep repeatedly is idempotent.
func (r *Registry) Sweep() []Record {
	now := r.nowMillis()
	r.mu.Lock()
	var offline []Record
	for id, record := range r.workers {
		if record.State == StateOnline && record.Lease.ExpiresAt <= now {
			record.State = StateOffline
			r.workers[id] = record
			offline = append(offline, record)
		}
	}
	hook := r.onOffline
	r.mu.Unlock()
	for _, record := range offline {
		if hook != nil {
			hook(record)
		}
	}
	return offline
}

func (r *Registry) SetClock(clock func() time.Time) {
	if clock == nil {
		clock = time.Now
	}
	r.mu.Lock()
	r.clock = clock
	r.mu.Unlock()
}

func (r *Registry) nowMillis() int64 {
	r.mu.Lock()
	clock := r.clock
	r.mu.Unlock()
	return clock().UnixMilli()
}

func newID() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate worker id: %w", err)
	}
	return hex.EncodeToString(raw), nil
}
