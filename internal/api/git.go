package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/vuuihc/openkin/internal/remote"
	"github.com/vuuihc/openkin/internal/remote/worker"
	"github.com/vuuihc/openkin/internal/workspace"
)

type gitBranchesResponse = workspace.BranchStatus

type gitCheckoutRequest struct {
	Cwd    string `json:"cwd"`
	Branch string `json:"branch"`
	// Device names the machine whose checkout moves. Empty or "self" is this
	// daemon; anything else is a machine a phone is rearranging.
	Device string `json:"device,omitempty"`
}

type gitCheckoutResponse struct {
	Cwd     string `json:"cwd"`
	Current string `json:"current"`
}

func (s *Server) handleGitBranches(w http.ResponseWriter, r *http.Request) {
	cwd := strings.TrimSpace(r.URL.Query().Get("cwd"))
	if cwd == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "cwd is required"})
		return
	}
	device := strings.TrimSpace(r.URL.Query().Get("device"))
	if !s.localDevice(device) {
		// Another machine's directory: this daemon cannot stat it, cannot read
		// its refs, and must not answer from its own copy at the same address.
		// The two are usually checkouts of the same repository, which is exactly
		// why the wrong answer would go unnoticed.
		params := worker.GitBranchesParams{Path: cwd}
		if err := params.Validate(); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		s.askDeviceInto(w, r, device, worker.QueryGitBranches, params, &worker.GitBranchesResult{})
		return
	}
	if s.Workspace == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "workspace unavailable"})
		return
	}
	status, err := s.Workspace.ListBranches(r.Context(), cwd)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, status)
}

// handleGitCheckout switches one machine's checkout to a branch.
//
// The route is holder-only while this handler still refuses most holders,
// because the rule is not one rule. Switching a branch on *another* machine is
// what pairing a phone is for: it is bounded by that machine's own roots, which
// is the boundary pairing exists to grant and the same boundary a dispatched
// turn runs inside. Switching a branch on *this* machine rearranges the
// operator's own checkouts — the ones their sessions are running in — and stays
// theirs to do, which is the rule operatorOnly enforces on the routes that
// administer a daemon.
//
// So the gate moved into the handler rather than staying on the route: a route
// guard runs before the body is read, and which machine this is only becomes
// known by reading it. The refusal below is operatorOnly's own sentence.
func (s *Server) handleGitCheckout(w http.ResponseWriter, r *http.Request) {
	var req gitCheckoutRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	req.Cwd = strings.TrimSpace(req.Cwd)
	req.Branch = strings.TrimSpace(req.Branch)
	req.Device = strings.TrimSpace(req.Device)
	if req.Cwd == "" || req.Branch == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "cwd and branch are required"})
		return
	}
	if !s.localDevice(req.Device) {
		// The machine checks its own roots; this side checks only what would
		// become an argument to its git.
		params := worker.GitCheckoutParams{Path: req.Cwd, Branch: req.Branch}
		if err := params.Validate(); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		s.askDeviceInto(w, r, req.Device, worker.QueryGitCheckout, params, &worker.GitCheckoutResult{})
		return
	}
	principal, _ := remote.PrincipalFromContext(r.Context())
	if !isOperator(principal) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "operator access required"})
		return
	}
	if s.Workspace == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "workspace unavailable"})
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
