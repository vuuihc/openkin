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
	"github.com/vuuihc/kin/internal/store"
	"github.com/vuuihc/kin/internal/task"
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
