package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"net/url"
	"path"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/vuuihc/openkin/internal/remote/worker"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/workspace"
)

// A JSON string can expand each decoded byte to a six-byte \u00xx escape.
const workspaceWriteBodyLimit = 6*workspaceReadHardLimit + 64*1024

// workspaceGenEntry is one item in GET /api/tasks/{id}/workspaces.
type workspaceGenEntry struct {
	ID            string `json:"id"`
	TaskID        string `json:"task_id"`
	Generation    int    `json:"generation"`
	State         string `json:"state"`
	SourceRoot    string `json:"source_root"`
	Scope         string `json:"scope"`
	TargetBranch  string `json:"target_branch,omitempty"`
	BaseOID       string `json:"base_oid,omitempty"`
	ReviewBaseOID string `json:"review_base_oid,omitempty"`
	FinalHeadOID  string `json:"final_head_oid,omitempty"`
	FinalTreeOID  string `json:"final_tree_oid,omitempty"`
	IntegratedOID string `json:"integrated_oid,omitempty"`
	FailureReason string `json:"failure_reason,omitempty"`
	CreatedAt     int64  `json:"created_at"`
	UpdatedAt     int64  `json:"updated_at"`
	IntegratedAt  *int64 `json:"integrated_at,omitempty"`
	ReleasedAt    *int64 `json:"released_at,omitempty"`
}

// workspaceTreeResponse is GET .../tree.
type genTreeResponse struct {
	WorkspaceID string                `json:"workspace_id"`
	Generation  int                   `json:"generation"`
	View        string                `json:"view"` // live|snapshot|source
	Path        string                `json:"path"`
	Entries     []workspace.TreeEntry `json:"entries"`
	Truncated   bool                  `json:"truncated,omitempty"`
}

// workspaceFileResponse is GET .../file.
type genFileResponse struct {
	WorkspaceID string `json:"workspace_id"`
	Generation  int    `json:"generation"`
	View        string `json:"view"`
	Path        string `json:"path"`
	Size        int64  `json:"size"`
	Truncated   bool   `json:"truncated"`
	Content     string `json:"content"`
}

// genFilesResponse is GET .../source/files.
type genFilesResponse struct {
	View  string   `json:"view"`
	Files []string `json:"files"`
	// Truncated reports that more files matched than the answer carries; a
	// caller shows the matches it has and lets the query get longer.
	Truncated bool `json:"truncated,omitempty"`
}

// workspaceDiffResponse is GET .../diff.
type genDiffResponse struct {
	WorkspaceID string             `json:"workspace_id"`
	Generation  int                `json:"generation"`
	View        string             `json:"view"`
	Changes     []workspace.Change `json:"changes"`
	// Truncated reports that Changes is the beginning of a longer list, which a
	// machine answering about its own filesystem decides (see
	// worker.MaxWorkspaceChanges).
	Truncated bool `json:"truncated,omitempty"`
}

// handleListTaskWorkspaces lists all workspace generations for a task.
func (s *Server) handleListTaskWorkspaces(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	_, err := s.Engine.Get(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	wss, err := s.Store.ListTaskWorkspaces(r.Context(), id)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	entries := make([]workspaceGenEntry, 0, len(wss))
	for _, ws := range wss {
		entries = append(entries, workspaceGenEntry{
			ID:            ws.ID,
			TaskID:        ws.TaskID,
			Generation:    ws.Generation,
			State:         string(ws.State),
			SourceRoot:    ws.SourceRoot,
			Scope:         ws.Scope,
			TargetBranch:  ws.TargetBranch,
			BaseOID:       ws.BaseOID,
			ReviewBaseOID: ws.ReviewBaseOID,
			FinalHeadOID:  ws.FinalHeadOID,
			FinalTreeOID:  ws.FinalTreeOID,
			IntegratedOID: ws.IntegratedOID,
			FailureReason: ws.FailureReason,
			CreatedAt:     ws.CreatedAt,
			UpdatedAt:     ws.UpdatedAt,
			IntegratedAt:  ws.IntegratedAt,
			ReleasedAt:    ws.ReleasedAt,
		})
	}
	writeJSON(w, http.StatusOK, entries)
}

// workspaceIDParam is the generation id from the route, percent-decoded.
//
// The router matches on the escaped path, so a client that encodes the id —
// the console's URL builders encode every segment, and an id is
// `<task>:g<N>` — hands the handler `%3A` where the store expects `:`. Without
// this, every workspace route answers "workspace not found" for a workspace
// that exists. An id that arrives still encoded twice (`%253A`) decodes twice
// and names the same row; ids are generated and never contain a literal `%`,
// so the leniency cannot reach a row the client did not mean.
func workspaceIDParam(r *http.Request) string {
	id := chi.URLParam(r, "workspace_id")
	if decoded, err := url.PathUnescape(id); err == nil {
		return decoded
	}
	return id
}

// handleListWorkspaceTree lists entries in a workspace generation tree.
func (s *Server) handleListWorkspaceTree(w http.ResponseWriter, r *http.Request) {
	taskID := chi.URLParam(r, "id")
	wsID := workspaceIDParam(r)

	ws, err := s.Store.GetWorkspace(r.Context(), wsID)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "workspace not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if ws.TaskID != taskID {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "workspace not found"})
		return
	}

	reqPath := r.URL.Query().Get("path")
	if reqPath == "" {
		reqPath = ws.Scope
		if reqPath == "" || reqPath == "." {
			reqPath = "."
		}
	}
	side := r.URL.Query().Get("side")
	if side == "" {
		side = defaultSide(ws.State)
	}

	// Validate path is within scope
	if err := validateScopePath(ws.Scope, reqPath); err != nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": err.Error()})
		return
	}

	meta := generationMetadata(ws)

	switch side {
	case "live":
		if s.Workspace == nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "workspace manager unavailable"})
			return
		}
		entries, truncated, err := s.Workspace.ListLiveTree(r.Context(), meta, reqPath)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, genTreeResponse{
			WorkspaceID: ws.ID,
			Generation:  ws.Generation,
			View:        "live",
			Path:        reqPath,
			Entries:     entries,
			Truncated:   truncated,
		})
	case "base":
		if ws.BaseOID == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "base OID not recorded"})
			return
		}
		if s.Workspace == nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "workspace manager unavailable"})
			return
		}
		entries, err := s.Workspace.ListSnapshotTree(r.Context(), taskID, meta, ws.BaseOID+"^{tree}", reqPath)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, genTreeResponse{
			WorkspaceID: ws.ID,
			Generation:  ws.Generation,
			View:        "base",
			Path:        reqPath,
			Entries:     entries,
		})
	case "final":
		if ws.FinalTreeOID == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "final tree OID not recorded"})
			return
		}
		if s.Workspace == nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "workspace manager unavailable"})
			return
		}
		entries, err := s.Workspace.ListSnapshotTree(r.Context(), taskID, meta, ws.FinalTreeOID, reqPath)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, genTreeResponse{
			WorkspaceID: ws.ID,
			Generation:  ws.Generation,
			View:        "final",
			Path:        reqPath,
			Entries:     entries,
		})
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "side must be live, base, or final"})
	}
}

// handleReadWorkspaceFile reads a file from a workspace generation.
func (s *Server) handleReadWorkspaceFile(w http.ResponseWriter, r *http.Request) {
	taskID := chi.URLParam(r, "id")
	wsID := workspaceIDParam(r)

	ws, err := s.Store.GetWorkspace(r.Context(), wsID)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "workspace not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if ws.TaskID != taskID {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "workspace not found"})
		return
	}

	reqPath := strings.TrimSpace(r.URL.Query().Get("path"))
	if reqPath == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path is required"})
		return
	}
	raw := r.URL.Query().Get("raw") == "1"
	download := r.URL.Query().Get("download") == "1"
	side := r.URL.Query().Get("side")
	if side == "" {
		side = defaultSide(ws.State)
	}

	// Validate path is within scope
	if err := validateScopePath(ws.Scope, reqPath); err != nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": err.Error()})
		return
	}

	meta := generationMetadata(ws)

	switch side {
	case "live":
		if s.Workspace == nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "workspace manager unavailable"})
			return
		}
		if download {
			s.serveLiveFileDownload(w, r, meta, reqPath)
			return
		}
		if raw {
			data, err := s.Workspace.ReadLiveFileRaw(r.Context(), meta, reqPath)
			if err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			writeFileBytes(w, reqPath, data, true)
			return
		}
		content, err := s.Workspace.ReadLiveFile(r.Context(), meta, reqPath)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, genFileResponse{
			WorkspaceID: ws.ID,
			Generation:  ws.Generation,
			View:        "live",
			Path:        reqPath,
			Size:        int64(len(content)),
			Content:     string(content),
		})
	case "base":
		if ws.BaseOID == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "base OID not recorded"})
			return
		}
		if s.Workspace == nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "workspace manager unavailable"})
			return
		}
		if raw || download {
			data, err := s.Workspace.ReadSnapshotFile(r.Context(), taskID, meta, ws.BaseOID+"^{tree}", reqPath)
			if err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			// A snapshot is read out of git into memory, so its download keeps
			// the preview cap; only a live file can stream past it. A download
			// asks for an attachment even when raw was also named.
			writeFileBytes(w, reqPath, data, raw && !download)
			return
		}
		content, err := s.Workspace.ReadSnapshotFile(r.Context(), taskID, meta, ws.BaseOID+"^{tree}", reqPath)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, genFileResponse{
			WorkspaceID: ws.ID,
			Generation:  ws.Generation,
			View:        "base",
			Path:        reqPath,
			Size:        int64(len(content)),
			Content:     string(content),
		})
	case "final":
		if ws.FinalTreeOID == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "final tree OID not recorded"})
			return
		}
		if s.Workspace == nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "workspace manager unavailable"})
			return
		}
		if raw || download {
			data, err := s.Workspace.ReadSnapshotFile(r.Context(), taskID, meta, ws.FinalTreeOID, reqPath)
			if err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			writeFileBytes(w, reqPath, data, raw && !download)
			return
		}
		content, err := s.Workspace.ReadSnapshotFile(r.Context(), taskID, meta, ws.FinalTreeOID, reqPath)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, genFileResponse{
			WorkspaceID: ws.ID,
			Generation:  ws.Generation,
			View:        "final",
			Path:        reqPath,
			Size:        int64(len(content)),
			Content:     string(content),
		})
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "side must be live, base, or final"})
	}
}

func (s *Server) handleWriteWorkspaceFile(w http.ResponseWriter, r *http.Request) {
	s.writeWorkspaceFile(w, r, chi.URLParam(r, "id"), workspaceIDParam(r))
}

func (s *Server) writeWorkspaceFile(w http.ResponseWriter, r *http.Request, taskID, wsID string) {
	ws, err := s.Store.GetWorkspace(r.Context(), wsID)
	if errors.Is(err, store.ErrNotFound) || (err == nil && ws.TaskID != taskID) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "workspace not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	switch ws.State {
	case store.WorkspaceActive, store.WorkspaceMergeBlocked, store.WorkspaceFinalizeBlocked:
	default:
		writeJSON(w, http.StatusConflict, map[string]string{"error": "workspace is not writable"})
		return
	}
	var body struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, workspaceWriteBodyLimit)
	decoder := json.NewDecoder(r.Body)
	decodeErr := decoder.Decode(&body)
	if decodeErr == nil {
		decodeErr = ensureJSONEOF(decoder)
	}
	if decodeErr != nil {
		if _, ok := errors.AsType[*http.MaxBytesError](decodeErr); ok {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "request body too large"})
			return
		}
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	body.Path = strings.TrimSpace(body.Path)
	if body.Path == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path is required"})
		return
	}
	if err := validateScopePath(ws.Scope, body.Path); err != nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": err.Error()})
		return
	}
	if s.Workspace == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "workspace manager unavailable"})
		return
	}
	meta := generationMetadata(ws)
	unlock := s.Workspace.LockGeneration(meta)
	defer unlock()
	ws, err = s.Store.GetWorkspace(r.Context(), wsID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	switch ws.State {
	case store.WorkspaceActive, store.WorkspaceMergeBlocked, store.WorkspaceFinalizeBlocked:
	default:
		writeJSON(w, http.StatusConflict, map[string]string{"error": "workspace is not writable"})
		return
	}
	content, err := s.Workspace.WriteLiveFile(r.Context(), meta, body.Path, body.Content)
	if err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, workspace.ErrOutputTooLarge) {
			status = http.StatusRequestEntityTooLarge
		}
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, genFileResponse{
		WorkspaceID: ws.ID,
		Generation:  ws.Generation,
		View:        "live",
		Path:        body.Path,
		Size:        int64(len(content)),
		Content:     string(content),
	})
}

// handleGetWorkspaceDiff returns the diff for a workspace generation.
func (s *Server) handleGetWorkspaceDiff(w http.ResponseWriter, r *http.Request) {
	taskID := chi.URLParam(r, "id")
	wsID := workspaceIDParam(r)

	ws, err := s.Store.GetWorkspace(r.Context(), wsID)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "workspace not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if ws.TaskID != taskID {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "workspace not found"})
		return
	}

	meta := generationMetadata(ws)

	// Determine view based on state
	view := defaultSide(ws.State)
	if view == "live" {
		// Active generation: show live changes
		if s.Workspace == nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "workspace manager unavailable"})
			return
		}
		changes, err := s.Workspace.ListLiveChanges(r.Context(), meta)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, genDiffResponse{
			WorkspaceID: ws.ID,
			Generation:  ws.Generation,
			View:        "live",
			Changes:     changes,
		})
	} else {
		// Released/integrated: show snapshot diff
		if ws.ReviewBaseOID == "" || ws.FinalTreeOID == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "snapshot OIDs not recorded"})
			return
		}
		if s.Workspace == nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "workspace manager unavailable"})
			return
		}
		changes, err := s.Workspace.ListSnapshotChanges(r.Context(), taskID, meta, ws.ReviewBaseOID, ws.FinalTreeOID)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, genDiffResponse{
			WorkspaceID: ws.ID,
			Generation:  ws.Generation,
			View:        "final",
			Changes:     changes,
		})
	}
}

// sourceTask reads the task behind one of the source routes.
//
// It reports the two failures that are about the task itself and nothing else: a
// task that runs on another machine is not one of them any more. Its files are
// still not here, but the machine that has them answers — see
// workspace_remote.go, and the handlers below, which ask it.
func (s *Server) sourceTask(w http.ResponseWriter, r *http.Request) (store.Task, bool) {
	t, err := s.Engine.Get(r.Context(), chi.URLParam(r, "id"))
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return store.Task{}, false
	case err != nil:
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return store.Task{}, false
	}
	return t, true
}

// handleListSourceTree lists entries in the source repository tree.
func (s *Server) handleListSourceTree(w http.ResponseWriter, r *http.Request) {
	t, ok := s.sourceTask(w, r)
	if !ok {
		return
	}

	if s.Engine.RunsElsewhere(t) {
		dir := strings.TrimSpace(r.URL.Query().Get("path"))
		s.askRemoteTree(w, r, t, dir, func(found worker.WorkspaceTreeResult) any {
			return genTreeResponse{
				View:      "source",
				Path:      found.Dir,
				Entries:   remoteTree(found.Entries),
				Truncated: found.Truncated,
			}
		})
		return
	}

	if s.Workspace == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "workspace manager unavailable"})
		return
	}

	meta, err := sourceWorkspaceMetadata(r.Context(), s.Workspace, t)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	reqPath := r.URL.Query().Get("path")
	if reqPath == "" {
		reqPath = meta.Scope
		if reqPath == "" {
			reqPath = "."
		}
	}
	if err := validateScopePath(meta.Scope, reqPath); err != nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": err.Error()})
		return
	}
	entries, truncated, err := s.Workspace.ListLiveTree(r.Context(), meta, reqPath)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, genTreeResponse{
		View:      "source",
		Path:      reqPath,
		Entries:   entries,
		Truncated: truncated,
	})
}

// handleReadSourceFile reads a file from the source repository.
func (s *Server) handleReadSourceFile(w http.ResponseWriter, r *http.Request) {
	t, ok := s.sourceTask(w, r)
	if !ok {
		return
	}

	reqPath := strings.TrimSpace(r.URL.Query().Get("path"))
	if reqPath == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path is required"})
		return
	}

	raw := r.URL.Query().Get("raw") == "1"
	download := r.URL.Query().Get("download") == "1"
	if s.Engine.RunsElsewhere(t) {
		if raw || download {
			// The bytes live on another machine and the worker protocol carries
			// text, not arbitrary data. The text reader still answers; only the
			// previews and downloads that need raw bytes are unavailable.
			writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "raw preview and download are not available for a remote workspace"})
			return
		}
		s.askRemoteFile(w, r, t, reqPath, func(found worker.WorkspaceFileResult) any {
			return genFileResponse{
				View:      "source",
				Path:      found.File,
				Size:      int64(len(found.Content)),
				Truncated: found.Truncated,
				Content:   found.Content,
			}
		})
		return
	}

	if s.Workspace == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "workspace manager unavailable"})
		return
	}

	meta, err := sourceWorkspaceMetadata(r.Context(), s.Workspace, t)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if err := validateScopePath(meta.Scope, reqPath); err != nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": err.Error()})
		return
	}
	if download {
		s.serveLiveFileDownload(w, r, meta, reqPath)
		return
	}
	if raw {
		data, err := s.Workspace.ReadLiveFileRaw(r.Context(), meta, reqPath)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeFileBytes(w, reqPath, data, true)
		return
	}
	content, err := s.Workspace.ReadLiveFile(r.Context(), meta, reqPath)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, genFileResponse{
		View:    "source",
		Path:    reqPath,
		Size:    int64(len(content)),
		Content: string(content),
	})
}

// handleListSourceFiles answers which files in a task's workspace match a few
// characters, for the composer's @ menu.
//
// It is a search, not a listing: the query is required and short, and the answer
// is bounded, because the menu that consumes it is read at a glance. A task that
// runs on another machine is answered by that machine — the files are there, and
// so is the git that knows which of them are worth naming.
func (s *Server) handleListSourceFiles(w http.ResponseWriter, r *http.Request) {
	t, ok := s.sourceTask(w, r)
	if !ok {
		return
	}

	query, ok := sourceFileQuery(w, r)
	if !ok {
		return
	}

	if s.Engine.RunsElsewhere(t) {
		s.askRemoteFiles(w, r, t, query, func(found worker.WorkspaceFilesResult) any {
			return genFilesResponse{
				View:      "source",
				Files:     found.Files,
				Truncated: found.Truncated,
			}
		})
		return
	}

	if s.Workspace == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "workspace manager unavailable"})
		return
	}
	meta, err := sourceWorkspaceMetadata(r.Context(), s.Workspace, t)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	files, truncated, err := s.Workspace.ListLiveFiles(r.Context(), meta, query, workspace.LiveFilesLimit)
	if err != nil {
		// A directory that is not a checkout has no file list; the console
		// offers no file section rather than an empty one.
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if files == nil {
		files = []string{}
	}
	writeJSON(w, http.StatusOK, genFilesResponse{
		View:      "source",
		Files:     files,
		Truncated: truncated,
	})
}

// sourceFileQuery reads the @ menu's query, or writes the refusal.
//
// Both answers to this route are held to one set of rules — the machine that
// runs a task parses the same field with `WorkspaceFilesParams.Validate`, and a
// local read must not be more permissive than a remote one, or what a task
// answers would depend on where it happened to run.
func sourceFileQuery(w http.ResponseWriter, r *http.Request) (string, bool) {
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "q is required"})
		return "", false
	}
	if len(query) > worker.MaxFileQuery {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": fmt.Sprintf("q exceeds %d bytes", worker.MaxFileQuery),
		})
		return "", false
	}
	if strings.ContainsAny(query, "\x00\n\r") {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "q contains a control character",
		})
		return "", false
	}
	return query, true
}

// handleListSourceChanges answers what has changed in a task's workspace as it
// stands right now.
//
// The other change route is a generation's diff, which exists once a task has an
// isolated workspace and is what the console draws for one. A task whose files
// are the person's own checkout has no generation and no base to diff against,
// so this is the same question answered the other way: what does git say is
// different from HEAD, uncommitted work included. On a machine that runs the
// task, git is asked there — the answer is about its filesystem, not this one's.
func (s *Server) handleListSourceChanges(w http.ResponseWriter, r *http.Request) {
	t, ok := s.sourceTask(w, r)
	if !ok {
		return
	}

	if s.Engine.RunsElsewhere(t) {
		s.askRemoteChanges(w, r, t, func(found worker.WorkspaceChangesResult) any {
			return genDiffResponse{View: "source", Changes: remoteChanges(found.Changes), Truncated: found.Truncated}
		})
		return
	}

	if s.Workspace == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "workspace manager unavailable"})
		return
	}
	meta, err := sourceWorkspaceMetadata(r.Context(), s.Workspace, t)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	changes, err := s.Workspace.ListLiveChanges(r.Context(), meta)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if changes == nil {
		// Never null: the console reads this as an array.
		changes = []workspace.Change{}
	}
	writeJSON(w, http.StatusOK, genDiffResponse{View: "source", Changes: changes})
}

// generationMetadata builds workspace.Metadata from a WorkspaceGeneration.
func generationMetadata(ws store.WorkspaceGeneration) workspace.Metadata {
	return workspace.Metadata{
		Mode:         workspace.ResolvedWorktree,
		Generation:   ws.Generation,
		SourceRoot:   ws.SourceRoot,
		Root:         ws.PhysicalRoot,
		Cwd:          ws.ExecutionCwd,
		Scope:        ws.Scope,
		BaseOID:      ws.BaseOID,
		Branch:       ws.WorkspaceBranch,
		TargetBranch: ws.TargetBranch,
	}
}

func sourceWorkspaceMetadata(ctx context.Context, manager *workspace.Manager, task store.Task) (workspace.Metadata, error) {
	source, err := manager.ResolveSource(ctx, task.Cwd)
	if err == nil {
		return workspace.Metadata{
			Mode:       workspace.ResolvedShared,
			SourceRoot: source.SourceRoot,
			Root:       source.SourceRoot,
			Cwd:        source.Cwd,
			Scope:      source.Scope,
			BaseOID:    source.HeadOID,
		}, nil
	}
	root := strings.TrimSpace(task.WorkspaceSourceRoot)
	scope := strings.TrimSpace(task.WorkspaceScope)
	if root == "" {
		root = task.Cwd
		scope = "."
	}
	if scope == "" {
		scope = "."
	}
	return workspace.Metadata{
		Mode:       workspace.ResolvedShared,
		SourceRoot: root,
		Root:       root,
		Cwd:        task.Cwd,
		Scope:      scope,
	}, nil
}

// fileResponseHeaders sets the headers a file's bytes are served with.
//
// The type comes from the extension and nothing else. Sniffing would let a
// workspace file call itself text/html and run as a page on the daemon's
// origin; only the image types the viewer draws in an <img> may be inline, and
// everything else is a download. The bytes are file content, so no cache may
// outlive the file they came from.
func fileResponseHeaders(w http.ResponseWriter, name string, inline bool) {
	contentType, drawable := rawFileType(name)
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	disposition := "attachment"
	if inline && drawable {
		disposition = "inline"
	}
	// FormatMediaType quotes and escapes a name that needs it, so a file called
	// `my shot.png` cannot end the header early.
	if value := mime.FormatMediaType(disposition, map[string]string{"filename": filepath.Base(name)}); value != "" {
		w.Header().Set("Content-Disposition", value)
	}
}

// writeFileBytes answers with a file's bytes already in memory, inline only
// when the caller asks for a preview and the type is drawable.
func writeFileBytes(w http.ResponseWriter, name string, data []byte, inline bool) {
	fileResponseHeaders(w, name, inline)
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// serveLiveFileDownload streams a live file as an attachment.
//
// A download is not a preview: the preview cap keeps a mislabeled archive out
// of the daemon's memory, and applying it here would refuse the recording the
// person asked to save. The bytes are streamed from disk instead, under the
// same extension-only type and an always-attachment disposition.
func (s *Server) serveLiveFileDownload(w http.ResponseWriter, r *http.Request, meta workspace.Metadata, name string) {
	file, info, err := s.Workspace.OpenLiveFile(r.Context(), meta, name)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	defer file.Close()
	fileResponseHeaders(w, name, false)
	http.ServeContent(w, r, filepath.Base(name), info.ModTime(), file)
}

// rawFileType is the type a raw read may be drawn as, and whether the browser
// may draw it in place.
//
// SVG is deliberately absent: it is text, the code viewer already shows it,
// and as a document it can carry script. A viewer that never asks for it keeps
// that decision in one place.
func rawFileType(name string) (string, bool) {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".png":
		return "image/png", true
	case ".jpg", ".jpeg":
		return "image/jpeg", true
	case ".gif":
		return "image/gif", true
	case ".webp":
		return "image/webp", true
	case ".bmp":
		return "image/bmp", true
	case ".ico":
		return "image/x-icon", true
	case ".avif":
		return "image/avif", true
	case ".pdf":
		return "application/pdf", false
	default:
		return "application/octet-stream", false
	}
}

// defaultSide returns the default view side for a workspace state.
func defaultSide(state store.WorkspaceState) string {
	switch state {
	case store.WorkspaceActive, store.WorkspaceReady,
		store.WorkspaceMergeBlocked, store.WorkspaceFinalizeBlocked,
		store.WorkspaceLegacyPending:
		return "live"
	case store.WorkspaceIntegrated, store.WorkspaceReleased:
		return "final"
	default:
		return "live"
	}
}

// validateScopePath checks that a requested path is within the task scope.
func validateScopePath(scope, reqPath string) error {
	if scope == "" || scope == "." {
		return nil
	}
	clean := path.Clean(reqPath)
	scopeClean := path.Clean(scope)
	if clean == "." {
		return fmt.Errorf("path %q is outside task scope %q", reqPath, scope)
	}
	if clean == scopeClean || strings.HasPrefix(clean, scopeClean+"/") {
		return nil
	}
	return fmt.Errorf("path %q is outside task scope %q", reqPath, scope)
}

// handleLegacyListWorkspace delegates to the current generation or original handler.
func (s *Server) handleLegacyListWorkspace(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	// Try current workspace first (only if workspace manager is available)
	if s.Workspace != nil {
		ws, err := s.Store.GetCurrentWorkspace(r.Context(), id)
		if err == nil {
			reqPath := r.URL.Query().Get("path")
			side := defaultSide(ws.State)
			meta := generationMetadata(ws)

			if reqPath == "" {
				reqPath = ws.Scope
				if reqPath == "" || reqPath == "." {
					reqPath = "."
				}
			}

			if err := validateScopePath(ws.Scope, reqPath); err != nil {
				writeJSON(w, http.StatusForbidden, map[string]string{"error": err.Error()})
				return
			}

			if side == "live" {
				entries, truncated, err := s.Workspace.ListLiveTree(r.Context(), meta, reqPath)
				if err != nil {
					writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
					return
				}
				writeJSON(w, http.StatusOK, genTreeResponse{
					WorkspaceID: ws.ID,
					Generation:  ws.Generation,
					View:        side,
					Path:        reqPath,
					Entries:     entries,
					Truncated:   truncated,
				})
				return
			}
			treeOID := "HEAD^{tree}"
			if side == "final" {
				if ws.FinalTreeOID == "" {
					writeJSON(w, http.StatusBadRequest, map[string]string{"error": "final tree OID not recorded"})
					return
				}
				treeOID = ws.FinalTreeOID
			}

			entries, err := s.Workspace.ListSnapshotTree(r.Context(), id, meta, treeOID, reqPath)
			if err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, genTreeResponse{
				WorkspaceID: ws.ID,
				Generation:  ws.Generation,
				View:        side,
				Path:        reqPath,
				Entries:     entries,
			})
			return
		}
	}

	// Fall back to original filesystem-based handler
	s.handleListTaskWorkspace(w, r)
}

// handleLegacyReadWorkspaceFile delegates to the current generation or original handler.
func (s *Server) handleLegacyReadWorkspaceFile(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	reqPath := strings.TrimSpace(r.URL.Query().Get("path"))
	if reqPath == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path is required"})
		return
	}

	// Try current workspace first (only if workspace manager is available)
	if s.Workspace != nil {
		ws, err := s.Store.GetCurrentWorkspace(r.Context(), id)
		if err == nil {
			side := defaultSide(ws.State)
			meta := generationMetadata(ws)

			if err := validateScopePath(ws.Scope, reqPath); err != nil {
				writeJSON(w, http.StatusForbidden, map[string]string{"error": err.Error()})
				return
			}

			if side == "live" {
				content, err := s.Workspace.ReadLiveFile(r.Context(), meta, reqPath)
				if err != nil {
					writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
					return
				}
				writeJSON(w, http.StatusOK, genFileResponse{
					WorkspaceID: ws.ID,
					Generation:  ws.Generation,
					View:        side,
					Path:        reqPath,
					Size:        int64(len(content)),
					Content:     string(content),
				})
				return
			}
			treeOID := "HEAD^{tree}"
			if side == "final" {
				if ws.FinalTreeOID == "" {
					writeJSON(w, http.StatusBadRequest, map[string]string{"error": "final tree OID not recorded"})
					return
				}
				treeOID = ws.FinalTreeOID
			}

			content, err := s.Workspace.ReadSnapshotFile(r.Context(), id, meta, treeOID, reqPath)
			if err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, genFileResponse{
				WorkspaceID: ws.ID,
				Generation:  ws.Generation,
				View:        side,
				Path:        reqPath,
				Size:        int64(len(content)),
				Content:     string(content),
			})
			return
		}
	}

	// Fall back to original filesystem-based handler
	s.handleReadTaskWorkspaceFile(w, r)
}

// handleLegacyWriteWorkspaceFile resolves the current generation and delegates
// to the same rooted, locked writer as the generation-aware route.
func (s *Server) handleLegacyWriteWorkspaceFile(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if s.Workspace == nil {
		s.handleWriteTaskWorkspaceFile(w, r)
		return
	}
	ws, err := s.Store.GetCurrentWorkspace(r.Context(), id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			task, taskErr := s.Store.GetTask(r.Context(), id)
			if taskErr == nil &&
				(task.WorkspacePolicy == string(store.WorkspacePolicyShared) ||
					(task.WorkspacePolicy == "" && task.WorkspaceMode != "worktree")) {
				s.handleWriteTaskWorkspaceFile(w, r)
				return
			}
		}
		writeJSON(w, http.StatusConflict, map[string]string{"error": "no active writable workspace generation"})
		return
	}
	s.writeWorkspaceFile(w, r, id, ws.ID)
}
