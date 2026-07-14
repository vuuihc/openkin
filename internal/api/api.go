package api

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/vuuihc/kin/internal/remote"
	"github.com/vuuihc/kin/internal/store"
)

// Server holds HTTP handlers and dependencies for the Kin API.
type Server struct {
	Store   *store.Store
	Auth    *remote.Auth
	Version string
	// Static is the embedded (or on-disk) UI filesystem. May be nil in tests.
	Static http.Handler
}

// Handler returns the root chi router.
func (s *Server) Handler() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)

	r.Get("/api/health", s.handleHealth)
	r.Get("/api/version", s.handleVersion)

	r.Group(func(r chi.Router) {
		r.Use(s.Auth.Middleware)
		r.Get("/api/tasks", s.handleListTasks)
	})

	if s.Static != nil {
		r.Handle("/*", s.Static)
	}

	return r
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleVersion(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"version": s.Version})
}

func (s *Server) handleListTasks(w http.ResponseWriter, r *http.Request) {
	tasks, err := s.Store.ListTasks(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if tasks == nil {
		tasks = []store.Task{}
	}
	writeJSON(w, http.StatusOK, tasks)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
