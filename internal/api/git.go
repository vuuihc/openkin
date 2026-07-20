package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/vuuihc/kin/internal/workspace"
)

type gitBranchesResponse = workspace.BranchStatus

type gitCheckoutRequest struct {
	Cwd    string `json:"cwd"`
	Branch string `json:"branch"`
}

type gitCheckoutResponse struct {
	Cwd     string `json:"cwd"`
	Current string `json:"current"`
}

func (s *Server) handleGitBranches(w http.ResponseWriter, r *http.Request) {
	if s.Workspace == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "workspace unavailable"})
		return
	}
	cwd := strings.TrimSpace(r.URL.Query().Get("cwd"))
	if cwd == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "cwd is required"})
		return
	}
	status, err := s.Workspace.ListBranches(r.Context(), cwd)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, status)
}

func (s *Server) handleGitCheckout(w http.ResponseWriter, r *http.Request) {
	if s.Workspace == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "workspace unavailable"})
		return
	}
	var req gitCheckoutRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	req.Cwd = strings.TrimSpace(req.Cwd)
	req.Branch = strings.TrimSpace(req.Branch)
	if req.Cwd == "" || req.Branch == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "cwd and branch are required"})
		return
	}
	if err := s.Workspace.CheckoutBranch(r.Context(), req.Cwd, req.Branch); err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, workspace.ErrDirtySource) {
			status = http.StatusConflict
		} else if errors.Is(err, workspace.ErrGitUnavailable) {
			status = http.StatusServiceUnavailable
		} else if errors.Is(err, workspace.ErrNotGit) {
			status = http.StatusBadRequest
		}
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	// Re-read current branch after switch.
	status, err := s.Workspace.ListBranches(r.Context(), req.Cwd)
	if err != nil {
		writeJSON(w, http.StatusOK, gitCheckoutResponse{Cwd: req.Cwd, Current: req.Branch})
		return
	}
	current := status.Current
	if current == "" {
		current = req.Branch
	}
	writeJSON(w, http.StatusOK, gitCheckoutResponse{Cwd: status.Cwd, Current: current})
}
