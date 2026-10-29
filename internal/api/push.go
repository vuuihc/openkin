package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/oklog/ulid/v2"
	"github.com/vuuihc/openkin/internal/notify"
	"github.com/vuuihc/openkin/internal/push"
	"github.com/vuuihc/openkin/internal/store"
)

// The browser push endpoints.
//
// Subscribing is the only place a browser hands the daemon an address to post
// to, so it is validated here rather than at delivery: the endpoint must be
// https, and the keys must be a P-256 point and a 16-byte secret. Delivery
// happens in a goroutine where a bad registration would fail silently.

// pushConfigResponse is GET /api/push/config.
type pushConfigResponse struct {
	// PublicKey is the VAPID key the browser subscribes with, base64url.
	PublicKey string `json:"public_key"`
	// Subscribed is how many browsers would receive a message.
	Subscribed int `json:"subscribed"`
}

func (s *Server) pushService() *push.Service {
	if s.Push == nil || s.Push.Store == nil {
		return nil
	}
	return s.Push
}

func (s *Server) handlePushConfig(w http.ResponseWriter, r *http.Request) {
	svc := s.pushService()
	if svc == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "push is not available"})
		return
	}
	key, err := svc.PublicKey(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	n, err := svc.Count(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, pushConfigResponse{PublicKey: key, Subscribed: n})
}

// pushSubscribeRequest is POST /api/push/subscribe. The shape is the browser's
// own `PushSubscription.toJSON()`, so the console can post it with almost no
// translation.
type pushSubscribeRequest struct {
	Endpoint string `json:"endpoint"`
	Keys     struct {
		P256DH string `json:"p256dh"`
		Auth   string `json:"auth"`
	} `json:"keys"`
}

func (s *Server) handlePushSubscribe(w http.ResponseWriter, r *http.Request) {
	svc := s.pushService()
	if svc == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "push is not available"})
		return
	}
	var body pushSubscribeRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	endpoint := strings.TrimSpace(body.Endpoint)
	if err := push.ValidateRegistration(endpoint, body.Keys.P256DH, body.Keys.Auth); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	sub := store.PushSubscription{
		ID:        ulid.Make().String(),
		Endpoint:  endpoint,
		P256DH:    body.Keys.P256DH,
		Auth:      body.Keys.Auth,
		CreatedAt: time.Now().UnixMilli(),
	}
	id, err := svc.Store.SavePushSubscription(r.Context(), sub)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	// The id is the stored row's, which for a re-subscribe is the original one:
	// handing back the freshly minted ULID would name a row that does not exist.
	writeJSON(w, http.StatusCreated, map[string]string{"id": id})
}

// pushUnsubscribeRequest is DELETE /api/push/subscribe.
//
// The browser knows only its endpoint, never the row id — the id is this
// daemon's bookkeeping, and asking the console to remember it would break
// unsubscribing after a restart of either side.
type pushUnsubscribeRequest struct {
	Endpoint string `json:"endpoint"`
}

func (s *Server) handlePushUnsubscribe(w http.ResponseWriter, r *http.Request) {
	svc := s.pushService()
	if svc == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "push is not available"})
		return
	}
	endpoint := strings.TrimSpace(r.URL.Query().Get("endpoint"))
	if endpoint == "" {
		var body pushUnsubscribeRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&body); err == nil {
			endpoint = strings.TrimSpace(body.Endpoint)
		}
	}
	if endpoint == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "endpoint is required"})
		return
	}
	if err := svc.Store.DeletePushSubscriptionByEndpoint(r.Context(), endpoint); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handlePushTest sends one message to every registered browser, on an explicit
// action from the settings page.
func (s *Server) handlePushTest(w http.ResponseWriter, r *http.Request) {
	svc := s.pushService()
	if svc == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "push is not available"})
		return
	}
	results := svc.Push(r.Context(), notify.Payload{
		Title: "Kin test",
		Body:  "Push notifications from this Kin node reach this browser.",
		URL:   "/settings",
	})
	if results == nil {
		results = []notify.ChannelResult{}
	}
	anyOK := false
	for _, res := range results {
		if res.OK {
			anyOK = true
			break
		}
	}
	writeJSON(w, http.StatusOK, notifyTestResponse{OK: anyOK, Results: results})
}
