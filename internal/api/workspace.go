package api

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/vuuihc/kin/internal/store"
)

const (
	workspaceListLimit     = 500
	workspaceReadSoftLimit = 512 * 1024
	workspaceReadHardLimit = 1024 * 1024
	workspaceBinaryProbe   = 8 * 1024
)

type workspaceListEntry struct {
	Name string `json:"name"`
	Path string `json:"path"`
	Type string `json:"type"`
	Size int64  `json:"size,omitempty"`
}

type workspaceListResponse struct {
	Root      string               `json:"root"`
	Path      string               `json:"path"`
	Entries   []workspaceListEntry `json:"entries"`
	Truncated bool                 `json:"truncated,omitempty"`
}

type workspaceFileResponse struct {
	Root      string `json:"root"`
	Path      string `json:"path"`
	Size      int64  `json:"size"`
	Truncated bool   `json:"truncated"`
	Content   string `json:"content"`
}

type workspaceEnv struct {
	Root string
}

type workspaceResolvedPath struct {
	Abs string
	Rel string
}

func newWorkspaceEnv(cwd string) (*workspaceEnv, error) {
	if strings.TrimSpace(cwd) == "" {
		return nil, errors.New("task cwd is empty")
	}
	abs, err := filepath.Abs(cwd)
	if err != nil {
		return nil, err
	}
	root, err := filepath.EvalSymlinks(abs)
	if err != nil {
		root = abs
	}
	fi, err := os.Stat(root)
	if err != nil {
		return nil, fmt.Errorf("cwd %q: %w", root, err)
	}
	if !fi.IsDir() {
		return nil, fmt.Errorf("cwd %q is not a directory", root)
	}
	return &workspaceEnv{Root: root}, nil
}

func (e *workspaceEnv) resolvePath(p string) (workspaceResolvedPath, error) {
	p = strings.TrimSpace(p)
	if p == "" {
		p = "."
	}
	p = filepath.FromSlash(p)

	var candidate string
	if filepath.IsAbs(p) {
		candidate = filepath.Clean(p)
	} else {
		candidate = filepath.Clean(filepath.Join(e.Root, p))
	}
	if !pathWithinRoot(e.Root, candidate) {
		return workspaceResolvedPath{}, fmt.Errorf("path %q escapes workspace %q", p, e.Root)
	}

	abs := candidate
	if real, err := filepath.EvalSymlinks(candidate); err == nil {
		abs = real
	}
	if !pathWithinRoot(e.Root, abs) {
		return workspaceResolvedPath{}, fmt.Errorf("path %q escapes workspace %q", p, e.Root)
	}

	rel, err := filepath.Rel(e.Root, candidate)
	if err != nil {
		return workspaceResolvedPath{}, err
	}
	if rel == "." {
		return workspaceResolvedPath{Abs: abs, Rel: "."}, nil
	}
	if strings.HasPrefix(rel, ".."+string(os.PathSeparator)) || rel == ".." {
		return workspaceResolvedPath{}, fmt.Errorf("path %q escapes workspace %q", p, e.Root)
	}
	return workspaceResolvedPath{Abs: abs, Rel: filepath.ToSlash(rel)}, nil
}

func pathWithinRoot(root, target string) bool {
	root = filepath.Clean(root)
	target = filepath.Clean(target)
	if root == target {
		return true
	}
	sep := string(os.PathSeparator)
	return strings.HasPrefix(target, root+sep)
}

func (s *Server) workspaceEnvForTask(r *http.Request) (*workspaceEnv, error) {
	id := chi.URLParam(r, "id")
	t, err := s.Engine.Get(r.Context(), id)
	if err != nil {
		return nil, err
	}
	return newWorkspaceEnv(t.Cwd)
}

func (s *Server) handleListTaskWorkspace(w http.ResponseWriter, r *http.Request) {
	env, err := s.workspaceEnvForTask(r)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	resolved, err := env.resolvePath(r.URL.Query().Get("path"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	fi, err := os.Stat(resolved.Abs)
	if errors.Is(err, fs.ErrNotExist) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if !fi.IsDir() {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path is not a directory"})
		return
	}

	dirEntries, err := os.ReadDir(resolved.Abs)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	resp := workspaceListResponse{
		Root:    env.Root,
		Path:    resolved.Rel,
		Entries: make([]workspaceListEntry, 0, minInt(len(dirEntries), workspaceListLimit)),
	}
	for _, entry := range dirEntries {
		childRel := entry.Name()
		if resolved.Rel != "." {
			childRel = path.Join(resolved.Rel, childRel)
		}
		child, err := env.resolvePath(childRel)
		if err != nil {
			continue
		}
		info, err := os.Stat(child.Abs)
		if err != nil {
			if errors.Is(err, fs.ErrPermission) || errors.Is(err, fs.ErrNotExist) {
				continue
			}
			continue
		}

		item := workspaceListEntry{
			Name: entry.Name(),
			Path: child.Rel,
		}
		switch {
		case info.IsDir():
			item.Type = "dir"
		case info.Mode().IsRegular():
			item.Type = "file"
			item.Size = info.Size()
		default:
			continue
		}

		if len(resp.Entries) >= workspaceListLimit {
			resp.Truncated = true
			continue
		}
		resp.Entries = append(resp.Entries, item)
	}

	sort.Slice(resp.Entries, func(i, j int) bool {
		a, b := resp.Entries[i], resp.Entries[j]
		if a.Type != b.Type {
			return a.Type == "dir"
		}
		an, bn := strings.ToLower(a.Name), strings.ToLower(b.Name)
		if an != bn {
			return an < bn
		}
		return a.Name < b.Name
	})

	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) handleReadTaskWorkspaceFile(w http.ResponseWriter, r *http.Request) {
	reqPath := strings.TrimSpace(r.URL.Query().Get("path"))
	if reqPath == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path is required"})
		return
	}

	env, err := s.workspaceEnvForTask(r)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	resolved, err := env.resolvePath(reqPath)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	fi, err := os.Stat(resolved.Abs)
	if errors.Is(err, fs.ErrNotExist) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if fi.IsDir() {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path is a directory"})
		return
	}
	if fi.Size() > workspaceReadHardLimit {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{
			"error": fmt.Sprintf("file too large (max %d bytes)", workspaceReadHardLimit),
		})
		return
	}

	data, err := os.ReadFile(resolved.Abs)
	if errors.Is(err, fs.ErrNotExist) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	if hasBinaryContent(data) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "binary file"})
		return
	}
	if !utf8.Valid(data) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "file is not valid UTF-8"})
		return
	}

	truncated := false
	if len(data) > workspaceReadSoftLimit {
		data = trimValidUTF8(data[:workspaceReadSoftLimit])
		truncated = true
	}

	writeJSON(w, http.StatusOK, workspaceFileResponse{
		Root:      env.Root,
		Path:      resolved.Rel,
		Size:      fi.Size(),
		Truncated: truncated,
		Content:   string(data),
	})
}

func hasBinaryContent(data []byte) bool {
	probe := data
	if len(probe) > workspaceBinaryProbe {
		probe = probe[:workspaceBinaryProbe]
	}
	return bytes.IndexByte(probe, 0) >= 0
}

func trimValidUTF8(data []byte) []byte {
	for len(data) > 0 && !utf8.Valid(data) {
		data = data[:len(data)-1]
	}
	return data
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
