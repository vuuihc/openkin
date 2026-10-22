package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/vuuihc/openkin/internal/remote"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/task"
)

// This file is the realtime half of sync, and it is deliberately the smaller
// half. The cursor in GET /api/sessions is the truth; everything here only says
// "something changed, go look". A client that loses the stream, or never gets
// one because a corporate proxy eats long-lived responses, is still correct —
// it just polls the cursor instead of being told.
//
// The intended client sequence is:
//
//  1. open the stream (or the long poll),
//  2. then drain GET /api/sessions until has_more is false.
//
// In that order a change arriving during the catch-up is delivered twice, which
// costs nothing because the client applies changes by id. The other order has a
// window where a change is delivered by neither.

const (
	// sseHeartbeat keeps idle connections alive through proxies that would
	// otherwise close them, and is the only thing a quiet Hub sends.
	sseHeartbeat = 15 * time.Second
	// longPollDefault is how long a poll waits before answering "nothing yet".
	longPollDefault = 25 * time.Second
	longPollMax     = 60 * time.Second
	// principalRecheck is how often a live stream re-validates its credential,
	// so signing out or revoking a device closes the stream promptly instead of
	// at the next reconnect.
	principalRecheck = 10 * time.Second
)

// handleEventStream serves the realtime channel as Server-Sent Events.
//
// SSE rather than WebSocket because it is plain HTTP: it survives proxies that
// block upgrades, it reconnects on its own, and it needs no framing protocol on
// either side. Each frame is the same {kind, data} envelope the WebSocket bus
// sends, so clients can share one message handler.
func (s *Server) handleEventStream(w http.ResponseWriter, r *http.Request) {
	if s.Engine == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "engine unavailable"})
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "streaming unsupported"})
		return
	}
	sub := s.Engine.Bus().Subscribe()
	defer s.Engine.Bus().Unsubscribe(sub)

	header := w.Header()
	header.Set("Content-Type", "text/event-stream")
	header.Set("Cache-Control", "no-cache")
	header.Set("Connection", "keep-alive")
	// nginx buffers proxied responses by default, which would hold every frame.
	header.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	if _, err := io.WriteString(w, "retry: 3000\n\n"); err != nil {
		return
	}
	flusher.Flush()

	ctx := r.Context()
	heartbeat := time.NewTicker(sseHeartbeat)
	defer heartbeat.Stop()
	recheck := time.NewTicker(principalRecheck)
	defer recheck.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-recheck.C:
			if !s.principalStillValid(ctx) {
				return
			}
		case <-heartbeat.C:
			if _, err := io.WriteString(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case msg, ok := <-sub:
			if !ok {
				// The bus drops a subscriber that fell behind rather than
				// skipping a message. Ending the stream makes the client
				// reconnect and catch up through the cursor.
				return
			}
			payload, err := json.Marshal(msg)
			if err != nil {
				continue
			}
			if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", msg.Kind, payload); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

// principalStillValid re-checks the credential behind a long-lived request.
// Streams outlive the moment of authentication, and a revoked device or a
// signed-out browser should stop receiving task traffic immediately.
func (s *Server) principalStillValid(ctx context.Context) bool {
	principal, ok := remote.PrincipalFromContext(ctx)
	if !ok {
		return false
	}
	token, ok := remote.TokenFromContext(ctx)
	if !ok || token == "" {
		// The master token cannot be revoked, and there is nothing else to check.
		return principal.Kind == remote.PrincipalMaster
	}
	switch principal.Kind {
	case remote.PrincipalDevice:
		if s.Store == nil {
			return false
		}
		active, err := s.Store.DeviceActive(ctx, principal.DeviceID)
		return err == nil && active
	case remote.PrincipalUser:
		if s.Accounts == nil {
			return false
		}
		_, err := s.Accounts.Authenticate(ctx, token)
		return err == nil
	default:
		return false
	}
}

// handleSessionsWait is the bounded long poll: it answers as soon as something
// changed, and otherwise after timeout, with an empty page.
//
// It exists for clients that cannot hold a stream open, and it stays bounded on
// purpose — an unbounded wait is a connection a proxy will kill anyway, and the
// client learns nothing from a hang that it does not learn from a timeout.
func (s *Server) handleSessionsWait(w http.ResponseWriter, r *http.Request) {
	if s.Store == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "store unavailable"})
		return
	}
	q := r.URL.Query()
	var since int64
	if raw := q.Get("updated_since"); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || parsed < 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid updated_since"})
			return
		}
		since = parsed
	}
	timeout := longPollDefault
	if raw := q.Get("timeout"); raw != "" {
		seconds, err := strconv.Atoi(raw)
		if err != nil || seconds < 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid timeout"})
			return
		}
		timeout = time.Duration(seconds) * time.Second
		if timeout > longPollMax {
			timeout = longPollMax
		}
	}

	if page, err := s.Store.ListTaskChangesSince(r.Context(), since, 0); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	} else if len(page.Tasks) > 0 || len(page.Deleted) > 0 {
		writeJSON(w, http.StatusOK, page)
		return
	}

	// Nothing pending: wait for a nudge from the bus, and re-read the store when
	// it arrives. The message itself is not the answer — the store is, because
	// the wait may have been woken by a change this client already has.
	var sub chan task.WSMessage
	if s.Engine != nil {
		sub = s.Engine.Bus().Subscribe()
		defer s.Engine.Bus().Unsubscribe(sub)
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-r.Context().Done():
		return
	case <-timer.C:
	case _, ok := <-sub:
		if !ok {
			return
		}
	}
	page, err := s.Store.ListTaskChangesSince(r.Context(), since, 0)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if page.Tasks == nil {
		page.Tasks = []store.Task{}
	}
	if page.Deleted == nil {
		page.Deleted = []string{}
	}
	writeJSON(w, http.StatusOK, page)
}
