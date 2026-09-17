package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/vuuihc/openkin/internal/remote"
	"github.com/vuuihc/openkin/internal/remote/worker"
)

type workerResponse struct {
	worker.Record
}

func (s *Server) handleRegisterWorker(w http.ResponseWriter, r *http.Request) {
	if s.Workers == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "remote workers are disabled"})
		return
	}
	principal, ok := remote.PrincipalFromContext(r.Context())
	if !ok || principal.Kind != remote.PrincipalDevice || strings.TrimSpace(principal.DeviceID) == "" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "paired device token required"})
		return
	}
	var hello worker.Hello
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, worker.MaxFrameBytes)).Decode(&hello); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	record, err := s.Workers.RegisterForOwner(hello, principal.DeviceID)
	if err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, worker.ErrWorkerExists) {
			status = http.StatusConflict
		}
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, workerResponse{Record: record})
}

func (s *Server) handleHeartbeatWorker(w http.ResponseWriter, r *http.Request) {
	if s.Workers == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "remote workers are disabled"})
		return
	}
	principal, ok := remote.PrincipalFromContext(r.Context())
	if !ok || principal.Kind != remote.PrincipalDevice || strings.TrimSpace(principal.DeviceID) == "" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "paired device token required"})
		return
	}
	var heartbeat worker.Heartbeat
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&heartbeat); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	record, err := s.Workers.HeartbeatForOwner(heartbeat, principal.DeviceID)
	if err != nil {
		status := http.StatusBadRequest
		switch {
		case errors.Is(err, worker.ErrWorkerNotFound):
			status = http.StatusNotFound
		case errors.Is(err, worker.ErrWorkerRevoked), errors.Is(err, worker.ErrLeaseExpired):
			status = http.StatusConflict
		case errors.Is(err, worker.ErrWorkerOwner):
			status = http.StatusForbidden
		case errors.Is(err, worker.ErrWorkerExists):
			status = http.StatusConflict
		}
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, workerResponse{Record: record})
}

func (s *Server) handleListWorkers(w http.ResponseWriter, r *http.Request) {
	if s.Workers == nil {
		writeJSON(w, http.StatusOK, []worker.Record{})
		return
	}
	records := s.Workers.List()
	if principal, ok := remote.PrincipalFromContext(r.Context()); ok && principal.Kind == remote.PrincipalDevice {
		filtered := records[:0]
		for _, record := range records {
			if record.OwnerDeviceID == principal.DeviceID {
				filtered = append(filtered, record)
			}
		}
		records = filtered
	}
	if records == nil {
		records = []worker.Record{}
	}
	writeJSON(w, http.StatusOK, records)
}

func (s *Server) handleRevokeWorker(w http.ResponseWriter, r *http.Request) {
	if s.Workers == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "remote workers are disabled"})
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "worker id is required"})
		return
	}
	if _, err := s.Workers.Revoke(id, time.Now()); errors.Is(err, worker.ErrWorkerNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "worker not found"})
		return
	} else if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
