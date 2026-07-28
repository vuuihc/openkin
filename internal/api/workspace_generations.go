package api

import (
	"errors"
	"fmt"
	"net/http"
	"path"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/workspace"
)

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

// workspaceDiffResponse is GET .../diff.
type genDiffResponse struct {
	WorkspaceID string             `json:"workspace_id"`
	Generation  int                `json:"generation"`
	View        string             `json:"view"`
	Changes     []workspace.Change `json:"changes"`
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

// handleListWorkspaceTree lists entries in a workspace generation tree.
func (s *Server) handleListWorkspaceTree(w http.ResponseWriter, r *http.Request) {
	taskID := chi.URLParam(r, "id")
	wsID := chi.URLParam(r, "workspace_id")

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
		entries, err := s.Workspace.ListSnapshotTree(r.Context(), taskID, meta, "HEAD^{tree}", reqPath)
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
	wsID := chi.URLParam(r, "workspace_id")

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
		content, err := s.Workspace.ReadSnapshotFile(r.Context(), taskID, meta, "HEAD^{tree}", reqPath)
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

// handleGetWorkspaceDiff returns the diff for a workspace generation.
func (s *Server) handleGetWorkspaceDiff(w http.ResponseWriter, r *http.Request) {
	taskID := chi.URLParam(r, "id")
	wsID := chi.URLParam(r, "workspace_id")

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

// handleListSourceTree lists entries in the source repository tree.
func (s *Server) handleListSourceTree(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	t, err := s.Engine.Get(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	reqPath := r.URL.Query().Get("path")
	if reqPath == "" {
		reqPath = t.WorkspaceScope
		if reqPath == "" {
			reqPath = "."
		}
	}

	if err := validateScopePath(t.WorkspaceScope, reqPath); err != nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": err.Error()})
		return
	}

	if s.Workspace == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "workspace manager unavailable"})
		return
	}

	meta := workspace.Metadata{
		Mode:       workspace.ResolvedWorktree,
		SourceRoot: t.WorkspaceSourceRoot,
		Root:       t.WorkspaceSourceRoot,
		Cwd:        t.WorkspaceSourceRoot,
		Scope:      t.WorkspaceScope,
		BaseOID:    t.WorkspaceBaseOID,
	}

	entries, err := s.Workspace.ListSnapshotTree(r.Context(), id, meta, "HEAD^{tree}", reqPath)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, genTreeResponse{
		View:    "source",
		Path:    reqPath,
		Entries: entries,
	})
}

// handleReadSourceFile reads a file from the source repository.
func (s *Server) handleReadSourceFile(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	t, err := s.Engine.Get(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	reqPath := strings.TrimSpace(r.URL.Query().Get("path"))
	if reqPath == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path is required"})
		return
	}

	if err := validateScopePath(t.WorkspaceScope, reqPath); err != nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": err.Error()})
		return
	}

	if s.Workspace == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "workspace manager unavailable"})
		return
	}

	meta := workspace.Metadata{
		Mode:       workspace.ResolvedWorktree,
		SourceRoot: t.WorkspaceSourceRoot,
		Root:       t.WorkspaceSourceRoot,
		Cwd:        t.WorkspaceSourceRoot,
		Scope:      t.WorkspaceScope,
		BaseOID:    t.WorkspaceBaseOID,
	}

	content, err := s.Workspace.ReadSnapshotFile(r.Context(), id, meta, "HEAD^{tree}", reqPath)
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

// generationMetadata builds workspace.Metadata from a WorkspaceGeneration.
func generationMetadata(ws store.WorkspaceGeneration) workspace.Metadata {
	return workspace.Metadata{
		Mode:       workspace.ResolvedWorktree,
		SourceRoot: ws.SourceRoot,
		Root:       ws.PhysicalRoot,
		Cwd:        ws.ExecutionCwd,
		Scope:      ws.Scope,
		BaseOID:    ws.BaseOID,
		Branch:     ws.WorkspaceBranch,
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

			var treeOID string
			switch side {
			case "live":
				treeOID = "HEAD^{tree}"
			case "final":
				if ws.FinalTreeOID == "" {
					writeJSON(w, http.StatusBadRequest, map[string]string{"error": "final tree OID not recorded"})
					return
				}
				treeOID = ws.FinalTreeOID
			default:
				treeOID = "HEAD^{tree}"
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

			var treeOID string
			switch side {
			case "live":
				treeOID = "HEAD^{tree}"
			case "final":
				if ws.FinalTreeOID == "" {
					writeJSON(w, http.StatusBadRequest, map[string]string{"error": "final tree OID not recorded"})
					return
				}
				treeOID = ws.FinalTreeOID
			default:
				treeOID = "HEAD^{tree}"
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

// handleLegacyWriteWorkspaceFile requires an active writable generation or falls back.
func (s *Server) handleLegacyWriteWorkspaceFile(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	// If workspace manager is available, require an active writable generation
	if s.Workspace != nil {
		ws, err := s.Store.GetCurrentWorkspace(r.Context(), id)
		if err != nil || ws.State != store.WorkspaceActive {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "no active writable workspace generation"})
			return
		}
	}

	// Fall back to original handler
	s.handleWriteTaskWorkspaceFile(w, r)
}
