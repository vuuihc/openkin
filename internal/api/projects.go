package api

import (
	"context"
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

	"github.com/vuuihc/kin/internal/projectpulse"
	"github.com/vuuihc/kin/internal/provider"
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
		"project_id":        id,
		"markdown":          string(data),
		"updated_at":        updatedAt,
		"one_pager_summary": store.ParseOnePagerSummary(string(data), p.Name, p.Mode),
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
	out := map[string]any{
		"project": s.projectToJSON(p),
	}
	// Always include structured summary; failures degrade to empty, not 5xx.
	if abs, err := s.onePagerAbs(p.OnePagerRel); err == nil {
		if data, err := os.ReadFile(abs); err == nil {
			var updatedAt int64
			if st, err := os.Stat(abs); err == nil {
				updatedAt = st.ModTime().UnixMilli()
			}
			sum := store.ParseOnePagerSummary(string(data), p.Name, p.Mode)
			out["one_pager_summary"] = sum
			out["one_pager_updated_at"] = updatedAt
		} else {
			out["one_pager_summary"] = store.OnePagerSummary{Name: p.Name, Mode: p.Mode, Empty: true}
		}
	} else {
		out["one_pager_summary"] = store.OnePagerSummary{Name: p.Name, Mode: p.Mode, Empty: true}
	}
	// Back-compat: flatten project fields at top level for older clients.
	pj := s.projectToJSON(p)
	out["id"] = pj.ID
	out["name"] = pj.Name
	out["mode"] = pj.Mode
	out["status"] = pj.Status
	out["soft_progress"] = pj.SoftProgress
	out["created_at"] = pj.CreatedAt
	out["updated_at"] = pj.UpdatedAt
	out["last_active_at"] = pj.LastActiveAt
	out["roots"] = pj.Roots
	out["one_pager_path"] = pj.OnePagerPath
	writeJSON(w, http.StatusOK, out)
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
	userPrompt := strings.TrimSpace(body.Prompt)
	prompt := store.BuildContinuePrompt(p.Name, p.Mode, string(mdBytes), userPrompt)

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
		UserPrompt:     userPrompt,
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

func (s *Server) handleGetProjectPulse(w http.ResponseWriter, r *http.Request) {
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
	window := 90
	if v := r.URL.Query().Get("window_days"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			window = n
		}
	}
	pulse, err := projectpulse.Build(r.Context(), s.Store, p, window)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, pulse)
}

// handleRefreshProjectPulse rebuilds pulse and merges the managed auto section into ONE_PAGER.md.
// User-owned sections outside kin:auto markers are preserved.
func (s *Server) handleRefreshProjectPulse(w http.ResponseWriter, r *http.Request) {
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
	window := 90
	var body struct {
		WindowDays int   `json:"window_days"`
		Write      *bool `json:"write"` // default true
	}
	if r.Body != nil && r.ContentLength != 0 {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
			return
		}
	}
	if body.WindowDays > 0 {
		window = body.WindowDays
	}
	writeFile := true
	if body.Write != nil {
		writeFile = *body.Write
	}

	pulse, err := projectpulse.Build(r.Context(), s.Store, p, window)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	abs, err := s.onePagerAbs(p.OnePagerRel)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	cur, err := os.ReadFile(abs)
	if err != nil && !os.IsNotExist(err) {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	md := string(cur)
	if md == "" {
		md = store.DefaultOnePagerMarkdown(p.Name, p.Mode)
	}
	merged := projectpulse.MergeAutoSection(md, pulse.AutoMarkdown)
	if writeFile {
		if err := os.MkdirAll(filepath.Dir(abs), 0o700); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		if err := os.WriteFile(abs, []byte(merged), 0o600); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		_, _ = s.Store.UpdateProject(r.Context(), id, store.ProjectPatch{TouchLastActive: true})
	}
	var updatedAt int64
	if st, err := os.Stat(abs); err == nil {
		updatedAt = st.ModTime().UnixMilli()
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"pulse":      pulse,
		"markdown":   merged,
		"updated_at": updatedAt,
		"written":    writeFile,
	})
}

// handleSummarizeProject uses the cognition provider to draft user-owned cover
// sections as a proposal. Never silent-writes North Star without client accept.
// Body: { "apply"?: bool } — when apply=true, merges proposal into markdown after
// refreshing the auto pulse block. Default apply=false returns proposal only.
func (s *Server) handleSummarizeProject(w http.ResponseWriter, r *http.Request) {
	if !s.projectsConfigured(w) {
		return
	}
	if s.ProviderResolve == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "provider not available"})
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
		Apply      bool `json:"apply"`
		WindowDays int  `json:"window_days"`
	}
	if r.Body != nil && r.ContentLength != 0 {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
			return
		}
	}
	window := body.WindowDays
	if window <= 0 {
		window = 90
	}

	pulse, err := projectpulse.Build(r.Context(), s.Store, p, window)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	abs, err := s.onePagerAbs(p.OnePagerRel)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	cur, _ := os.ReadFile(abs)
	md := string(cur)
	if md == "" {
		md = store.DefaultOnePagerMarkdown(p.Name, p.Mode)
	}

	// Recent session titles as context (not a UI list).
	tasks, _ := s.Store.ListTasksForProject(r.Context(), p.ID, p.Roots, 12)
	var sessLines []string
	for _, tsk := range tasks {
		title := strings.TrimSpace(tsk.Title)
		if title == "" {
			title = strings.TrimSpace(tsk.Prompt)
		}
		if title == "" {
			continue
		}
		if len([]rune(title)) > 80 {
			title = string([]rune(title)[:80]) + "…"
		}
		sessLines = append(sessLines, fmt.Sprintf("- [%s] %s", tsk.Status, title))
		if len(sessLines) >= 8 {
			break
		}
	}

	cli, cfg, err := s.ProviderResolve(r.Context())
	if err != nil || cli == nil || !cfg.Configured() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "configure a cognition provider in Settings to summarize"})
		return
	}

	sys := `You help maintain a personal project cover page for a coding agent console.
Return ONLY a compact Markdown fragment with these sections (Chinese ok if user content is Chinese):
## 项目描述
## North Star
## Current Focus
## 结论
## 下一步（你写的）
## 模块笔记

Rules:
- Be concrete and short; no fluff, no KPI, no % complete.
- Prefer improving empty/placeholder text; keep strong user wording when already specific.
- Next steps: at most 3 bullets.
- Module notes: use hot paths if provided.
- Do not invent secrets or credentials.
- Do not wrap the whole answer in a code fence.`

	user := fmt.Sprintf(`Project name: %s
Mode: %s
Soft progress: %s

Pulse:
%s

Recent sessions:
%s

Current cover markdown:
-----
%s
-----

Draft improved sections now.`,
		p.Name, p.Mode, p.SoftProgress, pulse.AutoMarkdown, strings.Join(sessLines, "\n"), trimRunesLocal(md, 6000))

	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	resp, err := cli.Chat(ctx, provider.ChatRequest{
		Messages: []provider.Message{
			{Role: provider.RoleSystem, Content: sys},
			{Role: provider.RoleUser, Content: user},
		},
	})
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "summarize failed: " + err.Error()})
		return
	}
	proposal := strings.TrimSpace(resp.Content)
	if proposal == "" {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "empty summarize response"})
		return
	}

	// Always refresh auto pulse block.
	mergedAuto := projectpulse.MergeAutoSection(md, pulse.AutoMarkdown)
	outMD := mergedAuto
	if body.Apply {
		outMD = mergeCoverProposal(mergedAuto, proposal)
		if err := os.WriteFile(abs, []byte(outMD), 0o600); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		_, _ = s.Store.UpdateProject(r.Context(), id, store.ProjectPatch{TouchLastActive: true})
	}
	var updatedAt int64
	if st, err := os.Stat(abs); err == nil {
		updatedAt = st.ModTime().UnixMilli()
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"proposal":   proposal,
		"markdown":   outMD,
		"pulse":      pulse,
		"applied":    body.Apply,
		"updated_at": updatedAt,
	})
}

func trimRunesLocal(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max]) + "…"
}

// mergeCoverProposal replaces known user sections when proposal provides them;
// keeps kin:auto block intact.
func mergeCoverProposal(current, proposal string) string {
	current = strings.ReplaceAll(current, "\r\n", "\n")
	proposal = strings.ReplaceAll(proposal, "\r\n", "\n")
	// strip auto from working copy
	auto := ""
	if i := strings.Index(current, projectpulse.AutoStart); i >= 0 {
		if j := strings.Index(current, projectpulse.AutoEnd); j > i {
			auto = current[i : j+len(projectpulse.AutoEnd)]
			current = strings.TrimSpace(current[:i]) + "\n"
		}
	}
	sections := parseMDSections(current)
	propSecs := parseMDSections(proposal)
	order := []string{"项目描述", "North Star", "Current Focus", "完成定义（Demo）", "Teach-back", "仍模糊", "假设", "已否决路径", "健康与雷区", "结论", "未决问题", "下一步（你写的）", "模块笔记"}
	// title
	title := sections["#"]
	if title == "" {
		// first line heading
		for _, line := range strings.Split(current, "\n") {
			if strings.HasPrefix(line, "# ") {
				title = strings.TrimSpace(strings.TrimPrefix(line, "# "))
				break
			}
		}
	}
	var b strings.Builder
	if title != "" {
		fmt.Fprintf(&b, "# %s\n\n", title)
	}
	used := map[string]bool{}
	writeSec := func(name string) {
		body := strings.TrimSpace(propSecs[name])
		if body == "" {
			body = strings.TrimSpace(sections[name])
		}
		if body == "" && !sectionExists(sections, name) && !sectionExists(propSecs, name) {
			return
		}
		if body == "" && !sectionExists(propSecs, name) && !sectionExists(sections, name) {
			return
		}
		// include if either side has the heading conceptually
		if !sectionExists(sections, name) && !sectionExists(propSecs, name) {
			return
		}
		fmt.Fprintf(&b, "## %s\n", name)
		if body != "" {
			b.WriteString(body)
			if !strings.HasSuffix(body, "\n") {
				b.WriteByte('\n')
			}
		}
		b.WriteByte('\n')
		used[name] = true
	}
	for _, name := range order {
		if sectionExists(sections, name) || sectionExists(propSecs, name) {
			writeSec(name)
		}
	}
	// preserve unknown user sections
	for name, body := range sections {
		if name == "#" || used[name] {
			continue
		}
		if strings.HasPrefix(name, "Pulse") {
			continue
		}
		fmt.Fprintf(&b, "## %s\n%s\n\n", name, strings.TrimSpace(body))
	}
	out := strings.TrimSpace(b.String()) + "\n\n"
	if auto != "" {
		out += auto + "\n"
	} else {
		out = projectpulse.MergeAutoSection(out, "")
	}
	return out
}

func sectionExists(m map[string]string, name string) bool {
	_, ok := m[name]
	return ok
}

func parseMDSections(md string) map[string]string {
	out := map[string]string{}
	var cur string
	var buf strings.Builder
	flush := func() {
		if cur == "" {
			return
		}
		out[cur] = strings.TrimSpace(buf.String())
		buf.Reset()
	}
	for _, line := range strings.Split(md, "\n") {
		if strings.HasPrefix(line, "# ") && !strings.HasPrefix(line, "## ") {
			flush()
			cur = "#"
			buf.WriteString(strings.TrimSpace(strings.TrimPrefix(line, "# ")))
			continue
		}
		if strings.HasPrefix(line, "## ") {
			flush()
			cur = strings.TrimSpace(strings.TrimPrefix(line, "## "))
			continue
		}
		if cur != "" {
			buf.WriteString(line)
			buf.WriteByte('\n')
		}
	}
	flush()
	return out
}

// maybeInjectProjectContext prepends a bounded One-Pager digest when the task
// is (or will be) linked to a project. Never fails the create path.
func (s *Server) maybeInjectProjectContext(ctx context.Context, req *task.CreateRequest) {
	if req == nil || s.ProjectsDir == "" || s.Store == nil {
		return
	}
	// Skip if prompt already carries project context (e.g. Continue Focus).
	if strings.Contains(req.Prompt, "[Project context") {
		return
	}
	projectID := strings.TrimSpace(req.ProjectID)
	if projectID == "" {
		if id, err := s.Store.ResolveProjectIDForCwd(ctx, req.Cwd); err == nil {
			projectID = id
		}
	}
	if projectID == "" {
		return
	}
	p, err := s.Store.GetProject(ctx, projectID)
	if err != nil {
		return
	}
	req.ProjectID = p.ID
	abs, err := s.onePagerAbs(p.OnePagerRel)
	if err != nil {
		return
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return
	}
	// Rebuild prompt with digest; keep user text as the direct goal.
	if strings.TrimSpace(req.UserPrompt) == "" {
		req.UserPrompt = req.Prompt
	}
	req.Prompt = store.BuildContinuePrompt(p.Name, p.Mode, string(data), req.UserPrompt)
}
