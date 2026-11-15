package api

import (
	"errors"
	"net/http"

	"github.com/vuuihc/openkin/internal/remote/worker"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/workspace"
)

// The one branch a publish may need, made on the machine that holds the
// checkout.
//
// It is not a branch manager and it is not a checkout: a session's checkout is
// the machine's own, and moving it around is /api/git/checkout's job. This route
// exists for exactly one refusal — a publish of a checkout sitting on the
// repository's default branch, which would be a one-tap push of main — and it is
// the way out of it: start a branch here, carry the work onto it, publish that.
//
// The name is the Hub's, not the caller's, and it is the same name Kin gives a
// task's own work everywhere else (workspace.TaskBranch). A phone that had to
// invent branch names would invent a different one on each attempt, and the
// task's work would end up scattered across them.

// errSessionRunsHere is the answer to a write that a phone can only mean about
// another machine.
//
// A session whose checkout this daemon holds is one the person is already
// sitting next to: they can push it, switch it, or commit in it from the machine
// itself. The routes that do those things from a distance exist because a phone
// cannot reach the machine holding the work, and a phone that can already reach
// this daemon can reach the directory. So the Hub answers these writes with the
// conflict rather than doing them — publishing the operator's own directory from
// a phone is a decision nobody has made.
var errSessionRunsHere = errors.New(
	"this session runs on this machine, and this Hub only writes in the checkouts of the machines it is paired with")

// errSessionRunsHereCode is the machine-readable half of that sentence.
//
// Both routes that can answer it can also answer 409 for a different reason — a
// workspace on that machine this Hub cannot place (remoteWorkspacePath) — and the
// console has a translated line for exactly one of the two. Without this code it
// would print "this session runs on this machine" at somebody whose session runs
// on another machine, which is the one thing that line must never say.
const errSessionRunsHereCode = "session_runs_here"

// writeSessionRunsHere answers a write the Hub will not do for this session.
func writeSessionRunsHere(w http.ResponseWriter) {
	writeJSON(w, http.StatusConflict, map[string]string{
		"error": errSessionRunsHere.Error(),
		"code":  errSessionRunsHereCode,
	})
}

type createTaskBranchResponse = worker.GitBranchCreateResult

func (s *Server) handleCreateTaskBranch(w http.ResponseWriter, r *http.Request) {
	t, ok := s.sourceTask(w, r)
	if !ok {
		return
	}
	if s.Engine == nil || !s.Engine.RunsElsewhere(t) {
		writeSessionRunsHere(w)
		return
	}
	dir, ok := s.remoteWorkspacePath(w, r, t)
	if !ok {
		return
	}

	var answer worker.GitBranchCreateResult
	if !s.askDeviceResult(w, r.Context(), t.ExecutingDeviceID, worker.QueryGitBranchCreate,
		worker.GitBranchCreateParams{Path: dir, Branch: workspace.TaskBranch(t.ID)}, &answer) {
		return
	}
	// The row is corrected, because the session's checkout has moved and the row
	// is what the console draws before anybody asks anything: a publish sheet
	// opened after this would otherwise name the branch the work just left.
	//
	// Best effort, and written rather than compared first, for the reason the
	// publish's own write is: the machine answered, and this is the moment the
	// answer is worth a write.
	if answer.Current != "" {
		moved := answer.Current
		_ = s.Store.UpdateTask(r.Context(), t.ID, store.TaskPatch{WorkspaceBranch: &moved})
	}
	writeJSON(w, http.StatusOK, answer)
}
