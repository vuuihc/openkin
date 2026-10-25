package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/vuuihc/openkin/internal/node"
	"github.com/vuuihc/openkin/internal/remote/worker"
	"github.com/vuuihc/openkin/internal/store"
)

// The console on a phone picks a machine, and everything picked after that —
// the directory to work in, the repository, the branch — is on that machine,
// which the Hub cannot read. So the Hub asks the machine, over the control
// channel the machine already dialled in on, and passes the answer through.
//
// The Hub is a middleman here and nothing more: it does not reword a refusal,
// does not second-guess a listing, and does not decide which directories exist.
// The party that knows where a machine's boundary is, is the machine.

// ErrNoAnswer means a machine was asked and did not answer: the wait ran out, or
// the connection ended while the question was in flight.
//
// It is its own error because it maps to its own status: a question that was
// asked and not answered is not the same as one that was refused, and a console
// that showed a timeout as a refusal would tell a person their directory is not
// allowed when in fact nobody looked.
var errNoAnswer = errors.New("the machine did not answer")

// errNoMachineChannel means this Hub cannot ask any machine anything: it has no
// connection table, or nothing wired to keep track of the answers.
var errNoMachineChannel = errors.New("this hub cannot ask machines questions")

// errUnreadableAnswer means a machine answered and this Hub could not read what
// it said — a shape the two sides disagree about, which is a bug here rather
// than anything the caller did.
var errUnreadableAnswer = errors.New("the machine's answer could not be read")

// errMachineRefused means a machine read the question and declined it.
//
// It is its own sentinel because a refusal is not the caller's mistake, and the
// likeliest reason for one is that this Hub is newer than the machine: a
// question this side knows and that side has never heard of. Answering that
// with a bad request blames the person for a version skew — and the skew is the
// normal state of a Mac that has been updated and a NAS that has not.
var errMachineRefused = errors.New("the machine declined to answer")

// handleMachineDirs answers what directories are inside a path on one machine.
//
// {device} is a machine this Hub knows: its own id, the literal "self", or a
// paired device. The first two are this machine, answered in process by the
// same code that answers a paired machine over the wire — a Hub is a machine
// too, and a console looking at a desktop's own daemon must not take a
// different path than a console looking at it from a phone.
func (s *Server) handleMachineDirs(w http.ResponseWriter, r *http.Request) {
	params := worker.ListDirsParams{Path: r.URL.Query().Get("path")}
	if err := params.Validate(); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	s.askMachineInto(w, r, worker.QueryListDirs, params, &worker.ListDirsResult{})
}

// handleMachineRepoBranches answers what branches one repository has on one
// machine, without that machine having to clone it.
//
// The repository is named and not located, and the answer says which repository
// the machine understood that name to be: the console asks the next question —
// repo.prepare — in the words this answer used, not in the words the person
// typed.
func (s *Server) handleMachineRepoBranches(w http.ResponseWriter, r *http.Request) {
	params := worker.RepoBranchesParams{Repo: r.URL.Query().Get("repo")}
	if err := params.Validate(); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	s.askMachineInto(w, r, worker.QueryRepoBranches, params, &worker.RepoBranchesResult{})
}

// handleMachineRepoPrepare asks one machine to make a repository available on
// itself, for a console that cannot reach the repository.
//
// Where it lands is the machine's answer, not the caller's request: a Hub that
// could name the destination could write anywhere under a root, and a root is
// permission to run an agent, not permission for the Hub to write. So there is
// no path in the request and a path in the response.
func (s *Server) handleMachineRepoPrepare(w http.ResponseWriter, r *http.Request) {
	var params worker.RepoPrepareParams
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&params); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if err := params.Validate(); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	s.askMachineInto(w, r, worker.QueryRepoPrepare, params, &worker.RepoPrepareResult{})
}

// askMachineInto puts one question to one machine and decodes the answer into
// out, passing a refusal through in the machine's own words.
//
// Every question takes this path, so a refusal reads the same whichever question
// produced it: one shape for a console to handle, rather than one per endpoint.
func (s *Server) askMachineInto(w http.ResponseWriter, r *http.Request, method string, params any, out any) {
	s.askDeviceInto(w, r, chi.URLParam(r, "device"), method, params, out)
}

// askDeviceInto is askMachineInto for the questions whose device is a parameter
// rather than a path segment.
func (s *Server) askDeviceInto(w http.ResponseWriter, r *http.Request, device, method string, params any, out any) {
	if !s.askDeviceResult(w, r.Context(), device, method, params, out) {
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// askDeviceResult puts one question to one machine and decodes the answer into
// out, reporting whether there is an answer to write.
//
// It is the whole of asking a machine anything: one place where a refusal, a
// timeout, an absent machine and an answer this Hub cannot read are told apart,
// so that a question about a directory, a branch or a task's files all fail the
// same way. It writes the failure itself and returns false, because the successes
// are not one shape: a machine's own answer goes back as it stands, while an
// answer about a task is mapped into the envelope the console already reads.
func (s *Server) askDeviceResult(w http.ResponseWriter, ctx context.Context, device, method string, params any, out any) bool {
	raw, err := json.Marshal(params)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return false
	}
	result, err := s.askMachine(ctx, device, method, raw)
	if err != nil {
		writeMachineQueryError(w, err)
		return false
	}
	// A refusal is the machine's own sentence, passed through as it stands. The
	// status is 400 because the machine was asked and said no: the request named
	// something it will not do.
	if result.Error != "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": result.Error})
		return false
	}
	if err := result.Into(out); err != nil {
		// An answer that cannot be read is this Hub's bug, not the caller's.
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return false
	}
	return true
}

// hubMachines is the Hub's own paired machines, as the pull-request service
// needs them.
//
// The service drives reads that are about a machine — where a task's work sits,
// and what the machine holding it can see — and it has to do that through the
// same three steps every other route uses: is this task's machine another one,
// where is its checkout there, and ask it. Handing it the Server instead would
// give one package a second way to reach the same channel.
type hubMachines struct{ s *Server }

func (m hubMachines) RunsElsewhere(t store.Task) bool {
	return m.s.Engine != nil && m.s.Engine.RunsElsewhere(t)
}

func (m hubMachines) RemoteWorkspaceCwd(ctx context.Context, t store.Task) (string, bool, error) {
	if m.s.Engine == nil {
		return "", false, nil
	}
	return m.s.Engine.RemoteWorkspaceCwd(ctx, t)
}

func (m hubMachines) Ask(ctx context.Context, device, method string, params, out any) error {
	return m.s.askDeviceQuietly(ctx, device, method, params, out)
}

// BindGitHubMachines lets the pull-request service observe sessions that run on
// another machine, by asking the machine that holds the checkout.
//
// Called by the composition root once both are built. A server that never calls
// it — a daemon with no engine, or a test — reads every task as its own, which
// is what it is.
func (s *Server) BindGitHubMachines() {
	if s.GitHub != nil {
		s.GitHub.SetMachines(hubMachines{s})
	}
}

// askDeviceQuietly is askDeviceResult for a caller with no response to write:
// one question, one answer decoded into out, and a reason instead of a status
// code when there is none.
//
// It exists for the asks that happen as part of something else — recording
// where a new session's work sits, say — where the answer is bookkeeping rather
// than the point of the request, and a machine that is away must not turn into
// an error the person sees.
func (s *Server) askDeviceQuietly(ctx context.Context, device, method string, params any, out any) error {
	raw, err := json.Marshal(params)
	if err != nil {
		return fmt.Errorf("encode %s: %w", method, err)
	}
	result, err := s.askMachine(ctx, device, method, raw)
	if err != nil {
		return err
	}
	if result.Error != "" {
		// The machine's own sentence is kept: it is the only thing that says
		// which question it did not recognize, and a person reading it is
		// usually looking at two versions of this daemon.
		return fmt.Errorf("%w: %s", errMachineRefused, result.Error)
	}
	if err := result.Into(out); err != nil {
		// An answer that cannot be read is this Hub's bug, not the caller's, and
		// it is wrapped as such: the quiet helper's caller has no status code to
		// choose, so the reason has to carry its own kind — otherwise a version
		// skew between this Hub and a machine is reported to a phone as a bad
		// request, with a decoder's sentence as the explanation.
		return fmt.Errorf("%w: decode the answer to %s: %v", errUnreadableAnswer, method, err)
	}
	return nil
}

// localDevice reports whether a device name means the daemon answering this
// request.
//
// There are three ways to say it and they are one machine: absent, which is what
// a console that has not thought about machines sends; "self", which is what one
// that has calls the daemon it is talking to; and the desktop id, which is what
// the rest of the API calls the same thing. One predicate, because the day two
// of these disagree is the day a question about a phone gets answered by a NAS.
func (s *Server) localDevice(device string) bool {
	device = strings.TrimSpace(device)
	return device == "" || device == "self" || device == strings.TrimSpace(s.DesktopID)
}

// askMachine puts one question to one machine and returns its answer.
//
// It is the single place the local machine and a paired one are told apart, so
// that every question added later answers both the same way.
func (s *Server) askMachine(ctx context.Context, device, method string, params json.RawMessage) (worker.QueryResult, error) {
	device = strings.TrimSpace(device)

	if s.localDevice(device) {
		if s.LocalMachine == nil {
			return worker.QueryResult{}, fmt.Errorf("%w: this machine does not answer questions about itself", errNoMachineChannel)
		}
		return s.LocalMachine.Ask(ctx, method, params), nil
	}

	// A machine this Hub does not know, or one that has been revoked, is refused
	// exactly as a task naming it would be: one answer to "is this a machine I
	// can reach", wherever it is asked.
	if err := ValidateExecutingDevice(ctx, s.Store, s.DesktopID, device); err != nil {
		return worker.QueryResult{}, err
	}
	if s.Nodes == nil || s.Queries == nil {
		return worker.QueryResult{}, errNoMachineChannel
	}
	conn, err := s.Nodes.Get(device)
	if err != nil {
		// Offline is a normal state, not a failure, and it is known now rather
		// than after a timeout.
		return worker.QueryResult{}, fmt.Errorf("%w: %s", node.ErrOffline, device)
	}
	result, err := s.Queries.Ask(ctx, conn, method, params)
	if err != nil {
		return worker.QueryResult{}, fmt.Errorf("%w: %s", errNoAnswer, err)
	}
	return result, nil
}

// writeMachineQueryError maps the ways a machine question can fail onto
// statuses a client can act on.
func writeMachineQueryError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, node.ErrOffline):
		// The machine is away. The phone can say so and let the person pick
		// another one; retrying the same question will not help.
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
	case errors.Is(err, errNoAnswer):
		// A question went out and nothing came back in time. That is a gateway
		// timeout, and the caller can try the same machine again.
		writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": err.Error()})
	case errors.Is(err, errNoMachineChannel):
		// Nothing timed out: this Hub has no way to ask any machine at all. That
		// is a service that is not up rather than a door that did not open.
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
	case errors.Is(err, errUnreadableAnswer):
		// The machine answered and this Hub could not read it. The caller's
		// request was fine, so telling them it was not sends them to fix
		// something that is not broken.
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
	case errors.Is(err, errMachineRefused):
		// The machine read the question and declined it. Not implemented is the
		// status for that, and it is the honest one for a version skew: the
		// question is real, this machine's build is older than this Hub's.
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": err.Error()})
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
	}
}
