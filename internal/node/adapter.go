package node

import (
	"context"
	"errors"
	"fmt"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/remote/worker"
)

// Adapter runs a turn on another machine, and is an adapter.Adapter so that
// everything downstream of it — the engine's run loop, event storage, sequence
// allocation, the bus, the cursor, the console — is the same code that runs a
// local agent (ADR 0022 D8).
//
// It is bound to one device: the Hub picks the machine (M2.3 turns that into a
// workspace-anchor lookup) and builds the adapter for it.
type Adapter struct {
	Conns    *Connections
	Turns    *Turns
	DeviceID string
	// DeviceLabel is the machine as a person knows it ("studio"), used in the
	// lines a turn writes into a transcript. Empty falls back to DeviceID.
	DeviceLabel string
}

// Start dispatches a turn and returns the handle its events will arrive on.
func (a *Adapter) Start(ctx context.Context, spec adapter.TaskSpec) (adapter.RunHandle, error) {
	if a.Conns == nil || a.Turns == nil {
		return nil, errors.New("remote execution is not configured on this hub")
	}
	turnID := spec.Execution.ID
	if turnID == "" {
		return nil, errors.New("turn has no execution id")
	}

	dispatch := worker.Dispatch{
		TurnID:         turnID,
		TaskID:         spec.ID,
		Agent:          spec.Agent,
		Model:          spec.Model,
		Cwd:            spec.Cwd,
		Prompt:         spec.Prompt,
		SessionRef:     spec.SessionRef,
		PermissionMode: spec.PermissionMode,
	}
	if err := dispatch.Validate(); err != nil {
		return nil, err
	}

	// The turn belongs to the connection that dispatches it, and is dispatched on
	// that same connection: a reconnect in the middle of this must not produce a
	// turn bound to one socket and sent on another.
	sender, err := a.Conns.Get(a.DeviceID)
	if err != nil {
		return nil, err
	}
	handle, err := a.Turns.Open(turnID, sender, a.DeviceLabel)
	if err != nil {
		return nil, err
	}
	frame, err := worker.NewFrame("turn.dispatch", dispatch)
	if err != nil {
		a.Turns.close(handle.turn)
		return nil, err
	}
	if err := sender.Send(ctx, frame); err != nil {
		// The socket went away between the check and the write. Fail the start
		// rather than leave a turn nobody can feed.
		a.Turns.close(handle.turn)
		return nil, fmt.Errorf("dispatch turn to %s: %w", a.DeviceID, err)
	}
	return handle, nil
}

// RouteFrame is the Hub's dispatcher for frames a Node sends up outside the
// handshake: the turn traffic. It returns an error for anything else, so an
// unhandled frame is visible rather than silently dropped.
//
// Its signature is the one api.Server.NodeFrames wants, so the composition root
// wires it in directly.
func (t *Turns) RouteFrame(_ context.Context, sender Sender, frame worker.Frame) error {
	switch frame.Kind {
	case "turn.event":
		event, err := Decode[worker.TurnEvent](frame)
		if err != nil {
			return err
		}
		if err := event.Validate(); err != nil {
			return err
		}
		return t.Deliver(sender, event)
	case "turn.started":
		started, err := Decode[worker.TurnStarted](frame)
		if err != nil {
			return err
		}
		if err := started.Validate(); err != nil {
			return err
		}
		return t.Started(sender, started)
	case "turn.finish":
		finish, err := Decode[worker.TurnFinish](frame)
		if err != nil {
			return err
		}
		if err := finish.Validate(); err != nil {
			return err
		}
		return t.Finish(sender, finish)
	default:
		return fmt.Errorf("unhandled frame kind %q", frame.Kind)
	}
}
