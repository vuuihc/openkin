package api

import (
	"context"
	"strings"
	"time"

	"github.com/vuuihc/openkin/internal/remote/worker"
	"github.com/vuuihc/openkin/internal/store"
)

// workspaceGitTimeout bounds the one question below.
//
// The answer behind it is a handful of local git reads on a machine that is
// already connected, so the ordinary case is milliseconds; the bound is for the
// machine that accepted a connection and then stopped answering, and it is short
// because a person is watching the screen that started this session.
const workspaceGitTimeout = 5 * time.Second

// recordWhereTheWorkIs asks the machine that will run a task where its work sits
// in git, and writes the answer onto the row.
//
// A task that runs here does not need this: this Hub reads its own checkouts,
// and the workspace lifecycle records the branch a generation actually runs on.
// A session on another machine has no such row — its checkout is that machine's
// — so asking is the only way the Hub can learn the repository and branch, and
// the moment to ask is while the person is still looking at the screen that
// started the session. Everything that reads it afterwards is then a cache read,
// which is the rule those paths hold to: opening a panel must not spend a
// machine round trip or a rate limit.
//
// Best effort in every direction. A machine that is away, one that does not
// answer in time, a directory that is not a checkout: the task is created either
// way and the row keeps what it had. The worst case is a panel that says
// nothing, which is where it started.
func (s *Server) recordWhereTheWorkIs(ctx context.Context, t store.Task) store.Task {
	if s.Engine == nil || s.Store == nil || !s.Engine.RunsElsewhere(t) {
		return t
	}
	device := strings.TrimSpace(t.ExecutingDeviceID)
	if device == "" {
		return t
	}
	// The address on that machine, which is not always the path in the row: a
	// task with a workspace anchor gets the path the anchor resolves to there,
	// and an anchor that cannot be resolved is refused rather than guessed at —
	// the same rule the file reads follow.
	cwd, remote, err := s.Engine.RemoteWorkspaceCwd(ctx, t)
	if err != nil || !remote || strings.TrimSpace(cwd) == "" {
		return t
	}
	askCtx, cancel := context.WithTimeout(ctx, workspaceGitTimeout)
	defer cancel()

	var found worker.WorkspaceGitResult
	if err := s.askDeviceQuietly(askCtx, device, worker.QueryWorkspaceGit,
		worker.WorkspaceGitParams{Path: cwd}, &found); err != nil {
		return t
	}
	// Only what the machine actually said. A checkout on a detached HEAD has no
	// branch, and a directory with no origin has no repository: writing those as
	// empty strings would say "there is none" where the honest answer is "not
	// known", and the column reads the same either way.
	patch := store.TaskPatch{}
	if found.Repo != "" {
		patch.WorkspaceRepo = &found.Repo
	}
	if found.Branch != "" {
		patch.WorkspaceBranch = &found.Branch
	}
	if patch.WorkspaceRepo == nil && patch.WorkspaceBranch == nil {
		return t
	}
	if err := s.Store.UpdateTask(ctx, t.ID, patch); err != nil {
		return t
	}
	// The copy the caller answers with is updated too, so the screen that just
	// started this session has the repository and branch without asking again.
	t.WorkspaceRepo = found.Repo
	if found.Branch != "" {
		t.WorkspaceBranch = found.Branch
	}
	return t
}
