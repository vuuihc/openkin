package task

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/vuuihc/openkin/internal/fsroot"
	"github.com/vuuihc/openkin/internal/remote"
	"github.com/vuuihc/openkin/internal/store"
)

// requireCwdForNonHolder refuses a working directory that the account behind a
// request may not name.
//
// A Hub with more than one account has people on it who do not hold the machine,
// and creating a task is running an agent in a directory. Without this a member
// can name any path on the holder's disk and have the holder's own CLI work
// there — read it, write it, and commit in it. The bound is the projects the
// holder registered, because registering one is already an operator action, so
// "a directory the holder curated" needs no new entity.
//
// Three things about the shape are deliberate.
//
// The role comes from the account row, not from the request. Three surfaces fill
// OwnerUserID from the authenticated principal — REST, MCP and A2A — and it is
// already the field the engine trusts for isolation. A Role or AllowedRoots
// field on CreateRequest would be a fourth thing each surface has to remember to
// fill, and its zero value could not be both safe and compatible: defaulting to
// holder is a hole the day one surface forgets, and defaulting to member fails
// every caller that constructs a request today.
//
// The verdict is store.ActsForHolder's, not a role comparison written here.
// That function is the one place that answers "does this principal act for this
// machine", and task_scope.go is explicit that a second answer is how the two
// come to disagree — with a member's isolation on one side of the drift. It is
// asked with a user principal built from the stored role, so a member is
// confined and an owner is not. A paired device never reaches this: a device
// principal carries no UserID, so OwnerUserID is empty for it.
//
// An empty OwnerUserID means no check at all. That covers the master token, a
// paired device, and every standalone daemon with no accounts — none of which is
// a guest on this machine, and unowned tasks belong to whoever holds it. It also
// covers the tasks nobody asked for in a request: a routine firing on a timer,
// an eval case, and an attach to a recorded session each build their request
// from a stored row. Those are safe for a second reason, and it is one this
// function cannot enforce — the routes that create them are holder-gated, so a
// member cannot author the cwd that lands on one. Internal/api's
// TestAMemberCannotReachTheRoutesThatCreateAnUnownedTask is that premise; a
// route on its list moving to a member-visible gate reopens this bound.
//
// An id that resolves to no row is the opposite case and is refused, which is the
// direction TaskScope's zero value fails in.
//
// A non-holder may not name another machine at all, and that refusal is load
// bearing rather than tidy. The guard below is a bound on *this* machine's
// directories, so a request that leaves for another machine leaves the bound
// behind — and the receiving machine's roots are not this machine's projects:
// they are its own projects plus its checkout root plus whatever --node-root it
// was started with (internal/server/node.go). A member has no way to enumerate
// the machines a Hub knows (listing them is holderOnly), so naming one is not a
// choice they can make in the product, and accepting it would let a member who
// learned an id pick the list their cwd is judged by.
func (e *Engine) requireCwdForNonHolder(ctx context.Context, cwd, ownerUserID, executingDeviceID string) error {
	owner := strings.TrimSpace(ownerUserID)
	if owner == "" {
		return nil
	}
	user, err := e.store.GetUser(ctx, owner)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return fmt.Errorf("this account is no longer on this machine")
		}
		return fmt.Errorf("read the account behind this request: %w", err)
	}
	if store.ActsForHolder(remote.Principal{
		Kind:   remote.PrincipalUser,
		UserID: owner,
		Role:   user.Role,
	}) {
		return nil
	}
	if e.isRemoteDevice(executingDeviceID) {
		return fmt.Errorf(
			"only whoever holds this machine can send work to another machine; run the task in one of this machine's projects instead")
	}
	roots, err := e.store.ProjectRoots(ctx)
	if err != nil {
		return fmt.Errorf("read the projects on this machine: %w", err)
	}
	if fsroot.Contains(cwd, roots) {
		return nil
	}
	// The registered directories are deliberately not listed: which ones the
	// holder works in is theirs, and a member who needs one can ask for it to be
	// added. But the refusal does say what would make it work, because a person
	// who cannot tell a boundary from a bug asks for the wrong fix.
	return fmt.Errorf(
		"cwd %q is not inside a project on this machine; ask the owner to add that directory as a project, then start the task in it",
		strings.TrimSpace(cwd))
}
