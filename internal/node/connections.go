// Package node is the Hub's half of the Node control channel.
//
// A Node is a machine that runs turns with its own agents. It dials out to the
// Hub and stays connected; the Hub never dials in, so a machine behind NAT
// needs no port mapping, no VPN, and no public address. Everything the Hub
// wants to say to a Node — dispatch a turn, cancel one, hand back an approval
// decision — travels back down the connection the Node opened.
//
// This file is only the connection table. What the frames mean is the worker
// protocol's business (internal/remote/worker), and what happens to a
// dispatched turn is the engine's.
package node

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/vuuihc/openkin/internal/remote/worker"
)

// ErrOffline means the device has no live connection: either it never dialled
// in, or the connection dropped. Callers must treat it as a normal state, not
// an error to retry in a loop.
var ErrOffline = errors.New("node is not connected")

// Connections tracks which devices are connected right now.
//
// Liveness lives here and not in the database: a Hub restart, a killed process,
// or a yanked cable all look the same from the store's point of view, and only
// the process holding the socket knows the difference.
type Connections struct {
	mu      sync.RWMutex
	byID    map[string]Sender
	onEnded func(deviceID string)
}

// NewConnections returns an empty connection table. onEnded, when set, is called
// once per connection when that connection ends — because it dropped, or because
// a newer one replaced it — so the caller can settle whatever it was doing. A
// turn is bound to the connection that started it, so this is the only chance to
// reach a terminal state.
func NewConnections(onEnded func(deviceID string)) *Connections {
	return &Connections{byID: make(map[string]Sender), onEnded: onEnded}
}

// Attach registers a live connection and returns whatever it displaced.
//
// A device reconnecting is normal — a laptop that slept, a redeployed Node — so
// the new connection wins and the stale one is returned for the caller to close.
// Two live connections for one device would make dispatch a coin flip.
//
// The displaced connection counts as ended, so the caller hears about it here
// rather than when its handler eventually returns: its Detach will not report it
// (it is no longer the current connection), and anything it was running would
// otherwise never be settled. Its turns really are dead — the Node derives a
// turn's lifetime from the connection that dispatched it, so closing the socket
// stops the work on that machine too.
func (c *Connections) Attach(sender Sender) (previous Sender) {
	c.mu.Lock()
	previous = c.byID[sender.DeviceID()]
	c.byID[sender.DeviceID()] = sender
	c.mu.Unlock()

	if previous != nil && c.onEnded != nil {
		c.onEnded(sender.DeviceID())
	}
	return previous
}

// Detach removes a connection if it is still the current one. A connection that
// was already replaced must not remove its successor on the way out, and must
// not report itself ended twice.
func (c *Connections) Detach(sender Sender) {
	c.mu.Lock()
	current, ok := c.byID[sender.DeviceID()]
	wasCurrent := ok && current == sender
	if wasCurrent {
		delete(c.byID, sender.DeviceID())
	}
	c.mu.Unlock()

	if wasCurrent && c.onEnded != nil {
		c.onEnded(sender.DeviceID())
	}
}

// Get returns the live connection for a device, or ErrOffline.
func (c *Connections) Get(deviceID string) (Sender, error) {
	c.mu.RLock()
	sender, ok := c.byID[deviceID]
	c.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrOffline, deviceID)
	}
	return sender, nil
}

// Connected reports whether a device has a live connection.
func (c *Connections) Connected(deviceID string) bool {
	c.mu.RLock()
	_, ok := c.byID[deviceID]
	c.mu.RUnlock()
	return ok
}

// Online lists the devices connected right now.
func (c *Connections) Online() []string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := make([]string, 0, len(c.byID))
	for id := range c.byID {
		out = append(out, id)
	}
	return out
}

// Send delivers a frame to one device, or reports that it is offline.
func (c *Connections) Send(ctx context.Context, deviceID string, frame worker.Frame) error {
	sender, err := c.Get(deviceID)
	if err != nil {
		return err
	}
	return sender.Send(ctx, frame)
}
