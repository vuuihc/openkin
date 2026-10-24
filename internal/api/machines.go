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
	if err := json.NewDecoder(r.Body).Decode(&params); err != nil {
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
	raw, err := json.Marshal(params)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	result, err := s.askMachine(r.Context(), device, method, raw)
	if err != nil {
		writeMachineQueryError(w, err)
		return
	}
	// A refusal is the machine's own sentence, passed through as it stands. The
	// status is 400 because the machine was asked and said no: the request named
	// something it will not do.
	if result.Error != "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": result.Error})
		return
	}
	if err := result.Into(out); err != nil {
		// An answer that cannot be read is this Hub's bug, not the caller's.
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, out)
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
	case errors.Is(err, errNoAnswer), errors.Is(err, errNoMachineChannel):
		writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": err.Error()})
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
	}
}
