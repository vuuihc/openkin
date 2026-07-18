package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"nhooyr.io/websocket"

	"github.com/vuuihc/kin/internal/terminal"
)

const terminalCreateBodyLimit = 16 << 10

const (
	terminalFrameLimit   = 64 << 10
	terminalWriteTimeout = 5 * time.Second
)

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
	if !terminalOriginAllowed(r.Header.Get("Origin")) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "terminal origin must be loopback"})
		return
	}

	id := chi.URLParam(r, "id")
	info, ok := terminalSessionInfo(s.Terminals.List(), id)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": terminal.ErrNotFound.Error()})
		return
	}
	attachment, err := s.Terminals.Attach(id)
	if err != nil {
		status := http.StatusInternalServerError
		switch {
		case errors.Is(err, terminal.ErrNotFound):
			status = http.StatusNotFound
		case errors.Is(err, terminal.ErrAttached):
			status = http.StatusConflict
		case errors.Is(err, terminal.ErrClosed):
			status = http.StatusServiceUnavailable
		}
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	defer attachment.Detach()

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Origin is checked above against the stricter loopback-only rule.
		InsecureSkipVerify: true,
	})
	if err != nil {
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(terminalFrameLimit)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	if err := writeTerminalJSON(ctx, conn, map[string]any{"type": "ready", "session": info}); err != nil {
		return
	}
	if len(attachment.Replay) > 0 {
		if err := writeTerminalFrame(ctx, conn, websocket.MessageBinary, attachment.Replay); err != nil {
			return
		}
	}

	clientResult := make(chan terminalClientResult, 1)
	go readTerminalClient(ctx, conn, s.Terminals, id, clientResult)

	output := attachment.Output
	exit := attachment.Exit
	for {
		select {
		case chunk, open := <-output:
			if !open {
				_ = conn.Close(websocket.StatusPolicyViolation, "terminal client too slow")
				return
			}
			if err := writeTerminalFrame(ctx, conn, websocket.MessageBinary, chunk); err != nil {
				return
			}
		case code, open := <-exit:
			if !open {
				exit = nil
				continue
			}
			if err := writeTerminalJSON(ctx, conn, map[string]any{"type": "exit", "exit_code": code}); err != nil {
				return
			}
			exit = nil
		case result := <-clientResult:
			if result.message != "" {
				_ = writeTerminalJSON(ctx, conn, map[string]string{"type": "error", "message": result.message})
			}
			if result.status != 0 {
				_ = conn.Close(result.status, result.reason)
			}
			return
		case <-ctx.Done():
			_ = conn.Close(websocket.StatusGoingAway, "terminal handler closed")
			return
		}
	}
}

type terminalClientResult struct {
	status  websocket.StatusCode
	reason  string
	message string
}

type terminalControl struct {
	Type string `json:"type"`
	Cols int    `json:"cols,omitempty"`
	Rows int    `json:"rows,omitempty"`
}

func readTerminalClient(ctx context.Context, conn *websocket.Conn, manager *terminal.Manager, id string, result chan<- terminalClientResult) {
	finish := func(value terminalClientResult) {
		select {
		case result <- value:
		case <-ctx.Done():
		}
	}
	for {
		messageType, payload, err := conn.Read(ctx)
		if err != nil {
			status := websocket.CloseStatus(err)
			if status == websocket.StatusNormalClosure || status == websocket.StatusGoingAway {
				finish(terminalClientResult{})
				return
			}
			finish(terminalClientResult{status: websocket.StatusInternalError, reason: "terminal read failed"})
			return
		}
		switch messageType {
		case websocket.MessageBinary:
			if err := manager.Write(id, payload); err != nil {
				finish(terminalClientResult{
					status: websocket.StatusInternalError, reason: "terminal input failed", message: err.Error(),
				})
				return
			}
		case websocket.MessageText:
			control, err := decodeTerminalControl(payload)
			if err != nil {
				finish(terminalClientResult{status: websocket.StatusUnsupportedData, reason: "invalid terminal control"})
				return
			}
			switch control.Type {
			case "ping":
				if control.Cols != 0 || control.Rows != 0 {
					finish(terminalClientResult{status: websocket.StatusUnsupportedData, reason: "invalid ping control"})
					return
				}
			case "resize":
				if control.Cols < 0 || control.Cols > 1<<16-1 || control.Rows < 0 || control.Rows > 1<<16-1 {
					finish(terminalClientResult{status: websocket.StatusUnsupportedData, reason: "invalid terminal size"})
					return
				}
				if err := manager.Resize(id, uint16(control.Cols), uint16(control.Rows)); err != nil {
					if errors.Is(err, terminal.ErrSize) {
						finish(terminalClientResult{status: websocket.StatusUnsupportedData, reason: "invalid terminal size"})
					} else {
						finish(terminalClientResult{
							status: websocket.StatusInternalError, reason: "terminal resize failed", message: err.Error(),
						})
					}
					return
				}
			default:
				finish(terminalClientResult{status: websocket.StatusUnsupportedData, reason: "unsupported terminal control"})
				return
			}
		default:
			finish(terminalClientResult{status: websocket.StatusUnsupportedData, reason: "unsupported terminal data"})
			return
		}
	}
}

func decodeTerminalControl(payload []byte) (terminalControl, error) {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	var control terminalControl
	if err := decoder.Decode(&control); err != nil || control.Type == "" {
		return terminalControl{}, errors.New("invalid terminal control")
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return terminalControl{}, err
	}
	return control, nil
}

func writeTerminalJSON(ctx context.Context, conn *websocket.Conn, value any) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return writeTerminalFrame(ctx, conn, websocket.MessageText, payload)
}

func writeTerminalFrame(ctx context.Context, conn *websocket.Conn, messageType websocket.MessageType, payload []byte) error {
	writeCtx, cancel := context.WithTimeout(ctx, terminalWriteTimeout)
	defer cancel()
	return conn.Write(writeCtx, messageType, payload)
}

func terminalSessionInfo(sessions []terminal.SessionInfo, id string) (terminal.SessionInfo, bool) {
	for _, info := range sessions {
		if info.ID == id {
			return info, true
		}
	}
	return terminal.SessionInfo{}, false
}

func terminalOriginAllowed(origin string) bool {
	if origin == "" {
		return true
	}
	parsed, err := url.Parse(origin)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil {
		return false
	}
	if parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
