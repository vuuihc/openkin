package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/vuuihc/openkin/internal/github"
	"github.com/vuuihc/openkin/internal/remote/worker"
)

// Publishing a session's work, from the console.
//
// This is the only route in the API that puts something on a forge, and it is
// deliberately narrow: the Hub asks the machine that holds the checkout, and that
// machine decides. Everything that makes it safe is on that side — the boundary,
// the default branch, the uncommitted work, the push that is never forced — and
// this side does three things: say which directory is meant, carry the words, and
// write down what came back.
//
// It is not a read, and it is not part of one: nothing here happens because a
// panel was opened. A person taps 发布, and this is what that tap does.
//
// The route is holder-only. Whether a paired phone may spend this machine's
// GitHub *reads* is one question (see githubQueryOnly); whether it may push a
// branch is another, and the answer is the one pairing already gives — the phone
// is a full client of the machine it is paired with, and writing in a checkout
// under that machine's roots is bounded by those roots.

// publishPRRequest is the sheet's two boxes, as the person left them.
type publishPRRequest struct {
	Title string `json:"title"`
	Body  string `json:"body"`
}

func (s *Server) handlePublishTaskPR(w http.ResponseWriter, r *http.Request) {
	if s.GitHub == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "github unavailable"})
		return
	}
	t, ok := s.sourceTask(w, r)
	if !ok {
		return
	}
	var req publishPRRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// The words are checked by the same code the machine checks them with, so a
	// title that could not travel is refused here, where the person can still edit
	// it, rather than after a round trip that already pushed a branch.
	req.Title = strings.TrimSpace(req.Title)
	if err := worker.ValidatePRWords(req.Title, req.Body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	// A task whose checkout is here is refused rather than served: pushing the
	// operator's own directory from a phone is a different decision from pushing
	// one on a machine the phone cannot otherwise reach. See ErrPublishNotHere.
	if s.Engine == nil || !s.Engine.RunsElsewhere(t) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": github.ErrPublishNotHere.Error()})
		return
	}
	// The machine resolves this path against its own roots, and the same
	// resolution the reads use decides which directory that is. A workspace this
	// machine cannot place is a 409 with the reason, not a guess.
	dir, ok := s.remoteWorkspacePath(w, r, t)
	if !ok {
		return
	}

	var answer worker.PRPublishResult
	if !s.askDeviceResult(w, r.Context(), t.ExecutingDeviceID, worker.QueryPRPublish,
		worker.PRPublishParams{Path: dir, Title: req.Title, Body: req.Body}, &answer) {
		return
	}
	report, err := s.GitHub.RecordPublish(r.Context(), t.ID, req.Title, answer)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, report)
}
