package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/vuuihc/kin/internal/terminal"
)

const terminalCreateBodyLimit = 16 << 10

func (s *Server) handleTerminalProfiles(w http.ResponseWriter, r *http.Request) {
	if !s.terminalAvailable(w) {
		return
	}
	profiles := s.Terminals.Profiles()
	if profiles == nil {
		profiles = []terminal.Profile{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"profiles":           profiles,
		"default_profile_id": terminal.DefaultProfileID(profiles),
	})
}

func (s *Server) handleTerminalSessions(w http.ResponseWriter, r *http.Request) {
	if !s.terminalAvailable(w) {
		return
	}
	sessions := s.Terminals.List()
	if sessions == nil {
		sessions = []terminal.SessionInfo{}
	}
	writeJSON(w, http.StatusOK, sessions)
}

func (s *Server) handleCreateTerminalSession(w http.ResponseWriter, r *http.Request) {
	if !s.terminalAvailable(w) {
		return
	}
	reader := http.MaxBytesReader(w, r.Body, terminalCreateBodyLimit)
	defer reader.Close()
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()
	var request terminal.CreateRequest
	if err := decoder.Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if err := ensureJSONEOF(decoder); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}

	info, err := s.Terminals.Create(request)
	if err != nil {
		s.handleTerminalCreateError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, info)
}

func (s *Server) handleDeleteTerminalSession(w http.ResponseWriter, r *http.Request) {
	if !s.terminalAvailable(w) {
		return
	}
	err := s.Terminals.Remove(chi.URLParam(r, "id"))
	if err != nil && !errors.Is(err, terminal.ErrNotFound) {
		status := http.StatusInternalServerError
		if errors.Is(err, terminal.ErrClosed) {
			status = http.StatusServiceUnavailable
		}
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleTerminalCreateError(w http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	switch {
	case errors.Is(err, terminal.ErrProfile), errors.Is(err, terminal.ErrCwd), errors.Is(err, terminal.ErrSize):
		status = http.StatusBadRequest
	case errors.Is(err, terminal.ErrSessionLimit):
		status = http.StatusTooManyRequests
	case errors.Is(err, terminal.ErrClosed):
		status = http.StatusServiceUnavailable
	}
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

func (s *Server) terminalAvailable(w http.ResponseWriter) bool {
	if s.Terminals != nil {
		return true
	}
	writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "terminal unavailable"})
	return false
}

func ensureJSONEOF(decoder *json.Decoder) error {
	var extra any
	err := decoder.Decode(&extra)
	if errors.Is(err, io.EOF) {
		return nil
	}
	if err == nil {
		return errors.New("multiple json values")
	}
	return err
}

func (s *Server) handleTerminalWS(w http.ResponseWriter, r *http.Request) {
	if !s.terminalAvailable(w) {
		return
	}
	writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "terminal websocket unavailable"})
}
