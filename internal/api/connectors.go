package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/vuuihc/openkin/internal/connectors"
	"github.com/vuuihc/openkin/internal/remote"
)

func (s *Server) handleListConnectors(w http.ResponseWriter, _ *http.Request) {
	if s.Connectors == nil {
		writeJSON(w, http.StatusOK, []connectors.Config{})
		return
	}
	writeJSON(w, http.StatusOK, s.Connectors.List())
}

func (s *Server) handleRegisterConnector(w http.ResponseWriter, r *http.Request) {
	if s.Connectors == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "connector host unavailable"})
		return
	}
	var cfg connectors.Config
	if err := json.NewDecoder(r.Body).Decode(&cfg); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if err := s.Connectors.Register(cfg); err != nil {
		writeConnectorError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, cfg)
}

func (s *Server) handleUpdateConnector(w http.ResponseWriter, r *http.Request) {
	if s.Connectors == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "connector host unavailable"})
		return
	}
	var cfg connectors.Config
	if err := json.NewDecoder(r.Body).Decode(&cfg); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	cfg.ID = chi.URLParam(r, "id")
	if err := s.Connectors.Update(cfg); err != nil {
		writeConnectorError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, cfg)
}

func (s *Server) handleDisableConnector(w http.ResponseWriter, r *http.Request) {
	if s.Connectors == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "connector host unavailable"})
		return
	}
	if err := s.Connectors.Disable(chi.URLParam(r, "id"), true); err != nil {
		writeConnectorError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleListConnectorTools(w http.ResponseWriter, r *http.Request) {
	if s.Connectors == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "connector host unavailable"})
		return
	}
	tools, err := s.Connectors.Tools(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeConnectorError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, tools)
}

type connectorCallBody struct {
	TaskID    string         `json:"task_id,omitempty"`
	Tool      string         `json:"tool"`
	Arguments map[string]any `json:"arguments"`
}

func (s *Server) handleCallConnector(w http.ResponseWriter, r *http.Request) {
	if s.Connectors == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "connector host unavailable"})
		return
	}
	var body connectorCallBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	principal := "master"
	if p, ok := remote.PrincipalFromContext(r.Context()); ok && p.DeviceID != "" {
		principal = p.DeviceID
	}
	result, err := s.Connectors.Call(r.Context(), connectors.Call{
		ConnectorID: chi.URLParam(r, "id"),
		TaskID:      strings.TrimSpace(body.TaskID),
		Principal:   principal,
		Tool:        strings.TrimSpace(body.Tool),
		Arguments:   body.Arguments,
	})
	if err != nil {
		writeConnectorError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

type connectorCredentialBody struct {
	Value string `json:"value"`
}

func (s *Server) handleSetConnectorCredential(w http.ResponseWriter, r *http.Request) {
	if s.Connectors == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "connector host unavailable"})
		return
	}
	var body connectorCredentialBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Value == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "credential value is required"})
		return
	}
	if err := s.Connectors.SetCredential(chi.URLParam(r, "ref"), body.Value); err != nil {
		writeConnectorError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleDeleteConnectorCredential(w http.ResponseWriter, r *http.Request) {
	if s.Connectors == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "connector host unavailable"})
		return
	}
	if err := s.Connectors.DeleteCredential(chi.URLParam(r, "ref")); err != nil {
		writeConnectorError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func writeConnectorError(w http.ResponseWriter, err error) {
	status := http.StatusBadRequest
	message := "connector operation failed"
	switch {
	case errors.Is(err, connectors.ErrToolDenied), errors.Is(err, connectors.ErrDisabled):
		status = http.StatusForbidden
		if errors.Is(err, connectors.ErrToolDenied) {
			message = "connector tool is not allowlisted"
		} else {
			message = "connector is disabled"
		}
	case errors.Is(err, connectors.ErrUnsafeURL):
		status = http.StatusBadRequest
		message = "connector URL is not allowed"
	case errors.Is(err, connectors.ErrOutputTooLarge):
		status = http.StatusBadGateway
		message = "connector output exceeds limit"
	case errors.Is(err, connectors.ErrInvalidConfig):
		message = "invalid connector configuration"
	}
	writeJSON(w, status, map[string]string{"error": message})
}
