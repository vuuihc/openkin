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

	"github.com/vuuihc/kin/internal/store"
)

// maxArtifactBytes caps a single artifact body (study primers can be large).
const maxArtifactBytes = 5 << 20 // 5 MiB

// artifactExtension maps kind -> file extension. rel_path is always server-generated.
var artifactExtension = map[string]string{
	store.ArtifactKindMarkdown: ".md",
	store.ArtifactKindHTML:     ".html",
	store.ArtifactKindText:     ".txt",
}

// artifactRelPath builds the on-disk relative path for an artifact id+kind.
// Used by handlers and tests; never accept client-supplied paths.
func artifactRelPath(id, kind string) string {
	ext := artifactExtension[kind]
	if ext == "" {
		ext = ".txt"
	}
	now := time.Now().UTC()
	return filepath.Join(now.Format("2006"), now.Format("01"), id+ext)
}

// handleListArtifacts returns artifacts, optionally filtered by status.
func (s *Server) handleListArtifacts(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	opt := store.ListArtifactsOpts{Status: q.Get("status")}
	if lim := q.Get("limit"); lim != "" {
		if n, err := strconv.Atoi(lim); err == nil && n > 0 {
			opt.Limit = n
		}
	}
	list, err := s.Store.ListArtifacts(r.Context(), opt)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if list == nil {
		list = []store.Artifact{}
	}
	writeJSON(w, http.StatusOK, list)
}

// handleCreateArtifact stores the artifact body on disk and inserts metadata.
// Security: rel_path is server-generated only; stored HTML must never be served
// as text/html from this host (see handleGetArtifactContent).
func (s *Server) handleCreateArtifact(w http.ResponseWriter, r *http.Request) {
	if s.ArtifactsDir == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "artifacts not configured"})
		return
	}

	var body struct {
		Title        string `json:"title"`
		Kind         string `json:"kind"`
		Content      string `json:"content"`
		SourceTaskID string `json:"source_task_id,omitempty"`
		Status       string `json:"status,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if _, ok := artifactExtension[body.Kind]; !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid kind"})
		return
	}
	if strings.TrimSpace(body.Title) == "" {
		body.Title = "Untitled"
	}
	if len(body.Content) > maxArtifactBytes {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{
			"error": fmt.Sprintf("file too large (max %d MiB)", maxArtifactBytes>>20),
		})
		return
	}

	id, err := randomID()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "generate id: " + err.Error()})
		return
	}
	relPath := artifactRelPath(id, body.Kind)
	fullPath := filepath.Join(s.ArtifactsDir, relPath)
	if !pathWithinRoot(s.ArtifactsDir, fullPath) {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "path containment check failed"})
		return
	}
	if err := os.MkdirAll(filepath.Dir(fullPath), 0o700); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "create artifacts dir: " + err.Error()})
		return
	}
	if err := os.WriteFile(fullPath, []byte(body.Content), 0o600); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "write artifact: " + err.Error()})
		return
	}

	var sourceTaskIDPtr *string
	if body.SourceTaskID != "" {
		sourceTaskIDPtr = &body.SourceTaskID
	}
	artifact := store.Artifact{
		ID:           id,
		Title:        body.Title,
		Kind:         body.Kind,
		RelPath:      relPath,
		Size:         int64(len(body.Content)),
		Status:       body.Status,
		SourceTaskID: sourceTaskIDPtr,
	}
	if err := s.Store.InsertArtifact(r.Context(), artifact); err != nil {
		_ = os.Remove(fullPath)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "db insert: " + err.Error()})
		return
	}
	// Re-read so defaults (status, timestamps) match store.
	created, err := s.Store.GetArtifact(r.Context(), id)
	if err != nil {
		writeJSON(w, http.StatusCreated, artifact)
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

// handleGetArtifact returns artifact metadata (no body).
func (s *Server) handleGetArtifact(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	artifact, err := s.Store.GetArtifact(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, artifact)
}

// handleGetArtifactContent returns the raw body as text/plain.
// Never serve stored HTML as text/html — the reader sandboxes it client-side.
func (s *Server) handleGetArtifactContent(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	artifact, err := s.Store.GetArtifact(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if s.ArtifactsDir == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "artifacts not configured"})
		return
	}
	fullPath := filepath.Join(s.ArtifactsDir, artifact.RelPath)
	if !pathWithinRoot(s.ArtifactsDir, fullPath) {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "path containment check failed"})
		return
	}
	data, err := os.ReadFile(fullPath)
	if err != nil {
		if os.IsNotExist(err) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "file missing"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// handleSetArtifactStatus updates status (proposed | saved | archived).
// Archiving does not delete the file in P0.
func (s *Server) handleSetArtifactStatus(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body struct {
		Status string `json:"status"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	switch body.Status {
	case store.ArtifactProposed, store.ArtifactSaved, store.ArtifactArchived:
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid status"})
		return
	}
	artifact, err := s.Store.UpdateArtifactStatus(r.Context(), id, body.Status)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, artifact)
}
