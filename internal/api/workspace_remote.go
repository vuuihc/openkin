package api

import (
	"net/http"
	"path"

	"github.com/vuuihc/openkin/internal/remote/worker"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/workspace"
)

// Reading a workspace that lives on another machine.
//
// A task that runs on a phone-picked machine keeps its files there, and the Hub
// usually holds a different checkout of the same repository at the same address.
// Reading its own copy would show one session's files under another session's
// name, which is why these routes used to answer 409 — true, and a dead end:
// the machine that has the files can answer, and the Hub can ask it.
//
// So every read below becomes one question to the machine named in the task row.
// The machine resolves the path against its own roots (see node.Responder) and
// computes the answer with the same workspace layer the Hub uses on its own
// shared workspaces, so what comes back is the same computation over the
// filesystem that actually holds the files.
//
// Three shapes, because the console has three readers: a tree, a file, and a
// change list. The Hub maps each answer into the envelope that reader already
// reads, so nothing on the console has to know which machine answered.

// askRemoteTree asks the machine that runs this task to list one directory of
// its workspace, and writes the answer in the caller's shape.
//
// dir is relative to the workspace and empty means its root. shape maps the
// machine's answer into the envelope the calling route uses: the two families of
// file routes predate each other and do not share one.
func (s *Server) askRemoteTree(
	w http.ResponseWriter,
	r *http.Request,
	t store.Task,
	dir string,
	shape func(found worker.WorkspaceTreeResult) any,
) {
	workspacePath, ok := s.remoteWorkspacePath(w, r, t)
	if !ok {
		return
	}
	var found worker.WorkspaceTreeResult
	params := worker.WorkspaceTreeParams{Path: workspacePath, Dir: dir}
	if !s.askDeviceResult(w, r.Context(), t.ExecutingDeviceID, worker.QueryWorkspaceTree, params, &found) {
		return
	}
	writeJSON(w, http.StatusOK, shape(found))
}

// askRemoteFile asks the machine that runs this task for one text file of its
// workspace, and writes the answer in the caller's shape.
func (s *Server) askRemoteFile(
	w http.ResponseWriter,
	r *http.Request,
	t store.Task,
	file string,
	shape func(found worker.WorkspaceFileResult) any,
) {
	workspacePath, ok := s.remoteWorkspacePath(w, r, t)
	if !ok {
		return
	}
	var found worker.WorkspaceFileResult
	params := worker.WorkspaceFileParams{Path: workspacePath, File: file}
	if !s.askDeviceResult(w, r.Context(), t.ExecutingDeviceID, worker.QueryWorkspaceFile, params, &found) {
		return
	}
	writeJSON(w, http.StatusOK, shape(found))
}

// askRemoteChanges asks the machine that runs this task what has changed in its
// workspace, and writes the answer in the caller's shape.
func (s *Server) askRemoteChanges(
	w http.ResponseWriter,
	r *http.Request,
	t store.Task,
	shape func(found worker.WorkspaceChangesResult) any,
) {
	workspacePath, ok := s.remoteWorkspacePath(w, r, t)
	if !ok {
		return
	}
	var found worker.WorkspaceChangesResult
	params := worker.WorkspaceChangesParams{Path: workspacePath}
	if !s.askDeviceResult(w, r.Context(), t.ExecutingDeviceID, worker.QueryWorkspaceChanges, params, &found) {
		return
	}
	writeJSON(w, http.StatusOK, shape(found))
}

// remoteWorkspacePath is the directory to ask about on the machine that runs
// this task.
//
// It is the path the task row carries only when no anchor was recorded for it. A
// task that has one is resolved to the path that anchor names *on that machine*,
// because the address in the row belongs to whichever machine created the task,
// and the two are the same only by luck. A task whose workspace that machine
// cannot resolve is refused rather than guessed at: the alternative is reading
// this machine's directory at the same address, which is exactly the mistake
// these routes exist to avoid.
func (s *Server) remoteWorkspacePath(w http.ResponseWriter, r *http.Request, t store.Task) (string, bool) {
	cwd, remote, err := s.Engine.RemoteWorkspaceCwd(r.Context(), t)
	if err != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return "", false
	}
	if !remote || cwd == "" {
		writeJSON(w, http.StatusConflict, map[string]string{"error": errWorkspaceElsewhere.Error()})
		return "", false
	}
	return cwd, true
}

// remoteTreeEntries maps a machine's listing into the entry shape the legacy
// workspace browser draws.
//
// The two vocabularies differ by more than a name: the wire answers with
// worker.WorkspaceTreeEntry ("tree"/"blob", what git calls them), and that
// browser wants "dir"/"file", what a person calls them. The path is rebuilt
// rather than sent, because a listing is one level and its entries are one join
// away from the directory that was listed.
func remoteTreeEntries(dir string, entries []worker.WorkspaceTreeEntry) []workspaceListEntry {
	out := make([]workspaceListEntry, 0, len(entries))
	for _, entry := range entries {
		item := workspaceListEntry{
			Name: entry.Name,
			Path: joinEntryPath(dir, entry.Name),
			Size: entry.Size,
		}
		if entry.Type == "tree" {
			item.Type = "dir"
		} else {
			item.Type = "file"
		}
		out = append(out, item)
	}
	return out
}

// remoteTree is a machine's listing in the shape the source routes answer with.
func remoteTree(entries []worker.WorkspaceTreeEntry) []workspace.TreeEntry {
	out := make([]workspace.TreeEntry, 0, len(entries))
	for _, entry := range entries {
		out = append(out, workspace.TreeEntry{Name: entry.Name, Type: entry.Type, Size: entry.Size})
	}
	return out
}

// remoteChanges is a machine's change list in the shape the source routes answer
// with — the same envelope whether the answer came from the machine holding the
// files or from this Hub reading its own.
func remoteChanges(changes []worker.WorkspaceChange) []workspace.Change {
	out := make([]workspace.Change, 0, len(changes))
	for _, change := range changes {
		out = append(out, workspace.Change{
			Path:      change.Path,
			OldPath:   change.OldPath,
			Status:    change.Status,
			Additions: change.Additions,
			Deletions: change.Deletions,
			Binary:    change.Binary,
		})
	}
	return out
}

// joinEntryPath is one entry's path inside the listed directory.
func joinEntryPath(dir, name string) string {
	dir = path.Clean(dir)
	if dir == "." || dir == "" {
		return name
	}
	return path.Join(dir, name)
}
