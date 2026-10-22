package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/vuuihc/openkin/internal/node"
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
	DeviceID    string `json:"device_id"`
	Token       string `json:"token"`
	Label       string `json:"label,omitempty"`
	DesktopID   string `json:"desktop_id,omitempty"`
	DesktopName string `json:"desktop_name,omitempty"`
}

type deviceResponse struct {
	ID           string              `json:"id"`
	Label        string              `json:"label,omitempty"`
	Platform     string              `json:"platform,omitempty"`
	Arch         string              `json:"arch,omitempty"`
	Role         string              `json:"role,omitempty"`
	KinVersion   string              `json:"kin_version,omitempty"`
	Reachability string              `json:"reachability"`
	LastSeenAt   *int64              `json:"last_seen_at,omitempty"`
	CreatedAt    int64               `json:"created_at"`
	RevokedAt    *int64              `json:"revoked_at,omitempty"`
	Agents       []deviceAgentResult `json:"agents"`
	// Roots are the workspace roots the device reported. Paths, not secrets:
	// the same list the machine would show a user who asked it.
	Roots []string `json:"workspace_roots,omitempty"`
}

type deviceAgentResult struct {
	ID           string   `json:"id"`
	Installed    bool     `json:"installed"`
	Available    bool     `json:"available"`
	Version      string   `json:"version,omitempty"`
	Reason       string   `json:"reason,omitempty"`
	DefaultModel string   `json:"default_model,omitempty"`
	Models       []string `json:"models,omitempty"`
	IsDefault    bool     `json:"is_default,omitempty"`
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
			now := time.Now().UnixMilli()
			if authErr == nil && credential.CreatedAt <= now &&
				now-credential.CreatedAt <= pairingLifetime.Milliseconds() {
				// Recovery is only an idempotency window for a lost response;
				// the original five-minute pairing lifetime remains the bound.
				writeJSON(w, http.StatusOK, pairingExchangeResponse{
					DeviceID:    credential.ID,
					Token:       token,
					Label:       credential.Label,
					DesktopID:   strings.TrimSpace(s.DesktopID),
					DesktopName: strings.TrimSpace(s.DesktopName),
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
		DeviceID:    "ios-" + deviceID[:16],
		Token:       token,
		Label:       label,
		DesktopID:   strings.TrimSpace(s.DesktopID),
		DesktopName: strings.TrimSpace(s.DesktopName),
	})
}

// handleListDevices answers "which machines does this Hub know about, and what
// can each of them run" — the question a console needs before it can offer to
// run a session somewhere.
func (s *Server) handleListDevices(w http.ResponseWriter, r *http.Request) {
	devices, err := s.Store.ListDevices(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	out := make([]deviceResponse, 0, len(devices))
	for _, device := range devices {
		out = append(out, s.deviceResponse(r.Context(), device))
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) deviceResponse(ctx context.Context, device store.Device) deviceResponse {
	response := deviceResponse{
		ID:           device.ID,
		Label:        device.Label,
		Platform:     device.Platform,
		Arch:         device.Arch,
		Role:         device.Role,
		KinVersion:   device.KinVersion,
		Reachability: device.Reachability,
		LastSeenAt:   device.LastSeenAt,
		CreatedAt:    device.CreatedAt,
		RevokedAt:    device.RevokedAt,
		Agents:       []deviceAgentResult{},
		Roots:        node.DecodeCapabilities(device.Capabilities).WorkspaceRoots,
	}
	if s.Nodes != nil && s.Nodes.Connected(device.ID) {
		// A live socket outranks the last thing written to the row: the device
		// is here now, whatever the database says about a moment ago.
		response.Reachability = store.ReachabilityOnline
	}
	agents, err := s.Store.ListDeviceAgents(ctx, device.ID)
	if err != nil {
		return response
	}
	for _, agent := range agents {
		response.Agents = append(response.Agents, deviceAgentResult{
			ID:           agent.AgentID,
			Installed:    agent.Installed,
			Available:    agent.Available,
			Version:      agent.Version,
			Reason:       agent.Reason,
			DefaultModel: agent.DefaultModel,
			Models:       agent.Models,
			IsDefault:    agent.IsDefault,
		})
	}
	return response
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
	if s.Workers != nil {
		s.Workers.RevokeOwner(id, time.Now())
	}
	w.WriteHeader(http.StatusNoContent)
}
