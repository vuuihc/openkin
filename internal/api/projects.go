package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/oklog/ulid/v2"

	"github.com/vuuihc/kin/internal/store"
	"github.com/vuuihc/kin/internal/task"
	"github.com/vuuihc/kin/internal/workspace"
)

// maxOnePagerBytes caps One-Pager body size.
const maxOnePagerBytes = 1 << 20 // 1 MiB

// projectJSON is the API representation (includes one_pager path hint).
type projectJSON struct {
	store.Project
	OnePagerPath string `json:"one_pager_path,omitempty"`
}

func (s *Server) projectToJSON(p store.Project) projectJSON {
	out := projectJSON{Project: p}
	if s.ProjectsDir != "" && p.OnePagerRel != "" {
		out.OnePagerPath = filepath.Join(s.ProjectsDir, p.OnePagerRel)
	}
	return out
}

func (s *Server) projectsConfigured(w http.ResponseWriter) bool {
	if s.ProjectsDir == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "projects not configured"})
		return false
	}
	return true
}

func (s *Server) onePagerAbs(rel string) (string, error) {
	if s.ProjectsDir == "" {
		return "", fmt.Errorf("projects not configured")
	}
	rel = filepath.Clean("/" + rel)
	rel = strings.TrimPrefix(rel, "/")
	if rel == "" || strings.Contains(rel, "..") {
		return "", fmt.Errorf("invalid one_pager path")
	}
	abs := filepath.Join(s.ProjectsDir, rel)
	// Ensure under ProjectsDir
	base := filepath.Clean(s.ProjectsDir) + string(filepath.Separator)
	if abs != filepath.Clean(s.ProjectsDir) && !strings.HasPrefix(abs, base) {
		return "", fmt.Errorf("path escapes projects dir")
	}
	return abs, nil
}

func (s *Server) handleListProjects(w http.ResponseWriter, r *http.Request) {
	if !s.projectsConfigured(w) {
		return
	}
	q := r.URL.Query()
	opt := store.ListProjectsOpts{Status: q.Get("status")}
	if opt.Status == "" {
		opt.Status = store.ProjectActive
	}
	if opt.Status == "all" {
		opt.Status = ""
	}
	if lim := q.Get("limit"); lim != "" {
		if n, err := strconv.Atoi(lim); err == nil && n > 0 {
			opt.Limit = n
		}
	}
	list, err := s.Store.ListProjects(r.Context(), opt)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if list == nil {
		list = []store.Project{}
	}
	out := make([]projectJSON, 0, len(list))
	for _, p := range list {
		out = append(out, s.projectToJSON(p))
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleCreateProject(w http.ResponseWriter, r *http.Request) {
	if !s.projectsConfigured(w) {
		return
	}
	var body struct {
		Name  string   `json:"name"`
		Mode  string   `json:"mode"`
		Roots []string `json:"roots"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	name := strings.TrimSpace(body.Name)
	mode := strings.TrimSpace(body.Mode)
	if mode == "" {
		mode = store.ProjectModeShip
	}
	if !store.ValidProjectMode(mode) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid mode"})
		return
	}
	// Default name from first root basename.
	roots := make([]string, 0, len(body.Roots))
	for _, root := range body.Roots {
		root = strings.TrimSpace(root)
		if root == "" {
			continue
		}
		if abs, err := filepath.Abs(root); err == nil {
			root = abs
		}
		roots = append(roots, root)
	}
	if name == "" && len(roots) > 0 {
		name = filepath.Base(roots[0])
	}
	if name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "name or roots required"})
		return
	}

	id := ulid.Make().String()
	rel := filepath.Join(id, "ONE_PAGER.md")
	abs, err := s.onePagerAbs(rel)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o700); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	md := store.DefaultOnePagerMarkdown(name, mode)
	if err := os.WriteFile(abs, []byte(md), 0o600); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	now := time.Now().UnixMilli()
	p := store.Project{
		ID:           id,
		Name:         name,
		Mode:         mode,
		Status:       store.ProjectActive,
		OnePagerRel:  rel,
		CreatedAt:    now,
		UpdatedAt:    now,
		LastActiveAt: now,
	}
	if err := s.Store.InsertProject(r.Context(), p, roots); err != nil {
		_ = os.Remove(abs)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	got, err := s.Store.GetProject(r.Context(), id)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, s.projectToJSON(got))
}

// handleEnsureProject finds or creates a project for a working directory (lazy materialize).
// Body: { "path": "/abs/cwd", "name"?: "...", "mode"?: "ship|learn|..." }
func (s *Server) handleEnsureProject(w http.ResponseWriter, r *http.Request) {
	if !s.projectsConfigured(w) {
		return
	}
	var body struct {
		Path string `json:"path"`
		Name string `json:"name"`
		Mode string `json:"mode"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	path := strings.TrimSpace(body.Path)
	if path == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path required"})
		return
	}
	if abs, err := filepath.Abs(path); err == nil {
		path = abs
	}
	// Prefer existing by exact root match.
	if p, err := s.Store.FindProjectByRoot(r.Context(), path); err == nil {
		writeJSON(w, http.StatusOK, s.projectToJSON(p))
		return
	} else if !errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	name := strings.TrimSpace(body.Name)
	if name == "" {
		name = filepath.Base(path)
	}
	mode := strings.TrimSpace(body.Mode)
	if mode == "" {
		mode = store.ProjectModeShip
	}
	if !store.ValidProjectMode(mode) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid mode"})
		return
	}

	id := ulid.Make().String()
	rel := filepath.Join(id, "ONE_PAGER.md")
	abs, err := s.onePagerAbs(rel)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o700); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	md := store.DefaultOnePagerMarkdown(name, mode)
	if err := os.WriteFile(abs, []byte(md), 0o600); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	now := time.Now().UnixMilli()
	proj := store.Project{
		ID:           id,
		Name:         name,
		Mode:         mode,
		Status:       store.ProjectActive,
		OnePagerRel:  rel,
		CreatedAt:    now,
		UpdatedAt:    now,
		LastActiveAt: now,
	}
	if err := s.Store.InsertProject(r.Context(), proj, []string{path}); err != nil {
		_ = os.Remove(abs)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	// Best-effort: attach existing tasks with this cwd that have no project yet.
	_ = s.Store.AttachTasksByCwd(r.Context(), id, path)

	got, err := s.Store.GetProject(r.Context(), id)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, s.projectToJSON(got))
}

func (s *Server) handleGetProject(w http.ResponseWriter, r *http.Request) {
	if !s.projectsConfigured(w) {
		return
	}
	id := chi.URLParam(r, "id")
	p, err := s.Store.GetProject(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, s.projectToJSON(p))
}

func (s *Server) handlePatchProject(w http.ResponseWriter, r *http.Request) {
	if !s.projectsConfigured(w) {
		return
	}
	id := chi.URLParam(r, "id")
	var body struct {
		Name         *string  `json:"name"`
		Mode         *string  `json:"mode"`
		Status       *string  `json:"status"`
		SoftProgress *string  `json:"soft_progress"`
		Roots        []string `json:"roots"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	patch := store.ProjectPatch{
		Name:         body.Name,
		Mode:         body.Mode,
		Status:       body.Status,
		SoftProgress: body.SoftProgress,
	}
	p, err := s.Store.UpdateProject(r.Context(), id, patch)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if body.Roots != nil {
		roots := make([]string, 0, len(body.Roots))
		for _, root := range body.Roots {
			root = strings.TrimSpace(root)
			if root == "" {
				continue
			}
			if abs, err := filepath.Abs(root); err == nil {
				root = abs
			}
			roots = append(roots, root)
		}
		if err := s.Store.SetProjectRoots(r.Context(), id, roots); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		p, err = s.Store.GetProject(r.Context(), id)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
	}
	writeJSON(w, http.StatusOK, s.projectToJSON(p))
}

func (s *Server) handleGetOnePager(w http.ResponseWriter, r *http.Request) {
	if !s.projectsConfigured(w) {
		return
	}
	id := chi.URLParam(r, "id")
	p, err := s.Store.GetProject(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	abs, err := s.onePagerAbs(p.OnePagerRel)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		if os.IsNotExist(err) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "one-pager file missing"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	// File mtime as optimistic concurrency token (ms).
	var updatedAt int64 = p.UpdatedAt
	if st, err := os.Stat(abs); err == nil {
		updatedAt = st.ModTime().UnixMilli()
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"project_id": id,
		"markdown":   string(data),
		"updated_at": updatedAt,
	})
}

func (s *Server) handlePutOnePager(w http.ResponseWriter, r *http.Request) {
	if !s.projectsConfigured(w) {
		return
	}
	id := chi.URLParam(r, "id")
	var body struct {
		Markdown  string `json:"markdown"`
		UpdatedAt *int64 `json:"updated_at"` // optimistic lock; optional
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if len(body.Markdown) > maxOnePagerBytes {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "one-pager too large"})
		return
	}
	p, err := s.Store.GetProject(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	abs, err := s.onePagerAbs(p.OnePagerRel)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if body.UpdatedAt != nil {
		if st, err := os.Stat(abs); err == nil {
			cur := st.ModTime().UnixMilli()
			if *body.UpdatedAt != cur {
				writeJSON(w, http.StatusConflict, map[string]any{
					"error":      "one-pager was modified",
					"updated_at": cur,
				})
				return
			}
		}
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o700); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if err := os.WriteFile(abs, []byte(body.Markdown), 0o600); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	// Bump project updated_at
	if _, err := s.Store.UpdateProject(r.Context(), id, store.ProjectPatch{}); err != nil {
		// non-fatal for file write success
	}
	st, _ := os.Stat(abs)
	var updatedAt int64
	if st != nil {
		updatedAt = st.ModTime().UnixMilli()
	} else {
		updatedAt = time.Now().UnixMilli()
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"project_id": id,
		"markdown":   body.Markdown,
		"updated_at": updatedAt,
	})
}

func (s *Server) handleListProjectTasks(w http.ResponseWriter, r *http.Request) {
	if !s.projectsConfigured(w) {
		return
	}
	id := chi.URLParam(r, "id")
	p, err := s.Store.GetProject(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	} else if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	limit := 50
	if lim := r.URL.Query().Get("limit"); lim != "" {
		if n, err := strconv.Atoi(lim); err == nil && n > 0 {
			limit = n
		}
	}
	// Linked by project_id, plus same-cwd tasks (sidebar project == cwd group).
	list, err := s.Store.ListTasksForProject(r.Context(), id, p.Roots, limit)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if list == nil {
		list = []store.Task{}
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) handleListProjectArtifacts(w http.ResponseWriter, r *http.Request) {
	if !s.projectsConfigured(w) {
		return
	}
	id := chi.URLParam(r, "id")
	if _, err := s.Store.GetProject(r.Context(), id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	q := r.URL.Query()
	limit := 50
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}
	list, err := s.Store.ListArtifacts(r.Context(), store.ListArtifactsOpts{
		ProjectID: id,
		Status:    q.Get("status"),
		Limit:     limit,
	})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if list == nil {
		list = []store.Artifact{}
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) handleFindProjectByRoot(w http.ResponseWriter, r *http.Request) {
	if !s.projectsConfigured(w) {
		return
	}
	path := strings.TrimSpace(r.URL.Query().Get("path"))
	if path == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path required"})
		return
	}
	if abs, err := filepath.Abs(path); err == nil {
		path = abs
	}
	p, err := s.Store.FindProjectByRoot(r.Context(), path)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, s.projectToJSON(p))
}

func (s *Server) handleContinueProject(w http.ResponseWriter, r *http.Request) {
	if !s.projectsConfigured(w) {
		return
	}
	if s.Engine == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "engine not configured"})
		return
	}
	id := chi.URLParam(r, "id")
	p, err := s.Store.GetProject(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	var body struct {
		Prompt         string                  `json:"prompt"`
		Agent          string                  `json:"agent"`
		Model          *string                 `json:"model"`
		Title          *string                 `json:"title"`
		PermissionMode string                  `json:"permission_mode"`
		WorkspaceMode  workspace.RequestedMode `json:"workspace_mode"`
		Cwd            string                  `json:"cwd"`
	}
	if r.Body != nil && r.ContentLength != 0 {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
			return
		}
	}

	abs, err := s.onePagerAbs(p.OnePagerRel)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	mdBytes, err := os.ReadFile(abs)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "read one-pager: " + err.Error()})
		return
	}
	prompt := store.BuildContinuePrompt(p.Name, p.Mode, string(mdBytes), body.Prompt)

	cwd := strings.TrimSpace(body.Cwd)
	if cwd == "" && len(p.Roots) > 0 {
		cwd = p.Roots[0]
	}
	if cwd == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "cwd required (set project root or pass cwd)"})
		return
	}

	title := body.Title
	if title == nil {
		t := fmt.Sprintf("Continue: %s", p.Name)
		title = &t
	}

	req := task.CreateRequest{
		Agent:          body.Agent,
		Cwd:            cwd,
		Prompt:         prompt,
		Model:          body.Model,
		Title:          title,
		PermissionMode: body.PermissionMode,
		WorkspaceMode:  body.WorkspaceMode,
		ProjectID:      p.ID,
	}
	t, err := s.Engine.Create(r.Context(), req)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	_ = s.Store.TouchProjectActivity(r.Context(), p.ID)
	writeJSON(w, http.StatusCreated, t)
}
