package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/oklog/ulid/v2"
	"github.com/vuuihc/openkin/internal/apns"
	"github.com/vuuihc/openkin/internal/remote"
	"github.com/vuuihc/openkin/internal/store"
)

// APNsSender is the subset of *apns.Client the API needs.
type APNsSender interface {
	Configured() bool
	Send(ctx context.Context, token string, env apns.Environment, n apns.Notification) apns.Result
}

// Native push device endpoints.
//
// Registration is the only place a phone hands the daemon a token that can
// deliver to it, so it is validated here rather than at delivery: a bad token
// discovered inside a fire-and-forget send is a notification nobody sees and a
// row that fails on every later event. The token itself is never returned by
// the API — it is a capability, and the settings page only needs to know that
// this device exists and when it last worked.

var (
	pushTokenPattern   = regexp.MustCompile(`^[0-9a-fA-F]{32,256}$`)
	pushInstallPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{8,200}$`)
)

// pushDeviceView is one row of GET /api/push/devices. Token omitted.
type pushDeviceView struct {
	ID          string `json:"id"`
	Platform    string `json:"platform"`
	Name        string `json:"name"`
	Environment string `json:"environment"`
	CreatedAt   int64  `json:"created_at"`
	UpdatedAt   int64  `json:"updated_at"`
	LastOKAt    int64  `json:"last_ok_at"`
	LastError   string `json:"last_error"`
}

type pushDevicesResponse struct {
	Devices []pushDeviceView `json:"devices"`
	// APNsConfigured says whether this node has credentials. False means the
	// settings page must say what is missing instead of claiming the phone is on.
	APNsConfigured bool `json:"apns_configured"`
}

type registerPushDeviceRequest struct {
	InstallID   string `json:"install_id"`
	Platform    string `json:"platform"`
	Token       string `json:"token"`
	Environment string `json:"environment"`
	Name        string `json:"name"`
}

// pushOwner is what a registration belongs to, derived from the principal that
// made the request. An operator registering with the master token has no owner:
// that row receives every event, which is the single-owner default.
//
// A browser session also names its session, so the registration can end with
// that login rather than with the whole account: signing out on one phone must
// not leave it subscribed to the account's work.
func pushOwner(ctx context.Context, st *store.Store, p remote.Principal) (userID, deviceID, sessionID string) {
	switch p.Kind {
	case remote.PrincipalDevice:
		deviceID = strings.TrimSpace(p.DeviceID)
		if deviceID != "" && st != nil {
			// A paired console is a device credential; its account is the one
			// the device was paired for, when it has a registry row. A device
			// that never connected has no owner, and an empty owner is the
			// operator-wide row, not a row for nobody.
			if device, err := st.GetDevice(ctx, deviceID); err == nil {
				userID = device.OwnerUserID
			}
		}
	case remote.PrincipalUser:
		userID = strings.TrimSpace(p.UserID)
		sessionID = strings.TrimSpace(p.SessionID)
	}
	return userID, deviceID, sessionID
}

// canManagePushDevice reports whether this principal may list, test, or delete
// one row. An operator may manage every row; everyone else only the rows their
// own account or paired device created.
func canManagePushDevice(p remote.Principal, d store.PushDevice) bool {
	if isOperator(p) {
		return true
	}
	switch p.Kind {
	case remote.PrincipalDevice:
		return d.OwnerDeviceID != "" && d.OwnerDeviceID == p.DeviceID
	case remote.PrincipalUser:
		return d.OwnerUserID != "" && d.OwnerUserID == p.UserID
	}
	return false
}

// apnsConfigured answers the passive status question without reading or
// parsing the private key. Opening Settings must not touch a secret; metadata
// written with the key is enough to say the operator set a provider up. The
// key itself is read only for an explicit send.
func (s *Server) apnsConfigured(ctx context.Context) bool {
	if s.Store == nil {
		return s.APNs != nil && s.APNs.Configured()
	}
	return apns.ConfiguredInSettings(ctx, s.Store)
}

// apnsSender returns the live credentials, or nil when this node cannot send
// to iPhones. Reading settings per request is what makes `kin notify apns`
// take effect without restarting the daemon.
func (s *Server) apnsSender(ctx context.Context) APNsSender {
	if s.APNsFor != nil {
		client, err := s.APNsFor(ctx)
		if err != nil || client == nil || !client.Configured() {
			return nil
		}
		return client
	}
	if s.APNs != nil && s.APNs.Configured() {
		return s.APNs
	}
	return nil
}

func (s *Server) handleListPushDevices(w http.ResponseWriter, r *http.Request) {
	all, err := s.Store.ListPushDevices(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	p, _ := remote.PrincipalFromContext(r.Context())
	devices := make([]store.PushDevice, 0, len(all))
	for _, d := range all {
		if canManagePushDevice(p, d) {
			devices = append(devices, d)
		}
	}
	out := make([]pushDeviceView, 0, len(devices))
	for _, d := range devices {
		out = append(out, pushDeviceView{
			ID: d.ID, Platform: d.Platform, Name: d.Name, Environment: d.Environment,
			CreatedAt: d.CreatedAt, UpdatedAt: d.UpdatedAt, LastOKAt: d.LastOKAt, LastError: d.LastError,
		})
	}
	writeJSON(w, http.StatusOK, pushDevicesResponse{
		Devices:        out,
		APNsConfigured: s.apnsConfigured(r.Context()),
	})
}

func (s *Server) handleRegisterPushDevice(w http.ResponseWriter, r *http.Request) {
	var body registerPushDeviceRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	install := strings.TrimSpace(body.InstallID)
	token := strings.TrimSpace(body.Token)
	platform := strings.TrimSpace(body.Platform)
	env := apns.Environment(strings.TrimSpace(body.Environment))
	name := strings.TrimSpace(body.Name)
	switch {
	case !pushInstallPattern.MatchString(install):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "install_id is invalid"})
		return
	case platform != "ios":
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "platform must be ios"})
		return
	case !pushTokenPattern.MatchString(token):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "token is not an APNs device token"})
		return
	case env != apns.Sandbox && env != apns.Production:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "environment must be sandbox or production"})
		return
	case len(name) > 100:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "name is too long"})
		return
	}
	principal, _ := remote.PrincipalFromContext(r.Context())
	ownerUserID, ownerDeviceID, ownerSessionID := pushOwner(r.Context(), s.Store, principal)
	if principal.Kind == remote.PrincipalUser && ownerSessionID == "" {
		// Such a row would be bound to no session, so nothing would ever end it.
		// The auth wiring always names the login; refuse rather than store it.
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "session is required to register notifications"})
		return
	}
	now := time.Now().UnixMilli()
	id, err := s.Store.SavePushDevice(r.Context(), store.PushDevice{
		ID: ulid.Make().String(), InstallID: install, Platform: platform, Token: token,
		Environment: string(env), Name: name,
		OwnerUserID: ownerUserID, OwnerDeviceID: ownerDeviceID, OwnerSessionID: ownerSessionID,
		CreatedAt: now, UpdatedAt: now,
	})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	// The id is the stored row's, which for a re-register is the original one:
	// handing back the freshly minted ULID would name a row that does not exist.
	writeJSON(w, http.StatusCreated, map[string]string{"id": id})
}

// pushDeviceForRequest loads one row, keeping "gone" separate from "cannot
// read". Mapping a database error to 404 would tell the console the row is
// already deleted, so it would forget the pending deletion and leave a live
// registration ringing.
func (s *Server) pushDeviceForRequest(w http.ResponseWriter, r *http.Request, id string) (store.PushDevice, bool) {
	device, err := s.Store.GetPushDevice(r.Context(), id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "device not found"})
		} else {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not read the registration"})
		}
		return store.PushDevice{}, false
	}
	return device, true
}

func (s *Server) handleDeletePushDevice(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "id is required"})
		return
	}
	device, ok := s.pushDeviceForRequest(w, r, id)
	if !ok {
		return
	}
	if p, _ := remote.PrincipalFromContext(r.Context()); !canManagePushDevice(p, device) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "this registration belongs to another account"})
		return
	}
	if err := s.Store.DeletePushDevice(r.Context(), id); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// pushTestResponse is POST /api/push/devices/test.
type pushTestResponse struct {
	OK         bool `json:"ok"`
	Configured bool `json:"configured"`
	// Expired says the node deleted this row because Apple will never accept
	// the token again. The console has to leave the "on" state and offer
	// enable again; retrying or disabling the deleted row would only 404.
	Expired bool                  `json:"expired,omitempty"`
	Results []notifyChannelResult `json:"results"`
}

type notifyChannelResult struct {
	Channel string `json:"channel"`
	Device  string `json:"device,omitempty"`
	OK      bool   `json:"ok"`
	Status  string `json:"status,omitempty"`
	Error   string `json:"error,omitempty"`
}

type testPushDeviceRequest struct {
	ID string `json:"id"`
}

// handleTestPushDevice sends one alert to one registered device. It is an
// explicit action from the settings page, never part of opening it.
func (s *Server) handleTestPushDevice(w http.ResponseWriter, r *http.Request) {
	var body testPushDeviceRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	device, ok := s.pushDeviceForRequest(w, r, strings.TrimSpace(body.ID))
	if !ok {
		return
	}
	if p, _ := remote.PrincipalFromContext(r.Context()); !canManagePushDevice(p, device) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "this registration belongs to another account"})
		return
	}
	// A registration made through a login stops receiving when that login ends,
	// and a test is a send. The row is deleted rather than merely refused: its
	// credential is gone, so it can only mislead the device list from here.
	if device.OwnerSessionID != "" && !s.Store.AuthSessionLive(r.Context(), device.OwnerSessionID) {
		_ = s.Store.DeletePushDevice(r.Context(), device.ID)
		writeJSON(w, http.StatusGone, map[string]string{"error": "device session has ended"})
		return
	}
	sender := s.apnsSender(r.Context())
	if sender == nil {
		writeJSON(w, http.StatusOK, pushTestResponse{
			Configured: false,
			Results:    []notifyChannelResult{},
		})
		return
	}
	res := sender.Send(r.Context(), device.Token, apns.Environment(device.Environment), apns.Notification{
		Title: "Kin test",
		Body:  "Notifications from this Kin node reach this iPhone.",
		URL:   "/settings",
		Kind:  "test",
		ID:    device.ID,
	})
	at := time.Now().UnixMilli()
	result := notifyChannelResult{Channel: "apns", Device: device.ID, OK: res.OK}
	if res.OK {
		result.Status = "ok"
		_ = s.Store.MarkPushDeviceResult(r.Context(), device.ID, at, "")
	} else {
		result.Error = res.Reason
		_ = s.Store.MarkPushDeviceResult(r.Context(), device.ID, at, res.Reason)
		if res.Expired {
			_ = s.Store.DeletePushDeviceByToken(r.Context(), device.Token)
		}
	}
	writeJSON(w, http.StatusOK, pushTestResponse{
		OK:         res.OK,
		Configured: true,
		Expired:    res.Expired,
		Results:    []notifyChannelResult{result},
	})
}
