package node

import (
	"context"
	"path/filepath"
	"strings"

	"github.com/vuuihc/openkin/internal/remote/worker"
	"github.com/vuuihc/openkin/internal/workspace"
)

// The three questions about the files of a session that runs on this machine.
//
// The Hub asks them for the same reason it asks where a directory is: the task's
// workspace is this machine's checkout, and the Hub holding a checkout of the
// same repository at the same address is not the same thing as holding this one.
// Answering from its own copy would put one session's files under another
// session's name.
//
// Every one of them goes through r.own, the same boundary a dispatched turn is
// held to, and then through the workspace layer the Hub uses on its own
// shared workspaces — so a machine's answer and the Hub's answer to the same
// question are the same computation over different filesystems, not two
// implementations that have to be kept in step.

func (r *Responder) workspaceChanges(ctx context.Context, asked worker.WorkspaceChangesParams) (worker.WorkspaceChangesResult, error) {
	// This is the one of the three that needs git: a change list is git's
	// answer, not the filesystem's.
	path, err := r.own(asked.Path)
	if err != nil {
		return worker.WorkspaceChangesResult{}, err
	}
	git, err := r.workspaceFor("what changed in a directory")
	if err != nil {
		return worker.WorkspaceChangesResult{}, err
	}
	changes, err := git.ListLiveChanges(ctx, workspace.SharedMetadata(path))
	if err != nil {
		return worker.WorkspaceChangesResult{}, err
	}
	// Bounded where the answer is built rather than where git is read: how many
	// files a session touched is not this machine's to decide, but how many fit
	// in one answer is.
	truncated := false
	if len(changes) > worker.MaxWorkspaceChanges {
		changes = changes[:worker.MaxWorkspaceChanges]
		truncated = true
	}
	// Never nil: a console reading this answer reads it as a list, and a checkout
	// with nothing changed has an empty one.
	wire := make([]worker.WorkspaceChange, 0, len(changes))
	for _, change := range changes {
		wire = append(wire, worker.WorkspaceChange{
			Path:      change.Path,
			OldPath:   change.OldPath,
			Status:    change.Status,
			Additions: change.Additions,
			Deletions: change.Deletions,
			Binary:    change.Binary,
		})
	}
	return worker.WorkspaceChangesResult{Path: path, Changes: wire, Truncated: truncated}, nil
}

func (r *Responder) workspaceTree(ctx context.Context, asked worker.WorkspaceTreeParams) (worker.WorkspaceTreeResult, error) {
	// No git needed: listing a directory is a question about a filesystem, and a
	// machine that has no git still has directories.
	path, err := r.own(asked.Path)
	if err != nil {
		return worker.WorkspaceTreeResult{}, err
	}
	dir := strings.TrimSpace(asked.Dir)
	if dir == "" {
		dir = "."
	}
	entries, truncated, err := workspace.ListLiveTree(workspace.SharedMetadata(path), dir)
	if err != nil {
		return worker.WorkspaceTreeResult{}, err
	}
	// Never nil, for the same reason the change list never is.
	wire := make([]worker.WorkspaceTreeEntry, 0, len(entries))
	for _, entry := range entries {
		wire = append(wire, worker.WorkspaceTreeEntry{Name: entry.Name, Type: entry.Type, Size: entry.Size})
	}
	return worker.WorkspaceTreeResult{Path: path, Dir: dir, Entries: wire, Truncated: truncated}, nil
}

// workspaceGit answers what repository and branch one of this machine's own
// directories is in.
//
// It is the question the Hub cannot answer for a session that runs here: the
// Hub's copy of the same repository at the same address says nothing about which
// branch this machine's checkout is on, and the panel that shows a session's
// pull request is drawn from this answer. Every read behind it is local, so a
// phone is not waiting on this machine's network or its credential helper.
//
// A machine that cannot read git answers that instead of refusing, on the same
// reasoning the workspace layer uses for a missing git binary: "there is no
// checkout here" and "this machine cannot tell" are two different facts, and
// Reason is where the second one is said.
func (r *Responder) workspaceGit(ctx context.Context, asked worker.WorkspaceGitParams) (worker.WorkspaceGitResult, error) {
	path, err := r.own(asked.Path)
	if err != nil {
		return worker.WorkspaceGitResult{}, err
	}
	git, err := r.workspaceFor("what a directory has checked out")
	if err != nil {
		return worker.WorkspaceGitResult{Path: path, Reason: err.Error()}, nil
	}
	facts, err := git.InspectGit(ctx, path)
	if err != nil {
		return worker.WorkspaceGitResult{}, err
	}
	return worker.WorkspaceGitResult{
		Path:          path,
		IsGit:         facts.IsGit,
		Repo:          facts.Repo,
		Branch:        facts.Branch,
		DefaultBranch: facts.DefaultBranch,
		Detached:      facts.Detached,
		Dirty:         facts.Dirty,
		Upstream:      facts.Upstream,
		HeadOID:       facts.HeadOID,
		Reason:        facts.Reason,
	}, nil
}

func (r *Responder) workspaceFile(_ context.Context, asked worker.WorkspaceFileParams) (worker.WorkspaceFileResult, error) {
	path, err := r.own(asked.Path)
	if err != nil {
		return worker.WorkspaceFileResult{}, err
	}
	file := strings.TrimSpace(asked.File)
	data, err := workspace.ReadLiveFile(workspace.SharedMetadata(path), file)
	if err != nil {
		return worker.WorkspaceFileResult{}, err
	}
	// The workspace layer refuses anything over 1 MiB and anything that is not
	// text, so what is here is the whole file. The bound below is the answer's,
	// and it is smaller: a frame is 1 MiB in total (see MaxWorkspaceFile).
	size := len(data)
	truncated := false
	if size > worker.MaxWorkspaceFile {
		data = workspace.TrimValidUTF8(data[:worker.MaxWorkspaceFile])
		truncated = true
	}
	return worker.WorkspaceFileResult{
		Path:      path,
		File:      filepath.ToSlash(file),
		Size:      int64(size),
		Content:   string(data),
		Truncated: truncated,
	}, nil
}
