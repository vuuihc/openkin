package task

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/vuuihc/openkin/internal/store"
)

// Workspace anchors, engine side.
//
// The store keeps the identity and the per-device paths; this file decides when
// one is recorded and — more importantly — what happens when one cannot be
// resolved. The answer to that last question is the whole point of the feature:
// a turn does not run in a path that merely looks right, and it does not move
// to a machine that happens to have a directory with the same name. It fails,
// and says where the workspace actually is (ADR 0022 D6, R2).

// errWorkspaceUnresolvable means the device that was asked to run a turn cannot
// resolve the task's workspace.
var errWorkspaceUnresolvable = errors.New("the device cannot resolve this task's workspace")

// workspaceAnchorFor records the portable identity of a working directory, or
// returns "" when there is none to record.
//
// Best effort on purpose: a task is still a task when its directory cannot be
// described portably (no git, a directory that is not a checkout, a device that
// has not reported where its checkouts are). What an anchor buys is portability,
// and the absence of one is not an error a user can act on at this point — the
// machine that owns the filesystem still refuses work outside its roots at
// dispatch.
func (e *Engine) workspaceAnchorFor(ctx context.Context, cwd, deviceID string, now int64) string {
	cwd = strings.TrimSpace(cwd)
	if cwd == "" || e.store == nil {
		return ""
	}
	if e.isRemoteDevice(deviceID) {
		// Another machine's directory: this daemon cannot look at it, so the
		// only thing it can match the path against is what that machine said
		// about itself.
		anchor, _, ok, err := e.store.MatchDeviceRoot(ctx, deviceID, cwd, now)
		if err != nil || !ok {
			return ""
		}
		return anchor.ID
	}

	self := e.selfDevice()
	if self == "" {
		// An anchor root belongs to a device, and this daemon has no device
		// identity in this process (no hub role configured). Nothing to hang a
		// root on.
		return ""
	}
	anchor, checkout, err := e.anchors.DeriveAnchor(ctx, cwd)
	if err != nil {
		return ""
	}
	if anchor.Portable() {
		stored, err := e.store.EnsureGitAnchor(ctx, anchor.RemoteURL, anchor.RelativePath, now)
		if err != nil {
			return ""
		}
		if err := e.store.SetAnchorRoot(ctx, stored.ID, self, checkout, now); err != nil {
			return ""
		}
		return stored.ID
	}
	stored, err := e.store.EnsureDeviceAnchor(ctx, self, cwd, now)
	if err != nil {
		return ""
	}
	return stored.ID
}

// dispatchCwd returns the working directory to hand the machine that will run
// this turn.
//
// A task with an anchor gets the path that anchor resolves to *on that
// machine*, which is the only path that means anything there. A task without
// one keeps the path it was created with: that is what every task predating
// anchors has, and for a task created on the machine that runs it, the path is
// already correct.
//
// Only a turn leaving this daemon comes through here. A turn that runs here is
// already at the address in the row, and for an isolated workspace that address
// is the clone the workspace lifecycle owns, not the project path the anchor
// was derived from (the caller passes EffectiveCwd for those).
func (e *Engine) dispatchCwd(ctx context.Context, t store.Task) (string, error) {
	if strings.TrimSpace(t.WorkspaceAnchorID) == "" {
		return t.EffectiveCwd(), nil
	}
	anchor, err := e.store.GetWorkspaceAnchor(ctx, t.WorkspaceAnchorID)
	if err != nil {
		return "", fmt.Errorf("resolve workspace anchor: %w", err)
	}
	path, ok, err := e.store.ResolveAnchorPath(ctx, anchor, t.ExecutingDeviceID)
	if err != nil {
		return "", err
	}
	if !ok {
		// Not a fallback, a refusal: running this turn in a path this machine
		// does not have would either fail inside the agent or, worse, work in a
		// directory that is not the same code.
		devices, _ := e.store.DevicesWithAnchor(ctx, anchor)
		where := "no device has reported it"
		if len(devices) > 0 {
			where = "it is on " + strings.Join(devices, ", ")
		}
		return "", fmt.Errorf("%w: %s — %s", errWorkspaceUnresolvable,
			describeAnchor(anchor), where)
	}
	return path, nil
}

// noteUnanchoredRemoteTurn records that a turn left this daemon with no
// workspace identity to check.
//
// The machine that runs it still refuses paths outside the roots it declared,
// so this is not an open door — but it is the weaker check of the two, and
// without a line in the transcript it is indistinguishable from a turn whose
// workspace was resolved. Saying so is the difference between a fallback and a
// silent one.
func (e *Engine) noteUnanchoredRemoteTurn(ctx context.Context, t store.Task, executionID string) {
	name := t.ExecutingDeviceID
	if device, err := e.store.GetDevice(ctx, t.ExecutingDeviceID); err == nil {
		if label := strings.TrimSpace(device.Label); label != "" {
			name = label
		}
	}
	payload, err := json.Marshal(map[string]string{"message": fmt.Sprintf(
		"no workspace identity for this turn: %s runs it at %s, the path this task was created with, "+
			"which only that machine's own roots can vouch for", name, t.EffectiveCwd())})
	if err != nil {
		return
	}
	if ev, err := e.persistRunEvent(ctx, t.ID, executionID, "meta", payload); err == nil {
		e.bus.PublishEvent(ev)
	}
}

// describeAnchor says which workspace in the words a user would use.
func describeAnchor(anchor store.WorkspaceAnchor) string {
	if anchor.Kind == store.AnchorGitRemote {
		if anchor.RelativePath == "" || anchor.RelativePath == store.AnchorRepoRoot {
			return anchor.RemoteURL
		}
		return anchor.RemoteURL + " (" + anchor.RelativePath + ")"
	}
	return "the directory this task was created in"
}

// selfDevice is this daemon's device id, or "" when it has none.
func (e *Engine) selfDevice() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return strings.TrimSpace(e.selfDeviceID)
}
