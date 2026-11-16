package api

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/url"
	"sync"
	"time"

	"github.com/vuuihc/openkin/internal/node"
	"github.com/vuuihc/openkin/internal/notify"
	"github.com/vuuihc/openkin/internal/remote/worker"
)

// routineNotifyDedupe bounds the Hub's memory of routine alerts it has already
// accepted, keyed by the authenticated device and the Node's event id. It is
// process-local and FIFO-bounded: a Hub restart forgets it, and a frame that
// reconnects long after the entry was evicted can ring twice. APNs is
// best-effort, not exactly-once, and this is the bound that says so.
type routineNotifyDedupe struct {
	mu    sync.Mutex
	seen  map[string]struct{}
	order []string
	limit int
}

func newRoutineNotifyDedupe() *routineNotifyDedupe {
	return &routineNotifyDedupe{
		seen:  make(map[string]struct{}),
		limit: 1024,
	}
}

// claim reports whether this device+event pair is new. The first call for a
// pair is new; every later one (a reconnect replay) is a duplicate.
func (d *routineNotifyDedupe) claim(deviceID, eventID string) bool {
	key := deviceID + "\x00" + eventID
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.seen == nil {
		d.seen = make(map[string]struct{})
	}
	if _, ok := d.seen[key]; ok {
		return false
	}
	d.seen[key] = struct{}{}
	d.order = append(d.order, key)
	if len(d.order) > d.limit {
		oldest := d.order[0]
		d.order = d.order[1:]
		delete(d.seen, oldest)
	}
	return true
}

// handleRoutineNotify turns a Node's routine report or disabled alert into an
// APNs fan-out to the phones this Hub registered, and acknowledges it.
//
// The Node asserts nothing but the content: the source device is the
// authenticated connection, the recipient is the account the device registry
// records for that device (with the existing ownerless->operator fallback), and
// the link is built here. A revoked device is denied; one device cannot name
// another account, a recipient, a URL, or a broadcast flag.
func (s *Server) handleRoutineNotify(ctx context.Context, sender node.Sender, frame worker.Frame) error {
	msg, err := node.Decode[worker.RoutineNotify](frame)
	if err != nil {
		return err
	}
	if err := msg.Validate(); err != nil {
		return err
	}
	if s.Notify == nil || s.Store == nil {
		return errors.New("routine notify: hub notifier is unavailable")
	}

	deviceID := sender.DeviceID()

	// The authenticated connection must be the one this Hub currently holds for
	// the device. A replaced connection (a newer socket won) may still have its
	// reader draining, but its frames are no longer from the machine this Hub
	// thinks it is talking to, so they are dropped and never acknowledged.
	if s.Nodes == nil {
		return errors.New("routine notify: hub has no node connections")
	}
	current, err := s.Nodes.Get(deviceID)
	if err != nil || current == nil || current.Generation() != sender.Generation() {
		return errors.New("routine notify: sender is not the current connection")
	}

	// Revocation is fail-closed: a credential check error is treated the same as
	// a revoked credential, and neither is acknowledged. The revocation watcher
	// is closing the socket anyway.
	if s.Store != nil {
		active, err := s.Store.DeviceActive(ctx, deviceID)
		if err != nil || !active {
			if err != nil {
				log.Printf("routine notify: device active check for %s: %v", deviceID, err)
			}
			return nil
		}
	}

	// The device registry owns the recipient. A missing row or a read error is a
	// bug in the handshake path (a routine.notify only follows a successful
	// hello), so it must fail closed rather than quietly become an operator-wide
	// alert.
	owner := ""
	if s.Store != nil {
		device, err := s.Store.GetDevice(ctx, deviceID)
		if err != nil {
			log.Printf("routine notify: resolve device %s: %v", deviceID, err)
			return fmt.Errorf("routine notify: resolve device: %w", err)
		}
		owner = device.OwnerUserID
	}

	// A repeated frame - a reconnect replaying an alert whose write died with
	// the socket - must not ring twice. The acknowledgement is still sent, so
	// the Node can drop what it holds.
	if !s.reserveRoutineDispatch() {
		// No claim or acknowledgement: the Node retries when capacity returns.
		return errors.New("routine notify: apns fan-out saturated")
	}
	newEvent := s.routineNotifyDedupeState().claim(deviceID, msg.EventID)

	if newEvent {
		payload := routineNotifyPayload(deviceID, owner, msg)
		// APNs is network work and must not block the socket reader. The
		// notifier's DeliverAPNs runs the HTTP/2 sends; this goroutine holds
		// the short deadline the rest of the daemon gives a fire-and-forget send
		// and releases the dispatch slot when it finishes.
		go func() {
			defer s.releaseRoutineDispatch()
			cctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			_ = s.Notify.DeliverAPNs(cctx, payload)
		}()
	} else {
		s.releaseRoutineDispatch()
	}

	ack, err := worker.NewFrame("routine.notify.ack", worker.RoutineNotifyAck{EventID: msg.EventID})
	if err != nil {
		return err
	}
	writeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	return sender.Send(writeCtx, ack)
}

// routineNotifyMaxInFlight bounds concurrent routine-notify APNs fan-outs. A
// Hub that runs many Nodes at once still has a finite number of HTTP/2 sends
// in flight, and this is the process-local ceiling on that work.
const routineNotifyMaxInFlight = 64

// reserveRoutineDispatch takes one fan-out slot without blocking. It reports
// false when the Hub is saturated, so the caller can fail closed instead of
// acknowledging an event it is about to drop.
func (s *Server) reserveRoutineDispatch() bool {
	s.routineNotifyDispatchOnce.Do(func() {
		s.routineNotifyDispatch = make(chan struct{}, routineNotifyMaxInFlight)
	})
	select {
	case s.routineNotifyDispatch <- struct{}{}:
		return true
	default:
		return false
	}
}

func (s *Server) releaseRoutineDispatch() {
	<-s.routineNotifyDispatch
}

// routineNotifyDedupeState returns the process-local dedupe, initializing it on
// first use. The sync.Once keeps the first call race-free across concurrent
// Node connections.
func (s *Server) routineNotifyDedupeState() *routineNotifyDedupe {
	s.routineNotifyOnce.Do(func() { s.routineNotifyDedupe = newRoutineNotifyDedupe() })
	return s.routineNotifyDedupe
}

// routineNotifyPayload builds the alert the Hub sends, with a link that points
// at the machine that produced the report. The device id comes from the
// authenticated connection, never from the frame, so the link names the right
// Node without a Node ever asserting one.
func routineNotifyPayload(deviceID, owner string, msg worker.RoutineNotify) notify.Payload {
	escDevice := url.PathEscape(deviceID)
	var link, id string
	switch msg.Event {
	case worker.RoutineEventReport:
		id = msg.TaskID
		link = "/machines/" + escDevice + "/tasks/" + url.PathEscape(msg.TaskID)
	case worker.RoutineEventDisabled:
		id = msg.RoutineID
		link = "/routines?device=" + url.QueryEscape(deviceID)
	default:
		link = "/routines"
	}
	return notify.Payload{
		Title:       msg.Title,
		Body:        msg.Body,
		URL:         link,
		Kind:        "routine",
		ID:          id,
		ThreadID:    id,
		CollapseID:  "routine:" + id,
		OwnerUserID: owner,
	}
}
