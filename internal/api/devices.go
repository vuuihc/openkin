package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/vuuihc/openkin/internal/remote"
	"github.com/vuuihc/openkin/internal/store"
)

const pairingLifetime = 5 * time.Minute

type pairingSessionRequest struct {
	Label string `json:"label"`
}

type pairingSessionResponse struct {
	Secret    string `json:"secret"`
	ExpiresAt int64  `json:"expires_at"`
}

type pairingExchangeRequest struct {
	Secret string `json:"secret"`
	Label  string `json:"label"`
}

type pairingExchangeResponse struct {
	DeviceID string `json:"device_id"`
	Token    string `json:"token"`
	Label    string `json:"label,omitempty"`
}

type deviceResponse struct {
	ID         string `json:"id"`
	Label      string `json:"label,omitempty"`
	CreatedAt  int64  `json:"created_at"`
	LastUsedAt *int64 `json:"last_used_at,omitempty"`
	RevokedAt  *int64 `json:"revoked_at,omitempty"`
}

func (s *Server) handleCreatePairingSession(w http.ResponseWriter, r *http.Request) {
	var body pairingSessionRequest
	if r.Body != nil {
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
			return
		}
	}
	secret, err := remote.NewSecret()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "generate pairing secret"})
		return
	}
	now := time.Now().UnixMilli()
	expires := time.Now().Add(pairingLifetime).UnixMilli()
	if err := s.Store.CreatePairingSession(r.Context(), store.PairingSession{
		SecretHash: remote.HashToken(secret),
		Label:      strings.TrimSpace(body.Label),
		CreatedAt:  now,
		ExpiresAt:  expires,
	}); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, pairingSessionResponse{Secret: secret, ExpiresAt: expires})
}

func (s *Server) handlePairingExchange(w http.ResponseWriter, r *http.Request) {
	var body pairingExchangeRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	secret := strings.TrimSpace(body.Secret)
	if secret == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "secret is required"})
		return
	}
	session, err := s.Store.ConsumePairingSession(r.Context(), remote.HashToken(secret), time.Now().UnixMilli())
	if errors.Is(err, store.ErrNotFound) {
		// The first exchange may have committed the device but lost its HTTP
		// response. Return the deterministic credential on a safe retry.
		if r.Header.Get("X-Kin-Pairing-Recovery") == "1" {
			token := remote.HashToken(secret)
			credential, authErr := s.Store.AuthenticateDevice(
				r.Context(), remote.HashToken(token), time.Now().UnixMilli(),
			)
			if authErr == nil {
				writeJSON(w, http.StatusOK, pairingExchangeResponse{
					DeviceID: credential.ID,
					Token:    token,
					Label:    credential.Label,
				})
				return
			}
		}
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "pairing secret is invalid, expired, or already used"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	// Derive the device token from the pairing secret so a client can recover
	// from a lost HTTP response without issuing a second credential.
	token := remote.HashToken(secret)
	deviceID, err := remote.NewSecret()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "generate device id"})
		return
	}
	label := strings.TrimSpace(body.Label)
	if label == "" {
		label = session.Label
	}
	now := time.Now().UnixMilli()
	if err := s.Store.InsertDeviceCredential(r.Context(), store.DeviceCredential{
		ID:        "ios-" + deviceID[:16],
		TokenHash: remote.HashToken(token),
		Label:     label,
		CreatedAt: now,
	}); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, pairingExchangeResponse{
		DeviceID: "ios-" + deviceID[:16],
		Token:    token,
		Label:    label,
	})
}

func (s *Server) handleListDevices(w http.ResponseWriter, r *http.Request) {
	devices, err := s.Store.ListDeviceCredentials(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	out := make([]deviceResponse, 0, len(devices))
	for _, device := range devices {
		out = append(out, deviceResponse{
			ID:         device.ID,
			Label:      device.Label,
			CreatedAt:  device.CreatedAt,
			LastUsedAt: device.LastUsedAt,
			RevokedAt:  device.RevokedAt,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleRevokeDevice(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "device id is required"})
		return
	}
	if err := s.Store.RevokeDeviceCredential(r.Context(), id, time.Now().UnixMilli()); errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "device not found or already revoked"})
		return
	} else if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
